import type { PoolClient } from "pg";
import fs from "node:fs";
import path from "node:path";
import {
  pool,
  getGoal,
  getAllTasks,
  getChallenge,
  getChallenges,
  countIncomplete,
  getContestPublication,
  countUnreadyChallenges,
  type TaskRow,
  type GoalRow,
  type ChallengeRow,
  type ChallengeStatus,
  type ContestPublicationStatus,
  type DetailRow,
  type Detail2Row,
} from "./db.js";
import { config } from "./config.js";

/** 固定脚本层：所有业务写库、提示词与报告文件写入只能在这里发生。 */
const ADVISORY_LOCK_KEY = 90210;
const TASK_EXECUTION_LOCK_KEY = 90211;
const CONTEST_ACTIVATION_LOCK_KEY = 90212;
const CONTEST_PUBLICATION_LOCK_KEY = 90213;
const TASK_DELETE_WAIT_TIMEOUT_MS = 60_000;
const TASK_DELETE_POLL_INTERVAL_MS = 200;
const TASK_COMPLETE_WAIT_TIMEOUT_MS = 60_000;
const TASK_COMPLETE_POLL_INTERVAL_MS = 200;

export const MAX_TASK_CHARS = config.insertTaskMaxChars;
export const MAX_TASK_NOTE_CHARS = config.insertTaskMaxNoteChars;
export const MAX_FACT_CHARS = 60;
export const COMPACTOR_BATCH_SIZE = 10;
export const COMPACTOR_FIRST_TRIGGER = config.compactorFirstTrigger;
export const COMPACTOR_RETAIN_TASKS = COMPACTOR_FIRST_TRIGGER - COMPACTOR_BATCH_SIZE;
export const MAX_COMPACTED_TASK_CHARS = 30;
export const MAX_COMPACTED_FINDING_CHARS = 100;
export const COMPACTOR_TIMEOUT_ONLY_FINDING = `[任务执行异常。原因: 运行超时（${config.workerTimeoutMs}ms）]`;

export type Role = "manager" | "planner" | "worker" | "compactor";

export interface SaveContestChallengesInput {
  contest: { asset: string; customization: string; goal: string };
  challenges: Array<{
    name: string;
    asset: string;
    customization?: string;
    goal: string;
    skip_reason?: string;
  }>;
}

function assertChallengeId(challengeId: number, caller: string): void {
  if (!Number.isInteger(challengeId) || challengeId < 1) throw new Error(`${caller}: 非法 challenge_id`);
}

function assertTaskId(taskId: number, caller: string): void {
  if (!Number.isInteger(taskId) || taskId < 1) throw new Error(`${caller}: 非法 task_id`);
}

/** 内部兼容的一次性入口；challenge_id 与调度状态均不接受模型输入。 */
export async function saveContestChallenges(
  input: SaveContestChallengesInput
): Promise<{ goal: GoalRow; challenges: ChallengeRow[] }> {
  const contest = input?.contest;
  const challenges = input?.challenges;
  if (!contest?.asset?.trim() || !contest?.goal?.trim()) {
    throw new Error("save_contest_challenges: contest.asset 与 contest.goal 不能为空");
  }
  if (!Array.isArray(challenges) || challenges.length === 0) {
    throw new Error("save_contest_challenges: 至少需要一道 Challenge；无法识别的赛题应以 skip_reason 标记");
  }
  const names = new Set<string>();
  for (const [index, challenge] of challenges.entries()) {
    const prefix = `save_contest_challenges: challenges[${index}]`;
    if (!challenge?.name?.trim()) throw new Error(`${prefix}.name 不能为空`);
    const name = challenge.name.trim();
    if (names.has(name)) throw new Error(`save_contest_challenges: 赛题名称重复: ${name}`);
    names.add(name);
    const skipped = !!challenge.skip_reason?.trim();
    if (!skipped && (!challenge.asset?.trim() || !challenge.goal?.trim())) {
      throw new Error(`${prefix} 非 skipped 赛题的 asset/goal 不能为空；信息不足时请提供 skip_reason`);
    }
    if (skipped && !challenge.skip_reason?.trim()) throw new Error(`${prefix}.skip_reason 不能为空`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CONTEST_PUBLICATION_LOCK_KEY]);
    await client.query("LOCK TABLE challenge IN SHARE ROW EXCLUSIVE MODE");
    const existing = await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM challenge");
    if (Number(existing.rows[0]?.n ?? 0) > 0) {
      throw new Error("save_contest_challenges: 当前赛事已经初始化，禁止覆盖既有 Challenge");
    }
    const publication = await client.query("SELECT status FROM contest_publication WHERE id=1");
    if (publication.rows[0]) throw new Error("save_contest_challenges: 当前赛事已经初始化，禁止覆盖发布状态");
    const goalResult = await client.query<GoalRow>(
      `INSERT INTO goal (id, asset, customization, goal)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET asset=EXCLUDED.asset, customization=EXCLUDED.customization,
         goal=EXCLUDED.goal, updated_at=now()
       RETURNING asset, customization, goal, updated_at`,
      [contest.asset.trim(), (contest.customization ?? "").trim(), contest.goal.trim()]
    );
    const saved: ChallengeRow[] = [];
    for (const challenge of challenges) {
      const common = (contest.customization ?? "").trim();
      const own = (challenge.customization ?? "").trim();
      const merged = [common, own].filter(Boolean).join("\n");
      const skipReason = challenge.skip_reason?.trim();
      const inserted = await client.query<ChallengeRow>(
        `INSERT INTO challenge (name, asset, customization, goal, status, status_reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING challenge_id, name, asset, customization, goal, status, status_reason, report_file, created_at, updated_at`,
        [
          challenge.name.trim(),
          (challenge.asset ?? "").trim(),
          merged,
          (challenge.goal ?? "").trim(),
          skipReason ? "skipped" : "queued",
          skipReason || null,
        ]
      );
      saved.push(inserted.rows[0]!);
    }
    await client.query(
      "INSERT INTO contest_publication (id, status, finished_at) VALUES (1, 'finalized', now())"
    );
    await client.query("COMMIT");
    return { goal: goalResult.rows[0]!, challenges: saved };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 增量发布：冻结整场信息并进入 publishing；只有本函数或兼容的一次性脚本可初始化赛事。 */
export async function startContest(
  contest: SaveContestChallengesInput["contest"]
): Promise<GoalRow> {
  if (!contest?.asset?.trim() || !contest?.goal?.trim()) {
    throw new Error("start_contest: contest.asset 与 contest.goal 不能为空");
  }
  const client = await pool.connect();
  let goal: GoalRow;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CONTEST_PUBLICATION_LOCK_KEY]);
    await client.query("LOCK TABLE challenge IN SHARE ROW EXCLUSIVE MODE");
    const existing = await client.query(
      "SELECT (SELECT COUNT(*) FROM challenge)::text AS challenges, (SELECT COUNT(*) FROM goal)::text AS goals, (SELECT COUNT(*) FROM contest_publication)::text AS publications"
    );
    const row = existing.rows[0] as { challenges: string; goals: string; publications: string } | undefined;
    if (Number(row?.challenges ?? 0) > 0 || Number(row?.goals ?? 0) > 0 || Number(row?.publications ?? 0) > 0) {
      throw new Error("start_contest: 当前赛事已经初始化，禁止覆盖");
    }
    const inserted = await client.query<GoalRow>(
      `INSERT INTO goal (id, asset, customization, goal) VALUES (1,$1,$2,$3)
       RETURNING asset, customization, goal, updated_at`,
      [contest.asset.trim(), (contest.customization ?? "").trim(), contest.goal.trim()]
    );
    goal = inserted.rows[0]!;
    await client.query("INSERT INTO contest_publication (id, status) VALUES (1,'publishing')");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  try {
    const managerFile = prepareManagerPrompt();
    if (fs.readFileSync(managerFile, "utf8") !== readTemplate("manager")) {
      throw new Error("Manager 静态提示词回读校验失败");
    }
    const compactorFile = writeGenerated("compactor", readTemplate("compactor"));
    if (fs.readFileSync(compactorFile, "utf8") !== readTemplate("compactor")) {
      throw new Error("Compactor 静态提示词回读校验失败");
    }
    return goal;
  } catch (e) {
    await failContestPublication(`静态提示词生成失败: ${(e as Error).message}`).catch(() => {});
    throw e;
  }
}

/**
 * 每批先写入不可调度行，再生成并回读校验提示词，最后统一打开 ready 屏障。
 * 任一步失败都会清理本批未就绪行；其他已发布 Challenge 不受影响。
 */
