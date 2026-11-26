# Planner / Worker 每次唤醒时的完整上下文结构

> 本文依据当前仓库的 `README.md`、`DEVELOPMENT.md` 和实际源码静态整理。
> 未启动编排器、数据库、Kali 或 LLM；文中的 Challenge、任务、工具探测结果和路径均为说明性示例，不是一次真实运行的转储。
> 当前安装的 `@earendil-works/pi-coding-agent` 为 1.4.0。可选扩展的具体结果仍取决于运行时的环境变量、`.mcp.json`、MCP 缓存和扩展包。

## 1. 核心结论

Planner 和 Worker 每次被唤醒时都会创建一个**全新的 `SessionManager.inMemory()` 会话**。上一次唤醒产生的 assistant 回复、思考、工具调用和工具结果都不会自动带入下一次唤醒。

每次唤醒时的初始模型输入可概括为：

```text
全新 in-memory AgentSession
├─ system message
│  ├─ pi 默认 preamble
│  ├─ <tools>              当前可见工具的一句话说明
│  ├─ <rules>              pi 默认及工具贡献的规则
│  ├─ <docs>               保留标签；四角色正文均由内联扩展覆盖为空
│  ├─ <addendum>           本题、本角色 generated system prompt
│  ├─ <skills>             可选；仅技能索引，当前仓库实际无 SKILL.md
│  ├─ <cwd>                当前工作目录
│  └─ <mcp_tool_names>     可选；只含 MCP 服务器名和工具名
├─ user message
│  ├─ Planner：本题 ID/名称 + 完整本题快照 + 完成事件 + 本轮决策指令
│  └─ Worker：工作目录/运行环境 + 裁剪本题快照 + 当前任务 + 执行指令
└─ tool declarations
   ├─ 工具名称、description、参数 JSON Schema 等由 SDK 随请求声明
   └─ 不等同于全部都拼接在 system message 文本里
```

同一轮中模型调用工具后，后续请求还会带上本轮新增的 assistant/toolResult 消息；这些属于**本轮运行过程**，不是下一次唤醒的预注入上下文。

---

## 2. 唤醒来源与各类数据的生成时机

| 项目 | Planner | Worker |
|---|---|---|
| 唤醒原因 | Challenge 激活、历史恢复、该题新任务完成、无未完成任务时的静止点兜底；另有 Ctrl+C/SIGTERM 中断收尾轮 | 编排器从 active Challenge 中公平分发一个未完成任务 |
| 会话 | 每轮全新 in-memory | 每个任务全新 in-memory |
| 本题角色提示词 | 发布/恢复时生成到 `prompts/generated/challenges/<id>/planner.system.md`，每次创建 Agent 时读取 | 发布/恢复时生成到 `prompts/generated/challenges/<id>/worker.system.md`，每次创建 Agent 时读取 |
| 任务快照 | 每次唤醒前重新查询 PostgreSQL | 每个任务启动前重新查询 PostgreSQL |
| 完成事件 | 仅本轮启动前收集到的、本题新完成的全局 `task_id`，排序后注入；在途 Planner 不会被打断或热更新上下文 | 无完成事件列表 |
| 当前任务 | 不绑定单一执行任务 | 分发后再次读取并校验当前 `TaskRow`，绑定本题和当前 `task_id` |
| Kali 工具/字典清单 | 不注入 | 编排启动时探测一次并缓存，之后随每个 Worker 用户消息注入 |
| MCP 名称段 | 每次 `before_agent_start` 按当前 cwd 配置和缓存尝试生成 | 同左；Worker 的 `.mcp.json` 先由项目根复制到任务 cwd |
| skills | 明确 `skills:false` | 每次创建 Agent 时扫描 `skills/worker/`，只加载有效技能 |

注意：`runPlanner()` 中计算的 `before.length` 和 `incompleteBefore` 只用于日志，**不会作为独立字段注入模型**。

---

## 3. system message 的固定顺序与公共部分

### 3.1 完整段落顺序

在当前项目未使用其他自定义扩展改写提示词的前提下，顺序如下：

```text
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

<tools>
  ...按角色列出的工具 promptSnippet...
</tools>

<rules>
  ...按角色和可见工具生成的规则...
</rules>

<docs>

</docs>

<addendum>
  ...本题 Planner 或 Worker generated prompt...
</addendum>

[<skills>
  ...可选技能索引...
</skills>]

<cwd>
  ...项目根或任务工作目录...
</cwd>

[<mcp_tool_names>
  ...可选 MCP 名称...
</mcp_tool_names>]
```

其中：

- `preamble` 是不带 XML 标签的首段，其余段落带对应标签。
- 项目使用 `appendSystemPrompt`，所以保留 pi 默认系统提示词，不是用角色提示词整体替换它。
- 四角色均加载项目内联 `param-empty-docs` 扩展，在 `before_agent_start` 将 docs section 覆盖为单个空格；正文为空但标签保留，且不受 `EXTENSIONS_*` 开关影响。
- 角色提示词中的整行 HTML 注释（例如 `<!-- role: planner -->`）会在发送前删除。
- `noContextFiles:true`，因此没有 `<project_context>`；项目根 `README.md`、`DEVELOPMENT.md`、`AGENTS.md` 等不会因为存在就自动注入。
- `noPromptTemplates:true`、`noThemes:true`，它们不向本上下文增加项目模板或主题内容。
- `<skills>` 只包含技能名称、描述和 `SKILL.md` 路径，技能正文要由 Worker 后续按需 `read`，不是一开始全部内联。
- 其他第三方扩展理论上可通过 `before_agent_start` 等钩子修改段落或追加消息；本文列出的是当前项目固定代码及已配置的 MCP 名称扩展所确定的结构。

