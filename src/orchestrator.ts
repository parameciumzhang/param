import fs from "node:fs";
import { createInterface } from "node:readline/promises";
import { initSchema, closePool, getAllTasks, countIncomplete, getChallenges, getContestPublication, countUnreadyChallenges, type TaskRow } from "./db.js";
import { runManager, runPlanner, runWorker, runCompactor, type PlannerOutcome } from "./roles.js";
import {
  forceComplete,
  assertInjectedPromptsCurrent,
  resetRunState,
  injectPrompts,
  exportDatabaseHistory,
  restoreDatabaseHistory,
  resolveContinuableHistory,
  listContinuableHistory,
  getDueCompressionBatch,
  acquireTaskExecutionLock,
  releaseTaskExecutionLock,
  getTaskForExecution,
  getTaskDeletionRequestedIds,
  getPendingTaskDeletionStopIds,
  markTaskDeletionStopped,
  getTaskCompletionRequestedIds,
  getPendingTaskCompletionStopIds,
  markTaskCompletionStopped,
  activateQueuedChallenges,
  failChallenge,
  failContestPublication,
  generateContestSummary,
} from "./scripts.js";
import { config, LLM_ROLES, llmForRole } from "./config.js";
import { ensureKali, getKaliEnvInfo, type KaliEnvInfo } from "./kali.js";
import { loadContestInput } from "./contest-input.js";

const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
const MAX_PLANNER_ROUNDS = 150;
const PLANNER_EMPTY_RETRIES = 2;
const LOOP_ERROR_RETRIES = 10;
const COMPACTOR_FAILURE_RETRIES = 3;

interface OrchestratorResult {
  reportFile: string | null;
  plannerRounds: number;
  reason: string;
  interrupted?: boolean;
  hasFailures?: boolean;
}

interface RunHandle {
  taskId: number;
  challengeId: number;
  slot: number;
  controller: AbortController;
  cancel: null | "interrupt" | "delete" | "complete";
  promise?: Promise<void>;
}

