import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pool, initSchema, closePool, getChallenges, getChallenge, getAllTasks, getTask, getContestPublication, countUnreadyChallenges, type ChallengeRow } from "./db.js";
import {
  resetRunState,
  saveContestChallenges,
  startContest,
  publishChallengeBatch,
  finishChallengePublication,
  failContestPublication,
  activateQueuedChallenges,
  injectPrompts,
  assertInjectedPromptsCurrent,
  readGeneratedPrompt,
  insertTask,
  writeFact,
  writeFinding,
  getFactDetail,
  getFindingDetail,
  completeTask,
  completeTaskByRequester,
  forceComplete,
  deleteTask,
  acquireTaskExecutionLock,
  releaseTaskExecutionLock,
  getTaskCompletionRequestedIds,
  getPendingTaskCompletionStopIds,
  markTaskCompletionStopped,
  getTaskDeletionRequestedIds,
  getPendingTaskDeletionStopIds,
  markTaskDeletionStopped,
  getTaskForExecution,
  renderTaskSnapshot,
  generateReport,
  generateContestSummary,
  exportDatabaseHistory,
  restoreDatabaseHistory,
  compressTaskBatch,
  assertCompressionBatch,
  getDueCompressionBatch,
  COMPACTOR_FIRST_TRIGGER,
  COMPACTOR_RETAIN_TASKS,
  COMPACTOR_BATCH_SIZE,
  type CompressionTaskRow,
} from "./scripts.js";
import { makePlannerTools, makeWorkerTools, makeManagerTools } from "./tools.js";
import { config } from "./config.js";

let assertions = 0;
function ok(value: unknown, message: string): asserts value {
  assert.ok(value, message);
  assertions++;
}
function equal(actual: unknown, expected: unknown, message: string): void {
  assert.equal(actual, expected, message);
  assertions++;
}
async function rejects(action: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  await assert.rejects(action, pattern, message);
  assertions++;
}

async function setupContest(names = ["A", "B", "C"]): Promise<ChallengeRow[]> {
  await resetRunState();
  const saved = await saveContestChallenges({
    contest: { asset: "contest.scope", customization: "COMMON-RULE-$&", goal: "完成整场 CTF" },
    challenges: names.map((name) => ({
      name,
      asset: `${name.toLowerCase()}.ctf.test`,
      customization: `${name}-OWN-RULE`,
      goal: `${name}-GOAL-UNIQUE`,
    })),
  });
  await injectPrompts();
  return saved.challenges;
}

