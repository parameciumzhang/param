# param

基于**智能压缩**、**指针索引**和**智能纠偏**面向长任务多场景攻击智能体。

为了适配多场景的使用，**param**分为**CTF版**和**专业企业渗透版。当前仓库为CTF版。**

专业企业版请联系微信：parameciumZ

***

## 简介

1. 多智能体编排架构。基于 pi-coding-agent SDK、TypeScript、Node.js 和 PostgreSQL。由固定脚本负责业唤醒和管理生命周期。
2. 多challenge发布与并发调度。challenge获取、queued/active 状态转换、全局 Worker 池
   和轮转的任务分发。但challenge失败不影响其他challenge。
3. 可见范围控制与上下文优化。以 challenge\_id 为业务隔离边界，为 Planner 提供本题完整任务快照，为 Worker 仅提供必要的本
   题历史摘要和当前任务；调整历史快照与当前任务的注入顺序，减少无关描述、完成状态和跨题信息对 Worker 的干扰。详情查询采用
   challenge\_id与摘要的复合索引，避免同名内容串题。
4. 异常任务纠偏与并发治理。基于 force\_complete\_task 和 task\_delete 的状态约束及协作机制，强制完成前停止在途 Worker 并
   等待执行释放，保留已有fact和finding；仅允许删除本题无事实、无发现的未完成任务；处理删除、强制完成和正常完成之间的竞态，
   降低错误或无效规划对后续worker的影响。
5. 长任务智能压缩。按challenge选择固定批次的已完成任务进行有损摘要，通过索引
   按需回查。
6. 工具环境与系统封装。实现worker共享 Kali 容器和镜像内嵌All-In-One两种架构，后者用来适配“贫瘠”环境和CTF托管环境。

***

## 常用命令

### 本地开发（沿用 container 架构）

前置：Node.js ≥24、Docker。`.env` 保持以下配置即为原来的“宿主机编排器 + Compose PostgreSQL + 共享 Kali 容器”模式：

```env
KALI_RUNTIME=container
KALI_ENABLED=true
PARAM_OUTPUT_DIR=.
```

```bash
npm install
cp .env.example .env       # 按实际 LLM 端点修改
npm run db:up               # 启动本地 PostgreSQL
npm run kali:setup          # 可选：提前创建 Kali 并预装工具

npm run orchestrate -- --new "整场 CTF 赛事与赛题描述"
npm run orchestrate -- --continue
npm run orchestrate -- --continue "history_db/param-contest-..."

npm run selftest            # runtime + PostgreSQL 固定脚本测试
npm run e2e                 # 本地 mock 多题 E2E
```

`selftest` 和 `e2e` 会清空当前业务表及 workspaces，请使用专用测试库并先归档需要保留的产物。

### 本地无参数提示词文件

本地开发同样可以从文件启动：编辑**项目根目录**的 `input/ctf.txt`，然后直接运行 `npm run orchestrate`，不要附加 `--new` 或赛事正文。默认读取的是宿主机的 `input/ctf.txt`，不是容器内的 `/input/ctf.txt`。

需要其他路径时在 `.env` 设置 `CTF_INPUT_FILE=relative/or/absolute/path`；相对路径按项目根解析。文件与 `CTF_INPUT` 可同时使用并按“文件在前、env 在后”合并；显式赛事参数优先，`--continue` 不读取新赛事输入。

### All-in-One 构建、验收与 tar 导出

```bash
npm run image:all-in-one    # 只构建 param-ctf:local
npm run image:verify        # 验证已构建镜像；不要挂载真实 /output
npm run image:export        # 只导出已构建镜像及 SHA-256
npm run image:package       # 一键：构建 + 导出 tar + SHA-256
```

一键打包生成：

```text
param-ctf-all-in-one.tar
param-ctf-all-in-one.tar.sha256
```

### 无参数自动答题的两种提示词输入