export async function publishChallengeBatch(
  challenges: SaveContestChallengesInput["challenges"]
): Promise<ChallengeRow[]> {
  if (!Array.isArray(challenges) || challenges.length === 0 || challenges.length > 4) {
    throw new Error("publish_challenges: 每批必须包含1～4道 Challenge");
  }
  const names = new Set<string>();
  for (const [index, challenge] of challenges.entries()) {
    const prefix = `publish_challenges: challenges[${index}]`;
    if (!challenge?.name?.trim()) throw new Error(`${prefix}.name 不能为空`);
    const name = challenge.name.trim();
    if (names.has(name)) throw new Error(`publish_challenges: 赛题名称重复: ${name}`);
    names.add(name);
    const skipped = !!challenge.skip_reason?.trim();
    if (!skipped && (!challenge.asset?.trim() || !challenge.goal?.trim())) {
      throw new Error(`${prefix} 非 skipped 赛题的 asset/goal 不能为空；信息不足时请提供 skip_reason`);
    }
  }

  const client = await pool.connect();
  let saved: ChallengeRow[];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CONTEST_PUBLICATION_LOCK_KEY]);
    const publication = await client.query<{ status: ContestPublicationStatus }>(
      "SELECT status FROM contest_publication WHERE id=1 FOR UPDATE"
    );
    if (publication.rows[0]?.status !== "publishing") {
      throw new Error("publish_challenges: 赛事不在 publishing 状态，禁止继续发布");
    }
    const goal = await client.query<{ customization: string }>("SELECT customization FROM goal WHERE id=1");
    if (!goal.rows[0]) throw new Error("publish_challenges: goal 不存在，请先 start_contest");
    const existingNames = await client.query<{ name: string }>(
      "SELECT name FROM challenge WHERE name=ANY($1::text[])",
      [[...names]]
    );
    if (existingNames.rows[0]) throw new Error(`publish_challenges: 赛题名称已存在: ${existingNames.rows[0].name}`);
    const common = goal.rows[0].customization.trim();
    saved = [];
    for (const challenge of challenges) {
      const own = (challenge.customization ?? "").trim();
      const skipReason = challenge.skip_reason?.trim();
      const inserted = await client.query<ChallengeRow>(
        `INSERT INTO challenge (name, asset, customization, goal, status, status_reason, prompt_ready_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL)
         RETURNING challenge_id, name, asset, customization, goal, status, status_reason, report_file, created_at, updated_at`,
        [
          challenge.name.trim(),
          (challenge.asset ?? "").trim(),
          [common, own].filter(Boolean).join("\n"),
          (challenge.goal ?? "").trim(),
          skipReason ? "skipped" : "queued",
          skipReason || null,
        ]
      );
      saved.push(inserted.rows[0]!);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  try {
    for (const challenge of saved) {
      const rendered = renderChallengePrompts(challenge);
      writeGenerated("planner", rendered.planner, challenge.challenge_id);
      writeGenerated("worker", rendered.worker, challenge.challenge_id);
      if (readGeneratedPrompt("planner", challenge.challenge_id) !== rendered.planner ||
          readGeneratedPrompt("worker", challenge.challenge_id) !== rendered.worker) {
        throw new Error(`Challenge #${challenge.challenge_id} 提示词回读校验失败`);
      }
    }
    const ids = saved.map((row) => row.challenge_id);
    const ready = await pool.query<{ challenge_id: number }>(
      `UPDATE challenge SET prompt_ready_at=now(), updated_at=now()
       WHERE challenge_id=ANY($1::int[]) AND prompt_ready_at IS NULL
       RETURNING challenge_id`,
      [ids]
    );
    if (ready.rows.length !== saved.length) throw new Error("publish_challenges: 提示词就绪状态更新不完整");
    return saved;
  } catch (e) {
    const ids = saved.map((row) => row.challenge_id);
    try {
      const removed = await pool.query<{ challenge_id: number }>(
        "DELETE FROM challenge WHERE challenge_id=ANY($1::int[]) AND prompt_ready_at IS NULL RETURNING challenge_id",
        [ids]
      );
      for (const row of removed.rows) {
        fs.rmSync(path.join(config.promptsGeneratedDir, "challenges", String(row.challenge_id)), { recursive: true, force: true });
      }
    } catch (cleanupError) {
      throw new Error(`${(e as Error).message}；未就绪批次清理失败: ${(cleanupError as Error).message}`);
    }
    throw e;
  }
}

export async function finishChallengePublication(): Promise<{ challengeCount: number; status: "finalized" }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CONTEST_PUBLICATION_LOCK_KEY]);
    const publication = await client.query<{ status: ContestPublicationStatus }>(
      "SELECT status FROM contest_publication WHERE id=1 FOR UPDATE"
    );
    if (publication.rows[0]?.status === "finalized") {
      const count = await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM challenge");
      await client.query("COMMIT");
      return { challengeCount: Number(count.rows[0]?.n ?? 0), status: "finalized" };
    }
    if (publication.rows[0]?.status !== "publishing") throw new Error("finish_challenge_publication: 当前不在 publishing 状态");
    const count = await client.query<{ total: string; unready: string }>(
      "SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE prompt_ready_at IS NULL)::text AS unready FROM challenge"
    );
    if (Number(count.rows[0]?.total ?? 0) === 0) throw new Error("finish_challenge_publication: 至少需要发布一道 Challenge");
    if (Number(count.rows[0]?.unready ?? 0) > 0) throw new Error("finish_challenge_publication: 仍有提示词未就绪的 Challenge");
    await client.query("UPDATE contest_publication SET status='finalized', error=NULL, finished_at=now() WHERE id=1");
    await client.query("COMMIT");
    return { challengeCount: Number(count.rows[0]?.total ?? 0), status: "finalized" };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Manager 失败时停止新发布；未就绪行转为可审计 skipped，已发布题可继续执行。 */
export async function failContestPublication(reason: string): Promise<void> {
  const normalized = reason.trim() || "未知发布错误";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CONTEST_PUBLICATION_LOCK_KEY]);
    await client.query(
      `UPDATE challenge SET status='skipped', status_reason=$1, prompt_ready_at=now(), updated_at=now()
       WHERE prompt_ready_at IS NULL AND status IN ('queued','skipped')
         AND EXISTS (SELECT 1 FROM contest_publication WHERE id=1 AND status='publishing')`,
      [`Challenge 未完成发布: ${normalized}`]
    );
    await client.query(
      "UPDATE contest_publication SET status='failed', error=$1, finished_at=now() WHERE id=1 AND status='publishing'",
      [normalized]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 按 ID 激活 queued 赛题；活跃名额从激活一直持有到 completed/skipped/failed。 */
export async function activateQueuedChallenges(limit = config.ctfPlannerConcurrency): Promise<ChallengeRow[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("activate_queued_challenges: 非法并发上限");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CONTEST_ACTIVATION_LOCK_KEY]);
    const active = await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM challenge WHERE status = 'active'");
    const available = Math.max(0, limit - Number(active.rows[0]?.n ?? 0));
    if (available === 0) {
      await client.query("COMMIT");
      return [];
    }
    const queued = await client.query<{ challenge_id: number }>(
      "SELECT challenge_id FROM challenge WHERE status = 'queued' AND prompt_ready_at IS NOT NULL ORDER BY challenge_id LIMIT $1 FOR UPDATE",
      [available]
    );
    if (queued.rows.length === 0) {
      await client.query("COMMIT");
      return [];
    }
    const ids = queued.rows.map((row) => row.challenge_id);
    const activated = await client.query<ChallengeRow>(
      `UPDATE challenge SET status = 'active', updated_at = now()
       WHERE challenge_id = ANY($1::int[]) AND status = 'queued' AND prompt_ready_at IS NOT NULL
       RETURNING challenge_id, name, asset, customization, goal, status, status_reason, report_file, created_at, updated_at`,
      [ids]
    );
    await client.query("COMMIT");
    return activated.rows.sort((a, b) => a.challenge_id - b.challenge_id);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function failChallenge(challengeId: number, reason: string): Promise<ChallengeRow> {
  assertChallengeId(challengeId, "fail_challenge");
  const normalized = reason.trim() || "未知失败";
  const { rows } = await pool.query<ChallengeRow>(
    `UPDATE challenge SET status = 'failed', status_reason = $2, updated_at = now()
     WHERE challenge_id = $1 AND status = 'active'
     RETURNING challenge_id, name, asset, customization, goal, status, status_reason, report_file, created_at, updated_at`,
    [challengeId, normalized]
  );
  if (!rows[0]) throw new Error(`fail_challenge: Challenge #${challengeId} 不是 active 或不存在`);
  return rows[0];
}

export async function resetRunState(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM detail2");
    await client.query("DELETE FROM detail");
    await client.query("DELETE FROM task");
    await client.query("DELETE FROM challenge");
    await client.query("DELETE FROM contest_publication");
    await client.query("DELETE FROM goal");
    await client.query("UPDATE task_id_state SET last_task_id = 0 WHERE id = 1");
    await client.query("SELECT setval(pg_get_serial_sequence('challenge', 'challenge_id'), 1, false)");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  for (const entry of fs.readdirSync(config.workspacesDir)) {
    fs.rmSync(path.join(config.workspacesDir, entry), { recursive: true, force: true });
  }
  fs.rmSync(path.join(config.promptsGeneratedDir, "challenges"), { recursive: true, force: true });
  // 清除旧单目标/Monitor 布局，避免把历史产物误认为当前分题提示词。
  for (const legacy of ["planner.system.md", "worker.system.md", "monitor.system.md"]) {
    fs.rmSync(path.join(config.promptsGeneratedDir, legacy), { force: true });
  }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`{{${key}}}`, () => value);
  return out;
}

function readTemplate(role: Role): string {
  return fs.readFileSync(path.join(config.promptsTemplateDir, `${role}.system.md`), "utf8");
}

