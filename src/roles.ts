import fs from "node:fs";
import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createFreshAgent, promptWithTimeout } from "./agent-factory.js";
import { makeManagerTools, makePlannerTools, makeWorkerTools, makeKaliBashTool, makeCompactorTools } from "./tools.js";
import {
  prepareManagerPrompt,
  renderTaskSnapshot,
  COMPACTOR_TIMEOUT_ONLY_FINDING,
  assertCompressionBatch,
  type CompressionTaskRow,
} from "./scripts.js";
import { getGoal, getContestPublication, countIncomplete, getAllTasks, getChallenge, getChallenges, type TaskRow } from "./db.js";
import { config, extensionsForRole } from "./config.js";
import type { KaliEnvInfo } from "./kali.js";

export interface ManagerOutcome {
  challengeCount: number;
}

/** Manager 增量发布赛题；编排器可同时消费已就绪批次。 */
export async function runManager(
  userInput: string,
  log: (s: string) => void,
  opts: { signal?: AbortSignal } = {}
): Promise<ManagerOutcome> {
  let session: AgentSession | undefined;
  try {
    prepareManagerPrompt();
    const manager = makeManagerTools();
    session = await createFreshAgent("manager", [...manager.tools], {
      builtinTools: true,
      excludeTools: ["edit", "write"],
      extensions: extensionsForRole("manager"),
    });
    log(`[manager] 开始拆分赛事输入（${userInput.length} 字）`);
    const reply = await promptWithTimeout(
      session,
      [
        "用户原始输入如下。若明确指向本地文件或远程任务页，先按系统提示用 read/bash 获取资料。",
        "把输入拆成 contest 与 Challenge。每道信息充足的赛题必须有独立 asset/goal；信息不足的赛题填写 skip_reason，让其自动 skipped，不要阻塞其他赛题。",
        "先调用一次 start_contest。随后信息完整一批就调用 publish_challenges 发布一批（每批1～4道），不要等待已发布赛题执行完成，也不要自行决定 challenge_id、active 状态或激活顺序。",
        "全部批次发布成功后必须调用 finish_challenge_publication；该工具只结束发布，不会等待或结束各题执行。",
        "",
        "<<<USER_INPUT",
        userInput,
        "USER_INPUT>>>",
      ].join("\n"),
      config.managerTimeoutMs,
      (line) => log(`[manager]${line}`),
      opts.signal
    );
    const goal = await getGoal();
    const publication = await getContestPublication();
    const challenges = await getChallenges();
    if (!manager.started() || !manager.finalized() || publication?.status !== "finalized" || !goal || challenges.length === 0) {
      throw new Error(`Manager 未完成 contest 初始化与 Challenge 发布收尾。模型回复: ${reply.slice(0, 300) || "（无）"}`);
    }
    log(`[manager] 完成：${challenges.length} 道 Challenge（queued=${challenges.filter((row) => row.status === "queued").length}, skipped=${challenges.filter((row) => row.status === "skipped").length}）`);
    return { challengeCount: challenges.length };
  } finally {
    try { session?.dispose(); } catch { /* ignore */ }
  }
}

export interface PlannerOutcome {
  challengeId: number;
  inserted: number;
  deleted: number;
  forceCompleted: number;
  waiting: boolean;
  reportFile: string | null;
}

export interface PlannerRunOptions {
  signal?: AbortSignal;
  interrupted?: boolean;
  /** 仅本题新完成的全局 task_id；不包含其他 Challenge 的事件。 */
  completionEvents?: number[];
}