1. **固定文件**：编辑项目根目录的 `input/ctf.txt`，再执行 `npm run image:package`。文件会复制到镜像的 `/input/ctf.txt`，创建容器后无需任何业务参数即可自动开始答题。
2. **环境变量**：创建容器时传入 `CTF_INPUT="整场 CTF 赛事与赛题描述"`。

两种方式可以共存，编排器将按**文件内容在前、`CTF_INPUT` 在后**合并后交给 Manager。也可不重新构建，直接挂载覆盖文件：

```bash
-v "$PWD/input/ctf.txt:/input/ctf.txt:ro"
```

`CTF_INPUT_FILE` 可覆盖默认文件路径。显式 `--new "..."` 或直接赛事参数优先于这两个输入源；`--continue` 只恢复历史，不读取新赛事提示词。默认空文件不视为有效输入。注意：固化进 tar 的提示词可被提取，不要在文件中写 API Key 等密钥。

### All-in-One 比赛运行（可以不使用 `-v`）

只有 tar 文件时先加载镜像；已有 `param-ctf:local` 则跳过：

```bash
docker load -i param-ctf-all-in-one.tar
```

**方式一：使用构建时打入镜像的 `/input/ctf.txt`。** 不需要挂载、不需要业务命令行参数：

```bash
docker run -it \
  --name param-ctf \
  param-ctf:local
```

**方式二：不加 `-v`，直接通过环境变量传提示词：**

```bash
docker run -it \
  --name param-ctf \
  -e CTF_INPUT="整场 CTF 赛事与赛题描述" \
  param-ctf:local
```

以上两种方式任选其一；同时提供文件和 `CTF_INPUT` 时会自动合并。没有挂载 `/output` 时，以上命令刻意不加 `--rm`，容器结束后取回报告和历史：

```bash
docker cp param-ctf:/output ./output
docker rm param-ctf
```

**若使用 `docker run --rm` 且没有 `/output` 挂载，容器退出后报告、历史和工作区会被一并删除。**

需要持久化产物或不重新构建就替换提示词文件时，再按需添加可选挂载：

```bash
-v "$PWD/output:/output"
-v "$PWD/input/ctf.txt:/input/ctf.txt:ro"
```

显式赛事参数与续跑仍使用原编排器参数：

```bash
# 显式参数优先于文件和 CTF_INPUT
docker run --rm -it \
  -v "$PWD/output:/output" \
  param-ctf:local --new "整场 CTF 赛事与赛题描述"

# 使用同一个 /output 挂载续跑
docker run --rm -it \
  -v "$PWD/output:/output" \
  param-ctf:local --continue "/output/history_db/param-contest-<时间戳>-<pid>"
```

### All-in-One 配置与环境变量

**构建镜像时会把项目根目录的 `.env` 和真实 `.mcp.json` 分别复制为 `/opt/param/.env`、`/opt/param/.mcp.json`（权限均为 `0600`）。** 编排器通过 dotenv 加载 `.env`，各角色通过 `pi-mcp-adapter` 复用 `.mcp.json`。因此 LLM 端点、密钥、模型、并发、角色扩展和 MCP 服务器等无需在每次 `docker run` 时重复配置。运行时显式 `-e` 环境变量优先于镜像内 `.env`，可用于临时覆盖；需要更换 MCP 配置时可只读挂载 `/opt/param/.mcp.json` 或重新构建。镜像的固定 `ENV` 与 entrypoint 导出的本地 PostgreSQL 参数仍优先，保证 `embedded`、输出目录和数据库生命周期一致。

显式命令行赛事参数优先；没有显式参数时，`/input/ctf.txt` 与 `CTF_INPUT` 可单独使用或合并使用，`CTF_INPUT` 也可直接写入内嵌 `.env`。

真实比赛必须通过构建期 `.env` 或运行时 `-e` 提供：

| 参数名           | 用途                                   |
| ------------- | ------------------------------------ |
| `PI_BASE_URL` | 可访问的 OpenAI 兼容端点，例如 `https://.../v1` |
| `PI_API_KEY`  | LLM API Key；建议通过平台密钥机制注入             |
| `PI_MODEL_ID` | 实际模型 ID                              |

