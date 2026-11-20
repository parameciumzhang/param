import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  startContest,
  publishChallengeBatch,
  finishChallengePublication,
  insertTask,
  deleteTask,
  MAX_TASK_CHARS,
  MAX_TASK_NOTE_CHARS,
  writeFact,
  getFactDetail,
  getFindingDetail,
  writeFinding,
  completeTask,
  completeTaskByRequester,
  generateReport,
  MAX_FACT_CHARS,
  compressTaskBatch,
  MAX_COMPACTED_TASK_CHARS,
  MAX_COMPACTED_FINDING_CHARS,
  COMPACTOR_TIMEOUT_ONLY_FINDING,
  type CompressionTaskRow,
} from "./scripts.js";
import { kaliExec } from "./kali.js";
import { config } from "./config.js";

function text(content: string, isError = false) {
  return { content: [{ type: "text" as const, text: content }], details: undefined, isError };
}

/** Manager 增量发布；challenge_id、ready 与调度状态均只由固定脚本管理。 */
export function makeManagerTools() {
  let started = false;
  let finalized = false;
  const challengeSchema = Type.Object({
    name: Type.String({ minLength: 1, description: "赛事内唯一赛题名称" }),
    asset: Type.String({ description: "本题完整资产；skipped 赛题可为空" }),
    customization: Type.Optional(Type.String({ description: "本题附加约束" })),
    goal: Type.String({ description: "本题可判定目标；skipped 赛题可为空" }),
    skip_reason: Type.Optional(Type.String({ minLength: 1, description: "信息不足时必填；该题自动 skipped" })),
  }, { additionalProperties: false });
  const start = defineTool({
    name: "start_contest",
    label: "start_contest",
    description: "创建整场 contest 并进入 Challenge 增量发布状态。整场 asset/customization/goal 发布后冻结，只能调用一次。",
    promptSnippet: "初始化整场赛事，随后可分批发布 Challenge。",
    parameters: Type.Object({
      asset: Type.String({ minLength: 1, description: "赛事级资产/范围说明" }),
      customization: Type.String({ description: "整场通用约束，无则空字符串" }),
      goal: Type.String({ minLength: 1, description: "整场赛事目标" }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (started) return text("start_contest 失败: 本轮已初始化赛事", true);
      try {
        await startContest(params);
        started = true;
        return text("赛事已初始化并进入 publishing；请按1～4道一批发布信息完整的 Challenge。");
      } catch (e) {
        return text(`start_contest 失败: ${(e as Error).message}`, true);
      }
    },
  });
  const publish = defineTool({
    name: "publish_challenges",
    label: "publish_challenges",
    description: "增量发布1～4道 Challenge。固定脚本生成并校验提示词后才开放调度；返回后本题即可被 Planner/Worker 执行，Manager 可继续发布后续批次。",
    promptSnippet: "发布一批就绪 Challenge，无需等待其执行完成。",
    parameters: Type.Object({
      challenges: Type.Array(challengeSchema, { minItems: 1, maxItems: 4 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (!started) return text("publish_challenges 失败: 请先 start_contest", true);
      if (finalized) return text("publish_challenges 失败: 本轮发布已结束", true);
      try {
        const rows = await publishChallengeBatch(params.challenges);
        return text(`已发布并就绪 ${rows.length} 道 Challenge: ${rows.map((row) => `#${row.challenge_id} ${row.name} [${row.status}]`).join("; ")}`);
      } catch (e) {
        return text(`publish_challenges 失败: ${(e as Error).message}`, true);
      }
    },
  });
  const finish = defineTool({
    name: "finish_challenge_publication",
    label: "finish_challenge_publication",
    description: "确认全部 Challenge 已发布完毕。只有调用成功后，全部赛题终态时才允许生成赛事汇总。",
    promptSnippet: "结束 Challenge 发布（不是结束赛题执行）。",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      if (!started) return text("finish_challenge_publication 失败: 请先 start_contest", true);
      if (finalized) return text("本轮 Challenge 发布已经结束。");
      try {
        const result = await finishChallengePublication();
        finalized = true;
        return text(`Challenge 发布已完成，共 ${result.challengeCount} 道；各题继续独立执行。`);
      } catch (e) {
        return text(`finish_challenge_publication 失败: ${(e as Error).message}`, true);
      }
    },
  });
  return {
    tools: [start, publish, finish] as const,
    started: () => started,
    finalized: () => finalized,
  };
}

function makeFactDetailTool(challengeId: number) {
  return defineTool({
    name: "get_fact_detail",
    label: "get_fact_detail",
    description: "按本题历史快照中的单条 [fact] 查询本题 detail 表；方括号可省略。工具已绑定 Challenge，不能查询其他赛题。",
    promptSnippet: "查询本题单条 fact 的完整细节。",
    parameters: Type.Object({
      fact: Type.String({ minLength: 1, maxLength: MAX_FACT_CHARS + 2 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try { return text(await getFactDetail(challengeId, params.fact)); }
      catch (e) { return text(`get_fact_detail 失败: ${(e as Error).message}`, true); }
    },
  });
}

function makeFindingDetailTool(challengeId: number) {
  return defineTool({
    name: "get_finding_detail",
    label: "get_finding_detail",
    description: "按本题单条压缩 [finding] 查询原始详情；未压缩 finding 会提示已是详细版本。工具已绑定 Challenge。",
    promptSnippet: "查询本题压缩 finding 的原始详情。",
    parameters: Type.Object({
      finding: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try { return text(await getFindingDetail(challengeId, params.finding)); }
      catch (e) { return text(`get_finding_detail 失败: ${(e as Error).message}`, true); }
    },
  });
}

/** 每题每轮 Planner 独占工具状态；所有数据库脚本都由闭包绑定 challengeId。 */
function makeForceCompleteTaskTool(challengeId: number, onChanged: () => void) {
  return defineTool({
    name: "force_complete_task",
    label: "force_complete_task",
    description: "强制完成当前 Challenge 内指定 task_id。若 Worker 在途，先请求停止并等待其完全退出；保留已有 fact/finding，不伪造执行结果。已完成任务幂等返回。可与其他 Planner 决策同轮调用。",
    promptSnippet: "强制完成本题指定任务（必要时先停止 Worker）；保留证据，且可与其他 Planner 决策同轮使用。",
    // 同批包含报告等顺序敏感决策时按模型给出的顺序执行，避免报告早于强制完成。
    executionMode: "sequential",
    parameters: Type.Object({
      task_id: Type.Integer({ minimum: 1 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const result = await completeTaskByRequester(challengeId, params.task_id, "planner");
        if (!result.alreadyComplete) onChanged();
        const status = result.alreadyComplete
          ? "任务此前已完成，本次幂等返回"
          : result.stoppedWorker
            ? "已停止 Worker 并强制完成"
            : "已强制完成";
        return text(`${status}：Challenge #${challengeId} 任务 #${result.taskId}；已有 fact/finding 保持不变，完成状态不代表执行成功。`);
      } catch (e) {
        return text(`force_complete_task 失败: ${(e as Error).message}`, true);
      }
    },
  });
}

/** 每题每轮 Planner 独占工具状态；所有数据库脚本都由闭包绑定 challengeId。 */
export function makePlannerTools(challengeId: number, opts: { interrupted?: boolean } = {}) {
  let inserted = 0;
  let deleted = 0;
  let forceCompleted = 0;
  let waiting = false;
  let reportFile: string | null = null;
  const insert = defineTool({
    name: "insert_task",
    label: "insert_task",
    description: `向当前绑定的 Challenge 发布任务。task≤${MAX_TASK_CHARS}字符，note≤${MAX_TASK_NOTE_CHARS}字符；禁止与等待或报告同轮调用。`,
    promptSnippet: "向当前 Challenge 发布任务（全局 task_id 自动递增）。",
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS }),
      note: Type.String({ minLength: 1, maxLength: MAX_TASK_NOTE_CHARS }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (reportFile) return text("insert_task 失败: 本轮已生成报告", true);
      if (waiting) return text("insert_task 失败: 本轮已选择等待", true);
      try {
        const row = await insertTask(challengeId, params.task, params.note);
        inserted++;
        return text(`已向 Challenge #${challengeId} 发布任务 #${row.task_id}: ${row.task}`);
      } catch (e) { return text(`insert_task 失败: ${(e as Error).message}`, true); }
    },
  });
  const remove = defineTool({
    name: "task_delete",
    label: "task_delete",
    description: "删除当前 Challenge 内指定 task_id 的空未完成任务；在途 Worker 会先停止并退出。已有 fact/finding 或已完成任务禁止删除。",
    promptSnippet: "删除本题无证据的未完成任务。",
    parameters: Type.Object({
      task_id: Type.Integer({ minimum: 1 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const result = await deleteTask(challengeId, params.task_id);
        deleted++;
        return text(`${result.stoppedWorker ? "已停止 Worker 并删除" : "已删除"}本题任务 #${result.taskId}`);
      } catch (e) { return text(`task_delete 失败: ${(e as Error).message}`, true); }
    },
  });
  const wait = defineTool({
    name: "wait_for_next_event",
    label: "wait_for_next_event",
    description: "本题当前无需发布新任务且未到终态时显式等待；正常由本题激活/完成事件唤醒。若本题已无 Worker 在途且无未完成任务，编排器会按静止点兜底唤醒；连续无效等待超过安全阀后本题失败。禁止与发布或报告同轮调用。",
    promptSnippet: "等待本题下一次内部事件。",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      if (inserted > 0 || reportFile) return text("wait_for_next_event 失败: 与本轮发布/报告互斥", true);
      waiting = true;
      return text("本题本轮选择等待。");
    },
  });
  const report = defineTool({
    name: "generate_report",
    label: "generate_report",
    description: opts.interrupted
      ? "为当前 active Challenge 生成 Ctrl+C/SIGTERM 阶段性报告，不改变本题 active 状态，不宣称 goal 达成。"
      : "本题 goal 达成、无未完成任务且无在途 Worker 时生成单题报告，并把本题标记 completed；不会结束其他赛题。",
    promptSnippet: opts.interrupted ? "生成本题中断报告。" : "生成本题终态报告并完成本题。",
    parameters: Type.Object({
      conclusion: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (inserted > 0 || waiting) return text("generate_report 失败: 与本轮发布/等待互斥", true);
      try {
        const result = await generateReport(challengeId, params.conclusion, { interrupted: opts.interrupted });
        reportFile = result.file;
        return text(`Challenge #${challengeId} ${opts.interrupted ? "中断" : "终态"}报告: ${result.file}`);
      } catch (e) { return text(`generate_report 失败: ${(e as Error).message}`, true); }
    },
  });
  return {
    tools: opts.interrupted
      ? [report]
      : [insert, remove, makeForceCompleteTaskTool(challengeId, () => { forceCompleted++; }), wait, report, makeFactDetailTool(challengeId), makeFindingDetailTool(challengeId)],
    inserted: () => inserted,
    deleted: () => deleted,
    forceCompleted: () => forceCompleted,
    waiting: () => waiting,
    reportFile: () => reportFile,
  };
}

export function makeCompactorTools(batch: CompressionTaskRow[]) {
  let compressed = false;
  const challengeId = batch[0]?.challenge_id;
  const compress = defineTool({
    name: "compress_task_batch",
    label: "compress_task_batch",
    description: `提交 Challenge #${challengeId} 当前绑定批次的 ${batch.length} 个压缩结果；task≤${MAX_COMPACTED_TASK_CHARS}字符，每条 finding≤${MAX_COMPACTED_FINDING_CHARS}字符且本题内唯一。纯超时文案 ${COMPACTOR_TIMEOUT_ONLY_FINDING} 由脚本清空。`,
    promptSnippet: "提交本题绑定批次的压缩摘要。",
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        task_id: Type.Integer(),
        task: Type.String({ minLength: 1, maxLength: MAX_COMPACTED_TASK_CHARS }),
        findings: Type.Array(Type.String({ minLength: 1, maxLength: MAX_COMPACTED_FINDING_CHARS })),
      }, { additionalProperties: false }), { minItems: batch.length, maxItems: batch.length }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (compressed) return text("compress_task_batch 失败: 本批次已成功压缩", true);
      try {
        await compressTaskBatch(batch, params.items);
        compressed = true;
        return text(`Challenge #${challengeId} 的 ${batch.length} 个任务已压缩`);
      } catch (e) {
        console.warn(`[compactor] Challenge #${challengeId} 压缩失败: ${(e as Error).message}`);
        return text(`compress_task_batch 失败: ${(e as Error).message}`, true);
      }
    },
  });
  return { tools: [compress], compressed: () => compressed };
}

export function makeWorkerTools(challengeId: number, taskId: number) {
  const fact = defineTool({
    name: "write_fact",
    label: "write_fact",
    description: `记录当前任务的事实概括与完整详情；fact≤${MAX_FACT_CHARS}字符，在本题内唯一。工具同时绑定 Challenge 与 task_id。`,
    promptSnippet: "写入当前任务的 fact/fact_detail。",
    parameters: Type.Object({
      fact: Type.String({ minLength: 1, maxLength: MAX_FACT_CHARS }),
      fact_detail: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        await writeFact(challengeId, taskId, params.fact, params.fact_detail);
        return text(`Challenge #${challengeId} 任务 #${taskId} 的 fact 已写入`);
      } catch (e) { return text(`write_fact 失败: ${(e as Error).message}`, true); }
    },
  });
  const finding = defineTool({
    name: "write_finding",
    label: "write_finding",
    description: "实时记录当前任务 finding；只能写当前 Challenge 的当前任务。",
    promptSnippet: "写入当前任务 finding。",
    parameters: Type.Object({ finding: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        await writeFinding(challengeId, taskId, params.finding);
        return text(`任务 #${taskId} finding 已写入`);
      } catch (e) { return text(`write_finding 失败: ${(e as Error).message}`, true); }
    },
  });
  const complete = defineTool({
    name: "complete_task",
    label: "complete_task",
    description: "把当前 Challenge 的当前任务标记完成；每个任务最后必须调用。",
    promptSnippet: "完成当前任务。",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      try {
        await completeTask(challengeId, taskId);
        return text(`任务 #${taskId} 已完成`);
      } catch (e) { return text(`complete_task 失败: ${(e as Error).message}`, true); }
    },
  });
  return [fact, finding, complete, makeFactDetailTool(challengeId), makeFindingDetailTool(challengeId)] as const;
}

/** 所有 Challenge 共用同一 Kali 工具环境；任务目录按全局唯一 task_id 隔离。 */
export function makeKaliBashTool(workdir: string) {
  const environment = config.kali.runtime === "embedded" ? "All-in-One 本容器 Kali 工具环境" : "共享 Kali 容器";
  return defineTool({
    name: "kali_bash",
    label: "kali_bash",
    description: `在${environment}内执行 bash；起始目录固定为 ${workdir}。不同任务共享网络/端口命名空间，避免绑定冲突端口。`,
    promptSnippet: "在 Kali 工具环境的当前任务目录执行命令。",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeout_sec: Type.Optional(Type.Number({ minimum: 1 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const result = await kaliExec(params.command, {
        workdir,
        timeoutMs: (params.timeout_sec ?? 300) * 1000,
        signal,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 100_000);
      return text(`[exit ${result.code}]${output ? `\n${output}` : "（无输出）"}`, result.code !== 0);
    },
  });
}