/** 每轮都是全新 in-memory Planner；内置工具仅含本题固定工具，扩展/MCP 由角色开关控制。 */
export async function runPlanner(
  challengeId: number,
  log: (s: string) => void,
  opts: PlannerRunOptions = {}
): Promise<PlannerOutcome> {
  let session: AgentSession | undefined;
  const tag = `[planner challenge=${challengeId}]`;
  try {
    const challenge = await getChallenge(challengeId);
    if (!challenge || challenge.status !== "active") throw new Error(`Challenge #${challengeId} 不是 active，不能创建 Planner`);
    const before = await getAllTasks(challengeId);
    const incompleteBefore = await countIncomplete(challengeId);
    const snapshot = await renderTaskSnapshot(challengeId, "planner");
    const planner = makePlannerTools(challengeId, { interrupted: opts.interrupted });
    session = await createFreshAgent("planner", [...planner.tools], {
      challengeId,
      builtinTools: false,
      extensions: extensionsForRole("planner"),
      skills: false,
    });
    log(`${tag} 触发（全新实例${opts.interrupted ? "，中断总结" : ""}）。本题 ${before.length} 个任务，${incompleteBefore} 个未完成`);
    const events = opts.completionEvents ?? [];
    const reply = await promptWithTimeout(
      session,
      [
        `当前只处理 Challenge #${challengeId}（${challenge.name}）。不得规划、查询或引用其他赛题。`,
        "",
        "本题 task 全量快照（含已完成任务，供查重与增量规划）：",
        "<<<TASK_SNAPSHOT",
        snapshot,
        "TASK_SNAPSHOT>>>",
        "",
        `本题待处理内部完成事件: ${events.length ? events.map((id) => `#${id}`).join(", ") : "（无；本次为激活/静止点/中断触发）"}`,
        "",
        ...(opts.interrupted
          ? [
              "<<<INTERRUPTED_SHUTDOWN",
              "用户已通过 Ctrl+C/SIGTERM 停止整场编排。在途 Planner/Worker 已退出，本快照是退出后的状态。",
              "INTERRUPTED_SHUTDOWN>>>",
              "只调用 generate_report 生成本题阶段性报告；如实保留未完成任务，不宣称 goal 达成。",
            ]
          : [
              "你的内置能力只有绑定本题的固定工具，没有通用 read/bash、Kali 或其他赛题查询接口。若已启用 MCP，只能查询当前 Challenge 直接相关的只读信息；实际探测通过 insert_task 交给 Worker。",
              "请决策：insert_task 发布本题任务；task_delete 删除本题空未完成任务；force_complete_task(task_id) 可在必要时停止 Worker 并强制完成本题指定任务，但这只改变状态、不代表执行成功，且可与其他 Planner 决策同轮使用；wait_for_next_event 等待本题内部事件；goal 达成且无未完成任务时 generate_report 只结束本题。",
              "强制完成必须保留已有 fact/finding，不得补造执行结果。若本题已解题成功，在赛事授权允许实例管理操作的前提下，generate_report 前必须安排并确认 Worker 通过赛事平台接口停止本题实例；停止失败须留有真实 finding。",
              "快照中的单条 fact/finding 可分别用 get_fact_detail/get_finding_detail 回查本题详情。",
            ]),
      ].join("\n"),
      config.plannerTimeoutMs,
      (line) => log(`${tag}${line}`),
      opts.signal
    );
    if (reply) log(`${tag} 决策说明: ${reply.slice(0, 300)}`);
    const after = await getAllTasks(challengeId);
    const deleted = planner.deleted();
    const inserted = after.length - before.length + deleted;
    const reportFile = planner.reportFile();
    if (reportFile && (inserted > 0 || planner.inserted() > 0 || planner.waiting())) {
      throw new Error("Planner 同轮混用了报告与发布/等待决策");
    }
    if (opts.interrupted && !reportFile) throw new Error(`Challenge #${challengeId} 中断 Planner 未生成报告`);
    return { challengeId, inserted, deleted, forceCompleted: planner.forceCompleted(), waiting: planner.waiting(), reportFile };
  } finally {
    try { session?.dispose(); } catch { /* ignore */ }
  }
}

