import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

/**
 * Kali 执行环境（所有 Challenge 的 Worker 共用）：
 * - container：共享容器，workspaces/ → /work，wordlists/ → /wordlists:ro，可幂等预装；
 * - embedded：All-in-One 本容器，直接运行构建期固化的工具，不调用 Docker 或运行时安装。
 * 两种后端都以唯一进程组执行每个任务，超时/中止只清理本次执行。
 */

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runDocker(
  args: string[],
  timeoutMs: number,
  maxBuffer = 50 * 1024 * 1024,
  signal?: AbortSignal
): Promise<DockerResult> {
  return new Promise((resolve) => {
    // Docker CLI 收到 SIGTERM 后可能自行以 0 退出，导致 execFile 回调 err=null、超时误判成功。
    // 客户端在超时/中止时直接 SIGKILL；容器内进程由 kaliExec 的进程组清理兜底。
    execFile("docker", args, { timeout: timeoutMs, maxBuffer, windowsHide: true, signal, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        return;
      }
      const exitLike = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({
        code: signal?.aborted ? 130 : (err as Error & { killed?: boolean }).killed ? 124 : typeof exitLike === "number" ? exitLike : 127,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") || err.message,
      });
    });
  });
}

/** embedded 后端只执行本机程序；与 runDocker 分离，确保该路径不存在 Docker 调用。 */
function runEmbedded(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; maxBuffer?: number; signal?: AbortSignal }
): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer ?? 50 * 1024 * 1024,
      windowsHide: true,
      signal: opts.signal,
      killSignal: "SIGKILL",
    }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        return;
      }
      const exitLike = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({
        code: opts.signal?.aborted ? 130 : (err as Error & { killed?: boolean }).killed ? 124 : typeof exitLike === "number" ? exitLike : 127,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") || err.message,
      });
    });
  });
}

