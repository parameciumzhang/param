# 新电脑迁移与启动

本文涵盖两种运行方式：**本地 container 模式**和 **All-in-One 单镜像模式**。container 模式由宿主机运行编排器，Docker Compose 运行 PostgreSQL，Docker 运行共享 Kali 容器；All-in-One 则把编排器、PostgreSQL 和 Kali 工具全部放进一个容器。container 模式的定制 Kali 镜像名为 `param-kali-ctf`，容器名默认为 `kali`；All-in-One 镜像名为 `param-ctf:local`。

## 命令职责

- `npm run kali:image`：只构建本地 `param-kali-ctf` 镜像，不创建 `kali` 容器。
- `npm run kali:setup`：可选的预检查入口，用于提前创建/启动并校验 Kali 容器。
- `npm run orchestrate`：启动编排器时会自动调用同一套 `ensureKali()` 逻辑，创建、启动或复用 Kali 容器，因此**不必须先执行 `npm run kali:setup`**。
- `npm run db:up`：创建或启动开发模式 PostgreSQL；它不是 `kali:setup` 的替代品。

使用定制镜像时，Kali 部分首次只需构建镜像：

```bash
npm run kali:image
```

之后直接启动编排器即可自动创建容器。若希望提前发现 Docker、挂载或工具问题，也可以可选执行：

```bash
npm run kali:setup
```

## 一、需要迁移的内容

1. 项目源代码，包括 `package-lock.json`、`docker/`、`prompts/`、`skills/`、`wordlists/` 和 `.pi-agent/npm/` 的锁定清单与静态配置。
2. `.env` 和真实 `.mcp.json`：它们通常被 Git 忽略，通过 Git 迁移时需要单独复制或重新配置。
3. 可选的 `input/ctf.txt` 赛事输入。
4. 如需续跑旧赛事，复制 `history_db/`；建议同时复制 `report/` 和 `workspaces/` 以保留完整产物。

`node_modules/`、`dist/` 和 Docker 镜像不需要直接复制，可在新电脑重新安装或构建。普通续跑使用 `history_db`，不要求复制旧电脑的 PostgreSQL Docker 数据卷。

## 二、新电脑前置条件

- Node.js ≥ 24 和 npm。
- Docker Desktop 或 Docker Engine，包含 Docker Compose。
- Docker 已启动；Windows 使用 WSL 时需启用对应发行版的 Docker Desktop 集成。

## 三、方式 A：在新电脑重新构建镜像

### 1. 配置项目

进入项目根目录。如果没有 `.env`，先复制示例：

```bash
cp .env.example .env
```

Windows CMD 可使用：

```bat
copy .env.example .env
```

编辑 `.env`，至少设置真实的 LLM 配置，并确认本地 container 模式及镜像名：

```env
PI_BASE_URL=你的OpenAI兼容端点
PI_API_KEY=你的API密钥
PI_MODEL_ID=你的模型ID

KALI_RUNTIME=container
KALI_IMAGE=param-kali-ctf
KALI_CONTAINER=kali
KALI_SKIP_PROVISION=false
PARAM_OUTPUT_DIR=.
```

`.env` 中保留密钥时，不要把该文件或构建出的镜像公开分发。

### 2. 一次性安装、构建和启动数据库

```bash
# 按 lockfile 安装项目依赖
npm ci

# 安装项目内 pi 扩展/MCP 依赖；不使用扩展时也可以执行
npm ci --prefix .pi-agent/npm

# 构建包含 CTF 工具的 param-kali-ctf
npm run kali:image

# 创建或启动 PostgreSQL
npm run db:up
```

这里不需要执行 `npm run kali:setup`，下一步编排器会自动创建 `kali` 容器。

### 3. 启动编排器

显式传入新赛事：

```bash
npm run orchestrate -- --new "整场 CTF 赛事与赛题描述"
```

或者编辑项目根目录的 `input/ctf.txt`，然后无参数启动：

```bash
npm run orchestrate
```

恢复已迁移的最新历史：

```bash
npm run orchestrate -- --continue
```

恢复指定历史目录：

```bash
npm run orchestrate -- --continue "history_db/param-contest-<时间戳>-<pid>"
```

## 四、方式 B：通过单个 tar 文件迁移 Kali 镜像

