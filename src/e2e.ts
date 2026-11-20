import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type http from "node:http";
import { initSchema, closePool, getChallenges, getAllTasks, pool } from "./db.js";
import { resetRunState, listContinuableHistory } from "./scripts.js";
import { config } from "./config.js";
import { startMock, resetMockObservations, observedPlannerContexts, observedWorkerContexts, observedToolNames } from "./mock/openai-mock.js";

const MODEL = "mock-pentest-model";
const PORT = Number(process.env.MOCK_PORT ?? 8793);
let checks = 0;
function ok(value: unknown, message: string): asserts value { assert.ok(value, message); checks++; }
function equal(actual: unknown, expected: unknown, message: string): void { assert.equal(actual, expected, message); checks++; }

interface RunResult { code: number | null; output: string }
interface RunningChild { child: ChildProcess; done: Promise<RunResult>; output: () => string }

function parseArgs(input: string): string[] {
  const args: string[] = [];
  for (const match of input.matchAll(/"([^"]*)"|(\S+)/g)) args.push(match[1] ?? match[2] ?? "");
  return args;
}

function launch(args: string, scenario: string): RunningChild {
  // mock 与 E2E 驱动同进程，编排器是子进程；显式同步场景供 HTTP decide() 使用。
  process.env.MOCK_SCENARIO = scenario;
  const child = spawn(process.execPath, ["--enable-source-maps", path.join(config.root, "dist", "orchestrator.js"), ...parseArgs(args)], {
    cwd: config.root,
    env: {
      ...process.env,
      PI_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
      PI_API_KEY: "sk-local-mock",
      PI_MODEL_ID: MODEL,
      PI_BASE_URL_MANAGER: `http://127.0.0.1:${PORT}/v1`,
      PI_BASE_URL_PLANNER: `http://127.0.0.1:${PORT}/v1`,
      PI_BASE_URL_WORKER: `http://127.0.0.1:${PORT}/v1`,
      PI_BASE_URL_COMPACTOR: `http://127.0.0.1:${PORT}/v1`,
      PI_MODEL_ID_MANAGER: MODEL,
      PI_MODEL_ID_PLANNER: MODEL,
      PI_MODEL_ID_WORKER: MODEL,
      PI_MODEL_ID_COMPACTOR: MODEL,
      PI_API_KEY_MANAGER: "sk-local-mock",
      PI_API_KEY_PLANNER: "sk-local-mock",
      PI_API_KEY_WORKER: "sk-local-mock",
      PI_API_KEY_COMPACTOR: "sk-local-mock",
      KALI_ENABLED: scenario === "embedded" ? "true" : "false",
      KALI_RUNTIME: scenario === "embedded" ? "embedded" : "container",
      EXTENSIONS_ENABLED: "false",
      EXTENSIONS_MANAGER: "false",
      EXTENSIONS_PLANNER: "false",
      EXTENSIONS_WORKER: "false",
      EXTENSIONS_COMPACTOR: "false",
      CTF_PLANNER_CONCURRENCY: "2",
      WORKER_CONCURRENCY: "3",
      POLL_INTERVAL_MS: "50",
      MANAGER_TIMEOUT_MS: "30000",
      PLANNER_TIMEOUT_MS: "30000",
      WORKER_TIMEOUT_MS: "45000",
      GLOBAL_TIMEOUT_MS: "120000",
      MOCK_SCENARIO: scenario,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += String(data); });
  child.stderr.on("data", (data) => { output += String(data); });
  const done = new Promise<RunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`编排器 E2E 超时\n${output}`));
    }, 150_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
  return { child, done, output: () => output };
}

async function run(args: string, scenario = "normal"): Promise<RunResult> {
  const running = launch(args, scenario);
  const result = await running.done;
  if (process.env.E2E_VERBOSE === "1") console.log(result.output);
  return result;
}