function writeGenerated(role: Role, content: string, challengeId?: number): string {
  const file = generatedPromptPath(role, challengeId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function generatedPromptPath(role: Role, challengeId?: number): string {
  if (role === "planner" || role === "worker") {
    if (!Number.isInteger(challengeId) || (challengeId ?? 0) < 1) {
      throw new Error(`角色 ${role} 的提示词必须绑定有效 Challenge ID`);
    }
    return path.join(config.promptsGeneratedDir, "challenges", String(challengeId), `${role}.system.md`);
  }
  if (challengeId !== undefined) throw new Error(`静态角色 ${role} 不接受 Challenge 提示词路径`);
  return path.join(config.promptsGeneratedDir, `${role}.system.md`);
}

function renderChallengePrompts(challenge: ChallengeRow): { planner: string; worker: string } {
  const vars = {
    GOAL: challenge.goal,
    ASSET: challenge.asset,
    CUSTOMIZATION: challenge.customization,
    MAX_TASK_CHARS: String(MAX_TASK_CHARS),
    MAX_TASK_NOTE_CHARS: String(MAX_TASK_NOTE_CHARS),
  };
  return {
    planner: renderTemplate(readTemplate("planner"), vars),
    worker: renderTemplate(readTemplate("worker"), vars),
  };
}

export function prepareManagerPrompt(): string {
  return writeGenerated("manager", readTemplate("manager"));
}

export interface InjectedPromptPaths {
  manager: string;
  compactor: string;
  challenges: Array<{ challenge_id: number; planner: string; worker: string }>;
}

export async function injectPrompts(): Promise<InjectedPromptPaths> {
  const goalRow = await getGoal();
  if (!goalRow) throw new Error("inject_prompts: goal 表为空，请先调用 start_contest");
  const challenges = await getChallenges();
  if (challenges.length === 0) throw new Error("inject_prompts: 当前没有任何 Challenge");
  const managerTemplate = readTemplate("manager");
  const compactorTemplate = readTemplate("compactor");
  const result: InjectedPromptPaths = {
    manager: prepareManagerPrompt(),
    compactor: writeGenerated("compactor", compactorTemplate),
    challenges: [],
  };
  if (fs.readFileSync(result.manager, "utf8") !== managerTemplate ||
      fs.readFileSync(result.compactor, "utf8") !== compactorTemplate) {
    throw new Error("inject_prompts: 静态提示词回读校验失败");
  }
  for (const challenge of challenges) {
    const rendered = renderChallengePrompts(challenge);
    const planner = writeGenerated("planner", rendered.planner, challenge.challenge_id);
    const worker = writeGenerated("worker", rendered.worker, challenge.challenge_id);
    if (fs.readFileSync(planner, "utf8") !== rendered.planner ||
        fs.readFileSync(worker, "utf8") !== rendered.worker) {
      throw new Error(`inject_prompts: Challenge #${challenge.challenge_id} 提示词回读校验失败`);
    }
    result.challenges.push({ challenge_id: challenge.challenge_id, planner, worker });
  }
  await pool.query("UPDATE challenge SET prompt_ready_at=now(), updated_at=now()");
  return result;
}

export function readGeneratedPrompt(role: Role, challengeId?: number): string {
  const file = generatedPromptPath(role, challengeId);
  if (!fs.existsSync(file)) throw new Error(`提示词文件不存在: ${file}（需要先执行 inject_prompts）`);
  return fs.readFileSync(file, "utf8");
}

export async function assertInjectedPromptsCurrent(): Promise<void> {
  if (!(await getGoal())) throw new Error("提示词校验失败：goal 表为空");
  if (readGeneratedPrompt("manager") !== readTemplate("manager")) throw new Error("提示词校验失败：manager 模板不是当前版本");
  if (readGeneratedPrompt("compactor") !== readTemplate("compactor")) throw new Error("提示词校验失败：compactor 模板不是当前版本");
  for (const challenge of await getChallenges()) {
    const expected = renderChallengePrompts(challenge);
    if (readGeneratedPrompt("planner", challenge.challenge_id) !== expected.planner) {
      throw new Error(`提示词校验失败：Challenge #${challenge.challenge_id} planner 不是当前赛题版本`);
    }
    if (readGeneratedPrompt("worker", challenge.challenge_id) !== expected.worker) {
      throw new Error(`提示词校验失败：Challenge #${challenge.challenge_id} worker 不是当前赛题版本`);
    }
  }
}

export function stripCommentLines(text: string): string {
  return text.split(/\r?\n/).filter((line) => !/^\s*<!--.*-->\s*$/.test(line)).join("\n").replace(/^\n+/, "");
}

export async function insertTask(challengeId: number, task: string, note: string): Promise<TaskRow> {
  assertChallengeId(challengeId, "insert_task");
  const normalizedTask = task?.trim();
  const normalizedNote = note?.trim();
  if (!normalizedTask) throw new Error("insert_task: task 不能为空");
  if (normalizedTask.length > MAX_TASK_CHARS) throw new Error(`insert_task: task 不能超过 ${MAX_TASK_CHARS} 字符`);
  if (!normalizedNote) throw new Error("insert_task: note 不能为空");
  if (normalizedNote.length > MAX_TASK_NOTE_CHARS) throw new Error(`insert_task: note 不能超过 ${MAX_TASK_NOTE_CHARS} 字符`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
    const counter = await client.query<{ last_task_id: number }>(
      "UPDATE task_id_state SET last_task_id = last_task_id + 1 WHERE id = 1 RETURNING last_task_id"
    );
    const taskId = counter.rows[0]?.last_task_id;
    if (!taskId) throw new Error("insert_task: task_id 高水位状态缺失");
    const inserted = await client.query<TaskRow>(
      `INSERT INTO task (task_id, challenge_id, task, note)
       SELECT $1, challenge_id, $2, $3 FROM challenge WHERE challenge_id = $4 AND status = 'active'
       RETURNING task_id, challenge_id, is_complete, task, note, fact, finding`,
      [taskId, normalizedTask, normalizedNote, challengeId]
    );
    if (!inserted.rows[0]) throw new Error(`insert_task: Challenge #${challengeId} 不是 active，禁止发布任务`);
    await client.query("COMMIT");
    return inserted.rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function acquireTaskExecutionLock(taskId: number): Promise<PoolClient | null> {
  assertTaskId(taskId, "task_execution_lock");
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
      [TASK_EXECUTION_LOCK_KEY, taskId]
    );
    if (!rows[0]?.acquired) {
      client.release();
      return null;
    }
    return client;
  } catch (e) {
    client.release();
    throw e;
  }
}

export async function releaseTaskExecutionLock(client: PoolClient, taskId: number): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [TASK_EXECUTION_LOCK_KEY, taskId]);
  } catch (e) {
    console.warn(`[task_execution_lock] 释放任务 #${taskId} 执行锁失败: ${(e as Error).message}`);
  } finally {
    client.release();
  }
}

export async function getTaskForExecution(taskId: number): Promise<TaskRow | null> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT t.task_id, t.challenge_id, t.is_complete, t.task, t.note, t.fact, t.finding
     FROM task t JOIN challenge c ON c.challenge_id = t.challenge_id
     WHERE t.task_id = $1 AND t.delete_requested_at IS NULL AND t.complete_requested_at IS NULL
       AND c.status = 'active' AND c.prompt_ready_at IS NOT NULL`,
    [taskId]
  );
  return rows[0] ?? null;
}

export async function getTaskDeletionRequestedIds(): Promise<number[]> {
  const { rows } = await pool.query<{ task_id: number }>(
    "SELECT task_id FROM task WHERE delete_requested_at IS NOT NULL ORDER BY task_id"
  );
  return rows.map((row) => row.task_id);
}

export async function getPendingTaskDeletionStopIds(): Promise<number[]> {
  const { rows } = await pool.query<{ task_id: number }>(
    "SELECT task_id FROM task WHERE delete_requested_at IS NOT NULL AND delete_stopped_at IS NULL ORDER BY task_id"
  );
  return rows.map((row) => row.task_id);
}

export async function getTaskCompletionRequestedIds(): Promise<number[]> {
  const { rows } = await pool.query<{ task_id: number }>(
    "SELECT task_id FROM task WHERE complete_requested_at IS NOT NULL ORDER BY task_id"
  );
  return rows.map((row) => row.task_id);
}

export async function getPendingTaskCompletionStopIds(): Promise<number[]> {
  const { rows } = await pool.query<{ task_id: number }>(
    "SELECT task_id FROM task WHERE complete_requested_at IS NOT NULL AND complete_stopped_at IS NULL ORDER BY task_id"
  );
  return rows.map((row) => row.task_id);
}

export async function markTaskCompletionStopped(taskId: number): Promise<void> {
  await pool.query(
    "UPDATE task SET complete_stopped_at = now() WHERE task_id = $1 AND complete_requested_at IS NOT NULL AND complete_stopped_at IS NULL",
    [taskId]
  );
}

export async function markTaskDeletionStopped(taskId: number): Promise<void> {
  await pool.query(
    "UPDATE task SET delete_stopped_at = now() WHERE task_id = $1 AND delete_requested_at IS NOT NULL AND delete_stopped_at IS NULL",
    [taskId]
  );
}

interface TaskDeleteGuardRow extends TaskRow {
  delete_requested_at: Date | null;
  delete_stopped_at: Date | null;
  complete_requested_at: Date | null;
}

export interface TaskDeleteResult {
  taskId: number;
  stoppedWorker: boolean;
}

function taskDeleteGuardError(row: TaskDeleteGuardRow | undefined, challengeId: number, taskId: number): string | null {
  if (!row) return `task_delete: Challenge #${challengeId} 中不存在任务 #${taskId}`;
  if (row.is_complete !== 0) return `task_delete: 任务 #${taskId} 已完成`;
  if (row.complete_requested_at) return `task_delete: 任务 #${taskId} 已有强制完成请求，禁止同时删除`;
  if (row.fact?.trim()) return `task_delete: 任务 #${taskId} 存在 fact，禁止删除`;
  if (row.finding?.trim()) return `task_delete: 任务 #${taskId} 存在 finding，禁止删除`;
  return null;
}