### 3.2 两种角色都含有的空 `<docs>` 段

SDK 1.4.0 默认会在这里生成 pi 自身文档的路径索引。当前项目通过 `src/system-prompt.ts` 的内联扩展覆盖该 section，Planner/Worker 实际结构为：

```text
<docs>

</docs>
```

正文只有一个空格，`trim()` 后为空；默认的 `Main documentation`、`Additional docs`、`Examples` 等索引不再进入上下文。之所以不直接赋空字符串，是因为 SDK 1.4.0 只应用 truthy 的自定义 section，空字符串会恢复默认 docs 正文。

该内联扩展只覆盖 docs 正文，不改变 `<tools>`、`<rules>`、`<addendum>`、`<cwd>` 或 tool declarations，也不随外部扩展/MCP 开关禁用。Manager、Planner、Worker、Compactor 四角色均加载此扩展。

项目的 `README.md` 和 `DEVELOPMENT.md` 仍不会自动注入。

---

## 4. Planner 每次唤醒的上下文

### 4.1 角色级配置

普通 Planner：

- `cwd`：项目根目录。
- `builtinTools:false`，即没有 pi 的 `read/bash/edit/write`。
- `skills:false`，没有 `<skills>` 段。
- 固定自定义工具：`insert_task`、`task_delete`、`force_complete_task`、`wait_for_next_event`、`generate_report`、`get_fact_detail`、`get_finding_detail`。
- 外部扩展/MCP 由 `EXTENSIONS_PLANNER` 控制；未设置时继承 `EXTENSIONS_ENABLED`，代码默认启用。空 docs 内联扩展不受该开关影响。
- generated prompt 只渲染本题 `GOAL`、`CUSTOMIZATION`，以及代码意图中的任务长度变量；**不渲染本题 ASSET**。

中断收尾 Planner：

- 同样全新会话、同样读取本题 Planner system prompt。
- 固定工具**只剩 `generate_report`**。
- 用户消息改为中断说明和“只生成阶段性报告”的指令。

### 4.2 普通 Planner 的 `<tools>` 与 `<rules>` 示例

以下示例假定扩展关闭，因此不含 `mcp`；这是为了展示确定的项目基线，并非表示扩展默认关闭。

```text
<tools>
- insert_task: 向当前 Challenge 发布任务（全局 task_id 自动递增）。
- task_delete: 删除本题无证据的未完成任务。
- force_complete_task: 强制完成本题指定任务（必要时先停止 Worker）；保留证据，且可与其他 Planner 决策同轮使用。
- wait_for_next_event: 等待本题下一次内部事件。
- generate_report: 生成本题终态报告并完成本题。
- get_fact_detail: 查询本题单条 fact 的完整细节。
- get_finding_detail: 查询本题压缩 finding 的原始详情。

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>

<rules>
- Be concise in your responses
- Show file paths clearly when working with files
</rules>
```

中断 Planner 的 `<tools>` 中，`generate_report` 的 snippet 改为“生成本题中断报告。”，其余固定工具不出现。

### 4.3 Planner `<addendum>` 示例全文

示例 Challenge：

```text
challenge_id = 7
name         = Web-Basic
asset        = http://10.20.0.7:8080（instance_id: web-basic-7）
goal         = 获取该 Web 服务中的 flag，并保留可验证的利用证据。
customization= 仅允许测试本题实例；不得攻击其他赛题或外部地址。平台已授权在解题后停止 instance_id=web-basic-7。
```

将第 3 节公共段落放在前面后，本题 Planner 的 `<addendum>` 为：