interface ChallengeRuntime {
  requested: boolean;
  inFlight: boolean;
  waiting: boolean;
  emptyRounds: number;
  rounds: number;
  failure: string | null;
  events: Set<number>;
  reportFile: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let shutdownHistoryExport: Promise<void> | null = null;

function exportHistoryForShutdown(): Promise<void> {
  shutdownHistoryExport ??= (async () => {
    try {
      const directory = await exportDatabaseHistory();
      log(`[orchestrator] 分题历史已导出: ${directory}`);
    } catch (e) {
      console.error(`[orchestrator] 历史导出失败: ${(e as Error).message}`);
    }
  })();
  return shutdownHistoryExport;
}

async function main(): Promise<number> {
  const request = readLaunchRequest();
  log(`=== CTF 多赛题编排启动（Challenge 并行=${config.ctfPlannerConcurrency}, Worker 并行=${config.workerConcurrency}）===`);
  for (const role of LLM_ROLES) {
    const llm = llmForRole(role);
    log(`[llm] ${role.padEnd(7)} → ${llm.baseUrl} model=${llm.modelId}`);
  }
  await initSchema();
  try {
    const selected = request.continueRequested
      ? resolveContinuableHistory(request.continueReference)
      : request.skipHistoryPrompt
        ? undefined
        : await chooseInteractiveHistory();
    if (selected) {
      const restored = await restoreDatabaseHistory(selected.file);
      log(`[orchestrator] 已恢复 ${restored.challengeCount} 道 Challenge / ${restored.taskCount} 个任务；发布状态=${restored.publicationStatus}；按当前并发上限重排 active/queued，跳过 Manager`);
    } else {
      await resetRunState();
      log("[orchestrator] 全新运行：已清空 goal/challenge/task/detail/detail2、发布状态、高水位、workspaces 与分题动态提示词");
    }
    try {
      await ensureKali(log);
    } catch (e) {
      log(`[kali] 准备失败: ${(e as Error).message}`);
      return 1;
    }
    const kaliEnv = config.kali.enabled ? await getKaliEnvInfo(log).catch(() => undefined) : undefined;
    const deadline = config.globalTimeoutMs > 0 ? Date.now() + config.globalTimeoutMs : Infinity;
    const result = await orchestrate(request.userInput, deadline, kaliEnv, { resumeFromHistory: !!selected });
    if (result.interrupted) {
      if (result.reportFile) {
        log(`=== 用户中断停止；各 active 赛题中断报告与赛事汇总已生成 ===`);
        log(`赛事汇总: ${result.reportFile}`);
        return 130;
      }
      log(`=== 用户中断停止: ${result.reason ?? "未生成中断报告"} ===`);
      return 130;
    }
    if (result.reportFile) {
      log(`=== 整场赛事结束（Planner 轮次=${result.plannerRounds}）: ${result.reason} ===`);
      log(`赛事汇总: ${result.reportFile}`);
      return result.hasFailures ? 1 : 0;
    }
    log(`=== 异常终止: ${result.reason} ===`);
    return 1;
  } finally {
    await exportHistoryForShutdown();
    await closePool();
  }
}

interface LaunchRequest {
  userInput: string;
  continueRequested: boolean;
  continueReference?: string;
  skipHistoryPrompt: boolean;
}

function usage(): never {
  console.error([
    '全新赛事: npm run orchestrate -- "<整场 CTF 赛事与赛题描述>"',
    '明确全新: npm run orchestrate -- --new "<整场 CTF 赛事与赛题描述>"',
    '续跑最新: npm run orchestrate -- --continue',
    '续跑指定: npm run orchestrate -- --continue "history_db/param-contest-.../"',
    '兼容旧版: npm run orchestrate -- --continue "history_db/param-db-....json"',
  ].join("\n"));
  process.exit(2);
}

function readLaunchRequest(): LaunchRequest {
  const args = process.argv.slice(2);
  if (args[0] === "--continue") {
    if (args.length > 2) usage();
    return { userInput: "", continueRequested: true, continueReference: args[1], skipHistoryPrompt: true };
  }
  const skipHistoryPrompt = args[0] === "--new";
  if (skipHistoryPrompt) args.shift();
  const arg = args[0];
  if (args.length > 1 || arg?.startsWith("--")) usage();
  if (arg?.trim()) return { userInput: arg.trim(), continueRequested: false, skipHistoryPrompt };
  const supplied = loadContestInput({
    requireFile: Boolean(process.env.CTF_INPUT_FILE?.trim()),
  });
  if (supplied) return { userInput: supplied, continueRequested: false, skipHistoryPrompt };
  if (!process.stdin.isTTY) {
    try {
      const input = fs.readFileSync(0, "utf8");
      if (input.trim()) return { userInput: input.trim(), continueRequested: false, skipHistoryPrompt };
    } catch { /* no pipe */ }
  }
  usage();
}

async function chooseInteractiveHistory() {
  const latest = listContinuableHistory()[0];
  if (!latest || !process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`检测到历史: ${latest.file}\n  Challenge=${latest.challengeCount}, 任务=${latest.taskCount}（未完成 ${latest.incompleteCount}）\n  发布状态=${latest.publicationStatus}\n  goal=${latest.goal.slice(0, 120)}`);
    const answer = await rl.question("是否跳过 Manager 并续跑？[y/N] ");
    return /^(y|yes)$/i.test(answer.trim()) ? latest : undefined;
  } finally {
    rl.close();
  }
}