如果不想在新电脑重新下载和构建工具，可在旧电脑执行：

```bash
npm run kali:export
```

项目根目录会生成：

```text
param-kali-image.tar
```

该 tar 内的镜像标签为 `param-kali-ctf`。将这个项目文件和项目源代码一起复制到新电脑，然后在新电脑项目根目录执行：

```bash
npm ci
npm ci --prefix .pi-agent/npm
npm run kali:import
npm run db:up
npm run orchestrate
```

`npm run kali:import` 替代方式 A 中的 `npm run kali:image`。同样不需要先运行 `npm run kali:setup`。

> 此 tar 只包含 Kali 工具镜像，不包含项目源代码、`.env`、`.mcp.json`、PostgreSQL 数据或 `history_db`，这些内容仍需按第一节单独迁移。

## 五、以后日常启动

镜像和容器已经创建后，不需要每次重新构建或运行 `kali:setup`。通常只需：

```bash
npm run db:up
npm run orchestrate
```

`db:up` 是幂等的；编排器会自动启动或复用已有 Kali 容器。

只有以下情况才需要重新执行 `npm run kali:image`：

- 修改了 `docker/kali/provision.sh` 或工具包清单；
- 删除了本地 `param-kali-ctf` 镜像；
- 换到另一台没有镜像 tar 的电脑。

重建镜像后，如果已有 `kali` 容器仍使用旧镜像，确认无运行任务后显式重建容器：

```bash
docker rm -f kali
npm run kali:setup
```

也可以跳过最后一条，直接运行 `npm run orchestrate` 自动创建新容器。删除容器不会删除挂载的 `workspaces/` 和 `wordlists/`，但容器内其他未挂载文件会丢失。

---

## 六、All-in-One 单镜像模式

### 1. 工具是否包含在镜像中

**包含。** `docker/all-in-one/Dockerfile` 与 `docker/kali/Dockerfile` 都执行同一份 `docker/kali/provision.sh`，因此重新构建的 `param-ctf:local` 会固化同一套 apt、pip、RubyGems 和 Git CTF 工具，包括 pwntools、volatility3、zsteg、jwt_tool 等。

All-in-One 不依赖 `param-kali-ctf`：它直接以 `kalilinux/kali-rolling` 为运行阶段基础镜像，执行共享安装脚本，并额外安装 PostgreSQL、PostgreSQL client 和 tini。默认 `KALI_SKIP_PROVISION=true`，比赛启动时只校验构建期预装标记，不在容器启动后执行 apt/pip/git 下载。

### 2. 与 container 模式的架构区别

```text
container 开发模式
┌─ 宿主机：Node.js 编排器 ───────────────┐
│  ├─ PostgreSQL 连接 ──► param-db 容器  │
│  └─ docker exec ──────► kali 容器      │
│                         param-kali-ctf │
└────────────────────────────────────────┘

All-in-One 模式
┌─ param-ctf 容器（param-ctf:local）──────────┐
│ tini → entrypoint → 本地 PostgreSQL + 编排器 │
│ Worker → embedded setsid/bash → 本机 CTF 工具│
│ /output：report/history_db/workspaces       │
└──────────────────────────────────────────────┘
```

| 对比项 | container 开发模式 | All-in-One 单镜像模式 |
|---|---|---|
| 编排器 | 宿主机 Node.js | 同一个容器内 Node.js 24 |
| PostgreSQL | Compose 的独立 `param-db` 容器 | 同一容器内的本地 PostgreSQL ≥16 |
| CTF 工具 | 独立 `kali` 容器，镜像 `param-kali-ctf` | 直接安装在 `param-ctf:local` 内 |
| Kali 配置 | `KALI_RUNTIME=container` | 固定 `KALI_RUNTIME=embedded` |
| 工具调用 | `docker exec ... setsid --wait bash` | 本容器直接 `setsid --wait bash`，不调用 Docker |
| 工作区 | 宿主机 `workspaces/` 挂载到 `/work` | `/output/workspaces`，`/work` 是其符号链接 |
| 字典 | 宿主机 `wordlists/` 挂载到 `/wordlists:ro` | 镜像内 `/opt/param/wordlists`，链接为 `/wordlists` |
| 生命周期 | 分别维护数据库和 Kali 容器 | entrypoint 启动 PostgreSQL、运行编排器，退出后停止 PostgreSQL |
| 外部依赖 | 宿主机需要 Node.js、npm、Docker、Compose | 运行 tar 镜像时只需要 Docker |

