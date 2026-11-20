import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  host: config.pg.host,
  port: config.pg.port,
  user: config.pg.user,
  password: config.pg.password,
  database: config.pg.database,
  max: Math.max(12, config.workerConcurrency + config.ctfPlannerConcurrency + 8),
});

pool.on("error", (err) => {
  console.error(`[db] 空闲连接异常（已由连接池接管，不影响运行）: ${err.message}`);
});

export type ChallengeStatus = "queued" | "active" | "completed" | "skipped" | "failed";
export type ContestPublicationStatus = "publishing" | "finalized" | "failed" | "incomplete";

export interface ContestPublicationRow {
  status: ContestPublicationStatus;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export interface ChallengeRow {
  challenge_id: number;
  name: string;
  asset: string;
  customization: string;
  goal: string;
  status: ChallengeStatus;
  status_reason: string | null;
  report_file: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskRow {
  task_id: number;
  challenge_id: number;
  is_complete: number;
  task: string;
  note: string;
  fact: string | null;
  finding: string | null;
}

export interface DetailRow {
  challenge_id: number;
  fact: string;
  fact_detail: string;
}

export interface Detail2Row {
  challenge_id: number;
  finding: string;
  finding_detail: string;
}

export interface GoalRow {
  asset: string;
  customization: string;
  goal: string;
  updated_at: Date;
}

/**
 * 初始化 Challenge 数据模型，并就地迁移旧单目标数据库。
 * 迁移只在归属明确时进行；若已有多个 Challenge 却仍有未归属行，会明确失败而不是猜测串题。
 */
export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS goal (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      asset TEXT NOT NULL,
      customization TEXT NOT NULL,
      goal TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS challenge (
      challenge_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      asset TEXT NOT NULL,
      customization TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','active','completed','skipped','failed')),
      status_reason TEXT,
      report_file TEXT,
      prompt_ready_at TIMESTAMPTZ DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE challenge ADD COLUMN IF NOT EXISTS status_reason TEXT`);
  await pool.query(`ALTER TABLE challenge ADD COLUMN IF NOT EXISTS report_file TEXT`);
  // 新列默认 now()，因此旧行自动视为已就绪；增量发布会显式插入 NULL 作为调度屏障。
  await pool.query(`ALTER TABLE challenge ADD COLUMN IF NOT EXISTS prompt_ready_at TIMESTAMPTZ DEFAULT now()`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contest_publication (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      status TEXT NOT NULL CHECK (status IN ('publishing','finalized','failed','incomplete')),
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task (
      task_id INTEGER PRIMARY KEY,
      is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
      task TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      fact TEXT,
      finding TEXT,
      compressed_at TIMESTAMPTZ,
      delete_requested_at TIMESTAMPTZ,
      delete_requested_by TEXT,
      delete_stopped_at TIMESTAMPTZ,
      complete_requested_at TIMESTAMPTZ,
      complete_requested_by TEXT,
      complete_stopped_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE task ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE task ADD COLUMN IF NOT EXISTS compressed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE task ADD COLUMN IF NOT EXISTS delete_requested_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE task ADD COLUMN IF NOT EXISTS delete_requested_by TEXT`);
  await pool.query(`ALTER TABLE task ADD COLUMN IF NOT EXISTS delete_stopped_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE task ADD COLUMN IF NOT EXISTS complete_requested_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE task ADD COLUMN IF NOT EXISTS complete_requested_by TEXT`);
  await pool.query(`ALTER TABLE task ADD COLUMN IF NOT EXISTS complete_stopped_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE task DROP COLUMN IF EXISTS revision`);
  await pool.query(`ALTER TABLE task DROP COLUMN IF EXISTS is_stopped`);
  await pool.query(`DROP TABLE IF EXISTS task_command`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS detail (
      fact TEXT,
      fact_detail TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS detail2 (
      finding TEXT,
      finding_detail TEXT NOT NULL
    )
  `);

  const legacyNeeded = await pool.query<{ needed: boolean }>(`
    SELECT EXISTS(SELECT 1 FROM goal)
       OR EXISTS(SELECT 1 FROM task)
       OR EXISTS(SELECT 1 FROM detail)
       OR EXISTS(SELECT 1 FROM detail2) AS needed
  `);
  const challengeCount = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM challenge");
  let legacyId: number | undefined;
  if (Number(challengeCount.rows[0]?.n ?? 0) === 0 && legacyNeeded.rows[0]?.needed) {
    const oldGoal = await pool.query<GoalRow>("SELECT asset, customization, goal, updated_at FROM goal WHERE id = 1");
    const taskStats = await pool.query<{ total: string; incomplete: string }>(
      "SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE is_complete = 0)::text AS incomplete FROM task"
    );
    let haltReason: string | null = null;
    const haltTable = await pool.query<{ name: string | null }>("SELECT to_regclass('public.halt_request')::text AS name");
    if (haltTable.rows[0]?.name) {
      const halt = await pool.query<{ reason: string }>("SELECT reason FROM halt_request WHERE id = 1");
      haltReason = halt.rows[0]?.reason ?? null;
    }
    const total = Number(taskStats.rows[0]?.total ?? 0);
    const incomplete = Number(taskStats.rows[0]?.incomplete ?? 0);
    const status: ChallengeStatus = haltReason
      ? "skipped"
      : total > 0 && incomplete === 0
        ? "completed"
        : "active";
    const inserted = await pool.query<{ challenge_id: number }>(
      `INSERT INTO challenge (name, asset, customization, goal, status, status_reason)
       VALUES ('legacy', $1, $2, $3, $4, $5)
       RETURNING challenge_id`,
      [
        oldGoal.rows[0]?.asset ?? "旧版单目标数据",
        oldGoal.rows[0]?.customization ?? "",
        oldGoal.rows[0]?.goal ?? "恢复旧版单目标任务数据",
        status,
        haltReason,
      ]
    );
    legacyId = inserted.rows[0]?.challenge_id;
    console.log(`[db] 已将旧单目标数据迁移为 Challenge #${legacyId} (legacy)`);
  }

  async function backfillChallengeId(table: "task" | "detail" | "detail2"): Promise<void> {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS challenge_id INTEGER`);
    const nulls = await pool.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE challenge_id IS NULL) AS exists`);
    if (nulls.rows[0]?.exists) {
      let owner = legacyId;
      if (!owner) {
        const owners = await pool.query<{ challenge_id: number }>("SELECT challenge_id FROM challenge ORDER BY challenge_id LIMIT 2");
        if (owners.rows.length === 1) owner = owners.rows[0]?.challenge_id;
      }
      if (!owner) throw new Error(`${table} 存在无法确定 Challenge 归属的旧行；请先备份并修复数据库`);
      await pool.query(`UPDATE ${table} SET challenge_id = $1 WHERE challenge_id IS NULL`, [owner]);
    }
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN challenge_id SET NOT NULL`);
    const constraint = `${table}_challenge_fk`;
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraint}') THEN
          ALTER TABLE ${table} ADD CONSTRAINT ${constraint}
            FOREIGN KEY (challenge_id) REFERENCES challenge(challenge_id) ON DELETE CASCADE;
        END IF;
      END $$
    `);
  }

  await backfillChallengeId("task");
  await backfillChallengeId("detail");
  await backfillChallengeId("detail2");
  await pool.query(`ALTER TABLE detail DROP CONSTRAINT IF EXISTS detail_pkey`);
  await pool.query(`ALTER TABLE detail ADD CONSTRAINT detail_pkey PRIMARY KEY (challenge_id, fact)`);
  await pool.query(`ALTER TABLE detail2 DROP CONSTRAINT IF EXISTS detail2_pkey`);
  await pool.query(`ALTER TABLE detail2 ADD CONSTRAINT detail2_pkey PRIMARY KEY (challenge_id, finding)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_id_state (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_task_id INTEGER NOT NULL CHECK (last_task_id >= 0)
    )
  `);
  await pool.query(`
    INSERT INTO task_id_state (id, last_task_id)
    SELECT 1, COALESCE(MAX(task_id), 0) FROM task
    ON CONFLICT (id) DO UPDATE
      SET last_task_id = GREATEST(task_id_state.last_task_id, EXCLUDED.last_task_id)
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS challenge_status_idx ON challenge (status, challenge_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS challenge_dispatch_idx ON challenge (status, prompt_ready_at, challenge_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS task_challenge_idx ON task (challenge_id, task_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS task_dispatch_idx ON task (challenge_id, is_complete, task_id)`);

  // 旧库没有发布状态；其中已有赛事一定来自一次性完整发布。
  await pool.query(`
    INSERT INTO contest_publication (id, status, finished_at)
    SELECT 1, 'finalized', now()
    WHERE EXISTS(SELECT 1 FROM goal) OR EXISTS(SELECT 1 FROM challenge)
    ON CONFLICT (id) DO NOTHING
  `);

  // CTF 赛事启动后没有人工补充链路；旧表只参与上面的 legacy 状态迁移，随后彻底删除。
  await pool.query(`DROP TABLE IF EXISTS planner_append`);
  await pool.query(`DROP TABLE IF EXISTS halt_request`);
}

export async function getGoal(): Promise<GoalRow | null> {
  const { rows } = await pool.query<GoalRow>(
    "SELECT asset, customization, goal, updated_at FROM goal WHERE id = 1"
  );
  return rows[0] ?? null;
}

export async function getContestPublication(): Promise<ContestPublicationRow | null> {
  const { rows } = await pool.query<ContestPublicationRow>(
    "SELECT status, error, started_at, finished_at FROM contest_publication WHERE id=1"
  );
  return rows[0] ?? null;
}

export async function countUnreadyChallenges(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM challenge WHERE prompt_ready_at IS NULL"
  );
  return Number(rows[0]?.n ?? 0);
}