```text
<addendum>
你是 CTF 多赛题编排系统中某一道 Challenge 的 **Planner**（任务规划与决策者）。每次触发都是全新会话，你只能看到用户消息明确给出的本题 ID、名称、任务快照和本题内部完成事件。

## 本题测试目标（Goal）

获取该 Web 服务中的 flag，并保留可验证的利用证据。

## 本题定制要求（Customization）

仅允许测试本题实例；不得攻击其他赛题或外部地址。平台已授权在解题后停止 instance_id=web-basic-7。

上述约束同时约束任务设计。不得规划、查询或引用其他赛题，不得控制赛题激活顺序或并发。

## 输入与详情

- 你收到本题 task 全量快照，含已完成/未完成状态、task、note、fact/finding，用于查重与增量规划。
- 用户消息中的完成事件只包含本题 task\_id；没有事件时是本题激活、历史恢复或静止点触发。
- `get_fact_detail(fact)` 查询本题快照中单条 `[fact]` 的完整细节；方括号可省略。
- `get_finding_detail(finding)` 查询本题单条压缩 `[finding]` 的原文；未压缩时会提示已是详细版本。
- 两类详情工具都已绑定 Challenge，不接受也不能指定 challenge\_id。

## 本轮决策

### A. `insert_task`

根据本题已有 fact/finding/note 发布有价值的下一批任务。每任务调用一次：

- `task` 是指令式描述（动作 + 对象 + 期望产出），不超过 600 字符；Worker 看不到 note，执行所需信息必须写进 task。
- `note` 简述任务意义与后续建议，不超过 200 字符。
- 单轮最多4个；有依赖时只发布当前可执行任务；避免任务过宽导致 Worker 超时。

### B. `task_delete`

仅删除本题误发布、重复或失效的空未完成任务。已有任何 fact/finding 或已完成的任务禁止删除；在途 Worker 会先停止并退出。删除可与发布、等待、报告或详情查询同轮组合。

### C. `force_complete_task(task_id)`

必要时强制完成本题指定任务；若任务已被 Worker 认领，固定脚本会先停止 Worker，等待其完全退出后才写入完成状态。已完成任务幂等返回。它不与 Planner 其他决策工具互斥，可与发布、删除、等待、报告及详情查询同轮组合；同批调用按模型给出的顺序执行。

强制完成会保留已有 fact/finding。

### D. `wait_for_next_event`

本题没有值得发布的新任务且尚未终态时显式等待。正常情况下只有本题后续激活/任务完成等内部事件会唤醒你；没有人工补充信息链路。若等待时本题已无 Worker 在途且没有未完成任务，编排器会按静止点兜底唤醒你重新决策；连续无意义等待超过安全阀会将本题标记失败，不得把等待当作终态。等待与发布、报告互斥。

### E. `generate_report`

只有本题 goal 已实质达成（或继续测试已无价值）、无未完成任务且 finding 足以支撑结论时调用。`conclusion` 用中文写本题目标达成情况、关键发现和证据。

固定脚本会再次检查本题未完成任务与在途 Worker，成功后仅把本题标记 completed 并生成本题报告；其他赛题继续，queued 赛题由编排器按名额激活。

## 解题成功后的实例收尾（必须）

本题已实质解题成功且证据充分时，在赛事授权与 customization 允许实例管理操作的前提下，**必须先在 `generate_report` 前安排并确认 Worker 通过赛事平台提供的停止实例接口/工具停止本题对应实例**。只停止本题实例，不得停止其他赛题或其他战队实例。若尚未停止，应发布明确的收尾任务交给 Worker；平台没有停止接口或停止失败时，必须保留真实 finding，不得伪报已停止。

## 硬性约束

- 你的内置工具只有 `insert_task`、`task_delete`、`force_complete_task`、`wait_for_next_event`、`generate_report` 与两类本题详情固定工具。
- 若已通过角色开关启用 MCP，`mcp_tool_names` 只列出工具名称；可通过 `mcp` 代理用 `describe` 按需查看说明，并调用与当前 Challenge 直接相关的只读接口。不得查询其他 Challenge。
- `task_delete` 与 `force_complete_task` 都是独立治理操作；二者不得同时治理同一任务，但均可与其他 Planner 决策工具同轮使用。`insert_task` 不得与等待或报告混用，等待与报告互斥。
- 所有事实和结论必须来自本题 Worker 的真实写回，不得臆测。
</addendum>

<cwd>
/opt/param
</cwd>
```

**任务长度渲染：** `renderTemplate()` 会将 `{{MAX_TASK_CHARS}}` 和 `{{MAX_TASK_NOTE_CHARS}}` 分别替换为 `INSERT_TASK_MAX_CHARS`、`INSERT_TASK_MAX_NOTE_CHARS` 的当前配置值。上面的示例使用默认值 600 和 200；自定义配置时以实际配置为准，不会残留模板占位符。

### 4.4 Planner 用户消息中的快照格式

`renderTaskSnapshot(challengeId, "planner")` 只查询当前 Challenge，按 `task_id ASC` 排列。空表时整个快照为：

```text
（本题 task 表当前为空）
```

非空时每个任务的精确字段结构为：

```text
## 任务 #<task_id> [已完成|未完成]
任务内容: <task.task>
note（任务意义与后续操作建议）: <task.note；空字符串显示“（无）”>
fact（环境类信息）: <task.fact；NULL 显示“（无）”>
finding（任务结果）: <task.finding；NULL 显示“（无）”>
```

任务之间有一个空行。“全量”指**本题全部任务行**，不是整场赛事全部任务，也不代表包含数据库的全部列。

### 4.5 普通 Planner 用户消息示例全文

示例数据库中有两个任务：#101 已完成，#102 未完成；本次由 #101 的完成事件唤醒。