async function deleteTaskWithLock(client: PoolClient, challengeId: number, taskId: number): Promise<void> {
  await client.query("BEGIN");
  try {
    const current = await client.query<TaskDeleteGuardRow>(
      `SELECT task_id, challenge_id, is_complete, task, note, fact, finding, delete_requested_at, delete_stopped_at, complete_requested_at
       FROM task WHERE task_id = $1 AND challenge_id = $2 FOR UPDATE`,
      [taskId, challengeId]
    );
    const guard = taskDeleteGuardError(current.rows[0], challengeId, taskId);
    if (guard) {
      await client.query(
        "UPDATE task SET delete_requested_at=NULL, delete_requested_by=NULL, delete_stopped_at=NULL WHERE task_id=$1 AND challenge_id=$2",
        [taskId, challengeId]
      );
      await client.query("COMMIT");
      throw new Error(guard);
    }
    await client.query("DELETE FROM task WHERE task_id = $1 AND challenge_id = $2", [taskId, challengeId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

async function requestTaskDeletionStop(challengeId: number, taskId: number): Promise<void> {
  const result = await pool.query<TaskDeleteGuardRow>(
    `UPDATE task SET delete_requested_at=COALESCE(delete_requested_at, now()),
       delete_requested_by=COALESCE(delete_requested_by, 'planner'), delete_stopped_at=NULL
     WHERE task_id=$1 AND challenge_id=$2 AND is_complete=0 AND complete_requested_at IS NULL
       AND NULLIF(BTRIM(fact), '') IS NULL AND NULLIF(BTRIM(finding), '') IS NULL
     RETURNING task_id, challenge_id, is_complete, task, note, fact, finding, delete_requested_at, delete_stopped_at, complete_requested_at`,
    [taskId, challengeId]
  );
  if (result.rows[0]) return;
  const current = await pool.query<TaskDeleteGuardRow>(
    `SELECT task_id, challenge_id, is_complete, task, note, fact, finding, delete_requested_at, delete_stopped_at, complete_requested_at
     FROM task WHERE task_id=$1 AND challenge_id=$2`,
    [taskId, challengeId]
  );
  throw new Error(taskDeleteGuardError(current.rows[0], challengeId, taskId) ?? `task_delete: 任务 #${taskId} 当前不可删除`);
}

export async function deleteTask(challengeId: number, taskId: number): Promise<TaskDeleteResult> {
  assertChallengeId(challengeId, "task_delete");
  assertTaskId(taskId, "task_delete");
  const immediate = await acquireTaskExecutionLock(taskId);
  if (immediate) {
    try {
      await deleteTaskWithLock(immediate, challengeId, taskId);
      return { taskId, stoppedWorker: false };
    } finally {
      await releaseTaskExecutionLock(immediate, taskId);
    }
  }
  await requestTaskDeletionStop(challengeId, taskId);
  const deadline = Date.now() + TASK_DELETE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await pool.query<{ delete_stopped_at: Date | null }>(
      "SELECT delete_stopped_at FROM task WHERE task_id=$1 AND challenge_id=$2",
      [taskId, challengeId]
    );
    if (!state.rows[0]) throw new Error(`task_delete: 任务 #${taskId} 不存在`);
    if (state.rows[0].delete_stopped_at) {
      const stopped = await acquireTaskExecutionLock(taskId);
      if (stopped) {
        try {
          await deleteTaskWithLock(stopped, challengeId, taskId);
          return { taskId, stoppedWorker: true };
        } finally {
          await releaseTaskExecutionLock(stopped, taskId);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, TASK_DELETE_POLL_INTERVAL_MS));
  }
  throw new Error(`task_delete: 等待任务 #${taskId} 的 Worker 停止超时，任务尚未删除`);
}

export type TaskCompletionRequester = "planner";

export interface TaskCompletionResult {
  taskId: number;
  stoppedWorker: boolean;
  alreadyComplete: boolean;
  isComplete: boolean;
}

interface TaskCompletionGuardRow extends TaskRow {
  delete_requested_at: Date | null;
  complete_requested_at: Date | null;
  complete_stopped_at: Date | null;
}

function taskCompletionGuardError(row: TaskCompletionGuardRow | undefined, challengeId: number, taskId: number): string | null {
  if (!row) return `force_complete_task: Challenge #${challengeId} 中不存在任务 #${taskId}`;
  if (row.delete_requested_at) return `force_complete_task: 任务 #${taskId} 已有删除请求，禁止同时强制完成`;
  return null;
}

/** 持有任务执行锁时复查归属与治理状态；只推进未完成行，已有 fact/finding 原样保留。 */
async function completeTaskWithLock(
  client: PoolClient,
  challengeId: number,
  taskId: number
): Promise<{ alreadyComplete: boolean }> {
  await client.query("BEGIN");
  try {
    const current = await client.query<TaskCompletionGuardRow>(
      `SELECT task_id, challenge_id, is_complete, task, note, fact, finding,
         delete_requested_at, complete_requested_at, complete_stopped_at
       FROM task WHERE task_id=$1 AND challenge_id=$2 FOR UPDATE`,
      [taskId, challengeId]
    );
    const row = current.rows[0];
    const guard = taskCompletionGuardError(row, challengeId, taskId);
    if (guard) throw new Error(guard);
    const alreadyComplete = row!.is_complete === 1;
    await client.query(
      `UPDATE task SET is_complete=1,
         complete_requested_at=NULL, complete_requested_by=NULL, complete_stopped_at=NULL,
         updated_at=CASE WHEN is_complete=0 THEN now() ELSE updated_at END
       WHERE task_id=$1 AND challenge_id=$2`,
      [taskId, challengeId]
    );
    await client.query("COMMIT");
    return { alreadyComplete };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** 返回 true 表示必须继续等待停止确认；false 表示任务已完成且没有未收尾的强制完成请求。 */
async function requestTaskCompletionStop(
  challengeId: number,
  taskId: number,
  requester: TaskCompletionRequester
): Promise<boolean> {
  const requested = await pool.query<TaskCompletionGuardRow>(
    `UPDATE task SET complete_requested_at=COALESCE(complete_requested_at, now()),
       complete_requested_by=COALESCE(complete_requested_by, $3), complete_stopped_at=NULL
     WHERE task_id=$1 AND challenge_id=$2 AND is_complete=0 AND delete_requested_at IS NULL
     RETURNING task_id, challenge_id, is_complete, task, note, fact, finding,
       delete_requested_at, complete_requested_at, complete_stopped_at`,
    [taskId, challengeId, requester]
  );
  if (requested.rows[0]) return true;
  const current = await pool.query<TaskCompletionGuardRow>(
    `SELECT task_id, challenge_id, is_complete, task, note, fact, finding,
       delete_requested_at, complete_requested_at, complete_stopped_at
     FROM task WHERE task_id=$1 AND challenge_id=$2`,
    [taskId, challengeId]
  );
  const row = current.rows[0];
  const guard = taskCompletionGuardError(row, challengeId, taskId);
  if (guard) throw new Error(guard);
  if (row!.complete_requested_at) return true;
  if (row!.is_complete === 1) return false;
  throw new Error(`force_complete_task: 任务 #${taskId} 当前不可强制完成`);
}

/**
 * Planner 的任务治理入口。若执行锁被 Worker 持有，先登记数据库停止请求，
 * 等编排器确认 Worker 完整退出并释放锁后才最终写入，绝不追加异常 finding。
 */
export async function completeTaskByRequester(
  challengeId: number,
  taskId: number,
  requester: TaskCompletionRequester
): Promise<TaskCompletionResult> {
  assertChallengeId(challengeId, "force_complete_task");
  assertTaskId(taskId, "force_complete_task");
  if (requester !== "planner") throw new Error("force_complete_task: 当前多赛题架构只允许 planner 强制完成");

  const immediate = await acquireTaskExecutionLock(taskId);
  if (immediate) {
    try {
      const result = await completeTaskWithLock(immediate, challengeId, taskId);
      return { taskId, stoppedWorker: false, alreadyComplete: result.alreadyComplete, isComplete: true };
    } finally {
      await releaseTaskExecutionLock(immediate, taskId);
    }
  }

  const needsStop = await requestTaskCompletionStop(challengeId, taskId, requester);
  if (!needsStop) return { taskId, stoppedWorker: false, alreadyComplete: true, isComplete: true };
  const deadline = Date.now() + TASK_COMPLETE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await pool.query<TaskCompletionGuardRow>(
      `SELECT task_id, challenge_id, is_complete, task, note, fact, finding,
         delete_requested_at, complete_requested_at, complete_stopped_at
       FROM task WHERE task_id=$1 AND challenge_id=$2`,
      [taskId, challengeId]
    );
    const row = state.rows[0];
    const guard = taskCompletionGuardError(row, challengeId, taskId);
    if (guard) throw new Error(guard);
    // 另一个并发请求可能已完成最终写入；只有临时请求已清理后才允许返回。
    if (row!.is_complete === 1 && !row!.complete_requested_at) {
      return { taskId, stoppedWorker: true, alreadyComplete: true, isComplete: true };
    }
    if (!row!.complete_requested_at) throw new Error(`force_complete_task: 任务 #${taskId} 的强制完成请求已失效`);
    if (row!.complete_stopped_at) {
      const stopped = await acquireTaskExecutionLock(taskId);
      if (stopped) {
        try {
          const result = await completeTaskWithLock(stopped, challengeId, taskId);
          return { taskId, stoppedWorker: true, alreadyComplete: result.alreadyComplete, isComplete: true };
        } finally {
          await releaseTaskExecutionLock(stopped, taskId);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, TASK_COMPLETE_POLL_INTERVAL_MS));
  }
  throw new Error(`force_complete_task: 等待任务 #${taskId} 的 Worker 停止超时，任务尚未强制完成`);
}

export async function writeFact(challengeId: number, taskId: number, fact: string, factDetail: string): Promise<TaskRow> {
  assertChallengeId(challengeId, "write_fact");
  assertTaskId(taskId, "write_fact");
  const summary = fact?.trim();
  const detail = factDetail?.trim();
  if (!summary) throw new Error("write_fact: fact 概括不能为空");
  if (summary.length > MAX_FACT_CHARS) throw new Error(`write_fact: fact 不能超过 ${MAX_FACT_CHARS} 字符`);
  if (!detail) throw new Error("write_fact: fact_detail 不能为空");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<TaskRow>(
      `UPDATE task SET fact=CASE WHEN fact IS NULL OR fact='' THEN $3 ELSE fact || '、' || $3 END, updated_at=now()
       WHERE task_id=$1 AND challenge_id=$2
       RETURNING task_id, challenge_id, is_complete, task, note, fact, finding`,
      [taskId, challengeId, `[${summary}]`]
    );
    if (!updated.rows[0]) throw new Error(`write_fact: Challenge #${challengeId} 中不存在任务 #${taskId}`);
    await client.query("INSERT INTO detail (challenge_id, fact, fact_detail) VALUES ($1, $2, $3)", [challengeId, summary, detail]);
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string }).code === "23505") throw new Error(`write_fact: 本题 fact 概括已存在: ${summary}`);
    throw e;
  } finally {
    client.release();
  }
}

function unwrapSummary(value: string): string {
  const input = value?.trim();
  return input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1).trim() : input;
}

export async function getFactDetail(challengeId: number, fact: string): Promise<string> {
  assertChallengeId(challengeId, "get_fact_detail");
  const summary = unwrapSummary(fact);
  if (!summary) throw new Error("get_fact_detail: fact 不能为空");
  const { rows } = await pool.query<DetailRow>(
    "SELECT challenge_id, fact, fact_detail FROM detail WHERE challenge_id=$1 AND fact=$2",
    [challengeId, summary]
  );
  if (!rows[0]) throw new Error(`get_fact_detail: 本题未找到 fact: ${summary}`);
  return rows[0].fact_detail;
}

function parseTaskFindings(value: string | null): string[] {
  if (!value?.trim()) return [];
  const text = value.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return [text];
  return text.slice(1, -1).split(/\]\s*(?:、|\n\n---\n\n)\s*\[/);
}

export async function getFindingDetail(challengeId: number, finding: string): Promise<string> {
  assertChallengeId(challengeId, "get_finding_detail");
  const summary = unwrapSummary(finding);
  if (!summary) throw new Error("get_finding_detail: finding 不能为空");
  const detail = await pool.query<Detail2Row>(
    "SELECT challenge_id, finding, finding_detail FROM detail2 WHERE challenge_id=$1 AND finding=$2",
    [challengeId, summary]
  );
  if (detail.rows[0]) return detail.rows[0].finding_detail;
  const tasks = await pool.query<{ finding: string | null; compressed_at: Date | null }>(
    "SELECT finding, compressed_at FROM task WHERE challenge_id=$1",
    [challengeId]
  );
  if (tasks.rows.some((row) => !row.compressed_at && parseTaskFindings(row.finding).includes(summary))) {
    return `该 finding 已经为详细版本，无需查询 finding_detail: ${summary}`;
  }
  throw new Error(`get_finding_detail: 本题未找到 finding: ${summary}`);
}

async function appendFinding(challengeId: number, taskId: number, finding: string): Promise<TaskRow> {
  assertChallengeId(challengeId, "write_finding");
  assertTaskId(taskId, "write_finding");
  if (!finding?.trim()) throw new Error("write_finding: 内容不能为空");
  const { rows } = await pool.query<TaskRow>(
    `UPDATE task SET finding=CASE WHEN finding IS NULL OR finding='' THEN $3 ELSE finding || '、' || $3 END, updated_at=now()
     WHERE task_id=$1 AND challenge_id=$2
     RETURNING task_id, challenge_id, is_complete, task, note, fact, finding`,
    [taskId, challengeId, `[${finding.trim()}]`]
  );
  if (!rows[0]) throw new Error(`write_finding: Challenge #${challengeId} 中不存在任务 #${taskId}`);
  return rows[0];
}

export async function writeFinding(challengeId: number, taskId: number, finding: string): Promise<TaskRow> {
  return appendFinding(challengeId, taskId, finding);
}

export async function completeTask(challengeId: number, taskId: number): Promise<TaskRow> {
  assertChallengeId(challengeId, "complete_task");
  assertTaskId(taskId, "complete_task");
  const { rows } = await pool.query<TaskRow>(
    `UPDATE task SET is_complete=1, updated_at=now() WHERE task_id=$1 AND challenge_id=$2
     RETURNING task_id, challenge_id, is_complete, task, note, fact, finding`,
    [taskId, challengeId]
  );
  if (!rows[0]) throw new Error(`complete_task: Challenge #${challengeId} 中不存在任务 #${taskId}`);
  return rows[0];
}

/** 仅编排器可按全局唯一 task_id 强制补完成；该函数不暴露给 Agent。治理请求优先，禁止竞态补写异常。 */
export async function forceComplete(taskId: number, reason: string): Promise<TaskRow> {
  assertTaskId(taskId, "force_complete");
  const { rows } = await pool.query<TaskRow>(
    `UPDATE task SET finding=CASE WHEN finding IS NULL OR finding='' THEN $2 ELSE finding || '、' || $2 END,
       is_complete=1, updated_at=now()
     WHERE task_id=$1 AND delete_requested_at IS NULL AND complete_requested_at IS NULL
     RETURNING task_id, challenge_id, is_complete, task, note, fact, finding`,
    [taskId, `[任务执行异常。原因: ${reason}]`]
  );
  if (!rows[0]) throw new Error(`force_complete: task_id=${taskId} 不存在或已有删除/强制完成请求`);
  return rows[0];
}

export interface CompressionTaskRow extends TaskRow {
  compressed_at: Date | null;
}

export function assertCompressionBatch(batch: CompressionTaskRow[]): void {
  const ids = batch.map((row) => row.task_id);
  if (batch.length !== COMPACTOR_BATCH_SIZE) throw new Error(`Compactor 批次必须恰好包含 ${COMPACTOR_BATCH_SIZE} 个任务`);
  if (new Set(batch.map((row) => row.challenge_id)).size !== 1) throw new Error("Compactor 批次不得跨 Challenge");
  for (let index = 0; index < batch.length; index++) {
    const row = batch[index]!;
    if (!Number.isInteger(row.task_id) || row.task_id < 1 || (index > 0 && row.task_id <= batch[index - 1]!.task_id)) {
      throw new Error(`Compactor 批次 task_id 必须严格递增: ${ids.join(",")}`);
    }
    if (row.compressed_at) throw new Error(`Compactor 批次任务 #${row.task_id} 已压缩`);
  }
}

export async function getDueCompressionBatch(challengeId: number): Promise<CompressionTaskRow[]> {
  assertChallengeId(challengeId, "get_due_compression_batch");
  // task_id 在多题间交错分配，不能用 max(task_id)-retain 表示本题保留区。
  // cutoff 包含已压缩行，确保首批在每题 FIRST_TRIGGER 行时到期，之后每新增 10 行到期。
  const { rows } = await pool.query<CompressionTaskRow>(
    `WITH cutoff AS (
       SELECT task_id AS cutoff_task_id FROM task
       WHERE challenge_id=$1 ORDER BY task_id DESC OFFSET $2 LIMIT 1
     )
     SELECT t.task_id, t.challenge_id, t.is_complete, t.task, t.note, t.fact, t.finding, t.compressed_at FROM task t
     JOIN cutoff c ON t.task_id <= c.cutoff_task_id
     WHERE t.challenge_id=$1 AND t.compressed_at IS NULL AND t.delete_requested_at IS NULL AND t.complete_requested_at IS NULL
     ORDER BY t.task_id LIMIT $3`,
    [challengeId, COMPACTOR_RETAIN_TASKS, COMPACTOR_BATCH_SIZE]
  );
  return rows.length === COMPACTOR_BATCH_SIZE ? rows : [];
}

export interface CompactedTaskInput {
  task_id: number;
  task: string;
  findings: string[];
}

export async function compressTaskBatch(originals: CompressionTaskRow[], items: CompactedTaskInput[]): Promise<void> {
  assertCompressionBatch(originals);
  const challengeId = originals[0]!.challenge_id;
  if (!Array.isArray(items) || items.length !== COMPACTOR_BATCH_SIZE) throw new Error("compress_task_batch: 必须提交恰好10个任务");
  const expectedIds = originals.map((row) => row.task_id);
  const byId = new Map<number, CompactedTaskInput>();
  for (const item of items) {
    if (!expectedIds.includes(item.task_id)) throw new Error(`compress_task_batch: 非本批次 task_id=${item.task_id}`);
    if (byId.has(item.task_id)) throw new Error(`compress_task_batch: task_id=${item.task_id} 重复`);
    byId.set(item.task_id, item);
  }
  const prepared = originals.map((original) => {
    const item = byId.get(original.task_id);
    if (!item) throw new Error(`compress_task_batch: 缺少任务 #${original.task_id}`);
    if (original.finding === COMPACTOR_TIMEOUT_ONLY_FINDING) {
      return { taskId: original.task_id, task: "", finding: null as string | null, findingDetails: [] as Array<{ finding: string; finding_detail: string }> };
    }
    const task = item.task?.trim();
    if (!task || task.length > MAX_COMPACTED_TASK_CHARS) throw new Error(`compress_task_batch: 任务 #${original.task_id} 的 task 摘要为空或超过30字符`);
    const originalFindings = parseTaskFindings(original.finding);
    if (!Array.isArray(item.findings) || item.findings.length !== originalFindings.length) {
      throw new Error(`compress_task_batch: 任务 #${original.task_id} 应有 ${originalFindings.length} 条 finding 摘要`);
    }
    const findings = item.findings.map((value, index) => {
      const summary = value?.trim();
      if (!summary || summary.length > MAX_COMPACTED_FINDING_CHARS) {
        throw new Error(`compress_task_batch: 任务 #${original.task_id} 第 ${index + 1} 条 finding 摘要为空或超过100字符`);
      }
      return summary;
    });
    return {
      taskId: original.task_id,
      task,
      finding: originalFindings.length === 0 ? original.finding : findings.map((value) => `[${value}]`).join("、"),
      findingDetails: findings.map((finding, index) => ({ finding, finding_detail: originalFindings[index]! })),
    };
  });
  const owners = new Map<string, number>();
  for (const item of prepared) {
    for (const detail of item.findingDetails) {
      if (owners.has(detail.finding)) throw new Error(`compress_task_batch: 本题 finding 摘要重复: ${detail.finding}`);
      owners.set(detail.finding, item.taskId);
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<CompressionTaskRow>(
      `SELECT task_id, challenge_id, is_complete, task, note, fact, finding, compressed_at FROM task
       WHERE challenge_id=$1 AND task_id=ANY($2::int[]) ORDER BY task_id FOR UPDATE`,
      [challengeId, expectedIds]
    );
    if (locked.rows.length !== COMPACTOR_BATCH_SIZE) throw new Error("compress_task_batch: 数据库批次已变化");
    for (let index = 0; index < originals.length; index++) {
      const before = originals[index]!;
      const current = locked.rows[index]!;
      if (current.task_id !== before.task_id || current.challenge_id !== before.challenge_id || current.compressed_at ||
          current.task !== before.task || current.note !== before.note || current.finding !== before.finding) {
        throw new Error(`compress_task_batch: 任务 #${before.task_id} 在压缩期间已变化`);
      }
    }
    for (const item of prepared) {
      for (const detail of item.findingDetails) {
        await client.query("INSERT INTO detail2 (challenge_id, finding, finding_detail) VALUES ($1, $2, $3)", [challengeId, detail.finding, detail.finding_detail]);
      }
      await client.query(
        "UPDATE task SET task=$2, note='', finding=$3, compressed_at=now(), updated_at=now() WHERE task_id=$1 AND challenge_id=$4",
        [item.taskId, item.task, item.finding, challengeId]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string }).code === "23505") throw new Error("compress_task_batch: 本题 finding 摘要重复，请补充区分信息");
    throw e;
  } finally {
    client.release();
  }
}

export async function renderTaskSnapshot(challengeId: number, viewer: "planner" | "worker"): Promise<string> {
  assertChallengeId(challengeId, "render_task_snapshot");
  const tasks = await getAllTasks(challengeId);
  if (tasks.length === 0) return "（本题 task 表当前为空）";
  return tasks.map((task) => {
    const fact = `fact（环境类信息）: ${task.fact ?? "（无）"}`;
    const finding = `finding（任务结果）: ${task.finding ?? "（无）"}`;
    if (viewer === "worker") return [`## 任务 #${task.task_id}`, fact, finding].join("\n");
    return [
      `## 任务 #${task.task_id} [${task.is_complete ? "已完成" : "未完成"}]`,
      `任务内容: ${task.task}`,
      `note（任务意义与后续操作建议）: ${task.note || "（无）"}`,
      fact,
      finding,
    ].join("\n");
  }).join("\n\n");
}

function fileStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, "0")}`;
}

export interface ReportResult {
  file: string;
  taskCount: number;
}

function escapeTable(value: string | null | undefined): string {
  return (value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

/** 单题报告只读取绑定 Challenge；普通终态会在同一事务内把该题标记 completed。 */
export async function generateReport(
  challengeId: number,
  conclusion: string,
  opts: { interrupted?: boolean } = {}
): Promise<ReportResult> {
  assertChallengeId(challengeId, "generate_report");
  const client = await pool.connect();
  let file: string | undefined;
  try {
    await client.query("BEGIN");
    const challengeResult = await client.query<ChallengeRow>(
      `SELECT challenge_id, name, asset, customization, goal, status, status_reason, report_file, created_at, updated_at
       FROM challenge WHERE challenge_id=$1 FOR UPDATE`,
      [challengeId]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge || challenge.status !== "active") throw new Error(`generate_report: Challenge #${challengeId} 不是 active`);
    const taskResult = await client.query<TaskRow>(
      `SELECT task_id, challenge_id, is_complete, task, note, fact, finding FROM task
       WHERE challenge_id=$1 ORDER BY task_id FOR UPDATE`,
      [challengeId]
    );
    const tasks = taskResult.rows;
    // 报告前逐一尝试本题任务执行锁，防止仍在收尾的 Worker 与 completed 状态并存。
    for (const task of tasks) {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS acquired",
        [TASK_EXECUTION_LOCK_KEY, task.task_id]
      );
      if (!lock.rows[0]?.acquired) throw new Error(`generate_report: 任务 #${task.task_id} 的 Worker 仍在运行，暂不能结束本题`);
    }
    const incomplete = tasks.filter((task) => task.is_complete === 0).length;
    if (!opts.interrupted && incomplete > 0) throw new Error(`generate_report: 本题仍有 ${incomplete} 个未完成任务`);
    const stamp = fileStamp();
    file = path.join(config.reportDir, `challenge-${challengeId}-${stamp}.md`);
    const summary = (label: string, pick: (task: TaskRow) => string | null) => {
      const rows = tasks.filter((task) => pick(task));
      return `### ${label}\n\n${rows.length ? rows.map((task) => `- **任务 #${task.task_id}**: ${pick(task)}`).join("\n") : "（无）"}\n`;
    };
    const md = `# Challenge #${challengeId} ${challenge.name} — ${opts.interrupted ? "阶段性中断报告" : "终态报告"}

${opts.interrupted ? `> **用户通过 Ctrl+C/SIGTERM 主动停止；本题仍为 active，当前有 ${incomplete} 个未完成任务。本报告不代表 goal 已达成。**\n\n` : ""}## 1. 本题目标

- **asset**: ${challenge.asset}
- **customization**: ${challenge.customization || "（无）"}
- **goal**: ${challenge.goal}

## 2. 结论

${conclusion?.trim() || "（Planner 未提供结论）"}

## 3. Findings

${summary("Findings", (task) => task.finding)}
## 4. Facts

${summary("Facts", (task) => task.fact)}
## 5. 任务明细

| task_id | 状态 | 任务内容 | note | fact | finding |
|---|---|---|---|---|---|
${tasks.map((task) => `| ${task.task_id} | ${task.is_complete ? "完成" : "未完成"} | ${escapeTable(task.task)} | ${escapeTable(task.note)} | ${escapeTable(task.fact)} | ${escapeTable(task.finding)} |`).join("\n")}

---
*仅包含 Challenge #${challengeId} 的实时数据库记录。*
`;
    fs.mkdirSync(config.reportDir, { recursive: true });
    fs.writeFileSync(file, md, { encoding: "utf8", flag: "wx" });
    const relative = path.relative(config.root, file);
    await client.query(
      opts.interrupted
        ? "UPDATE challenge SET report_file=$2, updated_at=now() WHERE challenge_id=$1"
        : "UPDATE challenge SET status='completed', status_reason=$2, report_file=$3, updated_at=now() WHERE challenge_id=$1 AND status='active'",
      opts.interrupted ? [challengeId, relative] : [challengeId, conclusion?.trim() || "已完成", relative]
    );
    await client.query("COMMIT");
    return { file, taskCount: tasks.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (file) fs.rmSync(file, { force: true });
    throw e;
  } finally {
    client.release();
  }
}