/** 输出型查询：成功返回 stdout（trim），失败返回 null。 */
async function dockerOutput(args: string[], timeoutMs = 60_000): Promise<string | null> {
  const r = await runDocker(args, timeoutMs);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Windows 路径转 docker -v 可用的形式（D:/a/b）。 */
function toDockerPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * 确保容器就绪：不存在则创建（含挂载、NET_ADMIN 与 TUN），停止则重启；未预装则安装工具（幂等，标记 /root/.provisioned）。
 * KALI_ENABLED=false 时直接返回，Worker 仅使用宿主机 bash；Planner 始终无 shell。
 */
export async function ensureKali(log: (s: string) => void): Promise<void> {
  if (!config.kali.enabled) {
    log("[kali] 未启用（KALI_ENABLED=false），Worker 将仅使用宿主机 bash；Planner 不提供 shell");
    return;
  }
  if (config.kali.runtime === "embedded") {
    await ensureEmbeddedKali(log);
    return;
  }
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  fs.mkdirSync(config.wordlistsDir, { recursive: true });

  const name = config.kali.container;
  const inspected = await dockerOutput(["inspect", name], 30_000);
  if (inspected === null) {
    log(`[kali] 创建容器 ${name}（镜像 ${config.kali.image}，首次会自动拉取）…`);
    const r = await runDocker(
      [
        "run", "-d", "--name", name,
        "--cap-add", "NET_ADMIN",
        "--device", "/dev/net/tun",
        "-v", `${toDockerPath(config.workspacesDir)}:/work`,
        "-v", `${toDockerPath(config.wordlistsDir)}:/wordlists:ro`,
        config.kali.image, "sleep", "infinity",
      ],
      600_000
    );
    if (r.code !== 0) throw new Error(`Kali 容器创建失败（exit ${r.code}）: ${r.stderr.slice(0, 500)}\n提示：确认 Docker 已启动、D:/ 盘已加入 Docker Desktop 文件共享`);
    log("[kali] 容器已启动（workspaces→/work，wordlists→/wordlists 只读，NET_ADMIN，/dev/net/tun）");
  } else {
    const info = (JSON.parse(inspected) as Array<{
      Config?: { Image?: string };
      State?: { Running?: boolean };
      HostConfig?: { CapAdd?: string[] };
      Mounts?: Array<{ Source?: string; Destination?: string; RW?: boolean }>;
    }>)[0];
    if (!info) throw new Error(`无法读取 Kali 容器 ${name} 的配置`);
    const samePath = (actual: string, expected: string) => {
      const a = path.resolve(actual);
      const b = path.resolve(expected);
      return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    };
    if (info.Config?.Image !== config.kali.image) {
      throw new Error(`Kali 容器 ${name} 的镜像不匹配（实际 ${info.Config?.Image ?? "未知"}，期望 ${config.kali.image}）。请确认后显式移除旧容器再启动`);
    }
    const hasNetAdmin = info.HostConfig?.CapAdd?.some((cap) => {
      const normalized = cap.toUpperCase();
      return normalized === "NET_ADMIN" || normalized === "CAP_NET_ADMIN";
    });
    if (!hasNetAdmin) {
      throw new Error(`Kali 容器 ${name} 缺少 NET_ADMIN，无法操作 WireGuard/OpenVPN 网卡。Capability 只能在创建时授予；确认无运行任务后执行 docker rm -f ${name}，再由项目自动重建`);
    }
    for (const mount of [
      { destination: "/work", source: config.workspacesDir, readOnly: false },
      { destination: "/wordlists", source: config.wordlistsDir, readOnly: true },
    ]) {
      const actual = info.Mounts?.find((m) => m.Destination === mount.destination);
      if (!actual?.Source || !samePath(actual.Source, mount.source) || actual.RW === mount.readOnly) {
        throw new Error(
          `Kali 容器 ${name} 的 ${mount.destination} 挂载不匹配（实际 ${actual?.Source ?? "缺失"}，期望 ${mount.source}${mount.readOnly ? "，只读" : "，可写"}）。挂载仅在创建时生效，请确认后显式移除旧容器再启动`
        );
      }
    }
    if (!info.State?.Running) {
      const r = await runDocker(["start", name], 60_000);
      if (r.code !== 0) throw new Error(`Kali 容器启动失败: ${r.stderr.slice(0, 300)}`);
      log(`[kali] 已重启既有容器 ${name}（镜像、挂载与 NET_ADMIN 校验通过）`);
    } else {
      log(`[kali] 复用运行中的容器 ${name}（镜像、挂载与 NET_ADMIN 校验通过）`);
    }
  }

  const tun = await runDocker(["exec", name, "test", "-c", "/dev/net/tun"], 30_000);
  if (tun.code !== 0) throw new Error(`Kali 容器 ${name} 缺少字符设备 /dev/net/tun，无法使用 OpenVPN；请确认 Docker 宿主机支持 TUN 后重建容器`);
  const setsid = await runDocker(["exec", name, "bash", "-lc", "command -v setsid"], 30_000);
  if (setsid.code !== 0) throw new Error(`Kali 容器 ${name} 缺少 setsid，无法保证中止时停止容器内进程组`);
  if (config.kali.skipProvision) {
    log("[kali] 跳过工具安装（KALI_SKIP_PROVISION=1）");
    return;
  }
  const marker = await runDocker(["exec", name, "test", "-f", "/root/.provisioned"], 30_000);
  if (marker.code === 0) {
    log("[kali] 工具已预装（/root/.provisioned 标记存在，跳过安装）");
    return;
  }
  await provisionKali(log);
}

/**
 * embedded 只做只读校验。工具必须在镜像构建期安装，比赛启动时禁止 apt/pip/git 下载。
 */
async function ensureEmbeddedKali(log: (s: string) => void): Promise<void> {
  if (process.platform === "win32") throw new Error("Kali embedded runtime 需要 Linux/Unix 的 setsid 与进程组语义");
  const commands = await runEmbedded("bash", ["-lc", "command -v setsid >/dev/null && command -v bash >/dev/null"], { timeoutMs: 30_000 });
  if (commands.code !== 0) throw new Error("Kali embedded runtime 缺少 setsid 或 bash");
  for (const directory of [config.workspacesDir, config.wordlistsDir, "/wordlists"]) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error(`Kali embedded runtime 目录不存在: ${directory}；请检查 /output 初始化与 /wordlists 链接`);
    }
  }
  if (!fs.existsSync("/opt/param/.all-in-one-provisioned") && !fs.existsSync("/root/.provisioned")) {
    throw new Error("Kali embedded runtime 缺少预装标记（/opt/param/.all-in-one-provisioned 或 /root/.provisioned）；禁止在运行时安装工具");
  }
  log("[kali] Kali embedded runtime ready（本容器工具已固化，无需 Docker/运行时安装）");
}