```text
当前只处理 Challenge #7（Web-Basic）。不得规划、查询或引用其他赛题。

本题 task 全量快照（含已完成任务，供查重与增量规划）：
<<<TASK_SNAPSHOT
## 任务 #101 [已完成]
任务内容: 识别目标 Web 服务、开放端口和首页技术特征
note（任务意义与后续操作建议）: 确认基础攻击面，为登录接口测试提供入口
fact（环境类信息）: [80/tcp 开放；首页标题为 Web-Basic]
finding（任务结果）: [发现 POST /login 登录接口]

## 任务 #102 [未完成]
任务内容: 检查 POST /login 的 username 参数是否存在 SQL 注入，并记录可复现证据
note（任务意义与后续操作建议）: 优先复用 #101 的接口信息，避免重复枚举
fact（环境类信息）: （无）
finding（任务结果）: （无）
TASK_SNAPSHOT>>>

本题待处理内部完成事件: #101

你的内置能力只有绑定本题的固定工具，没有通用 read/bash、Kali 或其他赛题查询接口。若已启用 MCP，只能查询当前 Challenge 直接相关的只读信息；实际探测通过 insert_task 交给 Worker。
请决策：insert_task 发布本题任务；task_delete 删除本题空未完成任务；force_complete_task(task_id) 可在必要时停止 Worker 并强制完成本题指定任务，但这只改变状态、不代表执行成功，且可与其他 Planner 决策同轮使用；wait_for_next_event 等待本题内部事件；goal 达成且无未完成任务时 generate_report 只结束本题。
强制完成必须保留已有 fact/finding，不得补造执行结果。若本题已解题成功，在赛事授权允许实例管理操作的前提下，generate_report 前必须安排并确认 Worker 通过赛事平台接口停止本题实例；停止失败须留有真实 finding。
快照中的单条 fact/finding 可分别用 get_fact_detail/get_finding_detail 回查本题详情。
```

若没有完成事件，事件行会原样变为：

```text
本题待处理内部完成事件: （无；本次为激活/静止点/中断触发）
```

这里不会注入“唤醒原因=历史恢复”的独立枚举字段；无事件时统一使用上述文案。

### 4.6 中断 Planner 用户消息示例全文

中断轮仍带当时重新查询到的完整本题快照，但决策指令被替换。示例：

```text
当前只处理 Challenge #7（Web-Basic）。不得规划、查询或引用其他赛题。

本题 task 全量快照（含已完成任务，供查重与增量规划）：
<<<TASK_SNAPSHOT
## 任务 #101 [已完成]
任务内容: 识别目标 Web 服务、开放端口和首页技术特征
note（任务意义与后续操作建议）: 确认基础攻击面，为登录接口测试提供入口
fact（环境类信息）: [80/tcp 开放；首页标题为 Web-Basic]
finding（任务结果）: [发现 POST /login 登录接口]

## 任务 #102 [未完成]
任务内容: 检查 POST /login 的 username 参数是否存在 SQL 注入，并记录可复现证据
note（任务意义与后续操作建议）: 优先复用 #101 的接口信息，避免重复枚举
fact（环境类信息）: （无）
finding（任务结果）: （无）
TASK_SNAPSHOT>>>

本题待处理内部完成事件: （无；本次为激活/静止点/中断触发）

<<<INTERRUPTED_SHUTDOWN
用户已通过 Ctrl+C/SIGTERM 停止整场编排。在途 Planner/Worker 已退出，本快照是退出后的状态。
INTERRUPTED_SHUTDOWN>>>
只调用 generate_report 生成本题阶段性报告；如实保留未完成任务，不宣称 goal 达成。
```

---

## 5. Worker 每次被唤醒的上下文

### 5.1 角色级配置

- `cwd`：`workspaces/task-<全局task_id>`，不是项目根。
- `builtinTools:true` 且 `excludeTools:[]`；按当前默认 settings，可见内置工具为 `read`、`bash`、`edit`、`write`。
- 固定自定义工具：`write_fact`、`write_finding`、`complete_task`、`get_fact_detail`、`get_finding_detail`。
- `KALI_ENABLED=true` 时追加 `kali_bash`。
- 可以加载 `skills/worker/` 中的有效技能；但当前仓库没有任何 `SKILL.md`，所以当前静态检出的基线没有 `<skills>` 段。
- 外部扩展/MCP 由 `EXTENSIONS_WORKER` 控制；未设置时继承 `EXTENSIONS_ENABLED`，代码默认启用。空 docs 内联扩展不受该开关影响。
- generated prompt 只渲染本题 `ASSET`、`CUSTOMIZATION`；**不渲染本题 GOAL**。

### 5.2 Worker 的 `<tools>` 与 `<rules>` 示例

以下示例假定扩展关闭、`KALI_ENABLED=true`，因此没有 `mcp`，但有 `kali_bash`。

```text
<tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files
- write_fact: 写入当前任务的 fact/fact_detail。
- write_finding: 写入当前任务 finding。
- complete_task: 完成当前任务。
- get_fact_detail: 查询本题单条 fact 的完整细节。
- get_finding_detail: 查询本题压缩 finding 的原始详情。
- kali_bash: 在 Kali 工具环境的当前任务目录执行命令。

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- You can inspect PI_* environment variables for current model and session details.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>
```

### 5.3 Worker `<addendum>` 示例全文

沿用 Challenge #7，但 Worker 看到的是 ASSET，而不是 Planner 的 GOAL。