export interface ContestSummaryResult {
  file: string;
  challengeCount: number;
  failedCount: number;
  publicationStatus: ContestPublicationStatus;
  publicationFailed: boolean;
}

export async function generateContestSummary(opts: { interrupted?: boolean } = {}): Promise<ContestSummaryResult> {
  const goal = await getGoal();
  const challenges = await getChallenges();
  const publication = await getContestPublication();
  const publicationStatus = publication?.status ?? "finalized";
  if (opts.interrupted && (!goal || challenges.length === 0)) {
    const file = path.join(config.reportDir, `contest-summary-${fileStamp()}.md`);
    const md = `# CTF 赛事中断汇总

> **用户在 Manager 发布首题前主动停止。**

- 赛事 asset: ${goal?.asset || "（尚未初始化）"}
- 赛事 goal: ${goal?.goal || "（尚未初始化）"}
- Challenge 发布状态: ${publication?.status ?? "incomplete"}
- 发布错误: ${publication?.error || "（无）"}
- Challenge 数: 0
`;
    fs.mkdirSync(config.reportDir, { recursive: true });
    fs.writeFileSync(file, md, { encoding: "utf8", flag: "wx" });
    return {
      file,
      challengeCount: 0,
      failedCount: 0,
      publicationStatus: publication?.status ?? "incomplete",
      publicationFailed: true,
    };
  }
  if (!goal || challenges.length === 0) throw new Error("contest-summary: 当前赛事为空");
  if (!opts.interrupted && publicationStatus === "publishing") {
    throw new Error("contest-summary: Challenge 发布尚未结束，禁止生成整场终态汇总");
  }
  if (!opts.interrupted && await countUnreadyChallenges() > 0) {
    throw new Error("contest-summary: 仍有提示词未就绪的 Challenge");
  }
  if (!opts.interrupted && challenges.some((challenge) => challenge.status === "queued" || challenge.status === "active")) {
    throw new Error("contest-summary: 仍有 queued/active Challenge，禁止生成整场终态汇总");
  }
  const sections: string[] = [];
  for (const challenge of challenges) {
    const tasks = await getAllTasks(challenge.challenge_id);
    const findings = tasks.filter((task) => task.finding).map((task) => `- 任务 #${task.task_id}: ${task.finding}`).join("\n") || "（无）";
    sections.push(`## Challenge #${challenge.challenge_id} ${challenge.name}

- 状态: ${challenge.status}
- 原因/结论: ${challenge.status_reason || "（无）"}
- 报告: ${challenge.report_file || "（未生成）"}

### 主要 finding

${findings}`);
  }
  const failedCount = challenges.filter((challenge) => challenge.status === "failed").length;
  const publicationFailed = publicationStatus === "failed" || publicationStatus === "incomplete";
  const file = path.join(config.reportDir, `contest-summary-${fileStamp()}.md`);
  const md = `# CTF 赛事${opts.interrupted ? "中断" : "终态"}汇总

${opts.interrupted ? "> **用户通过 Ctrl+C/SIGTERM 主动停止；active 赛题尚未完成。**\n\n" : ""}- 赛事 asset: ${goal.asset}
- 赛事 customization: ${goal.customization || "（无）"}
- 赛事 goal: ${goal.goal}
- Challenge 发布状态: ${publicationStatus}
- 发布错误: ${publication?.error || "（无）"}
- Challenge 数: ${challenges.length}
- failed 数: ${failedCount}

${sections.join("\n\n")}
`;
  fs.mkdirSync(config.reportDir, { recursive: true });
  fs.writeFileSync(file, md, { encoding: "utf8", flag: "wx" });
  return { file, challengeCount: challenges.length, failedCount, publicationStatus, publicationFailed };
}