可选覆盖参数：

| 类别         | 参数名                                                                                                  | 默认值/说明                                       |
| ---------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 无参数输入      | `CTF_INPUT`、`CTF_INPUT_FILE`                                                                         | 环境变量赛事正文、提示词文件路径；两者可共存，文件默认 `/input/ctf.txt` |
| 并发         | `CTF_PLANNER_CONCURRENCY`、`WORKER_CONCURRENCY`                                                       | 分别默认 `1`、`3`                                 |
| 全局模型参数     | `PI_CONTEXT_WINDOW`、`PI_MAX_TOKENS`、`PI_THINKING_LEVEL`                                              | 上下文、输出 token 与思考档位                           |
| 角色级模型覆盖    | `PI_BASE_URL_<ROLE>`、`PI_API_KEY_<ROLE>`、`PI_MODEL_ID_<ROLE>`                                        | 未设置时继承全局三项                                   |
| 角色级参数覆盖    | `PI_CONTEXT_WINDOW_<ROLE>`、`PI_MAX_TOKENS_<ROLE>`、`PI_THINKING_LEVEL_<ROLE>`                         | 未设置时继承全局配置                                   |
| Pi 扩展/MCP  | `EXTENSIONS_ENABLED`、`EXTENSIONS_<ROLE>`                                                             | 四角色默认启用；角色级配置优先于全局配置                         |
| Compactor  | `COMPACTOR_ENABLED`、`COMPACTOR_FIRST_TRIGGER`、`COMPACTOR_TIMEOUT_MS`                                 | 默认关闭压缩                                       |
| 任务长度       | `INSERT_TASK_MAX_CHARS`、`INSERT_TASK_MAX_NOTE_CHARS`                                                 | 默认 `600`、`200`                               |
| 超时/轮询      | `POLL_INTERVAL_MS`、`MANAGER_TIMEOUT_MS`、`PLANNER_TIMEOUT_MS`、`WORKER_TIMEOUT_MS`、`GLOBAL_TIMEOUT_MS` | 均为毫秒；全局超时 `0` 表示不限制                          |
| 本地数据库      | `PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`                                                          | 有镜像内默认值；未传密码时随机生成                            |
| PG 实体持久化   | `PARAM_PGDATA`                                                                                       | 通常不用；需要时设为 `/output/postgres-data`           |
| 产物目录       | `PARAM_OUTPUT_DIR`                                                                                   | 默认 `/output`；修改后需同步调整挂载与续跑路径                 |
| 禁用 Kali 工具 | `KALI_ENABLED`                                                                                       | 默认 `true`；设为 `false` 时 Worker 仅用内置 bash      |

角色级变量中的 `<ROLE>` 可替换为 `MANAGER`、`PLANNER`、`WORKER`、`COMPACTOR`。例如：

```text
PI_BASE_URL_MANAGER       PI_API_KEY_MANAGER       PI_MODEL_ID_MANAGER
PI_BASE_URL_PLANNER       PI_API_KEY_PLANNER       PI_MODEL_ID_PLANNER
PI_BASE_URL_WORKER        PI_API_KEY_WORKER        PI_MODEL_ID_WORKER
PI_BASE_URL_COMPACTOR     PI_API_KEY_COMPACTOR     PI_MODEL_ID_COMPACTOR
```

以下配置已固化在镜像中，**通常无需也不能随意覆盖**：

```text
KALI_RUNTIME=embedded
KALI_SKIP_PROVISION=true
PGHOST=127.0.0.1
PI_CODING_AGENT_DIR=/opt/param/.pi-agent
```

`KALI_IMAGE`、`KALI_CONTAINER`、`KALI_PROVISION_TIMEOUT_MS`、`KALI_APT_MIRROR`、`KALI_INSTALL_PACKAGES` 是本地 container 模式的运行/预装参数，不是 All-in-One 比赛运行参数。All-in-One 构建如需定制镜像源或包列表，应使用 Docker 构建参数 `APT_MIRROR`、`KALI_PACKAGES`，而不是比赛运行环境变量。不要在比赛镜像中设置 `KALI_RUNTIME=container`。

