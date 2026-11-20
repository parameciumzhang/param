import { spawnSync } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";

/**
 * pi 包管理器包装（跨平台）：把 pi CLI 的 agentDir 固定为项目自包含的 .pi-agent/，
 * 使 install/list/remove/update 的 settings.json 与 npm/node_modules 全部落在项目内
 * （与 models.json/auth.json 同目录），编排器创建的 Agent 能直接发现这些 extension。
 *
 * 用法（等价于 pi <args>，只是钉住了 PI_CODING_AGENT_DIR）：
 *   npm run pi:install -- npm:pi-mcp-adapter   # 安装各角色可按开关使用的 pi 扩展
 *   npm run pi:install -- list                 # 查看已安装的包
 *   npm run pi:install -- remove npm:pi-mcp-adapter
 *   npm run pi:install -- update --extensions
 *
 * 之后给各角色挂 MCP：见 pi-mcp-adapter 的 README（extension 的配置同样放 .pi-agent/）。
 */

const USAGE = `用法:
  npm run pi:install -- <pi 包管理子命令及参数>
示例:
  npm run pi:install -- npm:pi-mcp-adapter        # 安装（pi install npm:pi-mcp-adapter）
  npm run pi:install -- list                      # 列出已安装
  npm run pi:install -- remove npm:pi-mcp-adapter # 卸载
  npm run pi:install -- update --extensions       # 更新已安装扩展`;

function main(): number {
  const args = process.argv.slice(2);
  // 常见直传场景容错：npm run pi:install -- npm:pi-mcp-adapter（首参是源而不是子命令）→ 补 install
  const normalized = args.length > 0 && ["install", "remove", "uninstall", "update", "list"].includes(args[0])
    ? args
    : ["install", ...args];
  // 直接以 node 运行包的 bin 入口（.cmd shim 在新版 Node 下禁止被 spawn）
  const cli = path.join(config.root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  const r = spawnSync(process.execPath, [cli, ...normalized], {
    stdio: "inherit",
    cwd: config.root,
    env: { ...process.env, PI_CODING_AGENT_DIR: path.resolve(config.agentDir) },
  });
  if (r.error) {
    console.error(`无法启动 pi CLI（${cli}）: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

process.exit(main());