/** 安装工具集（kali-rolling 裸镜像不含任何工具）。逐包安装+一次重试（apt 镜像站偶发超时 exit 100），全失败仅报不炸。 */
async function provisionKali(log: (s: string) => void): Promise<void> {
  const name = config.kali.container;
  const pkgs = config.kali.packages;
  log(`[kali] 安装渗透工具（首次约 10~30 分钟，之后不再重复）: ${pkgs.join(" ")}`);
  const t0 = Date.now();

  // 钉住镜像源须在首次 update 之前：官方 http.kali.org 会 geo 重定向，个别镜像不可达导致
  // 下载随机失败——先走官方源 update 大概率白跑一轮甚至直接失败，钉源后 update 一步到位
  if (config.kali.aptMirror) {
    const pin = await runDocker(
      [
        "exec", name, "bash", "-c",
        `printf 'Types: deb\\nURIs: ${config.kali.aptMirror}/\\nSuites: kali-rolling\\nComponents: main contrib non-free non-free-firmware\\nSigned-By: /usr/share/keyrings/kali-archive-keyring.gpg\\n' > /etc/apt/sources.list.d/kali.sources && apt update`,
      ],
      600_000
    );
    if (pin.code !== 0) throw new Error(`切换 apt 镜像失败（KALI_APT_MIRROR=${config.kali.aptMirror}）: ${pin.stderr.slice(0, 500)}`);
    log(`[kali] apt 镜像已钉住: ${config.kali.aptMirror}`);
  }

  const upd = await runDocker(["exec", name, "bash", "-c", "apt update"], 600_000);
  if (upd.code !== 0) throw new Error(`apt update 失败: ${upd.stderr.slice(0, 500)}（检查容器网络）`);

  const missing: string[] = [];
  for (const pkg of pkgs) {
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      const r = await runDocker(
        ["exec", name, "bash", "-c", `DEBIAN_FRONTEND=noninteractive apt install -y ${pkg}`],
        config.kali.provisionTimeoutMs
      );
      ok = r.code === 0;
      if (ok) {
        log(`[kali]   ✓ ${pkg}${attempt > 1 ? "（重试后成功）" : ""}`);
      } else if (attempt === 1) {
        log(`[kali]   … ${pkg} 失败（exit ${r.code}），重试一次`);
      } else {
        missing.push(pkg);
        log(`[kali]   ✗ ${pkg} 安装失败: ${r.stderr.split("\n").filter((l) => l.includes("E:")).slice(0, 2).join(" ") || `exit ${r.code}`}`);
      }
    }
  }

  if (missing.length === pkgs.length) {
    throw new Error(`全部工具安装失败（apt 源/网络异常）。可用 KALI_INSTALL_PACKAGES 调整列表后重试。`);
  }
  await installPythonTools(log);
  await installRubyTools(log);
  await installGitTools(log);
  await runDocker(["exec", name, "touch", "/root/.provisioned"], 30_000);
  log(
    `[kali] 工具安装完成，耗时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟` +
      (missing.length ? `；未装上: ${missing.join(", ")}（可 docker rm -f ${name} 后重装，或换 KALI_INSTALL_PACKAGES）` : "")
  );
}