## 核心流程

```text
用户输入整场赛事 / 本地或远程赛事资料
        │
        ▼
Manager ── start_contest ───────────► contest goal + publishing
        │
        ├─ publish_challenges(批次1) ─► 提示词就绪 ─► queued/skipped
        │                                      │
        ├─ publish_challenges(批次2) ─► 后续批次   ▼
        │                              Orchestrator 按名额激活
        └─ finish_challenge_publication          │
                 │                               ▼
                 │                    每题独立 Planner/Worker 提示词
                 │                               │
                 ▼                               ▼
          关闭发布入口                Challenge A / B / queued
                                           │
                                           ▼
                              全局 Worker 池（共享 Kali 环境）
                         <outputDir>/workspaces/task-<全局task_id>
```

每批发布先以 `prompt_ready_at=NULL` 写入不可调度行，固定脚本生成并回读校验本题提示词后才开放 `queued` 激活。Manager 与主循环并行，因此首批 Planner/Worker 可以在后续批次发布前开始执行。单题生成终态报告后仅自身变为 `completed` 并释放活跃名额；只有 Manager 已调用 `finish_challenge_publication`、发布状态关闭、全部 Challenge 进入 `completed/skipped/failed` 且没有在途会话后，才生成 `contest-summary`。

## Challenge 隔离边界

每道 Challenge 绑定自己的：

- `asset` / `customization` / `goal`；
- 一个逻辑 Planner，同一题最多一个在途 Planner；
- task、fact/finding、detail、detail2；
- `prompts/generated/challenges/<challenge_id>/` 下的提示词；
- 单题报告与 history\_db 中的独立 JSON；
- 从 `active` 到终态的靶机并发名额。

`challenge_id` 由数据库分配。Planner/Worker 固定工具通过闭包绑定 ID，工具 schema 不接受模型传入任意 `challenge_id`。`task_id` 仍全局唯一并由持久高水位严格递增，不复用删除后的 ID。

### 快照与详情

- Planner：只收到本题 ID、名称、本题全量 task 快照和本题完成事件；不包含其他赛题信息。
- Worker：当前任务单独注入且排在历史快照之后；历史快照只含本题 `task_id/fact/finding`，不含 task 描述、note、完成状态或其他题数据。
- `get_fact_detail` / `get_finding_detail` 均同时按 `challenge_id + 摘要` 查询；两题可以使用相同摘要而互不冲突。
- `detail` 主键为 `(challenge_id, fact)`，`detail2` 主键为 `(challenge_id, finding)`。
- 多题 Planner 不开放通用 read/bash、Kali 或 skills，只保留本题固定内置工具；扩展/MCP 由 `EXTENSIONS_PLANNER` 与全局开关控制。启用扩展后，Planner 可以主动访问 MCP 外部数据，必须遵守本题范围，不能再把快照与固定工具归属隔离视为外部访问强隔离。Worker 执行 shell 不受此限制，但仍受本题 asset/customization 约束。

这是一层编排数据访问隔离，不是针对任何启用扩展角色的完整安全沙箱；共享 Kali 工具环境的网络、进程和端口命名空间也仍是共享的。

## 并发语义

```env
CTF_PLANNER_CONCURRENCY=1
WORKER_CONCURRENCY=3
```

`CTF_PLANNER_CONCURRENCY=N` 同时表示：

1. 最多 N 道题处于 `active`；
2. 最多 N 个不同 Challenge 的 Planner 在途；
3. 同一题最多一个 Planner；
4. queued 或未就绪赛题不能创建 Planner，也不能分发 Worker，即使历史恢复时已有任务；
5. 活跃名额在本题整个生命周期内持有，**等待本题 Worker 时不释放**；
6. 本题 `completed/failed` 后才释放，skipped 从创建起就不占名额。

Worker 池按 Challenge 轮转选择任务，避免一道题持续占满全部槽位。所有任务继续使用 PostgreSQL 每任务执行锁。

