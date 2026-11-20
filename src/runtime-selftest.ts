import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { config, extensionsForRole } from "./config.js";
import { kaliExec } from "./kali.js";
import { loadContestInput } from "./contest-input.js";
import { loadMcpToolNamesSection, renderMcpToolNamesSection } from "./mcp-tool-names.js";

let assertions = 0;
function equal(actual: unknown, expected: unknown, message: string): void {
  assert.equal(actual, expected, message);
  assertions++;
}
function ok(value: unknown, message: string): asserts value {
  assert.ok(value, message);
  assertions++;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function configInChild(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const moduleUrl = pathToFileURL(path.join(config.root, "dist", "config.js")).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import(${JSON.stringify(moduleUrl)}).then(({config}) => console.log(JSON.stringify({root:config.root,outputDir:config.outputDir,reportDir:config.reportDir,historyDir:config.historyDir,workspacesDir:config.workspacesDir,wordlistsDir:config.wordlistsDir,runtime:config.kali.runtime})))`,
  ], {
    cwd: config.root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function main(): Promise<void> {
  console.log("[runtime-test] 1. PARAM_OUTPUT_DIR 与严格 KALI_RUNTIME 解析");
  const customOutput = path.join(os.tmpdir(), `param-output-config-${process.pid}`);
  const child = configInChild({ PARAM_OUTPUT_DIR: customOutput, KALI_RUNTIME: "embedded" });
  equal(child.status, 0, `自定义输出目录配置应加载成功: ${child.stderr}`);
  const parsed = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
  equal(parsed.outputDir, path.resolve(customOutput), "outputDir 使用 PARAM_OUTPUT_DIR");
  equal(parsed.reportDir, path.join(customOutput, "report"), "report 位于 outputDir");
  equal(parsed.historyDir, path.join(customOutput, "history_db"), "history_db 位于 outputDir");
  equal(parsed.workspacesDir, path.join(customOutput, "workspaces"), "workspaces 位于 outputDir");
  equal(parsed.wordlistsDir, path.join(config.root, "wordlists"), "字典仍来自只读项目目录");
  equal(parsed.runtime, "embedded", "embedded 配置被保留");
  const invalid = configInChild({ KALI_RUNTIME: "silent-fallback" });
  ok(invalid.status !== 0 && `${invalid.stdout}${invalid.stderr}`.includes("KALI_RUNTIME"), "非法 KALI_RUNTIME 必须明确失败");

  console.log("[runtime-test] 2. 四角色扩展开关与角色级覆盖");
  const extensionRoles = ["manager", "planner", "worker", "compactor"] as const;
  const extensionKeys = ["EXTENSIONS_ENABLED", ...extensionRoles.map((role) => `EXTENSIONS_${role.toUpperCase()}`)];
  const savedExtensionEnv = new Map(extensionKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of extensionKeys) delete process.env[key];
    for (const role of extensionRoles) equal(extensionsForRole(role), true, `${role} 未配置时默认启用扩展`);
    process.env.EXTENSIONS_ENABLED = "false";
    for (const role of extensionRoles) equal(extensionsForRole(role), false, `${role} 继承全局禁用`);
    for (const role of extensionRoles) {
      const key = `EXTENSIONS_${role.toUpperCase()}`;
      process.env[key] = "true";
      equal(extensionsForRole(role), true, `${role} 角色级 true 覆盖全局 false`);
      process.env[key] = "false";
      equal(extensionsForRole(role), false, `${role} 角色级 false 可独立禁用`);
      delete process.env[key];
    }
    process.env.EXTENSIONS_ENABLED = "true";
    for (const role of extensionRoles) {
      process.env[`EXTENSIONS_${role.toUpperCase()}`] = "false";
      equal(extensionsForRole(role), false, `${role} 角色级 false 覆盖全局 true`);
    }
  } finally {
    for (const key of extensionKeys) {
      const value = savedExtensionEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log("[runtime-test] 3. MCP 只注入服务器/工具名称");
  const mcpConfigFixture = {
    mcpServers: {
      ctfy: {
        includeTools: ["list_*", "start_instance"],
        excludeTools: ["list_suites"],
        headers: { Authorization: "SENSITIVE_AUTH" },
      },
      disabled: { disabled: true },
      off: { enabled: false },
      empty: {},
    },
  };
  const mcpCacheFixture = {
    servers: {
      ctfy: {
        tools: [
          { name: "list_competitions", description: "SENSITIVE_DESCRIPTION", inputSchema: { properties: { secretField: {} } } },
          { name: "list_competitions" },
          { name: "list_suites" },
          { name: "start_instance" },
          { name: "submit_answer" },
          { name: "bad\nname" },
        ],
      },
      disabled: { tools: [{ name: "disabled_tool" }] },
      off: { tools: [{ name: "off_tool" }] },
      stale: { tools: [{ name: "stale_tool" }] },
    },
  };
  const mcpNames = renderMcpToolNamesSection(mcpConfigFixture, mcpCacheFixture);
  ok(mcpNames?.includes("ctfy:"), "包含已配置服务器名称");
  ok(mcpNames?.includes("- list_competitions"), "包含允许的工具名称");
  ok(mcpNames?.includes("- start_instance"), "包含第二个允许的工具名称");
  equal(mcpNames?.match(/- list_competitions/g)?.length, 1, "重复工具名称只注入一次");
  for (const excluded of ["list_suites", "submit_answer", "disabled_tool", "off_tool", "stale_tool", "badname", "bad\nname"]) {
    ok(!mcpNames?.includes(excluded), `不得注入排除、禁用、陈旧或非法名称: ${JSON.stringify(excluded)}`);
  }
  for (const sensitive of ["SENSITIVE_AUTH", "SENSITIVE_DESCRIPTION", "secretField", "inputSchema", "outputSchema"]) {
    ok(!mcpNames?.includes(sensitive), `名称 section 不得包含描述、Schema 或认证配置: ${sensitive}`);
  }
  equal(renderMcpToolNamesSection({ mcpServers: {} }, { servers: {} }), undefined, "无名称时不注入空 section");
  equal(renderMcpToolNamesSection(mcpConfigFixture, { servers: {} }), undefined, "冷缓存时安全降级");
  const mcpFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "param-mcp-names-test-"));
  const mcpFixtureAgent = path.join(mcpFixtureRoot, "agent");
  try {
    fs.mkdirSync(mcpFixtureAgent);
    fs.writeFileSync(path.join(mcpFixtureRoot, ".mcp.json"), JSON.stringify(mcpConfigFixture));
    fs.writeFileSync(path.join(mcpFixtureAgent, "mcp-cache.json"), JSON.stringify(mcpCacheFixture));
    equal(loadMcpToolNamesSection(mcpFixtureAgent, mcpFixtureRoot), mcpNames, "从角色 cwd 与 agentDir 加载名称清单");
    fs.writeFileSync(path.join(mcpFixtureAgent, "mcp-cache.json"), "{broken");
    equal(loadMcpToolNamesSection(mcpFixtureAgent, mcpFixtureRoot), undefined, "缓存损坏不阻断会话");
  } finally {
    fs.rmSync(mcpFixtureRoot, { recursive: true, force: true });
  }

  console.log("[runtime-test] 4. 文件/CTF_INPUT 单独及合并输入");
  const inputTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "param-input-test-"));
  try {
    const promptFile = path.join(inputTestDir, "ctf.txt");
    const missingFile = path.join(inputTestDir, "missing.txt");
    fs.writeFileSync(promptFile, "  FILE-PROMPT\n", "utf8");
    equal(loadContestInput({ filePath: promptFile, envInput: "" }), "FILE-PROMPT", "可单独读取提示词文件并清理首尾空白");
    equal(loadContestInput({ filePath: missingFile, envInput: "ENV-PROMPT" }), "ENV-PROMPT", "可选文件不存在时可单独使用 CTF_INPUT");
    const combined = loadContestInput({ filePath: promptFile, envInput: "ENV-PROMPT" }) ?? "";
    ok(combined.includes("CTF_INPUT_FILE") && combined.includes("CTF_INPUT\n"), "双来源合并保留来源边界");
    ok(combined.indexOf("FILE-PROMPT") < combined.indexOf("ENV-PROMPT"), "双来源顺序为文件在前、环境变量在后");
    equal(loadContestInput({ filePath: missingFile, envInput: "  " }), undefined, "无有效输入时返回 undefined");
    assert.throws(() => loadContestInput({ filePath: missingFile, envInput: "", requireFile: true }), /提示词文件不存在/);
    assertions++;
  } finally {
    fs.rmSync(inputTestDir, { recursive: true, force: true });
  }

  if (process.platform === "win32") {
    console.log("[runtime-test] Windows 跳过 embedded setsid 进程组测试");
    console.log(`RUNTIME TEST OK · ${assertions} assertions`);
    return;
  }

  console.log("[runtime-test] 5. embedded 本地执行、退出码/输出/cwd 与无 Docker 调用");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "param-embedded-test-"));
  const workdir = path.join(temporary, "task-1");
  const fakeBin = path.join(temporary, "bin");
  const dockerMarker = path.join(temporary, "docker-called");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeDocker = path.join(fakeBin, "docker");
  fs.writeFileSync(fakeDocker, `#!/usr/bin/env bash\ntouch ${JSON.stringify(dockerMarker)}\nexit 99\n`, { mode: 0o755 });
  const originalRuntime = config.kali.runtime;
  const originalPath = process.env.PATH;
  config.kali.runtime = "embedded";
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  try {
    const result = await kaliExec("printf '%s' \"$PWD\" > cwd.txt; printf 'stdout-ok'; printf 'stderr-ok' >&2; exit 7", { workdir });
    equal(result.code, 7, "embedded 透传真实非零退出码");
    equal(result.stdout, "stdout-ok", "embedded 保留 stdout");
    ok(result.stderr.includes("stderr-ok"), "embedded 保留 stderr");
    equal(fs.readFileSync(path.join(workdir, "cwd.txt"), "utf8"), workdir, "embedded cwd 是本任务目录");
    equal(fs.existsSync(dockerMarker), false, "embedded 不得调用 docker");

    console.log("[runtime-test] 6. Abort/timeout 只清理本任务进程组");
    const controller = new AbortController();
    const survivor = kaliExec("sleep 0.6; printf survivor-ok > survivor.txt", { workdir, timeoutMs: 10_000 });
    const victim = kaliExec("printf '%s' \"$$\" > victim.pid; trap 'exit 143' TERM; while true; do sleep 1; done", { workdir, timeoutMs: 30_000, signal: controller.signal });
    await sleep(150);
    controller.abort();
    const [victimResult, survivorResult] = await Promise.all([victim, survivor]);
    equal(victimResult.code, 130, "Abort 返回中断退出码");
    const victimPid = Number(fs.readFileSync(path.join(workdir, "victim.pid"), "utf8"));
    let victimAlive = true;
    for (let attempt = 0; attempt < 50 && victimAlive; attempt++) {
      await sleep(100);
      try { process.kill(victimPid, 0); } catch { victimAlive = false; }
    }
    equal(victimAlive, false, "Abort 后目标任务进程必须真实退出，而不只是工具返回");
    equal(survivorResult.code, 0, "中止一个 Worker 不影响另一个进程组");
    equal(fs.readFileSync(path.join(workdir, "survivor.txt"), "utf8"), "survivor-ok", "并行 Worker 正常完成");

    const started = Date.now();
    const timedOut = await kaliExec("sleep 30", { workdir, timeoutMs: 150 });
    equal(timedOut.code, 124, "超时返回124");
    ok(Date.now() - started < 10_000, "超时进程组应在清理期限内退出");
    equal(fs.existsSync(dockerMarker), false, "清理路径也不得调用 docker");
  } finally {
    config.kali.runtime = originalRuntime;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`RUNTIME TEST OK · ${assertions} assertions`);
}

main().catch((error) => {
  console.error(`RUNTIME TEST FAILED: ${(error as Error).stack ?? error}`);
  process.exitCode = 1;
});