/**
 * Python CTF/Misc 工具：复用容器现有 Python 3 环境，不另建 venv。
 * 逐项检测模块或命令，仅安装缺失项，避免重复下载。
 */
async function installPythonTools(log: (s: string) => void): Promise<void> {
  const name = config.kali.container;
  const tools = [
    { name: "pwntools", package: "pwntools", check: "python3 -c 'import pwn'" },
    { name: "pycryptodome", package: "pycryptodome", check: "python3 -c 'import Crypto'" },
    { name: "capstone 5.x（Binwalk 兼容）", package: "\"capstone<6\"", check: "python3 -c 'import capstone; assert capstone.__version__.startswith(\"5.\")'" },
    { name: "volatility3", package: "volatility3", check: "python3 -c 'import volatility3'" },
    { name: "xortool", package: "xortool", check: "command -v xortool" },
  ];
  const missing: typeof tools = [];
  for (const tool of tools) {
    const exists = await runDocker(["exec", name, "bash", "-c", tool.check], 30_000);
    if (exists.code === 0) log(`[kali]   ✓ ${tool.name}（已存在，跳过）`);
    else missing.push(tool);
  }
  if (missing.length === 0) return;

  const packages = missing.map((tool) => tool.package).join(" ");
  const cmd = `python3 -m pip install --upgrade ${packages} || python3 -m pip install --upgrade --break-system-packages ${packages}`;
  const r = await runDocker(["exec", name, "bash", "-c", cmd], config.kali.provisionTimeoutMs);
  if (r.code !== 0) {
    log(`[kali]   ✗ Python 工具安装失败（${packages}）: ${r.stderr.slice(-500) || `exit ${r.code}`}`);
    return;
  }
  log(`[kali]   ✓ Python 工具已安装: ${missing.map((tool) => tool.name).join("、")}`);
}

/** Ruby CTF/Misc 工具：zsteg 通过 RubyGems 安装，已有命令时跳过。 */
async function installRubyTools(log: (s: string) => void): Promise<void> {
  const name = config.kali.container;
  const exists = await runDocker(["exec", name, "bash", "-c", "command -v zsteg"], 30_000);
  if (exists.code === 0) {
    log("[kali]   ✓ zsteg（已存在，跳过）");
    return;
  }
  const r = await runDocker(["exec", name, "gem", "install", "zsteg", "--no-document"], config.kali.provisionTimeoutMs);
  if (r.code !== 0) {
    log(`[kali]   ✗ zsteg 安装失败: ${r.stderr.slice(-500) || `exit ${r.code}`}`);
    return;
  }
  log("[kali]   ✓ zsteg（RubyGems）");
}

/**
 * git 直装工具（apt 源中无对应包）：
 * - ticarpi/jwt_tool → /opt/jwt_tool，依赖 pip 安装（PEP 668 环境自动加 --break-system-packages 重试），
 *   并生成 /usr/local/bin/jwt_tool 包装命令（cd 到安装目录运行，模板/字典资源按官方用法解析）。
 */
