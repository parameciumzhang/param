import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  resolveCliModel,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { config, syncModelsJson, llmForRole } from "./config.js";
import { createMcpToolNamesExtension } from "./mcp-tool-names.js";
import { readGeneratedPrompt, stripCommentLines, type Role } from "./scripts.js";

/**
 * 编排角色每次触发都重建全新 in-memory AgentSession：
 * - 保留 pi 原始系统提示词，追加分角色/分 Challenge 的 generated 提示词；
 * - Planner/Worker 从 challenges/<challenge_id>/ 读取各自动态提示词；
 * - 不保留跨触发会话，赛题业务状态只在 PostgreSQL；
 * - 四角色扩展均由 EXTENSIONS_<ROLE> / EXTENSIONS_ENABLED 控制；Planner 不开放通用内置工具。
 */
export async function createFreshAgent(
  role: Role,
  customTools: ToolDefinition[],
  opts: {
    builtinTools?: boolean;
    cwd?: string;
    excludeTools?: string[];
    extensions?: boolean;
    skills?: boolean;
    /** Planner/Worker 必须绑定到本题的分题目录提示词。 */
    challengeId?: number;
  } = {}
): Promise<AgentSession> {
  if ((role === "planner" || role === "worker") !== (opts.challengeId !== undefined)) {
    throw new Error(`角色 ${role} 的 challengeId 绑定不符合约定`);
  }
  // Worker cwd 为全局唯一 task_id 对应的工作目录；其他编排角色使用项目根。
  const cwd = opts.cwd ?? config.root;
  syncModelsJson();
  const llm = llmForRole(role); // 角色级端点/密钥/模型（可与其他角色不同）
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(config.agentDir, "auth.json"),
    modelsPath: path.join(config.agentDir, "models.json"),
  });
  const resolved = resolveCliModel({
    cliProvider: llm.providerId,
    cliModel: llm.modelId,
    modelRuntime,
  });
  if (!resolved.model) {
    throw new Error(
      `角色 ${role} 模型解析失败（provider=${llm.providerId} model=${llm.modelId} baseUrl=${llm.baseUrl}）: ${resolved.error ?? resolved.warning ?? "未知错误"}`
    );
  }

  // 项目按可信处理：项目根 .mcp.json 定义的服务器在 SDK 会话（非交互）默认被信任链跳过；
  // 本项目的项目文件由用户自己控制（cwd 仅项目根或 worker 专属空目录），风险可控。
  // loader 与 session 必须共用同一个实例——session 的扩展上下文按自身 settingsManager 判定信任
  const settingsManager = SettingsManager.create(cwd, config.agentDir, { projectTrusted: true });
  // noSkills:true 只关闭默认/全局发现；additionalSkillPaths 仍会显式加载当前角色目录。
  // 使用绝对路径，worker 即使以 workspaces/task-<id>/ 为 cwd 也读取同一份角色技能。
  const skillsEnabled = opts.skills !== false;
  const roleSkillsDir = path.join(config.skillsDir, role);
  if (skillsEnabled) fs.mkdirSync(roleSkillsDir, { recursive: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: config.agentDir,
    settingsManager,
    // 角色提示词追加在 pi 默认系统提示词之后（addendum 段），不替换默认内容；
    // 发送前剥离整行 HTML 注释（role 标记等维护者元数据不进入模型上下文）
    appendSystemPrompt: [stripCommentLines(readGeneratedPrompt(role, opts.challengeId))],
    // 扩展（pi install 装入 .pi-agent/ 的包，如 pi-mcp-adapter）：仅显式开启的角色加载
    noExtensions: !opts.extensions,
    // 代理模式下额外注入服务器/工具名称；描述与 Schema 仍通过 mcp describe 按需加载。
    extensionFactories: opts.extensions
      ? [{ name: "param-mcp-tool-names", factory: createMcpToolNamesExtension(config.agentDir) }]
      : [],
    // 禁用默认 skills 发现，仅显式加载本角色目录，保证各角色相互隔离
    noSkills: true,
    additionalSkillPaths: skillsEnabled ? [roleSkillsDir] : [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  // createAgentSession 只对自建的默认 loader 调 reload；systemPrompt/appendSystemPrompt 的解析发生在 reload 内
  await resourceLoader.reload();
  const { skills, diagnostics: skillDiagnostics } = resourceLoader.getSkills();
  for (const diagnostic of skillDiagnostics) {
    console.warn(`[agent] ${role} skill 加载${diagnostic.type === "error" ? "失败" : "告警"}: ${diagnostic.path} — ${diagnostic.message}`);
  }
  if (skills.length > 0) console.log(`[agent] ${role} 已加载 skills: ${skills.map((skill) => skill.name).join(", ")}`);

  // 扩展加载失败不阻断编排（扩展是增强件），但必须显式告警——否则 MCP 静默失效难排查
  if (opts.extensions) {
    const { extensions, errors } = resourceLoader.getExtensions();
    if (errors.length > 0) {
      for (const e of errors) console.warn(`[agent] 扩展加载失败: ${e.path} — ${e.error}`);
    }
    const loaded = extensions.map((e) => e.sourceInfo?.source || e.path);
    if (loaded.length > 0) console.log(`[agent] ${role} 已加载扩展: ${loaded.join(", ")}`);
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir: config.agentDir,
    // 所有编排角色都使用内存会话；Challenge 状态只在 PostgreSQL 中保存。
    sessionManager: SessionManager.inMemory(),
    resourceLoader,
    settingsManager,
    model: resolved.model,
    modelRuntime,
    // 思考强度（PI_THINKING_LEVEL[_<ROLE>]）：SDK 会按模型能力收敛（models.json 已随级别声明 reasoning）；
    // 未配置时不传，保持默认行为（模型未声明思考能力 → 实际 off）
    thinkingLevel: llm.thinkingLevel,
    customTools,
    // Manager 保留 read/bash；Worker 保留全部内置工具。
    // 多题 Planner 不开放内置工具，中断 Planner 与 Compactor 同样只使用固定脚本。
    noTools: opts.builtinTools ? undefined : "builtin",
    excludeTools: opts.excludeTools,
  });
  // SDK 的 createAgentSession 不会派发 session_start（pi CLI 的 print/json 模式才显式 bind）；
  // pi-mcp-adapter 等扩展靠该事件进入运行态（项目级 .mcp.json 服务器也仅在此时接纳）。
  // 以无 UI 的 print 模式绑定，行为对齐 `pi -p` 单轮运行
  if (opts.extensions) {
    await session.bindExtensions({
      mode: "print",
      onError: (err) => console.error(`[agent] 扩展运行时错误（${err.extensionPath}）: ${err.error}`),
    });
  }
  return session;
}

const MODEL_RESPONSE_LOG_CHARS = 4_000;

/** 单条日志保留足够上下文但避免超长回复刷屏；JSON 转义可同时保留换行边界并识别空白响应。 */
function logPreview(value: string, maxChars = MODEL_RESPONSE_LOG_CHARS): string {
  const text = value.trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（已截断，原文共 ${text.length} 字符）`;
}

/**
 * 带超时的单轮运行：超时或外部 signal 中止时先 abort 再抛错，由调用方处置
 * （worker 侧超时触发强制补完成；外部 signal 用于修改/停止 worker，或 Ctrl+C 中止 planner/worker）。
 */
export async function promptWithTimeout(
  session: AgentSession,
  userMessage: string,
  timeoutMs: number,
  onEvent?: (line: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const log = (s: string) => {
    if (onEvent) onEvent(s);
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      log(`  · 模型开始响应: ${event.message.responseModel ?? event.message.model}`);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const toolNames = message.content
        .filter((part) => part.type === "toolCall")
        .map((part) => part.name);
      const thinkingChars = message.content
        .filter((part) => part.type === "thinking")
        .reduce((sum, part) => sum + part.thinking.length, 0);
      const metadata = [
        `model=${message.responseModel ?? message.model}`,
        `stop=${message.stopReason}`,
        ...(message.rawStopReason && message.rawStopReason !== message.stopReason ? [`rawStop=${message.rawStopReason}`] : []),
        `tokens=${message.usage.input}→${message.usage.output}`,
        ...(message.usage.reasoning !== undefined ? [`reasoning=${message.usage.reasoning}`] : []),
        ...(message.durationMs !== undefined ? [`duration=${Math.round(message.durationMs)}ms`] : []),
        ...(thinkingChars > 0 ? [`thinking=${thinkingChars}字符`] : []),
        ...(toolNames.length > 0 ? [`tools=${toolNames.join(",")}`] : []),
        ...(message.errorMessage ? [`error=${JSON.stringify(logPreview(message.errorMessage, 1_000))}`] : []),
      ];
      log(`  · 模型返回 [${metadata.join(", ")}]: ${text.trim() ? JSON.stringify(logPreview(text)) : "（空文本）"}`);
      for (const diagnostic of message.diagnostics ?? []) {
        log(`  · 模型诊断: ${diagnostic.type}${diagnostic.error ? `: ${logPreview(diagnostic.error.message, 1_000)}` : ""}`);
      }
    } else if (event.type === "compaction_start") {
      log(`  · 开始压缩会话上下文（${event.reason}），保留摘要与最近消息`);
    } else if (event.type === "compaction_end") {
      if (event.result) {
        log(`  · 会话上下文压缩完成: ${event.result.tokensBefore} → 约 ${event.result.estimatedTokensAfter ?? "?"} tokens`);
      } else if (event.errorMessage) {
        log(`  · 会话上下文压缩失败: ${logPreview(event.errorMessage, 1_000)}`);
      }
    } else if (event.type === "auto_retry_start") {
      log(`  · 模型请求失败，${Math.ceil(event.delayMs / 1000)}s 后重试（${event.attempt}/${event.maxAttempts}）: ${logPreview(event.errorMessage, 1_000)}`);
    } else if (event.type === "auto_retry_end" && !event.success) {
      log(`  · 模型自动重试失败（第 ${event.attempt} 次）: ${logPreview(event.finalError ?? "未知错误", 1_000)}`);
    } else if (event.type === "tool_execution_start") {
      log(`  · 工具调用: ${event.toolName}`);
    } else if (event.type === "tool_execution_end") {
      const content = event.result?.content;
      const resultText = Array.isArray(content)
        ? content
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("\n")
            .trim()
        : "";
      const summary = (resultText || "（无文本结果）").slice(0, 1200);
      if (event.isError) {
        log(`  · 工具失败: ${event.toolName}: ${summary}`);
      } else if (event.toolName === "insert_task") {
        // 发布任务是关键状态变更，明确打印脚本成功返回，避免“发起调用”被误认为已落库。
        log(`  · 工具成功: ${summary}`);
      }
    }
  });
  let timer: NodeJS.Timeout | undefined;
  let onExternal: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`运行超时（${timeoutMs}ms）`)), timeoutMs);
    });
    // 编排器主动中止（用户实时修改/停止任务）：立刻 abort 会话并使本轮运行以错误结束
    const external = new Promise<never>((_, reject) => {
      if (!signal) return;
      if (signal.aborted) {
        reject(new Error("运行已被外部信号中止"));
        return;
      }
      onExternal = () => {
        try {
          session.abort();
        } catch {
          /* ignore */
        }
        reject(new Error("运行已被外部信号中止"));
      };
      signal.addEventListener("abort", onExternal, { once: true });
    });
    await Promise.race([session.prompt(userMessage), timeout, external]);
    return session.getLastAssistantText() ?? "";
  } catch (e) {
    // abort() 会等待会话回到 idle。交互 Monitor 必须等待中止收尾后再接受下一问，
    // 否则上一轮仍在写消息/工具结果，可能破坏连续上下文或与下一轮并发。
    try {
      await session.abort();
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onExternal) signal.removeEventListener("abort", onExternal);
    unsubscribe();
  }
}