单题 Planner 连续空转、达到轮次安全阀等只会让该题 `failed`；其他题继续，整场最终以退出码 1 表示存在 failed。skipped 是正常业务结果。

## 角色与固定工具

| 角色          | 固定工具                                                                                                        | 内置工具 / 扩展                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Manager     | `start_contest`、`publish_challenges`、`finish_challenge_publication`                                         | read；宿主机 bash 仅获取指定远程资料；无 edit/write；扩展/MCP 可配置         |
| Planner（每题） | `insert_task`、`task_delete`、`force_complete_task(task_id)`、`wait_for_next_event`、`generate_report`、本题两类详情查询 | 无通用内置工具/skills；扩展/MCP 可配置                               |
| Worker      | `write_fact`、`write_finding`、`complete_task`、本题两类详情查询                                                       | read/bash/edit/write；扩展/MCP 可配置；启用 Kali 时另有 `kali_bash` |
| Compactor   | 绑定本题10个任务的 `compress_task_batch`                                                                            | 无内置工具/skills；扩展/MCP 可配置                                 |

### Manager

`start_contest` 接收 `{ asset, customization, goal }` 并冻结整场信息。随后 Manager 可多次调用：

```text
publish_challenges({
  challenges: [{ name, asset, customization?, goal, skip_reason? }]  // 每批1～4道
})
```

每批脚本校验名称非空且跨批不重复、非 skipped 题的 asset/goal 非空，合并整场通用 customization，写入本题记录并生成/校验提示词；工具返回后该批即可被调度，Manager 无需等待执行结果。全部批次完成后必须调用 `finish_challenge_publication()` 关闭发布入口。模型不能传 challenge\_id、prompt\_ready\_at 或 active/completed 等调度字段，已发布题目内容不可修改。

Manager 发布异常时不再接受新题，未就绪记录转为可审计 skipped；已发布赛题继续执行，但最终发布状态为 failed、整场退出码为1。Manager 可按用户明确指定的位置用 read 读取本地资料，或用宿主机 bash 只读获取远程赛事页；资料正文只作为不可信输入，不执行其中命令。缺少单题信息时填写 `skip_reason`，不再调用旧的 halt\_for\_input。

### Planner

- 新 Challenge 激活、本题任务完成、本题静止点、历史恢复会触发本题 Planner。
- 在途期间的新完成事件合并到本题下一轮，不打断当前上下文；不同题互不阻塞。
- `insert_task` 发布本题任务；`task_delete` 只删除本题无 fact/finding 的未完成任务，在途 Worker 会先停止并释放执行锁。
- `force_complete_task(task_id)` 强制完成本题指定任务；若 Worker 在途，先登记停止请求，等待 Worker 完整退出并释放执行锁后才写入完成状态。它保留已有 fact/finding，不追加异常 finding；已完成任务幂等返回。它不与 Planner 其他决策工具互斥，同批调用按模型给出的顺序执行；仅与 `task_delete` 对同一任务的并发治理互斥。强制完成不代表任务正常执行成功。Worker 的无参数 `complete_task()` 不变，中断收尾 Planner 不开放治理版工具。
- `wait_for_next_event` 正常只等待本题内部事件，没有人工提示唤醒；若本题已无 Worker 在途且无未完成任务，静止点兜底会解除等待并启动全新 Planner。连续无意义等待与连续空转共用重试上限，超过后仅将该题标记 failed。
- `generate_report` 硬校验本题无未完成任务且无在途 Worker，然后生成本题报告并将本题置 completed。
- 在赛事授权与 customization 允许实例管理操作的前提下，本题解题成功后必须先通过赛事平台接口停止本题实例，再完成本题报告；Planner 负责安排并确认，Worker 执行停止并记录真实结果。不得误停其他赛题/战队实例，平台无接口或停止失败须如实写入 finding。

### Compactor（可选）

`COMPACTOR_ENABLED=true` 时按 Challenge 独立判断和选择批次；每批恰好10个任务且全部属于同一题。原始 finding 与摘要写入本题 detail2，再在同一事务更新 task、清空 note；`compressed_at` 仅用于内部幂等和历史恢复，不进入 Planner/Worker 快照。