async function orchestrate(
  userInput: string,
  globalDeadline: number,
  kaliEnv?: KaliEnvInfo,
  opts: { resumeFromHistory?: boolean } = {}
): Promise<OrchestratorResult> {
  const managerController = new AbortController();
  let managerSettled = Boolean(opts.resumeFromHistory);
  let managerFailure: string | null = null;
  let managerPromise: Promise<void> | null = null;
  if (opts.resumeFromHistory) {
    log("[orchestrator] 历史续跑：按每题当前数据重新 inject_prompts");
    await injectPrompts();
    await assertInjectedPromptsCurrent();
  } else {
    // 每批发布由固定脚本同步确认 ready；Manager 的分析/后续发布与主循环并行。
    managerPromise = (async () => {
      try {
        await runManager(userInput, log, { signal: managerController.signal });
      } catch (e) {
        managerFailure = (e as Error).message;
        log(`[manager] 发布异常: ${managerFailure}；已发布赛题继续执行，整场将标记失败`);
        try {
          await failContestPublication(managerFailure!);
        } catch (cleanupError) {
          managerFailure = `${managerFailure}；发布失败状态写入失败: ${(cleanupError as Error).message}`;
        }
      } finally {
        managerSettled = true;
      }
    })();
  }

  const runtimes = new Map<number, ChallengeRuntime>();
  const runtimeFor = (challengeId: number): ChallengeRuntime => {
    let runtime = runtimes.get(challengeId);
    if (!runtime) {
      runtime = { requested: false, inFlight: false, waiting: false, emptyRounds: 0, rounds: 0, failure: null, events: new Set(), reportFile: null };
      runtimes.set(challengeId, runtime);
    }
    return runtime;
  };
  const initialChallenges = await getChallenges();
  for (const challenge of initialChallenges) {
    const runtime = runtimeFor(challenge.challenge_id);
    if (challenge.status === "active") runtime.requested = true;
  }
  const initialTasks = await getAllTasks();
  const observedComplete = new Set(initialTasks.filter((task) => task.is_complete === 1).map((task) => task.task_id));

  const assigned = new Set<number>();
  const freeSlots = Array.from({ length: config.workerConcurrency }, (_, index) => index + 1);
  const runningTasks = new Map<number, RunHandle>();
  const workerRuns = new Set<Promise<void>>();
  const plannerRuns = new Set<Promise<void>>();
  const plannerControllers = new Map<number, AbortController>();
  let compactorController: AbortController | null = null;
  const compactorFailures = new Map<string, { count: number; retryAfter: number }>();
  let fairCursor = 0;
  let interrupted = false;
  let fatalReason: string | null = null;

  const totalPlannerRounds = () => [...runtimes.values()].reduce((sum, runtime) => sum + runtime.rounds, 0);
  const runningForChallenge = (challengeId: number) => [...runningTasks.values()].filter((handle) => handle.challengeId === challengeId).length;

  const abortInFlight = () => {
    managerController.abort();
    compactorController?.abort();
    for (const controller of plannerControllers.values()) controller.abort();
    for (const handle of runningTasks.values()) {
      if (!handle.cancel) handle.cancel = "interrupt";
      handle.controller.abort();
    }
  };

  const onShutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    if (interrupted) {
      log("[orchestrator] 第二次中断信号：跳过中断报告，导出分题历史后立即退出");
      void exportHistoryForShutdown().then(() => process.exit(130));
      return;
    }
    interrupted = true;
    log(`[orchestrator] 收到 ${signal}：停止分发并中止全部在途会话；随后逐题生成中断报告`);
    abortInFlight();
  };
  const onSigint = () => onShutdown("SIGINT");
  const onSigterm = () => onShutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const executeTask = async (taskId: number, slot: number, handle: RunHandle): Promise<void> => {
    const tag = `[worker-${slot} challenge=${handle.challengeId} task_id=${taskId}]`;
    let executionClient: Awaited<ReturnType<typeof acquireTaskExecutionLock>> = null;
    try {
      executionClient = await acquireTaskExecutionLock(taskId);
      if (!executionClient) {
        log(`${tag} 执行锁被占用，本次不重复启动`);
        return;
      }
      const task = await getTaskForExecution(taskId);
      if (!task || task.is_complete === 1 || task.challenge_id !== handle.challengeId) return;
      await runWorker(task, slot, log, kaliEnv, { signal: handle.controller.signal });
      const still = await getTaskForExecution(taskId);
      if (still && still.is_complete === 0 && !handle.controller.signal.aborted) {
        log(`${tag} 正常结束但未 complete_task → 强制补完成`);
        await forceComplete(taskId, "worker 结束但未调用 complete_task");
      }
    } catch (e) {
      if (handle.cancel === "delete") {
        log(`${tag} 删除请求已停止 Worker，不强制补完成`);
      } else if (handle.cancel === "complete") {
        log(`${tag} 强制完成请求已停止 Worker，不补写异常 finding`);
      } else if (handle.cancel === "interrupt") {
        log(`${tag} 已由编排器中止，不强制补完成`);
      } else {
        log(`${tag} 异常: ${(e as Error).message} → 强制补完成`);
        await forceComplete(taskId, (e as Error).message).catch((error) => log(`${tag} 强制补完成失败: ${(error as Error).message}`));
      }
    } finally {
      // 先释放跨进程执行锁，再开放 Worker 槽位与分配状态，避免同一任务立即重入。
      if (executionClient) await releaseTaskExecutionLock(executionClient, taskId);
      freeSlots.push(slot);
      if (runningTasks.get(taskId) === handle) {
        runningTasks.delete(taskId);
        assigned.delete(taskId);
      }
    }
  };

  let governanceStopActive = false;
  const stopWorkerForGovernance = async (taskId: number, kind: "delete" | "complete"): Promise<void> => {
    const handle = runningTasks.get(taskId);
    if (!handle) return;
    if (!handle.cancel) handle.cancel = kind;
    handle.controller.abort();
    // handle.promise 只有在 Worker 会话收尾、执行锁释放和槽位清理后才完成。
    if (handle.promise) await handle.promise;
    else while (runningTasks.get(taskId) === handle) await sleep(25);
  };
  const processTaskGovernanceStops = async (): Promise<void> => {
    if (governanceStopActive) return;
    governanceStopActive = true;
    try {
      for (const taskId of await getPendingTaskDeletionStopIds()) {
        await stopWorkerForGovernance(taskId, "delete");
        await markTaskDeletionStopped(taskId);
      }
      for (const taskId of await getPendingTaskCompletionStopIds()) {
        await stopWorkerForGovernance(taskId, "complete");
        await markTaskCompletionStopped(taskId);
      }
    } catch (e) {
      log(`[task_governance] 停止请求处理失败，将重试: ${(e as Error).message}`);
    } finally {
      governanceStopActive = false;
    }
  };
  const governanceStopTimer = setInterval(() => void processTaskGovernanceStops(), 250);
  governanceStopTimer.unref();

  const launchPlanner = (challengeId: number): void => {
    const runtime = runtimeFor(challengeId);
    const events = [...runtime.events].sort((a, b) => a - b);
    runtime.events.clear();
    runtime.requested = false;
    runtime.waiting = false;
    runtime.inFlight = true;
    runtime.rounds++;
    const controller = new AbortController();
    plannerControllers.set(challengeId, controller);
    log(`[orchestrator] 启动 Challenge #${challengeId} Planner（本题第 ${runtime.rounds} 轮；事件=${events.join(",") || "bootstrap/static"}）`);
    const run = (async () => {
      try {
        const outcome = await runPlannerSafe(challengeId, globalDeadline, controller.signal, events);
        if (interrupted || fatalReason) return;
        if (outcome.reportFile) {
          runtime.reportFile = outcome.reportFile;
          runtime.emptyRounds = 0;
          log(`[orchestrator] Challenge #${challengeId} 已生成报告并进入 completed；下一循环释放名额`);
        } else if (outcome.waiting) {
          if (outcome.inserted > 0 || outcome.deleted > 0 || outcome.forceCompleted > 0) runtime.emptyRounds = 0;
          runtime.waiting = true;
        } else if (outcome.inserted > 0 || outcome.deleted > 0 || outcome.forceCompleted > 0) {
          runtime.emptyRounds = 0;
        } else if (runningForChallenge(challengeId) > 0) {
          log(`[orchestrator] Challenge #${challengeId} 增量规划无新任务，等待本题 Worker`);
        } else {
          runtime.emptyRounds++;
          if (runtime.emptyRounds > PLANNER_EMPTY_RETRIES) {
            runtime.failure = "Planner 连续空转或运行失败";
          } else {
            runtime.requested = true;
            log(`[orchestrator] Challenge #${challengeId} Planner 空转 ${runtime.emptyRounds}/${PLANNER_EMPTY_RETRIES}，将重试`);
          }
        }
      } finally {
        runtime.inFlight = false;
        if (plannerControllers.get(challengeId) === controller) plannerControllers.delete(challengeId);
      }
    })();
    plannerRuns.add(run);
    void run.then(() => plannerRuns.delete(run), () => plannerRuns.delete(run));
  };

  const runDueCompactor = async (activeIds: number[]): Promise<boolean> => {
    if (!config.compactorEnabled) return false;
    for (const challengeId of activeIds) {
      const batch = await getDueCompressionBatch(challengeId);
      if (batch.length === 0) continue;
      const key = `${challengeId}:${batch.map((row) => row.task_id).join(",")}`;
      const previous = compactorFailures.get(key);
      if (previous && (previous.count >= COMPACTOR_FAILURE_RETRIES || Date.now() < previous.retryAfter)) continue;
      const controller = new AbortController();
      compactorController = controller;
      try {
        await runCompactor(batch, log, { signal: controller.signal });
        compactorFailures.delete(key);
        return true;
      } catch (e) {
        if (interrupted || fatalReason || controller.signal.aborted) return false;
        const count = (previous?.count ?? 0) + 1;
        const delay = Math.min(60_000, 5_000 * 2 ** (count - 1));
        compactorFailures.set(key, { count, retryAfter: Date.now() + delay });
        log(`[compactor] Challenge #${challengeId} 批次失败 ${count}/${COMPACTOR_FAILURE_RETRIES}: ${(e as Error).message}`);
        return false;
      } finally {
        if (compactorController === controller) compactorController = null;
      }
    }
    return false;
  };

  let loopErrors = 0;
  try {
    while (!interrupted && !fatalReason) {
      if (Date.now() > globalDeadline) {
        fatalReason = "全局超时";
        abortInFlight();
        break;
      }
      try {
        const activated = await activateQueuedChallenges();
        for (const challenge of activated) {
          const runtime = runtimeFor(challenge.challenge_id);
          runtime.requested = true;
          runtime.waiting = false;
          log(`[orchestrator] 激活 Challenge #${challenge.challenge_id} ${challenge.name}（占用一个靶机/Planner 名额）`);
        }
        let challenges = await getChallenges();
        const activeIds = challenges.filter((challenge) => challenge.status === "active").map((challenge) => challenge.challenge_id);

        // 某题规划失败只终止该题；先停止本题新分发，等在途 Worker/Planner 退出后落 failed。
        for (const challengeId of activeIds) {
          const runtime = runtimeFor(challengeId);
          if (runtime.failure && !runtime.inFlight && runningForChallenge(challengeId) === 0) {
            await failChallenge(challengeId, runtime.failure);
            log(`[orchestrator] Challenge #${challengeId} 已 failed: ${runtime.failure}；其他赛题继续`);
          }
        }
        challenges = await getChallenges();
        const stillActiveIds = challenges.filter((challenge) => challenge.status === "active").map((challenge) => challenge.challenge_id);
        const publication = await getContestPublication();
        if (!opts.resumeFromHistory && managerSettled && (!publication || (publication.status === "publishing" && managerFailure))) {
          fatalReason = managerFailure ?? "Manager 未初始化赛事发布状态";
          abortInFlight();
          break;
        }
        const publicationClosed = managerSettled && publication && publication.status !== "publishing";
        if (publicationClosed && challenges.length === 0) {
          fatalReason = publication.error ?? managerFailure ?? "赛事没有任何已发布 Challenge";
          abortInFlight();
          break;
        }
        const unready = await countUnreadyChallenges();

        const allTerminal = challenges.length > 0 && challenges.every((challenge) => ["completed", "skipped", "failed"].includes(challenge.status));
        const anyPlanner = [...runtimes.values()].some((runtime) => runtime.inFlight);
        if (publicationClosed && unready === 0 && allTerminal && runningTasks.size === 0 && !anyPlanner && !compactorController) {
          const summary = await generateContestSummary();
          const hasFailures = summary.failedCount > 0 || summary.publicationFailed;
          return {
            reportFile: summary.file,
            plannerRounds: totalPlannerRounds(),
            reason: summary.publicationFailed
              ? `Challenge 发布状态=${summary.publicationStatus}；已发布赛题全部终态`
              : summary.failedCount > 0
                ? `全部赛题终态，${summary.failedCount} 道 failed`
                : "全部赛题 completed/skipped",
            hasFailures,
          };
        }

        if (await runDueCompactor(stillActiveIds)) continue;
        if (interrupted || fatalReason) break;

        const tasks = await getAllTasks();
        const activeSet = new Set(stillActiveIds);
        for (const task of tasks) {
          if (task.is_complete === 1 && !observedComplete.has(task.task_id)) {
            observedComplete.add(task.task_id);
            if (activeSet.has(task.challenge_id)) {
              const runtime = runtimeFor(task.challenge_id);
              runtime.events.add(task.task_id);
              runtime.requested = true;
              log(`[orchestrator] Challenge #${task.challenge_id} 任务 #${task.task_id} 完成 → 唤醒本题 Planner`);
            }
          }
        }

        const deleted = new Set(await getTaskDeletionRequestedIds());
        const governed = new Set([...deleted, ...await getTaskCompletionRequestedIds()]);
        // 按 Challenge 轮转，每次只从一道题取一个任务，再移动到下一题，避免单题占满 Worker 池。
        while (!interrupted && freeSlots.length > 0 && stillActiveIds.length > 0) {
          let selected: TaskRow | undefined;
          let selectedOrderIndex = -1;
          for (let offset = 0; offset < stillActiveIds.length; offset++) {
            const orderIndex = (fairCursor + offset) % stillActiveIds.length;
            const challengeId = stillActiveIds[orderIndex]!;
            const runtime = runtimeFor(challengeId);
            if (runtime.failure || runtime.reportFile) continue;
            const candidate = tasks.find((task) => task.challenge_id === challengeId && task.is_complete === 0 &&
              !assigned.has(task.task_id) && !governed.has(task.task_id));
            if (candidate) {
              selected = candidate;
              selectedOrderIndex = orderIndex;
              break;
            }
          }
          if (!selected) break;
          fairCursor = (selectedOrderIndex + 1) % stillActiveIds.length;
          const slot = freeSlots.shift()!;
          const handle: RunHandle = {
            taskId: selected.task_id,
            challengeId: selected.challenge_id,
            slot,
            controller: new AbortController(),
            cancel: null,
          };
          assigned.add(selected.task_id);
          runningTasks.set(selected.task_id, handle);
          log(`[orchestrator] 公平分发 Challenge #${selected.challenge_id} 任务 #${selected.task_id} → Worker ${slot}（${runningTasks.size}/${config.workerConcurrency}）`);
          const work = executeTask(selected.task_id, slot, handle);
          handle.promise = work;
          workerRuns.add(work);
          void work.then(() => workerRuns.delete(work), () => workerRuns.delete(work));
        }

        for (const challengeId of stillActiveIds) {
          const runtime = runtimeFor(challengeId);
          if (runtime.failure || runtime.reportFile || runtime.inFlight || !runtime.requested) continue;
          if (runtime.rounds >= MAX_PLANNER_ROUNDS) {
            runtime.failure = `Planner 轮次达到安全阀 ${MAX_PLANNER_ROUNDS}`;
            continue;
          }
          launchPlanner(challengeId);
        }

        // 每题独立静止点兜底；仅在已经不可能产生后续内部事件时解除显式等待。
        for (const challengeId of stillActiveIds) {
          const runtime = runtimeFor(challengeId);
          if (runtime.failure || runtime.reportFile || runtime.inFlight || runtime.requested || runningForChallenge(challengeId) > 0) continue;
          if (await countIncomplete(challengeId) > 0) continue;
          if (!runtime.waiting) {
            runtime.requested = true;
            continue;
          }
          runtime.waiting = false;
          runtime.emptyRounds++;
          if (runtime.emptyRounds > PLANNER_EMPTY_RETRIES) {
            runtime.failure = "Planner 连续空转或在无可等待事件时反复等待";
            continue;
          }
          runtime.requested = true;
          log(`[orchestrator] Challenge #${challengeId} 没有后续内部事件可等待；按静止点唤醒 Planner（连续无事件等待 ${runtime.emptyRounds}/${PLANNER_EMPTY_RETRIES}）`);
        }
        await sleep(config.pollIntervalMs);
        loopErrors = 0;
      } catch (e) {
        loopErrors++;
        if (loopErrors >= LOOP_ERROR_RETRIES) {
          fatalReason = `主循环持续异常: ${(e as Error).message}`;
          abortInFlight();
          break;
        }
        log(`[orchestrator] 轮询异常 ${loopErrors}/${LOOP_ERROR_RETRIES}: ${(e as Error).message}`);
        await sleep(2000);
      }
    }

    abortInFlight();
    const sessionRuns: Promise<unknown>[] = [...workerRuns, ...plannerRuns];
    if (managerPromise) sessionRuns.push(managerPromise);
    await Promise.allSettled(sessionRuns);

    if (interrupted) {
      const active = (await getChallenges()).filter((challenge) => challenge.status === "active");
      log(`[orchestrator] 在途会话已退出，为 ${active.length} 道 active Challenge 生成独立中断报告`);
      const outcomes = await Promise.all(active.map(async (challenge) => {
        try {
          return await runPlanner(challenge.challenge_id, log, { interrupted: true });
        } catch (e) {
          log(`[planner challenge=${challenge.challenge_id}] 中断报告失败: ${(e as Error).message}`);
          return null;
        }
      }));
      const success = outcomes.every((outcome) => outcome?.reportFile);
      if (!success) return { reportFile: null, plannerRounds: totalPlannerRounds(), reason: "至少一道 active Challenge 未生成中断报告", interrupted: true };
      const summary = await generateContestSummary({ interrupted: true });
      return { reportFile: summary.file, plannerRounds: totalPlannerRounds(), reason: "用户 Ctrl+C 主动停止", interrupted: true };
    }

    // 全局/持续性系统失败：中止所有题的执行并记录 active 失败；queued 留作历史诊断。
    if (fatalReason) {
      for (const challenge of await getChallenges()) {
        if (challenge.status === "active") await failChallenge(challenge.challenge_id, fatalReason).catch(() => {});
      }
      return { reportFile: null, plannerRounds: totalPlannerRounds(), reason: fatalReason, hasFailures: true };
    }
    return { reportFile: null, plannerRounds: totalPlannerRounds(), reason: "主循环意外结束", hasFailures: true };
  } finally {
    clearInterval(governanceStopTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

async function runPlannerSafe(
  challengeId: number,
  globalDeadline: number,
  signal: AbortSignal,
  completionEvents: number[]
): Promise<PlannerOutcome> {
  if (Date.now() > globalDeadline || signal.aborted) {
    return { challengeId, inserted: 0, deleted: 0, forceCompleted: 0, waiting: false, reportFile: null };
  }
  try {
    return await runPlanner(challengeId, log, { signal, completionEvents });
  } catch (e) {
    log(signal.aborted ? `[planner challenge=${challengeId}] 已中止` : `[planner challenge=${challengeId}] 运行异常: ${(e as Error).message}`);
    return { challengeId, inserted: 0, deleted: 0, forceCompleted: 0, waiting: false, reportFile: null };
  }
}

process.on("unhandledRejection", (reason) => {
  console.error(`[orchestrator] 未处理的 promise 拒绝（已记录）: ${(reason as Error)?.stack ?? reason}`);
});

function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1_000).unref();
}

main().then(finish, (error) => {
  console.error(`致命错误: ${(error as Error).stack ?? error}`);
  finish(1);
});
