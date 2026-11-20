import fs from "node:fs";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const MCP_TOOL_NAMES_SECTION = "mcp_tool_names";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // MCP 名称来自外部服务，禁止控制字符进入系统提示词；只保留名称，不带描述/Schema。
  const name = value.trim();
  if (!name || /[\u0000-\u001f\u007f-\u009f]/.test(name) || name.length > 200) return undefined;
  return name;
}

function stringPatterns(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return name === pattern;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

function toolAllowed(serverName: string, toolName: string, definition: JsonObject): boolean {
  const include = stringPatterns(definition.includeTools);
  const exclude = stringPatterns(definition.excludeTools) ?? [];
  const candidates = [toolName, `${serverName}_${toolName}`];
  const matches = (patterns: string[]) => patterns.some((pattern) => candidates.some((name) => matchesPattern(name, pattern)));
  return (!include || matches(include)) && !matches(exclude);
}

/**
 * 仅根据当前项目配置和适配器缓存渲染服务器/工具名称。
 * 不读取或输出 description、inputSchema、outputSchema、instructions、headers 等字段。
 */
export function renderMcpToolNamesSection(mcpConfig: unknown, metadataCache: unknown): string | undefined {
  if (!isObject(mcpConfig) || !isObject(mcpConfig.mcpServers)) return undefined;
  if (!isObject(metadataCache) || !isObject(metadataCache.servers)) return undefined;

  const groups: string[] = [];
  const servers = mcpConfig.mcpServers;
  const cacheServers = metadataCache.servers;
  for (const rawServerName of Object.keys(servers).sort()) {
    const serverName = cleanName(rawServerName);
    const definition = servers[rawServerName];
    if (!serverName || !isObject(definition) || definition.disabled === true || definition.enabled === false) continue;
    const entry = cacheServers[rawServerName];
    if (!isObject(entry) || !Array.isArray(entry.tools)) continue;
    const names = [...new Set(entry.tools
      .map((tool) => isObject(tool) ? cleanName(tool.name) : undefined)
      .filter((name): name is string => name !== undefined && toolAllowed(rawServerName, name, definition)))].sort();
    if (names.length > 0) groups.push(`${serverName}:\n${names.map((name) => `- ${name}`).join("\n")}`);
  }
  if (groups.length === 0) return undefined;

  return [
    "以下是当前已发现的 MCP 工具名称。本段只包含服务器名和工具名，不包含功能描述或参数 Schema。",
    ...groups,
    "需要功能说明或参数时，按需调用 mcp({ describe: \"工具名\", server: \"服务器名\" })。",
    "调用工具时使用 mcp({ tool: \"工具名\", server: \"服务器名\", args: {} })，不要凭名称猜测参数。",
  ].join("\n\n");
}

/** 冷缓存、配置缺失或 JSON 损坏都返回 undefined，由 mcp 代理继续承担发现能力。 */
export function loadMcpToolNamesSection(agentDir: string, cwd: string): string | undefined {
  try {
    return renderMcpToolNamesSection(
      readJson(path.join(cwd, ".mcp.json")),
      readJson(path.join(agentDir, "mcp-cache.json")),
    );
  } catch {
    return undefined;
  }
}

/** 项目内联扩展：每轮只注入名称；不替换完整系统提示词，不改变 mcp 代理调用链。 */
export function createMcpToolNamesExtension(agentDir: string): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event, ctx) => {
      const section = loadMcpToolNamesSection(agentDir, ctx.cwd);
      if (section) event.systemPromptOptions.sections[MCP_TOOL_NAMES_SECTION] = section;
      else delete event.systemPromptOptions.sections[MCP_TOOL_NAMES_SECTION];
    });
  };
}