// ---- history_db v2：manifest + 每题独立 JSON；读取时完整校验后才允许事务恢复。 ----

type HistoryDate = Date | string;
interface HistoryGoal extends GoalRow { id: number; created_at: HistoryDate }
interface HistoryChallenge extends Omit<ChallengeRow, "created_at" | "updated_at"> {
  created_at: HistoryDate;
  updated_at: HistoryDate;
  prompt_ready_at?: HistoryDate | null;
}
interface HistoryPublication {
  status: ContestPublicationStatus;
  error: string | null;
  started_at: HistoryDate;
  finished_at: HistoryDate | null;
}
export type DatabaseHistoryTaskRow = TaskRow & { compressed_at?: HistoryDate | null };

interface ContestHistoryManifest {
  format: "param-ctf-contest-history";
  version: 2;
  exported_at: string;
  goal: HistoryGoal | null;
  publication?: HistoryPublication | null;
  last_task_id: number;
  challenges: Array<{ challenge_id: number; file: string; status: ChallengeStatus }>;
}

interface ChallengeHistoryFile {
  format: "param-ctf-challenge-history";
  version: 2;
  challenge_id: number;
  challenge: HistoryChallenge;
  task: DatabaseHistoryTaskRow[];
  detail: DetailRow[];
  detail2: Detail2Row[];
}