async function main(): Promise<void> {
  await initSchema();
  config.ctfPlannerConcurrency = 2;
  try {
    console.log("[selftest] 1. Challenge 创建、输入校验与激活上限");
    await resetRunState();
    const legacyTables = await pool.query<{ planner_append: string | null; halt_request: string | null }>(
      "SELECT to_regclass('public.planner_append')::text AS planner_append, to_regclass('public.halt_request')::text AS halt_request"
    );
    equal(legacyTables.rows[0]?.planner_append, null, "planner_append 必须移除");
    equal(legacyTables.rows[0]?.halt_request, null, "halt_request 必须移除");
    const saved = await saveContestChallenges({
      contest: { asset: "contest.scope", customization: "COMMON-RULE-$&", goal: "完成整场 CTF" },
      challenges: [
        { name: "A", asset: "a.ctf.test", customization: "A-OWN-RULE", goal: "A-GOAL-UNIQUE" },
        { name: "B", asset: "b.ctf.test", customization: "B-OWN-RULE", goal: "B-GOAL-UNIQUE" },
        { name: "C", asset: "", goal: "", skip_reason: "缺少靶机信息" },
        { name: "D", asset: "d.ctf.test", goal: "D-GOAL-UNIQUE" },
      ],
    });
    equal(saved.challenges.length, 4, "应保存4题");
    equal(saved.challenges[0]?.status, "queued", "Manager 创建普通题为 queued");
    equal(saved.challenges[2]?.status, "skipped", "信息不足题为 skipped");
    ok(saved.challenges[0]?.customization.includes("COMMON-RULE-$&") && saved.challenges[0].customization.includes("A-OWN-RULE"), "通用与每题约束应合并且 $& 按字面保留");
    const activated = await activateQueuedChallenges();
    equal(activated.map((row) => row.name).join(","), "A,B", "N=2 只激活 A/B");
    let challenges = await getChallenges();
    equal(challenges.find((row) => row.name === "D")?.status, "queued", "D 保持 queued");
    equal(challenges.filter((row) => row.status === "active").length, 2, "active 不超过 N");
    const a = challenges.find((row) => row.name === "A")!;
    const b = challenges.find((row) => row.name === "B")!;
    const d = challenges.find((row) => row.name === "D")!;

    console.log("[selftest] 2. 逐题提示词与工具参数隔离");
    const prompts = await injectPrompts();
    equal(prompts.challenges.length, 4, "每题都生成提示词");
    await assertInjectedPromptsCurrent();
    const aPlanner = readGeneratedPrompt("planner", a.challenge_id);
    const aWorker = readGeneratedPrompt("worker", a.challenge_id);
    ok(aPlanner.includes("A-GOAL-UNIQUE") && !aPlanner.includes("B-GOAL-UNIQUE"), "Planner 只含本题 goal");
    ok(!aPlanner.includes("a.ctf.test"), "Planner 不注入 asset");
    ok(aPlanner.includes(`不超过 ${config.insertTaskMaxChars} 字符`) &&
       aPlanner.includes(`不超过 ${config.insertTaskMaxNoteChars} 字符`) &&
       !aPlanner.includes("{{MAX"), "Planner 任务长度应渲染为配置值且不残留占位符");
    ok(aWorker.includes("a.ctf.test") && !aWorker.includes("b.ctf.test"), "Worker 只含本题 asset");
    ok(!aWorker.includes("A-GOAL-UNIQUE"), "Worker 不注入 goal 正文");
    for (const tool of [...makePlannerTools(a.challenge_id).tools, ...makeWorkerTools(a.challenge_id, 1)]) {
      ok(!JSON.stringify(tool.parameters).includes('"challenge_id"'), `${tool.name} schema 不得接受 challenge_id`);
    }
    const plannerToolset = makePlannerTools(a.challenge_id);
    const plannerToolNames = plannerToolset.tools.map((tool) => tool.name);
    ok(plannerToolNames.includes("force_complete_task"), "Planner 必须暴露带 task_id 的 force_complete_task");
    ok(!plannerToolNames.includes("complete_task"), "Planner 不与 Worker 共用普通 complete_task 工具名");
    const forceCompleteTool = plannerToolset.tools.find((tool) => tool.name === "force_complete_task")!;
    ok(JSON.stringify(forceCompleteTool.parameters).includes('"task_id"'), "Planner force_complete_task schema 必须包含 task_id");
    equal(forceCompleteTool.executionMode, "sequential", "force_complete_task 与同批其他 Planner 决策按声明顺序执行");
    const workerComplete = makeWorkerTools(a.challenge_id, 1).find((tool) => tool.name === "complete_task")!;
    ok(!JSON.stringify(workerComplete.parameters).includes('"task_id"'), "Worker complete_task 仍不得接受 task_id");
    ok(!makePlannerTools(a.challenge_id, { interrupted: true }).tools.some((tool) => tool.name === "force_complete_task"), "中断收尾 Planner 不得暴露 force_complete_task");
    ok(aPlanner.includes("force_complete_task(task_id)") && aPlanner.includes("强制完成会保留已有 fact/finding") && aPlanner.includes("不与 Planner 其他决策工具互斥") && aPlanner.includes("停止本题对应实例"), "Planner 提示词包含强制完成边界、非互斥语义与实例停止要求");
    ok(aWorker.includes("停止本题对应实例") && aWorker.includes("不能代替 `complete_task()`"), "Worker 提示词强调解题成功后停止本题实例");
    const managerToolNames = makeManagerTools().tools.map((tool) => tool.name);
    equal(managerToolNames.join(","), "start_contest,publish_challenges,finish_challenge_publication", "Manager 使用增量发布与明确收尾工具");

    console.log("[selftest] 3. 任务、Worker 快照和详情复合键隔离");
    const aTask = await insertTask(a.challenge_id, "A-TASK-UNIQUE", "A-NOTE-UNIQUE");
    const bTask = await insertTask(b.challenge_id, "B-TASK-UNIQUE", "B-NOTE-UNIQUE");
    await rejects(() => insertTask(d.challenge_id, "QUEUED-NOT-ALLOWED", "x"), /不是 active/, "queued 不能发布任务");
    await rejects(() => writeFact(b.challenge_id, aTask.task_id, "CROSS", "x"), /不存在/, "不能跨题写 fact");
    await writeFact(a.challenge_id, aTask.task_id, "SHARED-FACT", "A-FACT-DETAIL");
    await writeFact(b.challenge_id, bTask.task_id, "SHARED-FACT", "B-FACT-DETAIL");
    equal(await getFactDetail(a.challenge_id, "[SHARED-FACT]"), "A-FACT-DETAIL", "相同 fact 摘要按 A 查询");
    equal(await getFactDetail(b.challenge_id, "SHARED-FACT"), "B-FACT-DETAIL", "相同 fact 摘要按 B 查询");
    await writeFinding(a.challenge_id, aTask.task_id, "A-FINDING-UNIQUE");
    await writeFinding(b.challenge_id, bTask.task_id, "B-FINDING-UNIQUE");
    const aPlannerSnapshot = await renderTaskSnapshot(a.challenge_id, "planner");
    const aWorkerSnapshot = await renderTaskSnapshot(a.challenge_id, "worker");
    ok(aPlannerSnapshot.includes("A-TASK-UNIQUE") && !aPlannerSnapshot.includes("B-TASK-UNIQUE"), "Planner 快照不含其他题 task");
    ok(aPlannerSnapshot.includes("A-FINDING-UNIQUE") && !aPlannerSnapshot.includes("B-FINDING-UNIQUE"), "Planner 快照不含其他题 finding");
    ok(!aWorkerSnapshot.includes("A-TASK-UNIQUE") && !aWorkerSnapshot.includes("A-NOTE-UNIQUE"), "Worker 快照仍裁剪 task/note");
    ok(aWorkerSnapshot.includes("SHARED-FACT") && !aWorkerSnapshot.includes("B-FINDING-UNIQUE"), "Worker 快照只含本题历史");
    ok((await getFindingDetail(a.challenge_id, "A-FINDING-UNIQUE")).includes("详细版本"), "未压缩 finding 返回详细版本提示");
    await rejects(() => getFactDetail(a.challenge_id, "B-ONLY"), /本题未找到/, "详情查询不能全局回退");

    console.log("[selftest] 4. task_delete 边界、全局 ID 高水位与并发分配");
    await rejects(() => deleteTask(a.challenge_id, bTask.task_id), /不存在/, "不能跨题删除任务");
    await rejects(() => deleteTask(a.challenge_id, aTask.task_id), /fact/, "有 fact 的任务不能删除");
    const empty = await insertTask(a.challenge_id, "EMPTY-DELETE", "临时任务");
    await deleteTask(a.challenge_id, empty.task_id);
    equal(await getTask(empty.task_id), null, "空未完成任务可删除");
    const concurrent = await Promise.all(Array.from({ length: 10 }, (_, i) => insertTask(a.challenge_id, `CONCURRENT-${i}`, "并发ID测试")));
    equal(new Set(concurrent.map((row) => row.task_id)).size, 10, "并发 task_id 不重复");
    ok(Math.min(...concurrent.map((row) => row.task_id)) > empty.task_id, "删除最大任务后也不复用 ID");

    console.log("[selftest] 4b. Planner 强制完成、幂等、互斥与 Worker 执行锁协作");
    const direct = await insertTask(a.challenge_id, "FORCE-DIRECT", "无 Worker 直接强制完成");
    await writeFinding(a.challenge_id, direct.task_id, "FORCE-DIRECT-ORIGINAL");
    const directResult = await completeTaskByRequester(a.challenge_id, direct.task_id, "planner");
    equal(directResult.stoppedWorker, false, "无 Worker 时无需停止");
    equal(directResult.alreadyComplete, false, "首次强制完成是实际状态变更");
    equal((await getTask(direct.task_id))?.finding, "[FORCE-DIRECT-ORIGINAL]", "强制完成保留原 finding");
    const idempotent = await completeTaskByRequester(a.challenge_id, direct.task_id, "planner");
    equal(idempotent.alreadyComplete, true, "已完成任务幂等返回");
    equal((await getTask(direct.task_id))?.finding, "[FORCE-DIRECT-ORIGINAL]", "幂等完成不改写 finding");
    await rejects(() => completeTaskByRequester(b.challenge_id, direct.task_id, "planner"), /不存在/, "不能跨题强制完成");
    await rejects(() => completeTaskByRequester(a.challenge_id, 999999, "planner"), /不存在/, "不存在任务必须拒绝");
    await rejects(
      () => completeTaskByRequester(a.challenge_id, direct.task_id, "worker" as unknown as "planner"),
      /只允许 planner/,
      "Worker/其他角色不能调用治理版强制完成"
    );

    const lockedTask = await insertTask(a.challenge_id, "FORCE-LOCKED", "模拟在途 Worker");
    await writeFact(a.challenge_id, lockedTask.task_id, "FORCE-LOCKED-FACT", "强制完成前的原始事实");
    await writeFinding(a.challenge_id, lockedTask.task_id, "FORCE-LOCKED-FINDING");
    const workerLock = await acquireTaskExecutionLock(lockedTask.task_id);
    ok(workerLock, "测试夹具持有模拟 Worker 执行锁");
    const pendingCompletion = completeTaskByRequester(a.challenge_id, lockedTask.task_id, "planner");
    const requestDeadline = Date.now() + 3_000;
    while (!(await getTaskCompletionRequestedIds()).includes(lockedTask.task_id) && Date.now() < requestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    ok((await getTaskCompletionRequestedIds()).includes(lockedTask.task_id), "锁被占用时登记强制完成请求");
    ok((await getPendingTaskCompletionStopIds()).includes(lockedTask.task_id), "强制完成请求等待编排器停止确认");
    equal(await getTaskForExecution(lockedTask.task_id), null, "强制完成请求期间禁止重新分发");
    await rejects(() => deleteTask(a.challenge_id, lockedTask.task_id), /强制完成请求/, "强制完成期间禁止同时删除");
    await rejects(() => forceComplete(lockedTask.task_id, "RACE-SHOULD-NOT-WRITE"), /强制完成请求/, "异常补完成不得覆盖强制完成请求");
    equal((await getTask(lockedTask.task_id))?.finding, "[FORCE-LOCKED-FINDING]", "治理竞态不得追加异常 finding");
    await new Promise((resolve) => setTimeout(resolve, 300));
    equal((await getTask(lockedTask.task_id))?.is_complete, 0, "Worker 停止确认前不得提前完成");
    await releaseTaskExecutionLock(workerLock, lockedTask.task_id);
    await markTaskCompletionStopped(lockedTask.task_id);
    const stoppedResult = await pendingCompletion;
    equal(stoppedResult.stoppedWorker, true, "锁竞争路径报告已等待 Worker 停止");
    equal(stoppedResult.alreadyComplete, false, "停止后完成原未完成任务");
    const lockedAfter = await getTask(lockedTask.task_id);
    equal(lockedAfter?.is_complete, 1, "停止确认并重新获得锁后最终完成");
    equal(lockedAfter?.fact, "[FORCE-LOCKED-FACT]", "强制完成保留 fact");
    equal(lockedAfter?.finding, "[FORCE-LOCKED-FINDING]", "强制完成保留 finding 且不补异常原因");
    ok(!(await getTaskCompletionRequestedIds()).includes(lockedTask.task_id), "最终完成后清理临时协作字段");

    const deleteFirst = await insertTask(a.challenge_id, "DELETE-BEFORE-COMPLETE", "验证治理互斥");
    const deleteLock = await acquireTaskExecutionLock(deleteFirst.task_id);
    ok(deleteLock, "测试夹具持有删除路径执行锁");
    const pendingDelete = deleteTask(a.challenge_id, deleteFirst.task_id);
    const deleteDeadline = Date.now() + 3_000;
    while (!(await getTaskDeletionRequestedIds()).includes(deleteFirst.task_id) && Date.now() < deleteDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    ok((await getPendingTaskDeletionStopIds()).includes(deleteFirst.task_id), "测试夹具登记删除请求");
    await rejects(() => completeTaskByRequester(a.challenge_id, deleteFirst.task_id, "planner"), /删除请求/, "删除期间禁止同时强制完成");
    await releaseTaskExecutionLock(deleteLock, deleteFirst.task_id);
    await markTaskDeletionStopped(deleteFirst.task_id);
    await pendingDelete;
    equal(await getTask(deleteFirst.task_id), null, "互斥测试后删除流程仍可正常收尾");

    console.log("[selftest] 5. 单题报告只结束本题并激活下一题");
    await rejects(() => generateReport(a.challenge_id, "过早"), /未完成任务/, "有未完成任务不能终态");
    for (const task of await getAllTasks(a.challenge_id)) await completeTask(a.challenge_id, task.task_id);
    await completeTask(b.challenge_id, bTask.task_id);
    const aReport = await generateReport(a.challenge_id, "A-CONCLUSION");
    equal((await getChallenge(a.challenge_id))?.status, "completed", "A 单独 completed");
    equal((await getChallenge(b.challenge_id))?.status, "active", "B 继续 active");
    const next = await activateQueuedChallenges();
    equal(next.map((row) => row.name).join(","), "D", "A 终态释放名额后激活 D");
    const reportBody = fs.readFileSync(aReport.file, "utf8");
    ok(reportBody.includes("A-FINDING-UNIQUE") && !reportBody.includes("B-FINDING-UNIQUE"), "单题报告不含其他题 finding");
    const bReport = await generateReport(b.challenge_id, "B-CONCLUSION");
    const dTask = await insertTask(d.challenge_id, "D-TASK", "D-NOTE");
    await completeTask(d.challenge_id, dTask.task_id);
    await generateReport(d.challenge_id, "D-CONCLUSION");
    const summary = await generateContestSummary();
    equal(summary.challengeCount, 4, "汇总包含全部4题");
    equal(summary.failedCount, 0, "skipped 不算 failed");
    const summaryBody = fs.readFileSync(summary.file, "utf8");
    ok(summaryBody.includes(path.relative(config.root, aReport.file)) && summaryBody.includes(path.relative(config.root, bReport.file)), "汇总包含各题报告索引");

    console.log("[selftest] 6. 目录式历史隔离、损坏拒绝与并发重排");
    const historyDir = await exportDatabaseHistory();
    const manifest = JSON.parse(fs.readFileSync(path.join(historyDir, "manifest.json"), "utf8")) as { challenges: unknown[]; last_task_id: number };
    equal(manifest.challenges.length, 4, "manifest 索引全部赛题");
    const manifestRaw = fs.readFileSync(path.join(historyDir, "manifest.json"), "utf8");
    ok(!manifestRaw.includes("A-TASK-UNIQUE") && !manifestRaw.includes("A-FINDING-UNIQUE"), "manifest 不含任务正文");
    const aHistoryRaw = fs.readFileSync(path.join(historyDir, `challenge-${a.challenge_id}.json`), "utf8");
    ok(aHistoryRaw.includes("A-FINDING-UNIQUE") && !aHistoryRaw.includes("B-FINDING-UNIQUE"), "每题历史文件隔离");
    await resetRunState();
    config.ctfPlannerConcurrency = 1;
    await restoreDatabaseHistory(historyDir);
    equal((await getChallenges()).length, 4, "恢复全部 Challenge");

    const activeHistorySetup = await setupContest(["H-A", "H-B", "H-C"]);
    config.ctfPlannerConcurrency = 3;
    await activateQueuedChallenges();
    await insertTask(activeHistorySetup[0]!.challenge_id, "H-A-TASK", "H-A");
    await insertTask(activeHistorySetup[1]!.challenge_id, "H-B-TASK", "H-B");
    await insertTask(activeHistorySetup[2]!.challenge_id, "H-C-TASK", "H-C");
    const activeHistory = await exportDatabaseHistory();
    config.ctfPlannerConcurrency = 1;
    await restoreDatabaseHistory(activeHistory);
    const restored = await getChallenges();
    equal(restored.map((row) => row.status).join(","), "active,queued,queued", "恢复降额只保留首题 active");
    const queuedTask = (await getAllTasks(restored[1]!.challenge_id))[0]!;
    equal(await getTaskForExecution(queuedTask.task_id), null, "重新 queued 的任务不能执行");
    const activeTask = (await getAllTasks(restored[0]!.challenge_id))[0]!;
    ok((await getTaskForExecution(activeTask.task_id))?.task_id === activeTask.task_id, "active 任务仍可执行");
    config.ctfPlannerConcurrency = 3;
    await restoreDatabaseHistory(activeHistory);
    equal((await getChallenges()).filter((row) => row.status === "active").length, 3, "恢复增额可重新激活原非终态题");

    const corrupt = `${activeHistory}-corrupt`;
    fs.cpSync(activeHistory, corrupt, { recursive: true });
    const corruptFile = path.join(corrupt, `challenge-${activeHistorySetup[1]!.challenge_id}.json`);
    const corruptJson = JSON.parse(fs.readFileSync(corruptFile, "utf8")) as { task: Array<{ challenge_id: number }> };
    corruptJson.task[0]!.challenge_id = activeHistorySetup[0]!.challenge_id;
    fs.writeFileSync(corruptFile, JSON.stringify(corruptJson));
    await rejects(() => restoreDatabaseHistory(corrupt), /串题/, "串题历史必须拒绝");
    equal((await getChallenges()).length, 3, "损坏历史不能造成部分恢复");
    fs.rmSync(corrupt, { recursive: true, force: true });

    console.log("[selftest] 7. version=1 单目标历史兼容");
    const legacyFile = path.join(config.historyDir, `param-db-selftest-${process.pid}.json`);
    fs.writeFileSync(legacyFile, JSON.stringify({
      format: "param-database-history", version: 1, exported_at: new Date().toISOString(),
      goal: { id: 1, asset: "legacy.test", customization: "", goal: "legacy goal", created_at: new Date(), updated_at: new Date() },
      task: [{ task_id: 7, is_complete: 0, task: "LEGACY-TASK", note: "", fact: null, finding: null, compressed_at: null }],
      detail: [], detail2: [], halt_request: [], planner_append: [{ append_id: 1 }],
    }));
    await resetRunState();
    const legacySummary = await restoreDatabaseHistory(legacyFile);
    equal(legacySummary.taskCount, 1, "旧历史恢复任务");
    equal((await getChallenges())[0]?.name, "legacy", "旧历史转为 legacy Challenge");
    equal((await getAllTasks())[0]?.challenge_id, 1, "旧任务回填 challenge_id");
    equal((await insertTask(1, "AFTER-LEGACY", "高水位"))?.task_id, 8, "旧历史缺高水位时按最大 task_id 续增");
    fs.rmSync(legacyFile, { force: true });

    console.log("[selftest] 8. Compactor 单题批次与 detail2 复合唯一键");
    const compressionChallenges = await setupContest(["X", "Y"]);
    await activateQueuedChallenges();
    const batches: CompressionTaskRow[][] = [];
    for (const [index, challenge] of compressionChallenges.entries()) {
      for (let i = 0; i < 10; i++) {
        const task = await insertTask(challenge.challenge_id, `${challenge.name}-COMPACT-${i}`, "压缩测试");
        if (i === 0) await writeFinding(challenge.challenge_id, task.task_id, `${challenge.name}-RAW-FINDING`);
      }
      const tenRowDue = await getDueCompressionBatch(challenge.challenge_id);
      equal(tenRowDue.length, COMPACTOR_FIRST_TRIGGER === COMPACTOR_BATCH_SIZE ? COMPACTOR_BATCH_SIZE : 0, "10条仅在 FIRST_TRIGGER=10 时到期，其余配置应保持未到期");
      const result = await pool.query<CompressionTaskRow>(
        "SELECT task_id, challenge_id, is_complete, task, note, fact, finding, compressed_at FROM task WHERE challenge_id=$1 ORDER BY task_id",
        [challenge.challenge_id]
      );
      batches.push(result.rows);
      await compressTaskBatch(result.rows, result.rows.map((row, i) => ({
        task_id: row.task_id,
        task: `${challenge.name}-摘要-${i}`,
        findings: i === 0 ? ["SHARED-COMPRESSED"] : [],
      })));
      equal(await getFindingDetail(challenge.challenge_id, "SHARED-COMPRESSED"), `${challenge.name}-RAW-FINDING`, `detail2 相同摘要按题隔离 ${index}`);
    }
    assert.throws(() => assertCompressionBatch([batches[0]![0]!, ...batches[1]!.slice(0, 9)]), /不得跨 Challenge/);
    assertions++;

    console.log("[selftest] 8b. Compactor 多题交错全局 ID 的独立阈值与保留区");
    config.ctfPlannerConcurrency = 2;
    const interleaved = await setupContest(["P", "Q"]);
    await activateQueuedChallenges();
    for (const challenge of interleaved) {
      equal((await getDueCompressionBatch(challenge.challenge_id)).length, 0, "空 Challenge 不得产生压缩批次");
    }
    const insertedIds = new Map<number, number[]>(interleaved.map((challenge) => [challenge.challenge_id, []]));
    const triggerRounds = new Map<number, number[]>(interleaved.map((challenge) => [challenge.challenge_id, []]));
    for (let round = 1; round <= COMPACTOR_FIRST_TRIGGER + 2 * COMPACTOR_BATCH_SIZE; round++) {
      for (const [index, challenge] of interleaved.entries()) {
        const inserted = await insertTask(challenge.challenge_id, `${challenge.name}-INTERLEAVED-${round}`, "交错ID阈值测试");
        insertedIds.get(challenge.challenge_id)!.push(inserted.task_id);
        const other = interleaved[(index + 1) % interleaved.length]!;
        equal((await getDueCompressionBatch(other.challenge_id)).length, 0, "一道题新增任务不得使另一题凭空到期");
        const batch = await getDueCompressionBatch(challenge.challenge_id);
        if (batch.length === 0) continue;
        equal(batch.length, COMPACTOR_BATCH_SIZE, "到期批次必须恰好10条");
        ok(batch.every((row) => row.challenge_id === challenge.challenge_id), "交错ID批次只能包含当前 Challenge");
        triggerRounds.get(challenge.challenge_id)!.push(round);
        await compressTaskBatch(batch, batch.map((row) => ({
          task_id: row.task_id,
          task: `${challenge.name}-交错摘要-${row.task_id}`,
          findings: [],
        })));
        equal((await getDueCompressionBatch(challenge.challenge_id)).length, 0, "压缩后不足下一批时不得立即重复到期");
      }
    }
    const expectedTriggers = [0, 1, 2].map((index) => COMPACTOR_FIRST_TRIGGER + index * COMPACTOR_BATCH_SIZE);
    for (const challenge of interleaved) {
      equal(triggerRounds.get(challenge.challenge_id)!.join(","), expectedTriggers.join(","), "每题必须在 FIRST/FIRST+10/FIRST+20 独立触发");
      const remaining = await pool.query<{ task_id: number }>(
        "SELECT task_id FROM task WHERE challenge_id=$1 AND compressed_at IS NULL ORDER BY task_id",
        [challenge.challenge_id]
      );
      const ownIds = insertedIds.get(challenge.challenge_id)!;
      const expectedRecent = COMPACTOR_RETAIN_TASKS === 0 ? [] : ownIds.slice(-COMPACTOR_RETAIN_TASKS);
      equal(remaining.rows.map((row) => row.task_id).join(","), expectedRecent.join(","), "保留区必须是本题最近 RETAIN 条，而不是全局ID数值范围");
    }
    const pIds = insertedIds.get(interleaved[0]!.challenge_id)!;
    const qIds = insertedIds.get(interleaved[1]!.challenge_id)!;
    ok(pIds.every((id, index) => id === index * 2 + 1) && qIds.every((id, index) => id === index * 2 + 2), "测试夹具必须真实形成奇偶交错的全局 task_id");

    console.log("[selftest] 8c. Challenge 增量发布、ready 屏障、终态门与部分发布恢复");
    config.ctfPlannerConcurrency = 2;
    await resetRunState();
    await startContest({ asset: "incremental.test", customization: "INC-COMMON", goal: "增量发布测试" });
    equal((await getContestPublication())?.status, "publishing", "start_contest 进入 publishing");
    const incA = (await publishChallengeBatch([
      { name: "INC-A", asset: "inc-a.test", goal: "INC-A-GOAL" },
    ]))[0]!;
    equal((await getContestPublication())?.status, "publishing", "单批发布后仍保持 publishing");
    equal((await activateQueuedChallenges()).map((row) => row.challenge_id).join(","), String(incA.challenge_id), "首批 ready 后可立即激活");
    const incB = (await publishChallengeBatch([
      { name: "INC-B", asset: "inc-b.test", goal: "INC-B-GOAL" },
    ]))[0]!;
    await pool.query("UPDATE challenge SET prompt_ready_at=NULL WHERE challenge_id=$1", [incB.challenge_id]);
    equal(await countUnreadyChallenges(), 1, "测试夹具构造未就绪批次");
    equal((await activateQueuedChallenges()).length, 0, "未就绪 queued Challenge 不得激活");
    await injectPrompts();
    equal(await countUnreadyChallenges(), 0, "提示词重建可恢复 ready 屏障");
    equal((await activateQueuedChallenges()).map((row) => row.challenge_id).join(","), String(incB.challenge_id), "就绪后后续批次可激活");
    await rejects(() => publishChallengeBatch([
      { name: "INC-A", asset: "duplicate.test", goal: "DUPLICATE" },
    ]), /已存在/, "跨批名称重复必须拒绝");
    equal((await getChallenges()).length, 2, "重复批次不能留下部分 Challenge");
    const finished = await finishChallengePublication();
    equal(finished.challengeCount, 2, "finish 返回累计发布数量");
    equal((await getContestPublication())?.status, "finalized", "finish 关闭发布状态");
    await rejects(() => publishChallengeBatch([
      { name: "INC-C", asset: "inc-c.test", goal: "INC-C-GOAL" },
    ]), /不在 publishing/, "finalized 后禁止继续发布");

    await resetRunState();
    await startContest({ asset: "publish-gate.test", customization: "", goal: "发布终态门" });
    await publishChallengeBatch([
      { name: "ONLY-SKIPPED", asset: "", goal: "", skip_reason: "缺少资产" },
    ]);
    await rejects(() => generateContestSummary(), /发布尚未结束/, "全部现有题终态但 publishing 时禁止汇总");
    await finishChallengePublication();
    const finalizedSummary = await generateContestSummary();
    equal(finalizedSummary.publicationFailed, false, "正常 finalized 不算发布失败");

    await resetRunState();
    await startContest({ asset: "publish-failure.test", customization: "", goal: "发布失败清理" });
    const failedPending = (await publishChallengeBatch([
      { name: "FAILED-PENDING", asset: "failed-pending.test", goal: "PENDING" },
    ]))[0]!;
    await pool.query("UPDATE challenge SET prompt_ready_at=NULL WHERE challenge_id=$1", [failedPending.challenge_id]);
    await failContestPublication("模拟 Manager 失败");
    equal((await getContestPublication())?.status, "failed", "Manager 失败进入 failed 发布状态");
    equal((await getChallenge(failedPending.challenge_id))?.status, "skipped", "失败时未就绪题转 skipped 而非永久 queued");
    equal(await countUnreadyChallenges(), 0, "发布失败后无未就绪调度屏障残留");
    equal((await generateContestSummary()).publicationFailed, true, "发布失败必须影响整场退出判定");

    await resetRunState();
    await startContest({ asset: "partial-history.test", customization: "", goal: "部分发布历史" });
    const partialReady = (await publishChallengeBatch([
      { name: "PARTIAL-READY", asset: "ready.test", goal: "READY" },
    ]))[0]!;
    await activateQueuedChallenges();
    const partialPending = (await publishChallengeBatch([
      { name: "PARTIAL-PENDING", asset: "pending.test", goal: "PENDING" },
    ]))[0]!;
    await pool.query("UPDATE challenge SET prompt_ready_at=NULL WHERE challenge_id=$1", [partialPending.challenge_id]);
    const partialHistory = await exportDatabaseHistory();
    const partialManifest = JSON.parse(fs.readFileSync(path.join(partialHistory, "manifest.json"), "utf8")) as { publication?: { status?: string } };
    equal(partialManifest.publication?.status, "publishing", "历史保存发布中状态");
    await restoreDatabaseHistory(partialHistory);
    equal((await getContestPublication())?.status, "incomplete", "发布中历史恢复为 incomplete，避免等待不存在的 Manager");
    equal((await getChallenge(partialPending.challenge_id))?.status, "skipped", "未就绪历史 Challenge 转为 skipped");
    equal((await getChallenge(partialReady.challenge_id))?.status, "active", "已就绪历史 Challenge 可按并发恢复");
    equal(await countUnreadyChallenges(), 0, "恢复后不存在永远不可调度的未就绪行");
    await failContestPublication("模拟发布终止");
    equal((await getContestPublication())?.status, "incomplete", "failContestPublication 不覆盖已恢复 incomplete 状态");

    console.log("[selftest] 9. resetRunState 清理工作区与分题提示词");
    const workspace = path.join(config.workspacesDir, "task-999");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "keep-check"), "x");
    ok(fs.existsSync(path.join(config.promptsGeneratedDir, "challenges")), "重置前存在分题提示词");
    await resetRunState();
    equal(fs.existsSync(workspace), false, "重置删除历史工作区");
    equal(fs.existsSync(path.join(config.promptsGeneratedDir, "challenges")), false, "重置删除分题动态提示词");
    equal((await getChallenges()).length, 0, "重置清空 Challenge");

    console.log(`\nSELFTEST OK · ${assertions} assertions`);
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(`SELFTEST FAILED: ${(error as Error).stack ?? error}`);
  process.exitCode = 1;
});
