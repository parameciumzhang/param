import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

function findPkgRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function required(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function intEnvAtLeast(name: string, fallback: number, minimum: number): number {
  const value = intEnv(name, fallback);
  if (value >= minimum) return value;
  console.warn(`[config] ${name} 值无效: "${value}"（应不小于 ${minimum}），按 ${fallback} 处理`);
  return fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  console.warn(`[config] ${name} 值无效: "${raw}"（应为 true/false），按 ${fallback} 处理`);
  return fallback;
}

const pkgRoot = findPkgRoot();

export const KALI_RUNTIMES = ["container", "embedded"] as const;
export type KaliRuntime = (typeof KALI_RUNTIMES)[number];

/** 执行后端必须显式合法；比赛镜像缺少 Docker，不能从 embedded 静默回退到 container。 */
function kaliRuntimeEnv(): KaliRuntime {
  const raw = (process.env.KALI_RUNTIME ?? "container").trim().toLowerCase();
  if (KALI_RUNTIMES.includes(raw as KaliRuntime)) return raw as KaliRuntime;
  throw new Error(`[config] KALI_RUNTIME 值无效: "${raw}"（合法值: ${KALI_RUNTIMES.join("|")}）`);
}

const outputDir = path.resolve(pkgRoot, required("PARAM_OUTPUT_DIR", "."));

/**
 * pi 扩展（如 pi-mcp-adapter）在 SDK 进程内按 PI_CODING_AGENT_DIR 定位"user-global"配置根
 * （默认 ~/.pi/agent）。钉到项目 .pi-agent/ 使其与 pi install 的落位、本编排器的 agentDir 一致，
 * 否则 mcp-adapter 的 settings（如 projectServers）与缓存读到错误目录。不覆盖用户显式设置。
 */
process.env.PI_CODING_AGENT_DIR ??= path.join(pkgRoot, ".pi-agent");

/** 四类编排角色各自的 LLM 端点可独立配置（PI_<VAR>_<ROLE> 覆盖全局 PI_<VAR>）。 */
export const LLM_ROLES = ["manager", "planner", "worker", "compactor"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/** pi 的思考强度档位（与 @earendil-works/pi-agent-core 的 ThinkingLevel 值域一致） */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RoleLlmConfig {
  /** models.json 中的 provider id（角色唯一） */
  providerId: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /** 模型总上下文窗口（tokens），PI_CONTEXT_WINDOW[_<ROLE>]，默认 256000 */
  contextWindow: number;
  /** 单次响应最大输出 tokens，PI_MAX_TOKENS[_<ROLE>]，默认 126000 */
  maxTokens: number;
  /** 思考强度（PI_THINKING_LEVEL[_<ROLE>]）；undefined 或 off = 不启用思考 */
  thinkingLevel?: ThinkingLevel;
}

function firstEnv(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/** 正整数模型参数；非法值告警并回落到全局配置或项目默认值。 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = firstEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.warn(`[config] ${name} 值无效: "${raw}"（应为正整数），按 ${fallback} 处理`);
    return fallback;
  }
  return value;
}

/** 读思考强度：非法值告警并忽略（等价不启用），避免 .env 笔误静默改变行为难排查 */
function thinkingLevelFor(role: LlmRole): ThinkingLevel | undefined {
  const raw = firstEnv(`PI_THINKING_LEVEL_${role.toUpperCase()}`, "PI_THINKING_LEVEL");
  if (raw === undefined) return undefined;
  const level = raw.toLowerCase() as ThinkingLevel;
  if (!THINKING_LEVELS.includes(level)) {
    console.warn(`[config] PI_THINKING_LEVEL 值无效: "${raw}"（角色 ${role}），合法值: ${THINKING_LEVELS.join("|")}，已忽略`);
    return undefined;
  }
  return level;
}

/** 角色级 LLM 配置：PI_BASE_URL_MANAGER/PLANNER/WORKER 等覆盖全局值；每次调用现读 env，便于测试注入。 */
export function llmForRole(role: LlmRole): RoleLlmConfig {
  const suffix = role.toUpperCase();
  const contextWindow = positiveIntEnv(
    `PI_CONTEXT_WINDOW_${suffix}`,
    positiveIntEnv("PI_CONTEXT_WINDOW", 256_000)
  );
  const maxTokens = positiveIntEnv(
    `PI_MAX_TOKENS_${suffix}`,
    positiveIntEnv("PI_MAX_TOKENS", 126_000)
  );
  return {
    providerId: `custom-openai-${role}`,
    baseUrl: firstEnv(`PI_BASE_URL_${suffix}`) ?? required("PI_BASE_URL", "http://127.0.0.1:8787/v1"),
    apiKey: firstEnv(`PI_API_KEY_${suffix}`) ?? process.env.PI_API_KEY ?? "sk-local-mock",
    modelId: firstEnv(`PI_MODEL_ID_${suffix}`) ?? process.env.PI_MODEL_ID ?? "mock-pentest-model",
    contextWindow,
    maxTokens,
    thinkingLevel: thinkingLevelFor(role),
  };
}

/**
 * 扩展加载开关（EXTENSIONS_ENABLED / EXTENSIONS_<ROLE>，默认 true）。
 * 四角色均可通过 EXTENSIONS_<ROLE> 覆盖全局开关；未设置角色级值时继承 EXTENSIONS_ENABLED。
 * 每次调用现读 env（对齐 llmForRole），编排重启后生效。
 * 单个 MCP 服务器的精细开关不必动这里：.mcp.json 服务器条目加 "disabled": true 即可，
 * adapter 在各角色会话启动时重读配置。
 */
export function extensionsForRole(role: LlmRole): boolean {
  const raw = firstEnv(`EXTENSIONS_${role.toUpperCase()}`, "EXTENSIONS_ENABLED");
  if (raw === undefined) return true;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  console.warn(`[config] EXTENSIONS 值无效: "${raw}"（角色 ${role}，应为 true/false），按默认启用处理`);
  return true;
}

export const config = {
  root: pkgRoot,
  promptsTemplateDir: path.join(pkgRoot, "prompts", "templates"),
  promptsGeneratedDir: path.join(pkgRoot, "prompts", "generated"),
  /** 各角色专属 pi skills 根目录：skills/manager|planner|worker/；多题 Planner 不加载可读取文件的技能。 */
  skillsDir: path.join(pkgRoot, "skills"),
  /** 可选赛事输入文件；镜像通过 ENV 固定为 /input/ctf.txt。 */
  contestInputFile: path.resolve(pkgRoot, required("CTF_INPUT_FILE", path.join(pkgRoot, "input", "ctf.txt"))),
  /** 运行产物统一根目录；默认项目根，All-in-One 镜像固定为 /output。 */
  outputDir,
  reportDir: path.join(outputDir, "report"),
  /** 每次编排结束时导出的分题目录式历史快照；续跑时从这里恢复。 */
  historyDir: path.join(outputDir, "history_db"),
  /** worker 每任务专属工作目录根：<outputDir>/workspaces/task-<id>/ */
  workspacesDir: path.join(outputDir, "workspaces"),
  /** 字典目录：挂载进 Kali 容器 /wordlists（只读） */
  wordlistsDir: path.join(pkgRoot, "wordlists"),
  /** pi agent 目录：四类角色各一个 provider；各角色可按开关加载这里登记的扩展。 */
  agentDir: path.join(pkgRoot, ".pi-agent"),

  /** worker 的 Kali 执行环境（容器内预装渗透工具） */
  kali: {
    enabled: booleanEnv("KALI_ENABLED", true),
    runtime: kaliRuntimeEnv(),
    image: process.env.KALI_IMAGE ?? "kalilinux/kali-rolling",
    container: process.env.KALI_CONTAINER ?? "kali",
    skipProvision: process.env.KALI_SKIP_PROVISION === "1" || process.env.KALI_SKIP_PROVISION === "true",
    provisionTimeoutMs: intEnv("KALI_PROVISION_TIMEOUT_MS", 1_800_000),
    /** 可选：钉住 apt 镜像（如 http://mirror.nju.edu.cn/kali），避免官方 geo 重定向到不可达镜像 */
    aptMirror: (process.env.KALI_APT_MIRROR ?? "").trim().replace(/\/+$/, ""),
    packages: (
      process.env.KALI_INSTALL_PACKAGES ??
      // 注：pwntools 复用容器 Python 环境单独 pip 安装；jwt_tool 单独 git clone，见 kali.ts
      "python3 python3-pip python3-dev libssl-dev libffi-dev build-essential cmake pkg-config pipx git radare2 gdb patchelf binwalk libimage-exiftool-perl steghide tshark zbar-tools python3-gmpy2 python3-sympy ruby ruby-rubygems curl telnet openssh-client vim tmux jq tree htop net-tools nmap sqlmap metasploit-framework dirsearch nuclei hydra john tcpdump python3-impacket impacket-scripts proxychains4 wireguard-tools openvpn iproute2 openresolv"
    )
      .split(/\s+/)
      .filter(Boolean),
  },

  pg: {
    host: process.env.PGHOST ?? "127.0.0.1",
    port: intEnv("PGPORT", 55432),
    user: process.env.PGUSER ?? "pentest",
    password: process.env.PGPASSWORD ?? "pentest",
    database: process.env.PGDATABASE ?? "pentest",
  },

  workerConcurrency: Math.max(1, intEnv("WORKER_CONCURRENCY", 3)),
  /** 同时处于 active 的 Challenge 数；名额持有到本题终态，而不是仅持有 Planner 单轮。 */
  ctfPlannerConcurrency: Math.max(1, intEnv("CTF_PLANNER_CONCURRENCY", 1)),
  pollIntervalMs: intEnv("POLL_INTERVAL_MS", 500),
  managerTimeoutMs: intEnv("MANAGER_TIMEOUT_MS", 300_000),
  plannerTimeoutMs: intEnv("PLANNER_TIMEOUT_MS", 300_000),
  workerTimeoutMs: intEnv("WORKER_TIMEOUT_MS", 900_000),
  /** insert_task 的任务描述与规划备注长度上限（字符）。 */
  insertTaskMaxChars: positiveIntEnv("INSERT_TASK_MAX_CHARS", 600),
  insertTaskMaxNoteChars: positiveIntEnv("INSERT_TASK_MAX_NOTE_CHARS", 200),
  /** 首次压缩的每题任务数阈值；每批10个，之后每新增10个任务触发下一批。 */
  compactorFirstTrigger: intEnvAtLeast("COMPACTOR_FIRST_TRIGGER", 40, 10),
  /** 历史任务压缩默认关闭；开启后每增加10个任务压缩一个早期批次。 */
  compactorEnabled: booleanEnv("COMPACTOR_ENABLED", false),
  compactorTimeoutMs: intEnv("COMPACTOR_TIMEOUT_MS", 300_000),
  globalTimeoutMs: intEnv("GLOBAL_TIMEOUT_MS", 3_600_000),
};

/** 把四类角色的 OpenAI 兼容端点渲染为 pi 的 models.json（agentDir），每次启动覆盖。 */
export function syncModelsJson(): string {
  const dir = config.agentDir;
  fs.mkdirSync(dir, { recursive: true });
  const providers: Record<
    string,
    {
      baseUrl: string;
      api: string;
      apiKey: string;
      compat?: { supportsReasoningEffort: true };
      models: Array<{
        id: string;
        contextWindow: number;
        maxTokens: number;
        reasoning?: boolean;
        thinkingLevelMap?: Record<string, string | null>;
      }>;
    }
  > = {};
  for (const role of LLM_ROLES) {
    const c = llmForRole(role);
    providers[c.providerId] = {
      baseUrl: c.baseUrl,
      api: "openai-completions",
      apiKey: c.apiKey,
      // pi 对未声明 reasoning 的模型只允许 off（思考强度被收敛掉），启用思考必须显式声明能力；
      // xhigh/max 还需 thinkingLevelMap 显式映射（此处按同名放行 → 请求按字面值发 reasoning_effort）。
      // compat 强制开启 supportsReasoningEffort：pi 对智谱 bigmodel 端点（zai 兼容层）默认不发
      // reasoning_effort，开启后所有 OpenAI 兼容端点统一随请求发送 effort 档位
      ...(c.thinkingLevel && c.thinkingLevel !== "off"
        ? { compat: { supportsReasoningEffort: true } }
        : {}),
      models:
        c.thinkingLevel && c.thinkingLevel !== "off"
          ? [{
              id: c.modelId,
              contextWindow: c.contextWindow,
              maxTokens: c.maxTokens,
              reasoning: true,
              thinkingLevelMap: { xhigh: "xhigh", max: "max" },
            }]
          : [{ id: c.modelId, contextWindow: c.contextWindow, maxTokens: c.maxTokens }],
    };
  }
  const modelsJson = {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers,
  };
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, JSON.stringify(modelsJson, null, 2), "utf8");
  const auth = path.join(dir, "auth.json");
  if (!fs.existsSync(auth)) fs.writeFileSync(auth, "{}", "utf8");
  return file;
}