```text
<addendum>
你是 CTF 多赛题编排系统中某一道 Challenge 的一个 **Worker**（任务执行者）。写库与详情工具均已绑定本题和当前任务。

## 被测资产（Asset）

http://10.20.0.7:8080（instance_id: web-basic-7）

## 定制要求（Customization）

仅允许测试本题实例；不得攻击其他赛题或外部地址。平台已授权在解题后停止 instance_id=web-basic-7。

## Kali 可用工具与字典

按方向选用；现有工具不足时可手工测试。

| 方向      | 工具                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Web     | `nmap`、`netstat`、`curl`、`telnet`、`ssh`、`sqlmap`、`dirsearch`、`nuclei`、`msfconsole`、`jwt_tool`、`hydra`、`impacket-*`、`proxychains4` |
| Pwn     | `pwntools`、`gdb`、`patchelf`、`ROPgadget`、`checksec`                                                                               |
| Reverse | `r2`（radare2）                                                                                                                    |
| Crypto  | `pycryptodome`（`Crypto`）、`gmpy2`、`sympy`、`xortool`、`john`、`openssl`                                                              |
| Misc    | `binwalk`、`exiftool`、`steghide`、`zsteg`、`tshark`、`tcpdump`、`zbarimg`、`volatility3`（`vol`）                                        |
| VPN     | `wg`、`wg-quick`、`openvpn`                                                                                                        |

固定字典位于 Kali 工具环境的只读目录 `/wordlists`，优先按场景复用，不要无意义地重新生成大字典：

| 路径                                | 用途与使用注意                             |
| --------------------------------- | ----------------------------------- |
| `/wordlists/dirTOP1000.txt`       | web目录字典，可配合 dirsearch 工具            |
| `/wordlists/jwt-secretTOP10w.txt` | JWT 密钥字典，可配合 jwt\_tool；大字典不要直接读取上下文 |
| `/wordlists/passwordTOP200.txt`   | 密码字典                                |
| `/wordlists/portTOP1000.txt`      | 端口字典；逗号分隔                           |
| `/wordlists/usernameTOP15.txt`    | 用户名字典                               |

## 你的职责

用户消息会给你**一个**任务（含 task\_id 与任务描述）。你在指定的执行环境中实际完成它：

- 历史快照仅提供**本题**的 task\_id 和 fact/finding，不提供完成状态、task 描述或 note，也不包含其他赛题；当前任务 ID 与任务描述在历史快照之后单独注入。
- 细致且全面的测试，根据不同场景灵活改进测试方法和利用方法。

* Kali 渗透工具通过 `kali_bash` 执行；普通本地工具通过 `bash` 执行。
* 若已启用 MCP，系统提示词的 `mcp_tool_names` 只列出已发现的工具名称；通过 `mcp` 代理用 `describe` 按需查看功能与参数，再用 `tool` + `args` 调用。
* `get_fact_detail(fact)`：按历史快照中的**一条完整 `[fact]`**精确查询对应的 `fact_detail`，可直接复制方括号，也可只传原始 fact。不要传入包含多条记录的整个 fact 字段。
* `get_finding_detail(finding)`：按历史快照中的**一条完整 `[finding]`**精确查询 Compactor 压缩前的 `finding_detail`，方括号可省略。只有被压缩的 finding 才有独立详情记录；查询尚未压缩的 finding 时，工具会提示该 finding 已经为详细版本。不要传入包含多条记录的整个 finding 字段。
* 遇到困难时，善用之前的fact/finding，组合拳利用。

### 注意事项

1. `kali_bash` 每次调用都是全新 shell（起始目录为任务目录）；需要保持目录/变量状态时，在单条命令内用 `cd x && ...` 串联。长扫描显式传 `timeout_sec`。宿主机 `bash` 的起始目录同样是本任务目录。
2. 调用工具爆破或扫描时，尽量使用已提供的字典。比如：端口、目录、jwt密钥（内容较大不建议直接阅读）、用户名、密码

## 实时写库

- `write_fact(fact, fact_detail)`：记录**环境类信息**——端口、服务指纹、版本、目录结构、账号名等客观观察，发现即写，不要攒到最后。`fact` 是在**本题内唯一**且简短的概括，脚本会以 `[fact]` 形式追加到当前任务的 fact 字段，调用时无需自行添加方括号；`fact_detail` 保存完整细节。`fact` 单条最多 **60 字符**；超长或重复会失败，精简后重新调用 `write_fact`，不得丢弃对应事实。
- `write_finding(finding)`：记录**任务结果**——漏洞名称、发现过程、利用方法、利用该漏洞可获得什么、失败原因、踩坑点（尝试未果也是有效 finding）。调用时无需自行添加方括号。
- 写入内容需精简且具体，不遗漏必要细节，不写入无关信息。无需修复建议。
- 写库工具已绑定当前 Challenge 与当前任务，无需传入 challenge\_id/task\_id。

<br />

<br />

## 解题成功后的实例收尾（必须）

当前任务已经实质解题成功并写入充分证据后，在赛事授权与 customization 允许实例管理操作的前提下，**必须先通过赛事平台提供的停止实例接口/工具停止本题对应实例，再调用 `complete_task()`**。若平台能力通过 MCP 暴露，先用 `describe` 确认停止接口及参数，只停止本题 `instance_id` 对应实例，不得停止其他赛题或其他战队实例。

- 停止成功后，用 `write_finding` 记录平台真实返回及实例 ID；不得把目标服务内部的 stop/shutdown 接口误当成平台实例停止接口。
- 平台没有停止接口、接口不可用或停止失败时，如实 `write_finding` 记录原因，不得伪报已停止；随后仍须正常收尾当前任务。
- 停止平台实例不能代替 `complete_task()`，也不能删除或改写已经写入的解题证据。

## 收尾（必须）

任务无论成败，最后一步必须调用 `complete_task()`。

## 约束

- 一次只处理给你的这个 task\_id，不去执行其他任务。
- 你的命令工作目录是本任务的**专属工作目录**（路径见任务消息）；所有产物（脚本、扫描输出等）保存在该目录内。
- 所有对环境的改动必须可回滚或在报告中说明。
- 遇到环境不可达 / 工具缺失等情况：如实 write\_finding 说明原因，然后 complete\_task，不要空转。
- 不要将推测当成结论。

<br />
</addendum>

<cwd>
/opt/param/workspaces/task-102
</cwd>
```