export async function getChallenge(challengeId: number): Promise<ChallengeRow | null> {
  const { rows } = await pool.query<ChallengeRow>(
    `SELECT challenge_id, name, asset, customization, goal, status, status_reason, report_file, created_at, updated_at
     FROM challenge WHERE challenge_id = $1`,
    [challengeId]
  );
  return rows[0] ?? null;
}

export async function getChallenges(): Promise<ChallengeRow[]> {
  const { rows } = await pool.query<ChallengeRow>(
    `SELECT challenge_id, name, asset, customization, goal, status, status_reason, report_file, created_at, updated_at
     FROM challenge ORDER BY challenge_id`
  );
  return rows;
}

export async function getTask(taskId: number): Promise<TaskRow | null> {
  const { rows } = await pool.query<TaskRow>(
    "SELECT task_id, challenge_id, is_complete, task, note, fact, finding FROM task WHERE task_id = $1",
    [taskId]
  );
  return rows[0] ?? null;
}

export async function getAllTasks(challengeId?: number): Promise<TaskRow[]> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT task_id, challenge_id, is_complete, task, note, fact, finding
     FROM task ${challengeId === undefined ? "" : "WHERE challenge_id = $1"} ORDER BY task_id ASC`,
    challengeId === undefined ? [] : [challengeId]
  );
  return rows;
}

export async function countIncomplete(challengeId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM task WHERE challenge_id = $1 AND is_complete = 0",
    [challengeId]
  );
  return Number(rows[0]?.n ?? 0);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
