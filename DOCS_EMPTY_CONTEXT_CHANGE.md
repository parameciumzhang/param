# 四角色 docs 正文清空：改动与影响报告

## 结论

已通过 pi 扩展的 `before_agent_start` section 覆盖机制，将 **Manager、Planner、Worker、Compactor** 四角色的 `<docs>` 正文统一清空，同时保留标签。未修改 `node_modules`、pi system prompt 构建源码或整体替换 system prompt。

## 代码改动

- `src/system-prompt.ts`
  - 新增 `createEmptyDocsExtension()`。
  - 在 `before_agent_start` 中修改 `event.systemPromptOptions.sections.docs`。
  - 使用 `EMPTY_DOCS_SECTION_CONTENT = " "`（单个空格）。
- `src/agent-factory.ts`
  - 四角色始终加载 `param-empty-docs` 内联扩展。
  - `param-mcp-tool-names` 仍按 `opts.extensions` 加载。
  - 四角色统一调用 `session.bindExtensions({mode:"print"})`。
- `src/runtime-selftest.ts`
  - 新增 docs section 的实际构建测试及空字符串回落回归测试。

## 为什么使用单个空格

pi-coding-agent 1.4.0 仅在自定义 section 值为 truthy 时覆盖默认内容：

- `" "`：覆盖成功，正文 `trim()` 后为空。
- `""`：被当作未覆盖，恢复默认文档索引。

因此保留一个空格作为实现细节，而不是把默认文档正文整体复制到项目代码中。

## 对上下文的影响

以下默认 docs 索引不再进入四角色模型上下文：

- `Main documentation: .../README.md`
- `Additional docs: .../docs`
- `Examples: .../examples`
- “何时阅读 pi 文档”以及各类文档主题的说明

四角色仍会保留：

- pi preamble；
- `<tools>`；
- `<rules>`；
- 本题或本角色 `<addendum>`；
- 可选 `<skills>`；
- `<cwd>`；
- 可选 `<mcp_tool_names>`；
- tool declarations。

当前 `<docs>` 结构为：

```text
<docs>

</docs>
```

## 开关行为

- `EXTENSIONS_*=true`：外部扩展、`param-mcp-tool-names` 和 `param-empty-docs` 均加载。
- `EXTENSIONS_*=false`：外部扩展与 MCP 名称扩展不加载，但 `param-empty-docs` 仍加载。
- 内联扩展在 pi 中显示为 `<inline:param-empty-docs>`。
- 扩展加载失败会显式输出告警，避免静默回落到默认 docs。

这样关闭 MCP 以减少上下文时，不会同时失去 docs 优化。

## 对角色能力的影响

- 没有给任何角色新增或删除工具。
- 没有改变角色模型、提示词 addendum、业务快照、数据库或任务生命周期。
- Manager 与 Worker 仍可通过 `read` 主动读取 pi 文档，但本次任务不强制增加默认路径。
- 本次修改不是 pi SDK 层修改；升级 pi 后仍应运行 `runtime:test`，尤其关注 truthy section 的覆盖行为。

## 验证

已执行并通过：

```bash
npm run build
npm run runtime:test
git diff --check
```

`runtime:test` 共通过 78 项断言，其中新增覆盖：

1. 默认 prompt 原先包含 `Main documentation:`。
2. `noExtensions:true` 时内联 `param-empty-docs` 仍加载且无错误。
3. 触发真实 `before_agent_start` handler 后，docs 正文为空。
4. 默认文档路径索引消失。
5. tools、rules、addendum、cwd 保持不变。
6. 空字符串会恢复默认 docs，防止后续误改占位实现。
7. 原有扩展开关、MCP 名称段过滤和其他运行时测试继续通过。

未启动真实 LLM，因此未产生模型 API 调用或模型响应。未运行会清理业务表/workspaces 的 PG selftest、E2E 或镜像测试。