### 5.4 Worker 用户消息中的快照格式

`renderTaskSnapshot(challengeId, "worker")` 同样查询本题全部任务并按 `task_id ASC` 排列，空表也返回 `（本题 task 表当前为空）`。但每个任务只保留：

```text
## 任务 #<task_id>
fact（环境类信息）: <task.fact；NULL 显示“（无）”>
finding（任务结果）: <task.finding；NULL 显示“（无）”>
```

明确没有：

- 其他任务的 `task` 描述；
- 任何任务的 `note`；
- `is_complete` 完成状态；
- 其他 Challenge 的任务；
- `detail.fact_detail`、`detail2.finding_detail` 全表正文（只能按需用工具回查）。

### 5.5 Worker 用户消息示例全文

示例当前执行任务为 #102，使用 container 后端；工具清单和字典大小是虚构的展示值。

```text
专属工作目录: /opt/param/workspaces/task-102（共享 Kali 容器 /work/task-102）
共享 Kali 容器实际工具: nmap curl sqlmap python3 pwntools(python) pycryptodome(python)
共享字典:
      12KB  /wordlists/dirTOP1000.txt
       2KB  /wordlists/passwordTOP200.txt
       1KB  /wordlists/usernameTOP15.txt
本题历史快照（仅本题 task_id/fact/finding，不含其他任务描述、note、完成状态或其他赛题）：
<<<TASK_SNAPSHOT
## 任务 #101
fact（环境类信息）: [80/tcp 开放；首页标题为 Web-Basic]
finding（任务结果）: [发现 POST /login 登录接口]

## 任务 #102
fact（环境类信息）: （无）
finding（任务结果）: （无）
TASK_SNAPSHOT>>>

你只执行 Challenge #7 的任务 #102：
任务内容: 检查 POST /login 的 username 参数是否存在 SQL 注入，并记录可复现证据
开始执行。write_fact/write_finding/complete_task 均已绑定当前 Challenge 和任务。最后必须 complete_task。
若当前任务已实质解题成功，在赛事授权允许实例管理操作的前提下，写入证据后必须再通过赛事平台接口停止本题实例，然后 complete_task；不得停止其他实例，失败须如实 write_finding。
```

可见顺序是：**运行环境 → 历史快照 → 当前任务 ID/描述 → 执行与收尾指令**。当前任务描述不依赖历史快照提供，而是在快照后单独注入。

运行环境有两种替代形式：

- `KALI_ENABLED=false`：不注册 `kali_bash`，环境段变为 `Kali 未启用，shell 使用宿主机 bash。`，首行也没有 Kali 路径括号。
- `KALI_RUNTIME=embedded`：文案使用“本容器 Kali”，Kali 工作目录与 hostWorkspace 相同，而不是 `/work/task-<id>`。

---

## 6. 可选上下文段

### 6.1 `<mcp_tool_names>`

两种角色的外部扩展/MCP 由角色开关控制；空 docs 内联扩展不受影响。MCP 名称扩展在 `before_agent_start` 时读取：

```text
Planner: <项目根>/.mcp.json
Worker:  <任务工作目录>/.mcp.json（运行前从项目根复制）
共同读取: <项目根>/.pi-agent/mcp-cache.json
```

只有配置和缓存均可读、服务器启用、缓存中存在工具且 include/exclude 过滤后仍有工具时才注入。示例：

```text
<mcp_tool_names>
以下是当前已发现的 MCP 工具名称。本段只包含服务器名和工具名，不包含功能描述或参数 Schema。

ctf-platform:
- get_instance
- stop_instance

需要功能说明或参数时，按需调用 mcp({ describe: "工具名", server: "服务器名" })。

调用工具时使用 mcp({ tool: "工具名", server: "服务器名", args: {} })，不要凭名称猜测参数。
</mcp_tool_names>
```

它位于 `<cwd>` 之后。冷缓存、配置缺失、JSON 损坏或过滤后为空时省略整个段。

启用 MCP 代理后，`<tools>` 还会增加类似下面的条目，并随请求声明代理工具：

```text
- mcp: MCP gateway — install by URL, status, search, describe, auth, and single MCP tool calls
```

当前 `.pi-agent/mcp-adapter.json` 设置了 `projectServers:"allow"`、`directTools:false`，所以项目 MCP 工具通过统一 `mcp` 代理发现和调用。描述、参数 Schema、instructions、headers 不会被 `mcp_tool_names` 段批量注入；按需 `describe/search` 的结果是在后续工具调用中进入本轮上下文。