interface LoadedContestHistory {
  directory?: string;
  manifest: ContestHistoryManifest;
  files: ChallengeHistoryFile[];
}

export interface ContinuableHistorySummary {
  file: string;
  exportedAt: string;
  asset: string;
  goal: string;
  taskCount: number;
  incompleteCount: number;
  challengeCount: number;
  activeCount: number;
  publicationStatus: ContestPublicationStatus;
}

const TERMINAL_STATUSES = new Set<ChallengeStatus>(["completed", "skipped", "failed"]);
const ALL_STATUSES = new Set<ChallengeStatus>(["queued", "active", "completed", "skipped", "failed"]);
const PUBLICATION_STATUSES = new Set<ContestPublicationStatus>(["publishing", "finalized", "failed", "incomplete"]);

function effectivePublication(manifest: ContestHistoryManifest): HistoryPublication {
  return manifest.publication ?? {
    status: "finalized",
    error: null,
    started_at: manifest.exported_at,
    finished_at: manifest.exported_at,
  };
}

function validatePublicationHistory(manifest: ContestHistoryManifest, source: string): void {
  const publication = manifest.publication;
  if (publication == null) return;
  if (!PUBLICATION_STATUSES.has(publication.status) ||
      (publication.error !== null && typeof publication.error !== "string") ||
      !publication.started_at) {
    throw new Error(`历史发布状态无效: ${source}`);
  }
}

function validateHistoryGoal(goal: HistoryGoal | null, source: string): void {
  if (goal !== null && (!goal || typeof goal.asset !== "string" || typeof goal.customization !== "string" || typeof goal.goal !== "string")) {
    throw new Error(`历史 goal 结构无效: ${source}`);
  }
}

function validateChallengeHistory(file: ChallengeHistoryFile, source: string): void {
  if (file.format !== "param-ctf-challenge-history" || file.version !== 2 || !Number.isInteger(file.challenge_id) || file.challenge_id < 1) {
    throw new Error(`Challenge 历史格式无效: ${source}`);
  }
  const challenge = file.challenge;
  if (!challenge || challenge.challenge_id !== file.challenge_id || typeof challenge.name !== "string" ||
      typeof challenge.asset !== "string" || typeof challenge.customization !== "string" || typeof challenge.goal !== "string" ||
      !ALL_STATUSES.has(challenge.status)) throw new Error(`Challenge 历史主体无效: ${source}`);
  if (!Array.isArray(file.task) || !Array.isArray(file.detail) || !Array.isArray(file.detail2)) throw new Error(`Challenge 历史缺少数组: ${source}`);
  for (const row of file.task) {
    if (row.challenge_id !== file.challenge_id || !Number.isInteger(row.task_id) || row.task_id < 1 ||
        (row.is_complete !== 0 && row.is_complete !== 1) || typeof row.task !== "string" || typeof row.note !== "string") {
      throw new Error(`历史 task 串题或结构无效: ${source}`);
    }
  }
  for (const row of file.detail) {
    if (row.challenge_id !== file.challenge_id || typeof row.fact !== "string" || typeof row.fact_detail !== "string") {
      throw new Error(`历史 detail 串题或结构无效: ${source}`);
    }
  }
  for (const row of file.detail2) {
    if (row.challenge_id !== file.challenge_id || typeof row.finding !== "string" || typeof row.finding_detail !== "string") {
      throw new Error(`历史 detail2 串题或结构无效: ${source}`);
    }
  }
}

function readV2History(directory: string): LoadedContestHistory {
  const manifestFile = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as ContestHistoryManifest;
  if (manifest.format !== "param-ctf-contest-history" || manifest.version !== 2 ||
      !Number.isInteger(manifest.last_task_id) || manifest.last_task_id < 0 || !Array.isArray(manifest.challenges)) {
    throw new Error(`历史 manifest 格式无效: ${manifestFile}`);
  }
  validateHistoryGoal(manifest.goal, manifestFile);
  validatePublicationHistory(manifest, manifestFile);
  const files: ChallengeHistoryFile[] = [];
  const ids = new Set<number>();
  for (const entry of manifest.challenges) {
    if (!Number.isInteger(entry.challenge_id) || entry.challenge_id < 1 || ids.has(entry.challenge_id) ||
        entry.file !== `challenge-${entry.challenge_id}.json` || !ALL_STATUSES.has(entry.status)) {
      throw new Error(`历史 manifest 文件索引无效: ${manifestFile}`);
    }
    ids.add(entry.challenge_id);
    const filePath = path.join(directory, entry.file);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ChallengeHistoryFile;
    if (parsed.challenge_id !== entry.challenge_id || parsed.challenge?.status !== entry.status) {
      throw new Error(`历史 manifest 与 Challenge 文件不一致: ${filePath}`);
    }
    validateChallengeHistory(parsed, filePath);
    files.push(parsed);
  }
  const taskIds = new Set<number>();
  let maxTaskId = 0;
  for (const file of files) {
    for (const task of file.task) {
      if (taskIds.has(task.task_id)) throw new Error(`历史 task_id 全局重复: ${task.task_id}`);
      taskIds.add(task.task_id);
      maxTaskId = Math.max(maxTaskId, task.task_id);
    }
  }
  if (maxTaskId > manifest.last_task_id) throw new Error("历史 task_id 超过 manifest 高水位");
  return { directory, manifest, files };
}

/** 兼容现有 version=1 单目标 JSON；planner_append/monitor 数据不进入新系统。 */
function readV1History(file: string): LoadedContestHistory {
  const old = JSON.parse(fs.readFileSync(file, "utf8")) as {
    format?: string; version?: number; exported_at?: string; goal?: HistoryGoal | null;
    task?: Array<Omit<DatabaseHistoryTaskRow, "challenge_id">>; detail?: Array<Omit<DetailRow, "challenge_id">>;
    detail2?: Array<Omit<Detail2Row, "challenge_id">>; last_task_id?: number;
    halt_request?: Array<{ reason?: string }>; planner_append?: unknown[];
  };
  if (old.format !== "param-database-history" || old.version !== 1 || !Array.isArray(old.task) || !Array.isArray(old.detail) ||
      (old.detail2 !== undefined && !Array.isArray(old.detail2))) throw new Error(`旧历史文件格式无效: ${file}`);
  validateHistoryGoal(old.goal ?? null, file);
  const skipReason = old.halt_request?.[0]?.reason;
  const challenge: HistoryChallenge = {
    challenge_id: 1,
    name: "legacy",
    asset: old.goal?.asset ?? "旧版单目标数据",
    customization: old.goal?.customization ?? "",
    goal: old.goal?.goal ?? "恢复旧版单目标任务数据",
    status: skipReason ? "skipped" : old.task.length > 0 && old.task.every((task) => task.is_complete === 1) ? "completed" : "active",
    status_reason: skipReason ?? null,
    report_file: null,
    created_at: old.exported_at ?? new Date().toISOString(),
    updated_at: old.exported_at ?? new Date().toISOString(),
  };
  const converted: ChallengeHistoryFile = {
    format: "param-ctf-challenge-history",
    version: 2,
    challenge_id: 1,
    challenge,
    task: old.task.map((row) => ({ ...row, challenge_id: 1 })),
    detail: old.detail.map((row) => ({ ...row, challenge_id: 1 })),
    detail2: (old.detail2 ?? []).map((row) => ({ ...row, challenge_id: 1 })),
  };
  validateChallengeHistory(converted, file);
  const maxTaskId = converted.task.reduce((max, row) => Math.max(max, row.task_id), 0);
  const restoredHighWater = Math.max(old.last_task_id ?? 0, maxTaskId);
  console.log(`[history] 已将 version=1 单目标历史迁移为一道 Challenge；忽略 ${old.planner_append?.length ?? 0} 条 planner_append`);
  return {
    manifest: {
      format: "param-ctf-contest-history",
      version: 2,
      exported_at: old.exported_at ?? "",
      goal: old.goal ?? null,
      publication: {
        status: "finalized",
        error: null,
        started_at: old.exported_at ?? new Date().toISOString(),
        finished_at: old.exported_at ?? new Date().toISOString(),
      },
      last_task_id: restoredHighWater,
      challenges: [{ challenge_id: 1, file: "challenge-1.json", status: challenge.status }],
    },
    files: [converted],
  };
}