async function installGitTools(log: (s: string) => void): Promise<void> {
  const name = config.kali.container;
  const exists = await runDocker(["exec", name, "test", "-f", "/opt/jwt_tool/jwt_tool.py"], 30_000);
  if (exists.code === 0) {
    log("[kali]   ✓ jwt_tool（git 版，已存在 /opt/jwt_tool）");
    return;
  }
  const cmd = [
    "git clone https://github.com/ticarpi/jwt_tool.git /opt/jwt_tool",
    "cd /opt/jwt_tool",
    "(pip3 install -r requirements.txt || pip3 install --break-system-packages -r requirements.txt)",
    "printf '#!/bin/bash\\ncd /opt/jwt_tool && exec python3 jwt_tool.py \"$@\"\\n' > /usr/local/bin/jwt_tool",
    "chmod +x /usr/local/bin/jwt_tool",
  ].join(" && ");
  const r = await runDocker(["exec", name, "bash", "-c", cmd], 600_000);
  if (r.code !== 0) {
    log(`[kali]   ✗ jwt_tool 安装失败: ${r.stderr.slice(0, 300) || `exit ${r.code}`}`);
    return;
  }
  log("[kali]   ✓ jwt_tool（github.com/ticarpi/jwt_tool → /opt/jwt_tool，命令 jwt_tool）");
}