扩展开启但没有 `.mcp.json` 时，`mcp_tool_names` 会省略，也不会声明各个远端 MCP 工具；但当前 pi-mcp-adapter 7.0.0 仍会默认注册统一 `mcp` 代理，因此 `<tools>` 条目和代理 tool declaration 这部分固定额外上下文仍存在。完全不需要 MCP 时应关闭对应角色的外部扩展；空 docs 内联扩展不受影响。

Planner 即使启用 MCP，角色指令仍只允许本题直接相关的只读查询，不能获得 `read/bash/kali_bash`。这只是提示词范围约束；需要强隔离时应关闭 Planner 扩展。

### 6.2 `<skills>`

如果以后在 `skills/worker/<skill-name>/SKILL.md` 添加有效技能，Worker 会在 `<addendum>` 后、`<cwd>` 前看到索引，结构为：

```text
<skills>
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>example-skill</name>
    <description>说明技能能做什么，以及什么任务应使用它。</description>
    <location>/opt/param/skills/worker/example-skill/SKILL.md</location>
  </skill>
</available_skills>
</skills>
```

技能正文不在这里展开。Planner 明确禁用 skills，即使 `skills/planner/` 后续放入文件也不会按当前代码加载。

---

## 7. 随请求声明的工具与参数结构

系统 `<tools>` 只是一句话导航；真正可调用工具还由 SDK 以名称、description、参数 Schema 等形式声明。项目固定工具与相关内置工具的参数如下；其中项目自定义工具的 Schema 均设置了 `additionalProperties:false`。

### 7.1 普通 Planner

| 工具 | 参数结构 | 绑定关系 |
|---|---|---|
| `insert_task` | `{ task: string(1..600), note: string(1..200) }`，长度可由配置修改 | 闭包绑定本题 |
| `task_delete` | `{ task_id: integer >= 1 }` | 闭包绑定本题 |
| `force_complete_task` | `{ task_id: integer >= 1 }` | 闭包绑定本题；同批顺序执行 |
| `wait_for_next_event` | `{}` | 本题运行状态 |
| `generate_report` | `{ conclusion: string(minLength=1) }` | 闭包绑定本题 |
| `get_fact_detail` | `{ fact: string(1..62) }`；60 为 fact 上限，另允许两侧方括号 | 闭包绑定本题 |
| `get_finding_detail` | `{ finding: string(minLength=1) }` | 闭包绑定本题 |

中断 Planner 只声明 `generate_report`，其 description 改为中断阶段性报告语义。

### 7.2 Worker

| 工具 | 参数结构 | 绑定关系 |
|---|---|---|
| `write_fact` | `{ fact: string(1..60), fact_detail: string(minLength=1) }` | 同时绑定本题和当前 task_id |
| `write_finding` | `{ finding: string(minLength=1) }` | 同时绑定本题和当前 task_id |
| `complete_task` | `{}` | 同时绑定本题和当前 task_id |
| `get_fact_detail` | `{ fact: string(1..62) }` | 本题 |
| `get_finding_detail` | `{ finding: string(minLength=1) }` | 本题 |
| `kali_bash`（可选） | `{ command: string(minLength=1), timeout_sec?: number >= 1 }` | 当前任务的 Kali 工作目录 |
| `read` | `{ path: string, offset?: number, limit?: number }` | 当前任务 cwd，支持绝对路径 |
| `bash` | `{ command: string, timeout?: number }` | 当前任务 cwd |
| `edit` | `{ path: string, edits: Array<{ oldText: string, newText: string }> }` | pi 内置文件编辑 |
| `write` | `{ path: string, content: string }` | pi 内置文件写入 |
| `mcp`（扩展可选） | 代理由 adapter 声明，支持 search/describe/tool/args/connect/auth 等 | 当前角色 cwd 下 MCP 配置及全局 adapter 配置 |

工具闭包中的 `challengeId/taskId` 不需要、也不允许由模型作为普通参数随意改传。Worker 写库 SQL 还同时匹配 `task_id + challenge_id`。

---

## 8. 明确不注入的内容

### 8.1 Planner 看不到的固定内容

- 本题 `asset`（角色模板刻意不渲染，用户消息也不补）。
- Kali 实际工具清单和字典文件清单。
- 其他 Challenge 的 ID、名称、asset、goal、任务或事件。
- 整场 Manager 原始输入和 Manager 历史会话。
- `detail` / `detail2` 的全部详情正文；只能按摘要回查。
- 通用 `read/bash/edit/write/kali_bash` 工具能力。

### 8.2 Worker 看不到的固定内容

- 本题 `goal` 和 Challenge 名称（用户消息只有 Challenge ID）。
- 历史任务描述、note、完成状态；当前任务描述和 ID 是快照之后单独提供的。
- 当前任务 note。
- 其他 Challenge 的信息。
- 全部详情表正文；只能按单条摘要回查。
- Planner 的完成事件列表和规划决策历史。

### 8.3 两者都不会跨唤醒自动获得的内容

- 上一次唤醒的 system/user/assistant/toolResult 消息、模型思考和最终回复。
- 上一次 Worker 的 shell 变量、进程内状态或会话记忆；文件产物只能留在任务工作区，业务结果应写入数据库。
- `compressed_at`、删除/强制完成协作字段、任务时间戳等内部治理列。
- 项目 README、DEVELOPMENT、报告实体、history_db 文件内容（除非某角色用其可用工具主动读取；Planner 当前无通用 read）。
- LLM API Key、数据库密码等配置秘密；模型 ID、thinking level、超时和并发数属于运行配置，不是这段业务用户消息的一部分。