function readAnyHistory(reference: string): LoadedContestHistory {
  const stat = fs.statSync(reference);
  return stat.isDirectory() ? readV2History(reference) : readV1History(reference);
}

function historySummary(file: string, history: LoadedContestHistory): ContinuableHistorySummary {
  if (!history.manifest.goal) throw new Error(`历史没有 goal，无法续跑: ${file}`);
  const tasks = history.files.flatMap((entry) => entry.task);
  return {
    file,
    exportedAt: history.manifest.exported_at,
    asset: history.manifest.goal.asset,
    goal: history.manifest.goal.goal,
    taskCount: tasks.length,
    incompleteCount: tasks.filter((task) => task.is_complete === 0).length,
    challengeCount: history.files.length,
    activeCount: history.files.filter((entry) => entry.challenge.status === "active").length,
    publicationStatus: effectivePublication(history.manifest).status,
  };
}

export function listContinuableHistory(): ContinuableHistorySummary[] {
  if (!fs.existsSync(config.historyDir)) return [];
  const entries = fs.readdirSync(config.historyDir)
    .filter((name) => /^param-contest-/.test(name) || /^param-db-.*\.json$/.test(name))
    .sort().reverse();
  const result: ContinuableHistorySummary[] = [];
  for (const name of entries) {
    const file = path.join(config.historyDir, name);
    try {
      const history = readAnyHistory(file);
      if (history.manifest.goal) result.push(historySummary(file, history));
    } catch {
      // 自动列表忽略损坏历史；显式 --continue 会返回具体错误。
    }
  }
  // v1/v2 文件名前缀不同，不能按文件名比较新旧；统一按快照导出时间倒序。
  return result.sort((a, b) => b.exportedAt.localeCompare(a.exportedAt) || b.file.localeCompare(a.file));
}

export function resolveContinuableHistory(reference?: string): ContinuableHistorySummary {
  if (!reference?.trim()) {
    const latest = listContinuableHistory()[0];
    if (!latest) throw new Error(`没有找到可续跑历史: ${config.historyDir}`);
    return latest;
  }
  const ref = reference.trim();
  const file = path.isAbsolute(ref) || ref.includes("/") || ref.includes("\\") ? path.resolve(config.root, ref) : path.join(config.historyDir, ref);
  return historySummary(file, readAnyHistory(file));
}

export async function exportDatabaseHistory(): Promise<string> {
  const client = await pool.connect();
  let history: LoadedContestHistory;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const goal = await client.query<HistoryGoal>("SELECT id, asset, customization, goal, created_at, updated_at FROM goal WHERE id=1");
    const publication = await client.query<HistoryPublication>(
      "SELECT status, error, started_at, finished_at FROM contest_publication WHERE id=1"
    );
    const challenges = await client.query<HistoryChallenge>(
      `SELECT challenge_id, name, asset, customization, goal, status, status_reason, report_file, prompt_ready_at, created_at, updated_at
       FROM challenge ORDER BY challenge_id`
    );
    const state = await client.query<{ last_task_id: number }>("SELECT last_task_id FROM task_id_state WHERE id=1");
    const files: ChallengeHistoryFile[] = [];
    for (const challenge of challenges.rows) {
      const id = challenge.challenge_id;
      const task = await client.query<DatabaseHistoryTaskRow>(
        "SELECT task_id, challenge_id, is_complete, task, note, fact, finding, compressed_at FROM task WHERE challenge_id=$1 ORDER BY task_id", [id]
      );
      const detail = await client.query<DetailRow>("SELECT challenge_id, fact, fact_detail FROM detail WHERE challenge_id=$1 ORDER BY fact", [id]);
      const detail2 = await client.query<Detail2Row>("SELECT challenge_id, finding, finding_detail FROM detail2 WHERE challenge_id=$1 ORDER BY finding", [id]);
      const file: ChallengeHistoryFile = {
        format: "param-ctf-challenge-history", version: 2, challenge_id: id, challenge,
        task: task.rows, detail: detail.rows, detail2: detail2.rows,
      };
      validateChallengeHistory(file, `Challenge #${id}`);
      files.push(file);
    }
    history = {
      manifest: {
        format: "param-ctf-contest-history", version: 2, exported_at: new Date().toISOString(),
        goal: goal.rows[0] ?? null,
        publication: publication.rows[0] ?? null,
        last_task_id: state.rows[0]?.last_task_id ?? files.flatMap((file) => file.task).reduce((max, row) => Math.max(max, row.task_id), 0),
        challenges: files.map((file) => ({ challenge_id: file.challenge_id, file: `challenge-${file.challenge_id}.json`, status: file.challenge.status })),
      },
      files,
    };
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  fs.mkdirSync(config.historyDir, { recursive: true });
  const directory = path.join(config.historyDir, `param-contest-${fileStamp()}-${process.pid}`);
  const temporary = `${directory}.tmp`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: false });
  try {
    fs.writeFileSync(path.join(temporary, "manifest.json"), `${JSON.stringify(history.manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    for (const file of history.files) {
      const name = `challenge-${file.challenge_id}.json`;
      const body = `${JSON.stringify(file, null, 2)}\n`;
      if (body.includes('"format": "param-ctf-contest-history"')) throw new Error(`历史归属校验失败: ${name}`);
      fs.writeFileSync(path.join(temporary, name), body, { encoding: "utf8", flag: "wx" });
    }
    // 写入后重新按正式读取路径验证，全部成功才发布目录。
    readV2History(temporary);
    fs.renameSync(temporary, directory);
  } catch (e) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw e;
  }
  return directory;
}

export async function restoreDatabaseHistory(reference: string): Promise<ContinuableHistorySummary> {
  const history = readAnyHistory(reference);
  const summary = historySummary(reference, history);
  const sourcePublication = effectivePublication(history.manifest);
  const restoredPublicationStatus: ContestPublicationStatus = sourcePublication.status === "finalized" ? "finalized" : "incomplete";
  for (const file of history.files) {
    if (sourcePublication.status === "finalized" && file.challenge.prompt_ready_at === null) {
      throw new Error(`历史 Challenge #${file.challenge_id} 在 finalized 赛事中仍未就绪`);
    }
    if (restoredPublicationStatus === "incomplete" && file.challenge.prompt_ready_at === null) {
      file.challenge.status = "skipped";
      file.challenge.status_reason = "Challenge 在赛事发布完成前中断，提示词尚未就绪";
    }
  }
  summary.publicationStatus = restoredPublicationStatus;
  // 当前 .env 优先：所有非终态赛题按 ID 重排，前 N 道 active，其余 queued。
  let activeLeft = config.ctfPlannerConcurrency;
  for (const file of [...history.files].sort((a, b) => a.challenge_id - b.challenge_id)) {
    if (TERMINAL_STATUSES.has(file.challenge.status)) continue;
    const status: ChallengeStatus = activeLeft > 0 ? "active" : "queued";
    if (status === "active") activeLeft--;
    file.challenge.status = status;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM detail2");
    await client.query("DELETE FROM detail");
    await client.query("DELETE FROM task");
    await client.query("DELETE FROM challenge");
    await client.query("DELETE FROM contest_publication");
    await client.query("DELETE FROM goal");
    const goal = history.manifest.goal;
    if (goal) {
      await client.query(
        "INSERT INTO goal (id, asset, customization, goal, created_at, updated_at) VALUES (1,$1,$2,$3,$4,$5)",
        [goal.asset, goal.customization, goal.goal, goal.created_at, goal.updated_at]
      );
    }
    for (const file of history.files) {
      const row = file.challenge;
      await client.query(
        `INSERT INTO challenge (challenge_id, name, asset, customization, goal, status, status_reason, report_file, prompt_ready_at, created_at, updated_at)
         OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10)`,
        [row.challenge_id, row.name, row.asset, row.customization, row.goal, row.status, row.status_reason, row.report_file, row.created_at, row.updated_at]
      );
    }
    for (const file of history.files) {
      for (const row of file.task) {
        await client.query(
          `INSERT INTO task (task_id, challenge_id, is_complete, task, note, fact, finding, compressed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [row.task_id, row.challenge_id, row.is_complete, row.task, row.note, row.fact, row.finding, row.compressed_at ?? null]
        );
      }
      for (const row of file.detail) await client.query("INSERT INTO detail (challenge_id,fact,fact_detail) VALUES ($1,$2,$3)", [row.challenge_id,row.fact,row.fact_detail]);
      for (const row of file.detail2) await client.query("INSERT INTO detail2 (challenge_id,finding,finding_detail) VALUES ($1,$2,$3)", [row.challenge_id,row.finding,row.finding_detail]);
    }
    await client.query(
      `INSERT INTO contest_publication (id, status, error, started_at, finished_at)
       VALUES (1,$1,$2,$3,now())`,
      [
        restoredPublicationStatus,
        restoredPublicationStatus === "incomplete"
          ? sourcePublication.error ?? "赛事在 Challenge 发布完成前中断；仅恢复已就绪赛题"
          : sourcePublication.error,
        sourcePublication.started_at,
      ]
    );
    const highWater = history.manifest.last_task_id;
    await client.query("UPDATE task_id_state SET last_task_id=$1 WHERE id=1", [highWater]);
    await client.query(
      "SELECT setval(pg_get_serial_sequence('challenge','challenge_id'), COALESCE(MAX(challenge_id),0)+1, false) FROM challenge"
    );
    await client.query("COMMIT");
    return summary;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function latestReport(): string | null {
  if (!fs.existsSync(config.reportDir)) return null;
  const files = fs.readdirSync(config.reportDir).filter((name) => /^(challenge-\d+|contest-summary)-.*\.md$/.test(name)).sort();
  return files.length ? path.join(config.reportDir, files.at(-1)!) : null;
}