async function waitForOutput(running: RunningChild, pattern: RegExp, count: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const matches = running.output().match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? [];
    if (matches.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  running.child.kill("SIGKILL");
  throw new Error(`等待编排输出超时: ${pattern}\n${running.output()}`);
}

async function main(): Promise<void> {
  await initSchema();
  const server: http.Server = await startMock(PORT);
  try {
    console.log("[e2e] 1. 三道可执行题 + 一道 skipped；N=2 多 Planner 与全局 Worker 池");
    resetMockObservations();
    await resetRunState();
    const normal = await run('--new "mock CTF 整场赛事"');
    if (normal.code !== 0) throw new Error(`正常多题链路失败（exit=${normal.code}）\n${normal.output}`);
    checks++;
    let challenges = await getChallenges();
    equal(challenges.length, 4, "Manager 拆分4题");
    equal(challenges.filter((row) => row.status === "completed").length, 3, "三道可执行题均 completed");
    equal(challenges.filter((row) => row.status === "skipped").length, 1, "信息不足题 skipped");
    equal((await getAllTasks()).length, 6, "每道可执行题2个全局唯一任务");
    equal((await getAllTasks()).filter((row) => row.is_complete === 1).length, 6, "全部任务完成");
    ok(challenges.filter((row) => row.status === "completed").every((row) => row.report_file && fs.existsSync(path.join(config.root, row.report_file))), "每题独立报告存在");
    const plannerTools = observedToolNames(MODEL, "planner");
    for (const required of ["insert_task", "task_delete", "force_complete_task", "wait_for_next_event", "generate_report", "get_fact_detail", "get_finding_detail"]) {
      ok(plannerTools.includes(required), `Planner 工具 ${required}`);
    }
    for (const forbidden of ["bash", "read", "kali_bash", "mcp", "planner_append", "get_monitor_snapshot"]) {
      ok(!plannerTools.includes(forbidden), `Planner 不得暴露 ${forbidden}`);
    }
    const workerTools = observedToolNames(MODEL, "worker");
    ok(workerTools.includes("bash") && !workerTools.includes("kali_bash"), "KALI_ENABLED=false 时 Worker 仅用宿主机 bash");
    const plannerContexts = observedPlannerContexts();
    ok(plannerContexts.some((text) => text.includes("Alpha")) && plannerContexts.some((text) => text.includes("Beta")) && plannerContexts.some((text) => text.includes("Gamma")), "三道题都实际创建 Planner");
    ok(!plannerContexts.some((text) => text.includes("Challenge #4（Insufficient）")), "skipped 不创建 Planner");
    const workerContexts = observedWorkerContexts();
    for (const context of workerContexts) {
      const own = context.match(/你只执行 Challenge #(\d+)/)?.[1];
      ok(own, "Worker 消息含绑定 Challenge");
      const snapshotEnd = context.indexOf("TASK_SNAPSHOT>>>");
      const currentTask = context.indexOf("任务内容:");
      ok(snapshotEnd >= 0 && currentTask > snapshotEnd, "Worker 当前任务描述位于历史快照之后");
      for (const other of ["1", "2", "3"].filter((id) => id !== own)) {
        ok(!context.includes(`Challenge #${other} 的任务`), "Worker 不含其他题任务分配");
      }
    }
    for (const task of await getAllTasks()) {
      ok(fs.existsSync(path.join(config.workspacesDir, `task-${task.task_id}`, ".mock-worker-ok")), `任务 #${task.task_id} 工作区真实写入`);
    }
    const normalHistory = listContinuableHistory()[0];
    ok(normalHistory?.file.includes("param-contest-"), "退出导出 v2 目录历史");
    const manifestRaw = fs.readFileSync(path.join(normalHistory!.file, "manifest.json"), "utf8");
    ok(!manifestRaw.includes("TASK-1-FINDING"), "manifest 不含任务正文");

    console.log("[e2e] 1b. Manager 分批发布时，首批 Planner/Worker 已并行执行");
    await resetRunState();
    const incrementalRun = launch('--new "mock incremental 赛事"', "incremental");
    await waitForOutput(incrementalRun, /领取任务/, 1);
    const earlyChallenges = await getChallenges();
    equal(earlyChallenges.length, 1, "后续批次尚未发布时首批 Challenge 已启动 Worker");
    ok(!incrementalRun.output().includes("finish_challenge_publication"), "首批执行发生在 finish_challenge_publication 之前");
    ok(!incrementalRun.output().includes("整场赛事结束"), "发布未收尾时不得提前生成整场终态汇总");
    const incremental = await incrementalRun.done;
    if (incremental.code !== 0) throw new Error(`增量发布流水线失败\n${incremental.output}`);
    checks++;
    equal((await getChallenges()).length, 4, "后续批次最终全部发布");
    equal((await getAllTasks()).filter((task) => task.is_complete === 1).length, 6, "增量发布的全部可执行题均完成");

    console.log("[e2e] 1c. 最后完成事件后 wait_for_next_event：静止点恢复并激活 queued 题");
    await resetRunState();
    resetMockObservations();
    const noEvents = await run('--new "mock wait-no-events 赛事"', "wait-no-events");
    if (noEvents.code !== 0) throw new Error(`无后续事件等待恢复失败（exit=${noEvents.code}）\n${noEvents.output}`);
    checks++;
    const noEventChallenges = await getChallenges();
    equal(noEventChallenges.filter((row) => row.status === "completed").length, 3, "三道可执行题均从无效等待恢复并 completed");
    const noEventTasks = await getAllTasks();
    equal(noEventTasks.length, 6, "无事件等待场景每道可执行题2个任务");
    ok(noEventTasks.every((task) => task.is_complete === 1), "无事件等待场景全部任务完成");
    equal((noEvents.output.match(/没有后续内部事件可等待；按静止点唤醒 Planner/g) ?? []).length, 3, "三道题均记录无事件等待的静止点恢复");
    ok(observedPlannerContexts().some((text) => text.includes("（Gamma）")), "前两题释放 active 名额后第三道 queued 题实际创建 Planner");

    if (process.env.E2E_EMBEDDED === "1") {
      console.log("[e2e] 2. All-in-One embedded：kali_bash 本地执行、实际 cwd 与 /wordlists");
      await resetRunState();
      const embedded = await run('--new "mock embedded 整场赛事"', "embedded");
      if (embedded.code !== 0) throw new Error(`embedded 多题链路失败（exit=${embedded.code}）\n${embedded.output}`);
      checks++;
      ok(!embedded.output.includes("docker exec") && !embedded.output.includes("创建容器"), "embedded 不得进入 Docker 容器后端");
      ok(observedToolNames(MODEL, "worker").includes("kali_bash"), "embedded Worker 暴露 kali_bash");
      for (const task of await getAllTasks()) {
        const workspace = path.join(config.workspacesDir, `task-${task.task_id}`);
        equal(fs.readFileSync(path.join(workspace, ".mock-kali-ok"), "utf8"), workspace, `任务 #${task.task_id} kali_bash cwd 必须是实际输出工作区`);
      }
      ok(embedded.output.includes("Kali embedded runtime ready"), "embedded 启动只做本地环境校验");
    }

    console.log("[e2e] 3. Worker 未收尾由编排器强制补完成，单题仍可终态");

    await resetRunState();
    const forced = await run('--new "mock force-complete 赛事"', "force");
    if (forced.code !== 0) throw new Error(`异常补完成链路失败\n${forced.output}`);
    checks++;
    const forcedTasks = await getAllTasks();
    equal(forcedTasks.filter((task) => task.finding?.includes("worker 结束但未调用 complete_task")).length, 3, "每题异常任务均强制补完成");
    equal((await getChallenges()).filter((row) => row.status === "completed").length, 3, "强制补完成后各题正常报告");

    console.log("[e2e] 3b. Planner 强制停止在途 Worker，保留证据且不补异常 finding");
    await resetRunState();
    resetMockObservations();
    const governed = await run('--new "mock planner complete-task 赛事"', "complete-task");
    if (governed.code !== 0) throw new Error(`Planner 强制完成链路失败\n${governed.output}`);
    checks++;
    const governedTasks = await getAllTasks();
    equal(governedTasks.length, 3, "强制完成场景包含一个触发任务和两个长扫描任务");
    const governedWorkerIds = new Set(observedWorkerContexts().map((context) => context.match(/你只执行 Challenge #\d+ 的任务 #(\d+)/)?.[1]).filter(Boolean));
    equal(governedWorkerIds.size, 3, "三个任务均真实启动 Worker");
    ok(governedTasks.every((task) => task.is_complete === 1), "强制完成后全部任务完成");
    const longTasks = governedTasks.filter((task) => /TASK-[23]/.test(task.task));
    equal(longTasks.length, 2, "两个长扫描任务由 Planner 同轮强制完成");
    ok(governed.output.includes("tools=force_complete_task,force_complete_task,wait_for_next_event"), "force_complete_task 可与其他 Planner 决策同批调用");
    for (const task of longTasks) {
      ok(task.fact?.includes("FACT") && task.finding?.includes("mock 验证完成"), `任务 #${task.task_id} 保留 Worker 已写入的 fact/finding`);
      ok(!task.finding?.includes("任务执行异常"), `任务 #${task.task_id} 不得追加异常 finding`);
    }
    equal((governed.output.match(/强制完成请求已停止 Worker/g) ?? []).length, 2, "编排器实际按 complete 类型中止两个在途 Worker");
    equal((await getChallenges()).filter((row) => row.status === "completed").length, 1, "强制完成后正常生成单题终态报告");
    for (const task of longTasks) {
      const workspace = path.join(config.workspacesDir, `task-${task.task_id}`);
      equal(fs.existsSync(path.join(workspace, ".mock-scan-finished")), false, `任务 #${task.task_id} 停止时旧扫描尚未写入完成标记`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    for (const task of longTasks) {
      const workspace = path.join(config.workspacesDir, `task-${task.task_id}`);
      equal(fs.existsSync(path.join(workspace, ".mock-scan-finished")), false, `任务 #${task.task_id} 超过旧扫描原定结束时间后仍无迟到写入`);
    }

    console.log("[e2e] 4. Manager 遗漏发布收尾：已发布题完成，但整场退出1");
    await resetRunState();
    const noFinish = await run('--new "mock no finish"', "manager-no-finish");
    equal(noFinish.code, 1, "缺少 finish_challenge_publication 时整场退出1");
    ok(noFinish.output.includes("发布异常") && noFinish.output.includes("发布状态=failed"), "明确记录发布失败状态");
    equal((await getChallenges()).length, 4, "发布收尾失败不删除已发布 Challenge");
    equal((await getAllTasks()).filter((task) => task.is_complete === 1).length, 6, "已发布赛题在发布失败后仍继续完成");

    console.log("[e2e] 5. Ctrl+C 各 active 题中断报告 + 分题历史续跑");
    await resetRunState();
    const interruptedRun = launch('--new "mock Ctrl+C 赛事"', "ctrl-c");
    await waitForOutput(interruptedRun, /领取任务/, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    interruptedRun.child.kill("SIGINT");
    const interrupted = await interruptedRun.done;
    if (interrupted.code !== 130) throw new Error(`Ctrl+C 应退出130\n${interrupted.output}`);
    checks++;
    challenges = await getChallenges();
    equal(challenges.filter((row) => row.status === "active").length, 2, "中断后两道 active 保持可续跑");
    equal(challenges.filter((row) => row.status === "queued").length, 1, "第三题仍 queued");
    for (const challenge of challenges.filter((row) => row.status === "active")) {
      ok(challenge.report_file && fs.readFileSync(path.join(config.root, challenge.report_file), "utf8").includes("阶段性中断报告"), `Challenge #${challenge.challenge_id} 中断报告`);
    }
    const interruptedHistory = listContinuableHistory()[0]?.file;
    ok(interruptedHistory, "中断导出可续跑目录历史");

    const resumed = await run(`--continue "${interruptedHistory}"`, "normal");
    if (resumed.code !== 0) throw new Error(`历史续跑失败\n${resumed.output}`);
    checks++;
    ok(!resumed.output.includes("[manager]"), "续跑跳过 Manager");
    challenges = await getChallenges();
    equal(challenges.filter((row) => row.status === "completed").length, 3, "续跑完成原 active 与 queued 题");
    equal((await getAllTasks()).every((task) => task.is_complete === 1), true, "续跑后全部任务完成");

    const sequence = await pool.query<{ next: number }>(
      "SELECT COALESCE(MAX(challenge_id),0)+1::int AS next FROM challenge"
    );
    ok((sequence.rows[0]?.next ?? 0) > 4, "Challenge identity 高水位恢复有效");

    console.log("[e2e] 6. SIGTERM 与 Ctrl+C 共用优雅中断收尾");
    await resetRunState();
    const terminatedRun = launch('--new "mock SIGTERM 赛事"', "ctrl-c");
    await waitForOutput(terminatedRun, /领取任务/, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    terminatedRun.child.kill("SIGTERM");
    const terminated = await terminatedRun.done;
    equal(terminated.code, 130, "SIGTERM 应完成中断报告后退出130");
    ok(terminated.output.includes("收到 SIGTERM"), "日志明确记录 SIGTERM");
    ok((await getChallenges()).filter((row) => row.status === "active").every((row) => row.report_file), "SIGTERM 为 active 题生成中断报告");

    console.log(`\nE2E OK · ${checks} assertions/scenarios`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  }
}

main().catch((error) => {
  console.error(`E2E FAILED: ${(error as Error).stack ?? error}`);
  process.exitCode = 1;
});
