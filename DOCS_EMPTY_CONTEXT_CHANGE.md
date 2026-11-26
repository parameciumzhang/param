# 四角色空 docs 改动与影响检查

## 1. 改动目标与最终行为

Manager、Planner、Worker 和 Compactor 仍保留 pi 默认 system prompt 的结构化段落，但项目内联扩展会在每次 `before_agent_start` 时覆盖 `docs` section。最终结构为：

```text
<docs>

</docs>
```

正文仅含一个空格，`trim()` 后为空；SDK 默认的 `Main documentation`、`Additional docs`、`Examples` 和阅读规则不再进入四个角色的上下文。

不能直接使用空字符串：pi-coding-agent 1.4.0 只应用 truthy 的自定义 section，赋 `''` 会恢复默认 docs 正文。因此实现使用单个空格作为空白占位，而不是修改 pi 源码或整体替换 system prompt。

作用范围为 Manager、Planner、Worker、Compactor 全部四个角色；空 docs 不随任何角色的外部扩展/MCP 开关禁用。

## 2. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/system-prompt.ts` | 新增。定义空 docs 空白占位、section 覆盖函数及 `param-empty-docs` 内联扩展 |
| `src/agent-factory.ts` | 四角色始终加载空 docs 扩展；MCP 名称扩展仍由角色扩展开关控制；四角色统一显式绑定扩展并报告加载错误 |
| `src/runtime-selftest.ts` | 新增空 docs、其他 system section 保持、`noExtensions:true` 内联加载、空字符串回落行为和无 `.mcp.json` 降级测试 |
| `DEVELOPMENT.md` | 更新模块职责、扩展边界、SDK 升级注意事项及 runtime 测试说明；该文件在当前仓库被 `.gitignore` 忽略 |
| `PLANNER_WORKER_CONTEXT.md` | 更新实际上下文结构、空 docs 说明、MCP 无配置时的行为及源码依据 |
| `DOCS_EMPTY_CONTEXT_CHANGE.md` | 本改动与影响检查报告 |
| `README.md` | 在“长任务-内网渗透评测靶场”标题下添加 <https://github.com/inwpu/shadownet-benchmark> |

`npm run build` 会重新生成被 `.gitignore` 忽略的 `dist/`，没有手工修改构建产物。All-in-One Dockerfile 使用 `COPY src ./src` 后执行 TypeScript 构建，新源码文件会自动包含，无需增加独立复制规则或 npm 依赖。

## 3. 实现细节

### 内联扩展组合

- `param-empty-docs`：四个角色均固定加载，不随 `EXTENSIONS_*` 禁用。
- `param-mcp-tool-names`：仅在对应角色 `extensions=true` 时加载，原逻辑不变。
- `noExtensions:true` 继续阻止外部扩展；项目显式提供的 inline factory 仍可加载。
- 四个角色即使关闭外部扩展，也会因空 docs 内联扩展而执行 `session.bindExtensions({mode:'print'})`。此时不会因此加载或连接 MCP。

### 保持不变的功能

- `<tools>`、`<rules>`、`<addendum>`、`<skills>`、`<cwd>` 和可选 `<mcp_tool_names>` 的生成逻辑。
- 原生 tool declarations、参数 JSON Schema、工具闭包中的 Challenge/task 绑定。
- Planner/Worker 用户消息、任务快照字段及注入顺序。
- 每轮全新 `SessionManager.inMemory()` 的跨唤醒无状态模型。
- 数据库固定脚本、事务、SQL 归属校验、执行锁、任务治理与报告逻辑。
- Challenge 调度、Worker 公平性、Compactor、history_db 和中断收尾。
- Kali 双运行时、命令执行和进程组清理。
- MCP 配置发现、代理调用和按需 `describe/search`；仅 docs 正文被覆盖。

### 需要留意的边界

1. 该实现依赖 pi 1.4.x 的自定义 section 覆盖及 truthy 行为；升级 SDK 必须重跑对应回归测试。
2. 如果以后新增第三方扩展读取或改写任一角色的 docs section，它会看到空正文；加载顺序不同的后续扩展也可能再次覆盖 docs。当前 `param-mcp-tool-names` 不修改 docs。
3. 四角色在外部扩展关闭时新增的是 docs-only 扩展绑定和 `session_start` 生命周期，不是 MCP 能力；这是保证空 docs 可靠的必要变化。
4. 本次只将 docs 正文清空，保留 `<docs>` 标签，因此不会获得“整个段落完全移除”的极少额外 token 收益。

## 4. 验证结果

已执行：

```text
npm run build
结果：通过。

npm run runtime:test
结果：通过，RUNTIME TEST OK · 78 assertions。
```

新增及相关断言覆盖：

- 覆盖前默认存在 pi 文档索引，覆盖后索引消失且 docs 正文为空。
- `<tools>`、`<rules>`、`<addendum>`、`<cwd>` 保持存在。
- `noExtensions:true` 时项目空 docs 内联扩展仍加载并注册 `before_agent_start`。
- 空字符串会恢复默认 docs，防止以后误把单空格占位改成 `''`。
- 没有 `.mcp.json` 时，即使缓存存在，也不生成 `mcp_tool_names`。
- 原有配置、输入合并、MCP 名称过滤、embedded 执行、Abort/timeout 和并行进程组隔离测试全部通过。

未执行 `npm run selftest`、`npm run e2e` 或 `npm run image:verify`：这些命令会清业务表/workspaces 或构建运行测试镜像，当前已有运行产物，未对其实施破坏性测试。本次未启动真实 LLM。正式发布前仍建议在专用测试库和临时输出目录执行完整 E2E；本次代码改动不涉及数据库和调度路径。

## 5. extensions=true 但没有 MCP 配置时的上下文

**仍会产生 MCP 代理相关的固定额外上下文。**

当前 `.env` 中四个角色扩展均为 true，项目根只有 `.mcp.json.example`，没有真实 `.mcp.json`，正好属于该场景。根据当前安装的 pi-mcp-adapter 7.0.0：

| 内容 | 是否存在 |
|---|---|
| `<mcp_tool_names>` | 不存在；缺少配置时整个段省略 |
| 各远端 MCP 工具的独立 declarations | 不存在；且当前 `directTools:false` |
| 缓存中的远端工具描述、Schema、instructions、headers 批量注入 | 不存在 |
| `<tools>` 中的 `mcp` 代理条目 | 仍存在 |
| 统一 `mcp` 代理的 description、参数 Schema/tool declaration | 仍存在 |

也就是说，“没有 MCP 配置”只会去掉服务器/工具名称等动态内容，不会自动去掉适配器注册的统一代理工具。

若完全不需要这部分上下文，应设置对应角色开关，例如：

```env
EXTENSIONS_PLANNER=false
EXTENSIONS_WORKER=false
```

当前 `.env` 存在角色级 true，因此只把全局 `EXTENSIONS_ENABLED=false` 会被这些角色级 true 覆盖。关闭外部扩展后，空 docs 内联扩展仍然有效，四个角色都不会恢复默认文档索引。