一题压缩失败按独立退避次数处理，不影响其他题或全局 Worker 调度。完全只有当前 Worker 超时错误文案的任务仍按原规则清空 task/note/finding。

## 报告与终态

```text
report/challenge-<challenge_id>-YYYYMMDD-HHmmss-SSS.md
report/contest-summary-YYYYMMDD-HHmmss-SSS.md
```

单题报告只包含本题数据；赛事汇总包含发布状态/错误、所有题的状态、报告路径、主要 finding 和 skipped/failed 原因。汇总不会注入 Planner/Worker。

### Ctrl+C / SIGTERM

- 第一次 Ctrl+C 或 SIGTERM：停止分发，中止在途 Manager、Compactor、所有 Planner/Worker；任务保持未完成，不强制补完成。随后为每道 active Challenge 创建全新的中断 Planner，分别生成阶段性报告，再生成赛事中断汇总。
- 第二次中断信号：跳过中断报告，导出当前分题历史后退出。
- 中断报告不宣称 goal 达成，active/queued 状态保留供续跑。

退出码：

| 代码  | 含义                                                               |
| --- | ---------------------------------------------------------------- |
| 0   | Challenge 发布已 finalized，全部 Challenge 为 completed/skipped，赛事汇总已生成 |
| 1   | 系统异常、全局超时、发布 failed/incomplete，或整场结束但至少一道 failed                 |
| 2   | 命令行用法错误                                                          |
| 130 | 用户 Ctrl+C 或 SIGTERM 停止并完成中断报告，或第二次中断信号直接导出                       |

## history\_db 与续跑

每次编排结束（正常、异常或 Ctrl+C）在关闭连接池前导出：

```text
history_db/param-contest-YYYYMMDD-HHmmss-SSS-<pid>/
├── manifest.json             # 赛事 goal、publication、全局 last_task_id、文件索引；不含任务正文
├── challenge-1.json          # 仅 Challenge 1 的 challenge/task/detail/detail2
├── challenge-2.json
└── ...
```

导出使用一个只读可重复读事务，在事务内按 challenge\_id 查询分组；先写临时目录，逐文件校验归属后原子重命名。恢复时先完整校验 manifest、严格文件名、每题 ID、所有行归属、全局 task\_id 唯一性和高水位，再在单事务中恢复，任何损坏或串题都不会留下部分数据。

```bash
# 最新可续跑历史
npm run orchestrate -- --continue

# 指定 v2 目录
npm run orchestrate -- --continue "history_db/param-contest-YYYYMMDD-HHmmss-SSS-<pid>"

# 兼容旧 version=1 单目标 JSON
npm run orchestrate -- --continue "history_db/param-db-YYYYMMDD-HHmmss-SSS-<pid>.json"
```

续跑跳过 Manager，根据当前模板重新生成并逐题校验提示词。finalized 历史按完整赛事恢复；发布中/失败的历史转为 `incomplete`，不重启或重放 Manager，只恢复已就绪赛题，未就绪记录转为带原因的 skipped，最终退出码为1。当前 `.env` 的并发上限优先：终态不变，其余题按 ID 保留前 N 道 active，剩余重新 queued；queued 题已有任务也不会执行。旧版 planner\_append/Monitor 数据不恢复，旧 halt\_request 转为该题 skipped 原因。

历史不包含 workspaces、报告实体或 Agent 会话；跨机续跑需另行归档这些产物。

**全新运行具有破坏性**：默认新任务或 `--new` 会清空 goal/challenge/task/detail/detail2、发布状态、高水位、workspaces 和分题动态提示词；history\_db 与 report 不删除。

## Kali、运行模式与 MCP