在途 Planner 运行期间新到的完成事件只会累计到编排器内存，**不会修改在途上下文**；下次全新 Planner 才看到新事件和重新查询的快照。Worker 启动后也不会因其他 Worker 写库而实时刷新自己的初始快照。

---

## 9. 同一轮内部上下文如何增长

初次请求之后，如果模型调用工具，同一个 in-memory session 内会形成类似：

```text
system（上述结构）
user（上述唯一初始用户消息）
assistant（文本和/或工具调用）
toolResult（固定工具、内置工具或 MCP 的返回）
assistant（继续决策/执行）
toolResult
...
```

因此：

- “无状态”是指**跨 Planner 轮次、跨 Worker 任务无会话记忆**，不是同一轮里禁止连续工具调用。
- 本轮工具返回可能让模型看到数据库写入结果、命令输出或按需查到的详情；它们不是唤醒时预注入的固定快照。
- pi SDK 自身的会话自动压缩若在一个长会话内触发，属于本轮消息管理；项目的 Compactor 则是压缩 PostgreSQL 中已完成任务，供**下一次唤醒**生成更短快照。两者不能混为一谈。
- 下一次唤醒仍从空消息会话开始，只根据当时数据库和编排器事件重建初始上下文。

---

## 10. Planner / Worker 业务字段对照速查

| 数据 | Planner | Worker |
|---|---|---|
| Challenge ID | 有，用户消息 | 有，用户消息 |
| Challenge 名称 | 有 | 无 |
| Challenge asset | 无 | 有，system addendum |
| Challenge goal | 有，system addendum | 无 |
| Challenge customization | 有，system addendum | 有，system addendum |
| 本题全部 task_id | 有 | 有 |
| 完成状态 | 有 | 无 |
| 历史 task 描述 | 有 | 无 |
| 历史 note | 有 | 无 |
| 历史 fact/finding | 有 | 有 |
| 当前执行任务描述 | 不绑定单一任务 | 快照后单独注入 |
| 当前执行任务 note | 不适用 | 无 |
| 完成事件 task_id | 有，仅本题新完成事件 | 无 |
| fact/finding 详情全文 | 按需工具回查 | 按需工具回查 |
| 工作目录 | 项目根 | 当前 task 专属目录 |
| Kali 实测工具与字典清单 | 无 | Kali 启用时有 |
| 其他 Challenge 业务快照 | 无（但通用 MCP 不是强制隔离边界） | 无 |
| 跨唤醒模型会话 | 无 | 无 |

---

## 11. 主要源码依据

| 文件/位置 | 决定的内容 |
|---|---|
| `src/roles.ts`：`runPlanner()`（约 83 行） | Planner 快照、完成事件、普通/中断用户消息、工具配置 |
| `src/roles.ts`：`runWorker()`（约 188 行） | Worker 环境段、裁剪快照、当前任务及用户消息顺序 |
| `src/agent-factory.ts`：`createFreshAgent()`（约 24 行） | 全新 in-memory session、appendSystemPrompt、skills/extensions、内联扩展加载与绑定、cwd、内置工具开关 |
| `src/agent-factory.ts`：`promptWithTimeout()` | 每次只调用一次初始 `session.prompt(userMessage)`，之后由 SDK 驱动本轮工具循环 |
| `src/scripts.ts`：`renderChallengePrompts()`（约 463 行） | GOAL/ASSET/CUSTOMIZATION 和任务长度变量的模板替换 |
| `src/scripts.ts`：`readGeneratedPrompt()`、`stripCommentLines()` | 分题 generated prompt 读取与 HTML 注释剥离 |
| `src/scripts.ts`：`renderTaskSnapshot()`（约 1135 行） | Planner/Worker 两种快照的精确字段、顺序和空值文案 |
| `src/tools.ts`：`makePlannerTools()`（约 170 行） | 普通/中断 Planner 工具集、description、snippet、参数 Schema |
| `src/tools.ts`：`makeWorkerTools()`（约 284 行） | Worker 固定工具及本题/当前任务绑定 |
| `src/tools.ts`：`makeKaliBashTool()`（约 331 行） | 可选 Kali 工具及工作目录 |
| `src/mcp-tool-names.ts` | 可选 MCP 名称段的读取条件、过滤与格式 |
| `src/system-prompt.ts` | 四角色空 docs section 的内联扩展与空白占位处理 |
| `src/kali.ts`：`getKaliEnvInfo()`（约 422 行） | Worker 用户消息中的实测工具和字典清单来源 |
| `src/orchestrator.ts` | Planner 唤醒事件、Worker 分发及中断 Planner 的调用方式 |
| `prompts/templates/planner.system.md` | Planner addendum 原文 |
| `prompts/templates/worker.system.md` | Worker addendum 原文 |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js` | pi 默认 system 各段的顺序与文本生成逻辑 |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js` | skills 索引格式及“正文按需读取”行为 |

本文描述的是“每次唤醒时的初始上下文 + 本轮随后可能新增的消息”。若只关心业务用户消息，可直接查看第 4.4～4.6 节和第 5.4～5.5 节。