export async function runCompactor(
  batch: CompressionTaskRow[],
  log: (s: string) => void,
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  let session: AgentSession | undefined;
  assertCompressionBatch(batch);
  const challengeId = batch[0]!.challenge_id;
  const first = batch[0]!.task_id;
  const last = batch.at(-1)!.task_id;
  const tag = `[compactor challenge=${challengeId}]`;
  try {
    const compactor = makeCompactorTools(batch);
    session = await createFreshAgent("compactor", compactor.tools, { extensions: extensionsForRole("compactor"), skills: false });
    const input = batch.map((row) => ({ task_id: row.task_id, task: row.task, finding: row.finding }));
    log(`${tag} 开始压缩任务 #${first}～#${last}`);
    const reply = await promptWithTimeout(
      session,
      [
        `只压缩 Challenge #${challengeId} 的以下10个任务，保持 task_id 与 finding 数量/顺序。`,
        "task 摘要非空且≤30字符；每条 finding 摘要≤100字符、本题内唯一且不自行添加方括号。",
        `纯超时 finding ${COMPACTOR_TIMEOUT_ONLY_FINDING} 由固定脚本清空；仍需提交合法 item。`,
        "必须且只能成功调用一次 compress_task_batch。",
        "<<<TASK_COMPRESSION_INPUT",
        JSON.stringify(input, null, 2),
        "TASK_COMPRESSION_INPUT>>>",
      ].join("\n"),
      config.compactorTimeoutMs,
      (line) => log(`${tag}${line}`),
      opts.signal
    );
    if (!compactor.compressed()) throw new Error(`Compactor 未成功提交批次: ${reply.slice(0, 300) || "（无）"}`);
    log(`${tag} 任务 #${first}～#${last} 压缩完成`);
  } finally {
    try { session?.dispose(); } catch { /* ignore */ }
  }
}

export async function runWorker(
  task: TaskRow,
  slot: number,
  log: (s: string) => void,
  kaliEnv?: KaliEnvInfo,
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  let session: AgentSession | undefined;
  const challengeId = task.challenge_id;
  const tag = `[worker-${slot} challenge=${challengeId} task_id=${task.task_id}]`;
  const useKali = config.kali.enabled;
  const hostWorkspace = path.join(config.workspacesDir, `task-${task.task_id}`);
  const kaliWorkspace = config.kali.runtime === "embedded" ? hostWorkspace : `/work/task-${task.task_id}`;
  const runtimeLabel = config.kali.runtime === "embedded" ? "本容器 Kali" : "共享 Kali 容器";
  fs.mkdirSync(hostWorkspace, { recursive: true });
  const mcp = path.join(config.root, ".mcp.json");
  if (fs.existsSync(mcp)) fs.copyFileSync(mcp, path.join(hostWorkspace, ".mcp.json"));
  try {
    const snapshot = await renderTaskSnapshot(challengeId, "worker");
    const tools = [
      ...makeWorkerTools(challengeId, task.task_id),
      ...(useKali ? [makeKaliBashTool(kaliWorkspace)] : []),
    ];
    session = await createFreshAgent("worker", tools, {
      builtinTools: true,
      cwd: hostWorkspace,
      excludeTools: [],
      extensions: extensionsForRole("worker"),
      challengeId,
    });
    log(`${tag} 领取任务（工作目录 ${hostWorkspace}${useKali ? `，${runtimeLabel} ${kaliWorkspace}` : ""}）`);
    const reply = await promptWithTimeout(
      session,
      [
        `专属工作目录: ${hostWorkspace}${useKali ? `（${runtimeLabel} ${kaliWorkspace}）` : ""}`,
        ...(useKali
          ? [
              `${runtimeLabel}实际工具: ${kaliEnv?.toolLine || "以执行环境实测为准"}`,
              "共享字典:",
              kaliEnv?.wordlistBlock || "/wordlists",
            ]
          : ["Kali 未启用，shell 使用宿主机 bash。"]),
        "本题历史快照（仅本题 task_id/fact/finding，不含其他任务描述、note、完成状态或其他赛题）：",
        "<<<TASK_SNAPSHOT",
        snapshot,
        "TASK_SNAPSHOT>>>",
        "",
        `你只执行 Challenge #${challengeId} 的任务 #${task.task_id}：`,
        `任务内容: ${task.task}`,
        "开始执行。write_fact/write_finding/complete_task 均已绑定当前 Challenge 和任务。最后必须 complete_task。",
        "若当前任务已实质解题成功，在赛事授权允许实例管理操作的前提下，写入证据后必须再通过赛事平台接口停止本题实例，然后 complete_task；不得停止其他实例，失败须如实 write_finding。",
      ].join("\n"),
      config.workerTimeoutMs,
      (line) => log(`${tag}${line}`),
      opts.signal
    );
    log(`${tag} 运行结束${reply ? `: ${reply.slice(0, 200)}` : ""}`);
  } finally {
    try { session?.dispose(); } catch { /* ignore */ }
  }
}