| 配置                                           | 行为                                           |
| -------------------------------------------- | -------------------------------------------- |
| `KALI_RUNTIME=container`、`KALI_ENABLED=true` | 现有开发模式：通过 `docker exec` 使用共享 Kali 容器         |
| `KALI_RUNTIME=embedded`、`KALI_ENABLED=true`  | 本容器本地工具模式：直接 `setsid --wait bash`，不调用 Docker |
| `KALI_ENABLED=false`                         | 不提供 `kali_bash`，Worker 仅使用内置 bash            |

非法 `KALI_RUNTIME` 会在启动时明确报错，不会静默回退。两种后端共用 `kaliExec` 的真实退出码、stdout/stderr、超时和逐任务进程组清理语义。

`PARAM_OUTPUT_DIR` 统一控制 `report/`、`history_db/`、`workspaces/`；未设置或为 `.` 时保持项目根目录行为，相对路径按项目根解析。字典仍从项目 `wordlists/` 提供，Kali 内统一使用 `/wordlists`。

container 模式：

- 所有 Worker 共用 `KALI_CONTAINER`（默认 `kali`）与 `KALI_IMAGE`（默认 `kalilinux/kali-rolling`）。
- 自动创建时附带 `NET_ADMIN` 与 `/dev/net/tun`，供 `wg-quick`/`openvpn` 配置 VPN；复用旧容器时会校验，缺失则需确认无任务后显式重建。
- `<outputDir>/workspaces/` → `/work`，`wordlists/` → `/wordlists:ro`；任务目录按全局 task\_id 隔离。
- 首次自动幂等安装 Web/Pwn/Reverse/Crypto/Misc 工具；`KALI_APT_MIRROR` 可固定镜像源。
- 预构建分发：`npm run kali:image`、`kali:export`、`kali:import`，目标机设置 `KALI_IMAGE=param-kali-ctf`。

embedded 模式：

- `kali_bash` 直接使用 `<outputDir>/workspaces/task-<id>`，不再硬编码 `/work`。
- 启动仅校验 `setsid`、`bash`、目录和构建期预装标记；禁止运行时 apt/pip 下载。
- Worker 的内置 bash 与 `kali_bash` 在同一容器文件系统操作同一任务目录。

四角色均可通过 `.mcp.json` 与 `npm run pi:install` 使用扩展/MCP，并分别由 `EXTENSIONS_MANAGER`、`EXTENSIONS_PLANNER`、`EXTENSIONS_WORKER`、`EXTENSIONS_COMPACTOR` 控制；未设置角色级开关时继承 `EXTENSIONS_ENABLED`。Manager/Planner/Compactor 从项目根读取配置，Worker 启动时把根目录 `.mcp.json` 复制到任务工作目录。当前 `pi-mcp-adapter` 使用 `directTools:false` 代理模式，通过统一 `mcp` 工具搜索、查看和调用实际 MCP 工具。项目内联扩展 `src/mcp-tool-names.ts` 在 `before_agent_start` 增加 `mcp_tool_names` section，只列当前配置且已缓存的服务器/工具名称，不含描述、Schema 或认证信息；详情仍用 `mcp describe` 按需加载。冷缓存或配置损坏时不注入该 section，代理发现仍可使用。并行任务仍共享网络和端口，需避免监听端口冲突。

## All-in-One 比赛镜像