interface KaliExecOptions {
  workdir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function executionScripts(command: string): { stateFile: string; script: string; cleanup: string } {
  const token = `${process.pid}-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
  const stateFile = `/tmp/param-exec-${token}`;
  const quotedState = shellQuote(stateFile);
  const script = [
    `printf '%s\\n' "$$" > ${quotedState}`,
    `bash -c ${shellQuote(command)}`,
    // 不用 EXIT trap：外部中止时必须先留下 state 供进程组清理；正常退出再显式删除。
    "status=$?",
    `rm -f ${quotedState}`,
    "exit \"$status\"",
  ].join("; ");
  const cleanup = `
    # 客户端超时/中止时执行可能尚在启动；等待 state 文件，覆盖启动竞态。
    for _ in {1..30}; do
      test -f ${quotedState} && break
      sleep 0.1
    done
    if test -f ${quotedState}; then
      read -r pgid < ${quotedState}
      if [[ "$pgid" =~ ^[0-9]+$ ]]; then
        kill -TERM -- "-$pgid" 2>/dev/null || true
        for _ in {1..20}; do
          kill -0 -- "-$pgid" 2>/dev/null || break
          sleep 0.1
        done
        kill -KILL -- "-$pgid" 2>/dev/null || true
      fi
      rm -f ${quotedState}
    fi`;
  return { stateFile, script, cleanup };
}

/** container 后端：保留 docker exec + setsid --wait 与原有清理语义。 */
async function kaliExecContainer(command: string, opts: KaliExecOptions): Promise<DockerResult> {
  const { script, cleanup } = executionScripts(command);
  const args = ["exec"];
  if (opts.workdir) args.push("-w", opts.workdir);
  // --wait 必须保留：setsid 创建新会话时可能 fork；缺少它会让 docker exec 提前以 0 返回，
  // 真实命令转为后台继续执行且后续 stdout 丢失。--wait 同时透传真实命令退出码。
  args.push(config.kali.container, "setsid", "--wait", "bash", "-lc", script);
  const result = await runDocker(args, opts.timeoutMs ?? 300_000, undefined, opts.signal);
  if (opts.signal?.aborted || result.code === 124) {
    const stopped = await runDocker(["exec", config.kali.container, "bash", "-lc", cleanup], 10_000);
    if (stopped.code !== 0) result.stderr += `\n容器内进程组清理失败: ${stopped.stderr}`;
  }
  return result;
}

/** embedded 后端：本地 setsid 执行，清理仅针对 state 文件记录的本任务进程组。 */
async function kaliExecEmbedded(command: string, opts: KaliExecOptions): Promise<DockerResult> {
  if (process.platform === "win32") {
    return { code: 127, stdout: "", stderr: "Kali embedded runtime 需要 Linux/Unix 的 setsid 与进程组语义" };
  }
  const { script, cleanup } = executionScripts(command);
  const result = await runEmbedded("setsid", ["--wait", "bash", "-lc", script], {
    cwd: opts.workdir,
    timeoutMs: opts.timeoutMs ?? 300_000,
    signal: opts.signal,
  });
  if (opts.signal?.aborted || result.code === 124) {
    const stopped = await runEmbedded("bash", ["-lc", cleanup], { timeoutMs: 10_000 });
    if (stopped.code !== 0) result.stderr += `\nembedded 进程组清理失败: ${stopped.stderr}`;
  }
  return result;
}

/** 统一 Kali 执行接口；embedded 分支不会拼接或调用任何 docker 参数。 */
export async function kaliExec(command: string, opts: KaliExecOptions = {}): Promise<DockerResult> {
  return config.kali.runtime === "embedded" ? kaliExecEmbedded(command, opts) : kaliExecContainer(command, opts);
}

export interface KaliEnvInfo {
  /** 实际可用的工具命令清单（单行，空格分隔），注入 planner 快照与 worker 任务消息 */
  toolLine: string;
  /** /wordlists 字典文件清单（多行：大小+路径），注入 planner 快照与 worker 任务消息 */
  wordlistBlock: string;
}

const TOOL_PROBES = [
  "nmap", "sqlmap", "msfconsole", "dirsearch", "nuclei", "hydra", "john", "tcpdump",
  "jwt_tool", "netstat", "r2", "gdb", "patchelf", "binwalk", "exiftool", "steghide", "zsteg", "tshark", "zbarimg", "xortool",
  "python3", "pip3", "pipx", "git", "curl", "telnet", "ssh", "jq", "tmux", "vim", "tree", "htop",
  "wg", "wg-quick", "openvpn",
];

/** 探测容器内真实可用的工具与字典清单（编排启动时调用一次，缓存后随任务下发）。 */
export async function getKaliEnvInfo(log?: (s: string) => void): Promise<KaliEnvInfo> {
  const probe = await kaliExec(
    [
      `for t in ${TOOL_PROBES.join(" ")}; do command -v $t >/dev/null 2>&1 && printf '%s ' "$t"; done`,
      "echo",
      "ls /usr/bin 2>/dev/null | grep -c '^impacket-' || true",
      `python3 -c 'import importlib.util; modules={"pwntools(python)":"pwn","pycryptodome(python)":"Crypto","gmpy2(python)":"gmpy2","sympy(python)":"sympy","volatility3(python)":"volatility3"}; print(" ".join(name for name, module in modules.items() if importlib.util.find_spec(module)))'`,
    ].join("; "),
    { timeoutMs: 60_000 }
  );
  const lines = probe.stdout.trim().split("\n");
  const found = (lines[0] ?? "").trim().split(/\s+/).filter(Boolean);
  const impacketCount = Number((lines[1] ?? "0").trim()) || 0;
  if (impacketCount > 0) found.push(`impacket-*(${impacketCount}个)`);
  const pythonTools = (lines[2] ?? "").trim().split(/\s+/).filter(Boolean);
  found.push(...pythonTools);
  const toolLine = found.join(" ");

  const wl = await kaliExec(
    "find /wordlists -type f -printf '%s\\t%p\\n' 2>/dev/null | sort -k2 | head -60; find /wordlists -type f 2>/dev/null | wc -l",
    { timeoutMs: 60_000 }
  );
  const wlLines = wl.stdout.trim().split("\n");
  const total = Number(wlLines.pop() ?? "0") || 0;
  const files = wlLines.filter(Boolean);
  const human = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
  const wordlistBlock =
    total === 0
      ? "（wordlists 目录当前为空）"
      : files
          .map((l) => {
            const m = l.match(/^(\d+)\t(.+)$/);
            return m ? `${human(Number(m[1])).padStart(8)}  ${m[2]}` : l;
          })
          .join("\n") + (total > files.length ? `\n…（共 ${total} 个文件，仅列前 ${files.length} 个，可用 ls /wordlists 查看全部）` : "");

  log?.(`[kali] 环境清单已探测：${found.length} 组工具，/wordlists ${total} 个文件`);
  return { toolLine, wordlistBlock };
}