两种模式共用相同的 Challenge 数据模型、编排逻辑和工具安装定义。All-in-One 不需要 Docker Socket、特权模式、Compose、外部 PostgreSQL，也不会开放 PostgreSQL 端口；数据库只监听容器内 `127.0.0.1`。

### 3. 构建前配置

在旧电脑或构建机上准备项目根目录的：

- `.env`：真实 LLM 端点、API Key、模型和其他运行配置；
- `.mcp.json`：真实 MCP 配置；
- `input/ctf.txt`：可选，构建时复制为镜像内 `/input/ctf.txt`；
- `.pi-agent/npm/` 锁定清单、模板、skills 和 wordlists。

构建阶段会在 Docker 内执行 `npm ci`、TypeScript 构建和扩展依赖安装，不要求先在宿主机执行 `npm ci`。本地 `.env` 即使写着 `KALI_RUNTIME=container`，镜像固定配置仍会覆盖为 `embedded`，无需为 All-in-One 单独修改该值。

**安全注意：** `.env`、`.mcp.json` 和 `input/ctf.txt` 会被复制进镜像。镜像和导出的 tar 中都可能提取出 LLM API Key、MCP Authorization 等敏感内容，只能在受信环境构建、保存和分发，不要在提示词文件中写密钥。

### 4. 构建与验收

只构建镜像：

```bash
npm run image:all-in-one
```

生成镜像：

```text
param-ctf:local
```

可选执行完整镜像验收：

```bash
npm run image:verify
```

`image:verify` 会在临时容器内运行 runtime-selftest、PostgreSQL selftest 和 embedded E2E，并检查 Docker Socket 不存在、配置文件权限和 MCP JSON 结构。**它会清空验证容器中的业务表与工作区，不要给该命令挂载真实 `/output`。**

也可以只检查镜像中的关键工具，不启动编排器：

```bash
docker run --rm --entrypoint bash param-ctf:local -lc \
  'command -v nmap sqlmap msfconsole dirsearch nuclei hydra john gdb patchelf binwalk exiftool steghide zsteg tshark zbarimg xortool jwt_tool && \
   python3 -c "import pwn, Crypto, volatility3, capstone, gmpy2, sympy; assert capstone.__version__.startswith(\"5.\")"'
```

### 5. 启动 All-in-One

以下命令均在项目根目录执行。推荐挂载 `/output`，以持久保存报告、历史和工作区。

#### 方式 A：使用构建时打入镜像的 `input/ctf.txt`

```bash
docker run --rm -it \
  --name param-ctf \
  -v "$PWD/output:/output" \
  param-ctf:local
```

#### 方式 B：通过环境变量传入赛事

```bash
docker run --rm -it \
  --name param-ctf \
  -v "$PWD/output:/output" \
  -e CTF_INPUT="整场 CTF 赛事与赛题描述" \
  param-ctf:local
```

文件和 `CTF_INPUT` 可以同时存在，编排器按“文件在前、环境变量在后”合并。也可以在运行时用只读挂载替换提示词文件：

```bash
docker run --rm -it \
  --name param-ctf \
  -v "$PWD/output:/output" \
  -v "$PWD/input/ctf.txt:/input/ctf.txt:ro" \
  param-ctf:local
```

#### 方式 C：显式传入编排器参数

```bash
docker run --rm -it \
  --name param-ctf \
  -v "$PWD/output:/output" \
  param-ctf:local --new "整场 CTF 赛事与赛题描述"
```

显式 `--new` 或直接赛事参数优先于 `/input/ctf.txt` 和 `CTF_INPUT`。

#### 续跑

使用同一个 `/output` 挂载：

```bash
docker run --rm -it \
  --name param-ctf \
  -v "$PWD/output:/output" \
  param-ctf:local --continue
```

或指定历史目录：

```bash
docker run --rm -it \
  --name param-ctf \
  -v "$PWD/output:/output" \
  param-ctf:local --continue "/output/history_db/param-contest-<时间戳>-<pid>"
```