单个镜像包含 Node.js 24、PostgreSQL ≥16、Kali 工具、编排器、模板、skills、字典与角色扩展。不需要 Compose、Docker Socket、特权模式或外部 PostgreSQL；PostgreSQL 仅监听 `127.0.0.1`，不暴露端口。构建、打包、运行及环境变量见文首 [常用命令](#常用命令)。

`image:package` 在项目根生成 `param-ctf-all-in-one.tar` 和 `param-ctf-all-in-one.tar.sha256`；如只需导出已构建镜像，可运行 `npm run image:export`。构建会内嵌项目根 `.env`，但镜像的固定 `KALI_RUNTIME=embedded` 等运行配置优先，因此本地 `.env` 中的 `KALI_RUNTIME=container` 不会改变镜像后端。

**内嵌 `.env` 和 `.mcp.json` 后，镜像和 tar 中都可提取其中的 LLM API Key、MCP Authorization 令牌等密钥。** 只构建、分发和运行包含实际密钥的镜像到受信环境，不要公开上传；如需更换密钥，可重建镜像，或在运行时用 `-e` / 只读挂载覆盖。

镜像默认 `KALI_RUNTIME=embedded`、`PARAM_OUTPUT_DIR=/output`。`/output` 包含报告、历史和工作区；不挂载且未使用 `--rm` 时可在容器退出后通过 `docker cp` 取回，使用 `--rm` 则会在退出时删除。未提供 `PGPASSWORD` 时 entrypoint 生成随机本地密码，不写文件或日志。`PARAM_PGDATA=/output/postgres-data` 是可选的数据库实体持久化，与通常用于续跑的 `history_db` 快照是两套机制。

entrypoint 使用 tini 回收僵尸进程，把第一次 SIGINT/SIGTERM 只转给编排器，等待中断报告和历史导出后停止 PostgreSQL，并保留应用原始退出码。`image:verify` 会清空验证容器中的业务表与工作区，不应对挂载了真实产物的容器执行。

**当前只实现通用比赛接入约定：容器参数、`/input/ctf.txt`、`CTF_INPUT`/`CTF_INPUT_FILE`、标准 LLM 环境变量和 `/output`。比赛平台专有的参数名、启动方式、网络/挂载限制尚待接入文档确认，未在代码中预设。**

## 项目结构

```text
src/
├── config.ts          # 四角色 LLM、双 Kali 后端、统一输出目录、CTF/Worker/PG 配置
├── contest-input.ts   # 提示词文件与 CTF_INPUT 的读取和双来源合并
├── db.ts              # Challenge 数据模型、旧库迁移、复合详情主键、 scoped 查询
├── scripts.ts         # 唯一业务写库/提示词/报告/历史写入层
├── tools.ts           # Challenge/task 绑定的固定工具与 kali_bash
├── agent-factory.ts   # 四角色全新 in-memory AgentSession
├── roles.ts           # Manager / 每题 Planner / Worker / Compactor 运行器
├── orchestrator.ts    # 激活、每题事件、公平 Worker 分发、终态、SIGINT/SIGTERM、历史
├── kali.ts            # container/embedded 执行后端、进程组清理与环境校验
├── runtime-selftest.ts# 输出配置、embedded 无 Docker 执行与进程组测试
├── selftest.ts        # 数据模型、隔离、事务、历史、Compactor 自测
├── e2e.ts             # 多题 AgentSession、异常、SIGINT/SIGTERM 与续跑 E2E
└── mock/openai-mock.ts# 确定性多题 OpenAI 兼容 mock

docker/kali/           # 开发模式 Kali Dockerfile 与共享构建期安装脚本
docker/all-in-one/     # 单镜像 Dockerfile、PostgreSQL/信号生命周期入口
input/ctf.txt          # 可选赛事提示词；镜像内为 /input/ctf.txt

prompts/templates/     # manager/planner/worker/compactor 模板
prompts/generated/challenges/<id>/ # 每题动态提示词产物
skills/                # Manager/Worker 静态技能；Planner 当前禁用
workspaces/task-<id>/  # 默认任务工作目录（可用 PARAM_OUTPUT_DIR 重定向）
history_db/            # 默认分题历史目录（同上）
report/                # 默认报告目录（同上）
```

## 安全与限制

- 仅用于已授权 CTF/测试范围；Worker 必须遵守本题 asset/customization 和破坏性操作禁令。解题后的平台实例停止仅限本题实例且以授权允许为前提，不得扩大为控制其他实例。
- 不为每题创建独立 Kali 工具环境；无论共享容器还是 All-in-One，本方案都不是内核/网络强隔离。
- All-in-One 不调用 Docker、不开放 PostgreSQL 端口；仍需保护含敏感证据的 `/output`。
- Compactor 是有损摘要，原始 finding 可在本题 detail2 回查。
- 真实 LLM 的规划质量仍取决于模型；固定脚本负责硬状态、归属与终态约束。