`--continue` 只恢复历史，不读取新的赛事输入。常规续跑依赖 `history_db`，不要求持久化 PostgreSQL 实体；确有需要时才额外设置 `PARAM_PGDATA=/output/postgres-data`。

#### 不挂载 `/output` 时

可以不使用任何挂载：

```bash
docker run -it --name param-ctf param-ctf:local
```

此时刻意不要使用 `--rm`，容器结束后取回产物：

```bash
docker cp param-ctf:/output ./output
docker rm param-ctf
```

**如果使用 `--rm` 且没有挂载 `/output`，容器退出后报告、历史和工作区会被删除。**

### 6. 导出并迁移到新电脑

在旧电脑一键构建并导出：

```bash
npm run image:package
```

生成：

```text
param-ctf-all-in-one.tar
param-ctf-all-in-one.tar.sha256
```

如果镜像已经构建，只需导出：

```bash
npm run image:export
```

把 tar 和 SHA-256 文件复制到新电脑，在相同目录执行：

```bash
sha256sum -c param-ctf-all-in-one.tar.sha256
docker load -i param-ctf-all-in-one.tar
```

随后直接运行，例如：

```bash
docker run --rm -it \
  --name param-ctf \
  -v "$PWD/output:/output" \
  -e CTF_INPUT="整场 CTF 赛事与赛题描述" \
  param-ctf:local
```

只运行 All-in-One tar 时，新电脑**不需要安装 Node.js、PostgreSQL、Kali 或项目 npm 依赖，也不需要复制项目源代码**，只需 Docker。也不要执行以下 container 开发模式命令：

```text
npm run db:up
npm run kali:image
npm run kali:setup
npm run kali:import
```

如果要在新电脑续跑旧赛事，还需复制旧 `output/`（至少包含 `history_db`，建议同时包含 `report` 和 `workspaces`），挂载到 `/output` 后使用 `--continue`。运行时 `-e` 可临时覆盖镜像内 `.env` 中的 LLM 端点、API Key、模型等配置；需要更换 MCP 文件时可只读挂载 `/opt/param/.mcp.json`。

#### 按需构建并压缩导出

镜像不存在或源码、配置、工具清单发生变化时，先重新构建；已有最新镜像时可以跳过第一条命令。以下方式直接生成 gzip 压缩包，不会生成数 GB 的未压缩 tar：

```bash
npm run image:all-in-one

docker save param-ctf:local | gzip -6 > param-ctf-all-in-one.tar.gz
sha256sum param-ctf-all-in-one.tar.gz > param-ctf-all-in-one.tar.gz.sha256
```

在新电脑校验并导入：

```bash
sha256sum -c param-ctf-all-in-one.tar.gz.sha256
gzip -dc param-ctf-all-in-one.tar.gz | docker load
```

导入后镜像标签仍为 `param-ctf:local`。压缩只减小分发文件，不会减少导入后的镜像磁盘占用。

### 7. MCP 开关与免重建挂载

`.mcp.json` 中每个 MCP 服务器都支持独立的 `disabled` 开关。当前 `ctfy` 默认关闭：

```json
{
  "mcpServers": {
    "ctfy": {
      "type": "http",
      "disabled": true,
      "url": "https://ctfy.tsinghua.edu.cn/api/v1/mcp/"
    }
  }
}
```

需要启用时将 `disabled` 改为 `false`，或删除该字段；对应角色的扩展开关也必须允许加载扩展。本地 container 开发模式修改后重启编排器即可。

All-in-One 不必因 MCP 配置变化重新构建镜像，运行时只读挂载宿主机文件即可覆盖镜像内配置：

```bash
docker run --rm -it \
  --name param-ctf \
  -v "$PWD/output:/output" \
  -v "$PWD/.mcp.json:/opt/param/.mcp.json:ro" \
  param-ctf:local
```

### 8. 信号与退出

All-in-One 使用 tini 作为 PID 1 回收僵尸进程。第一次 SIGINT/SIGTERM 只转发给编排器，等待中断报告和历史导出后，entrypoint 才停止本地 PostgreSQL，并保留应用原始退出码。执行 `docker stop` 时应给足收尾时间，不要直接强制 Kill，否则无法保证报告和历史完整。

