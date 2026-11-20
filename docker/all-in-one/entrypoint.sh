#!/usr/bin/env bash
# All-in-One 生命周期：本地 PostgreSQL → 编排器/镜像验证 → 停止 PostgreSQL。
set -Eeuo pipefail

log() { printf '[entrypoint] %s\n' "$*"; }
usage() {
  cat >&2 <<'EOF'
用法:
  docker run <image> --new "整场 CTF 赛事与赛题描述"
  docker run <image> --continue ["/output/history_db/param-contest-..."]
  docker run -e CTF_INPUT="整场 CTF 赛事与赛题描述" <image>
  docker run <image>   # 读取 /input/ctf.txt，并可使用镜像内 .env 的 CTF_INPUT

文件与 CTF_INPUT 可同时使用，orchestrator 按文件在前、环境变量在后合并。
平台专有参数尚未预设；显式容器参数优先，--continue 不读取新赛事输入。
EOF
  exit 2
}

VERIFY_ONLY=0
CTF_INPUT="${CTF_INPUT:-}"
if [[ "${1:-}" == "--image-verify" ]]; then
  [[ $# -eq 1 ]] || { echo "--image-verify 不接受其他参数" >&2; exit 2; }
  VERIFY_ONLY=1
  shift
elif [[ $# -eq 0 ]]; then
  CTF_INPUT_FILE="${CTF_INPUT_FILE:-/input/ctf.txt}"
  export CTF_INPUT_FILE
  # 保留空参数，让 orchestrator 同时读取文件和 CTF_INPUT；不要在 entrypoint 提前转成 CLI 参数。
  if [[ -z "${CTF_INPUT//[[:space:]]/}" ]]; then
    # 编排器由 dotenv 加载 /opt/param/.env；entrypoint 仅用解析结果做预检，不 source/执行该文件。
    # 显式容器环境变量仍优先；这里不 export 文件值，避免改变编排器读取到的原始内容。
    ENV_FILE_CTF_INPUT=""
    if [[ -f /opt/param/.env ]]; then
      ENV_FILE_CTF_INPUT="$(node -e 'const fs=require("node:fs");const dotenv=require("/opt/param/node_modules/dotenv");process.stdout.write(dotenv.parse(fs.readFileSync("/opt/param/.env")).CTF_INPUT||"")')"
    fi
    if [[ -z "${ENV_FILE_CTF_INPUT//[[:space:]]/}" ]]; then
      if [[ ! -f "$CTF_INPUT_FILE" ]] || ! grep -q '[^[:space:]]' "$CTF_INPUT_FILE" 2>/dev/null; then
        usage
      fi
    fi
  fi
fi

PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-pentest}"
PGDATABASE="${PGDATABASE:-pentest}"
PARAM_OUTPUT_DIR="${PARAM_OUTPUT_DIR:-/output}"
PARAM_PGDATA="${PARAM_PGDATA:-/var/lib/postgresql/param-data}"

[[ "$PGPORT" =~ ^[0-9]+$ ]] && (( 10#$PGPORT >= 1 && 10#$PGPORT <= 65535 )) \
  || { echo "PGPORT 必须是 1..65535 的整数" >&2; exit 2; }
[[ "$PGUSER" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
  || { echo "PGUSER 必须是安全的 PostgreSQL 标识符" >&2; exit 2; }
[[ "$PGDATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
  || { echo "PGDATABASE 必须是安全的 PostgreSQL 标识符" >&2; exit 2; }
[[ "$PARAM_PGDATA" != "/" && "$PARAM_OUTPUT_DIR" != "/" ]] \
  || { echo "PARAM_PGDATA/PARAM_OUTPUT_DIR 不得为根目录" >&2; exit 2; }

PG_BIN=""
for candidate in $(find /usr/lib/postgresql -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null | sort -Vr); do
  if [[ -x "$candidate/postgres" ]]; then PG_BIN="$candidate"; break; fi
done
[[ -n "$PG_BIN" ]] || { echo "找不到 PostgreSQL server 二进制" >&2; exit 1; }
PG_VERSION="$($PG_BIN/postgres --version | awk '{print $3}')"
PG_MAJOR="${PG_VERSION%%.*}"
[[ "$PG_MAJOR" =~ ^[0-9]+$ ]] && (( PG_MAJOR >= 16 )) \
  || { echo "PostgreSQL >=16 才受支持，当前: $PG_VERSION" >&2; exit 1; }

# 未注入密码时生成随机本地密码。密码只存在进程环境，不写镜像、文件或日志。
if [[ -z "${PGPASSWORD:-}" ]]; then
  PGPASSWORD="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
fi
export PGHOST=127.0.0.1 PGPORT PGUSER PGPASSWORD PGDATABASE PARAM_OUTPUT_DIR

install -d -m 0755 "$PARAM_OUTPUT_DIR" "$PARAM_OUTPUT_DIR/report" "$PARAM_OUTPUT_DIR/history_db" "$PARAM_OUTPUT_DIR/workspaces"
install -d -o postgres -g postgres -m 0755 /var/run/postgresql
[[ "$PARAM_PGDATA" == /* ]] || { echo "PARAM_PGDATA 必须使用绝对路径" >&2; exit 2; }
install -d -o postgres -g postgres -m 0700 "$PARAM_PGDATA"
chown -R postgres:postgres "$PARAM_PGDATA"
umask 077

as_postgres() { runuser -u postgres -- "$@"; }
if [[ ! -s "$PARAM_PGDATA/PG_VERSION" ]]; then
  log "初始化本地 PostgreSQL $PG_VERSION（仅 127.0.0.1:$PGPORT）"
  as_postgres "$PG_BIN/initdb" -D "$PARAM_PGDATA" --username=postgres --auth-local=trust --auth-host=scram-sha-256 --no-instructions >/dev/null
fi
[[ "$(cat "$PARAM_PGDATA/PG_VERSION")" == "$PG_MAJOR" ]] \
  || { echo "PGDATA 主版本与当前 PostgreSQL 不一致，请使用新数据目录或显式 pg_upgrade" >&2; exit 1; }

# 每次启动都收紧认证规则；服务启动参数同时固定监听地址、端口和本地 socket。
cat > "$PARAM_PGDATA/pg_hba.conf" <<'EOF'
local   all             all                                     trust
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
EOF
chown postgres:postgres "$PARAM_PGDATA/pg_hba.conf"

PG_STARTED=0
stop_postgres() {
  if [[ "$PG_STARTED" == "1" ]]; then
    log "编排器已退出，停止本地 PostgreSQL"
    set +e
    as_postgres "$PG_BIN/pg_ctl" -D "$PARAM_PGDATA" -m fast -w stop >/dev/null
    STOP_STATUS=$?
    set -e
    [[ "$STOP_STATUS" == "0" ]] || echo "PostgreSQL 停止失败（保留应用原始退出码）" >&2
    PG_STARTED=0
  fi
}
on_exit() {
  STATUS=$?
  trap - EXIT INT TERM
  stop_postgres
  exit "$STATUS"
}
trap on_exit EXIT

PG_STARTED=1
as_postgres "$PG_BIN/pg_ctl" -D "$PARAM_PGDATA" -l "$PARAM_PGDATA/postgresql.log" \
  -o "-c listen_addresses=127.0.0.1 -c port=$PGPORT -c unix_socket_directories=/var/run/postgresql" -w start >/dev/null
as_postgres "$PG_BIN/pg_isready" -h /var/run/postgresql -p "$PGPORT" -U postgres -d postgres >/dev/null

# 标识符已通过白名单；值仍使用 psql 的 :'var'/:"var" 引用，避免 SQL 拼接注入。
as_postgres "$PG_BIN/psql" -h /var/run/postgresql -p "$PGPORT" -U postgres -d postgres \
  --set=ON_ERROR_STOP=1 --set=role="$PGUSER" --set=password="$PGPASSWORD" >/dev/null <<'SQL'
SET password_encryption = 'scram-sha-256';
SELECT format('CREATE ROLE %I LOGIN', :'role')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
ALTER ROLE :"role" WITH LOGIN PASSWORD :'password';
SQL
as_postgres "$PG_BIN/psql" -h /var/run/postgresql -p "$PGPORT" -U postgres -d postgres \
  --set=ON_ERROR_STOP=1 --set=database_name="$PGDATABASE" --set=role="$PGUSER" >/dev/null <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'database_name', :'role')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database_name') \gexec
ALTER DATABASE :"database_name" OWNER TO :"role";
SQL
"$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" >/dev/null
log "PostgreSQL ready；业务 schema 由 orchestrator initSchema 负责"

run_verify() {
  [[ ! -S /var/run/docker.sock ]] || { echo "镜像验收不得挂载 Docker Socket" >&2; return 1; }
  [[ -f /opt/param/.env ]] || { echo "镜像缺少构建期内嵌的 .env" >&2; return 1; }
  [[ "$(stat -c '%a' /opt/param/.env)" == "600" ]] || { echo "镜像内 .env 权限必须为 600" >&2; return 1; }
  [[ -f /opt/param/.mcp.json ]] || { echo "镜像缺少构建期内嵌的 .mcp.json" >&2; return 1; }
  [[ "$(stat -c '%a' /opt/param/.mcp.json)" == "600" ]] || { echo "镜像内 .mcp.json 权限必须为 600" >&2; return 1; }
  node -e 'const c=require("node:fs").readFileSync("/opt/param/.mcp.json","utf8");const p=JSON.parse(c);if(!p.mcpServers||typeof p.mcpServers!=="object"||Array.isArray(p.mcpServers))throw new Error("mcpServers 必须是对象")'
  log "运行无 Docker 依赖的 runtime/selftest/embedded E2E（会清空当前验证库与 /output/workspaces）"
  node --enable-source-maps /opt/param/dist/runtime-selftest.js
  node --enable-source-maps /opt/param/dist/selftest.js
  E2E_EMBEDDED=1 node --enable-source-maps /opt/param/dist/e2e.js
}

if [[ "$VERIFY_ONLY" == "1" ]]; then
  run_verify &
else
  node --enable-source-maps /opt/param/dist/orchestrator.js "$@" &
fi
APP_PID=$!
forward_signal() {
  local signal="$1"
  if kill -0 "$APP_PID" 2>/dev/null; then
    kill -s "$signal" "$APP_PID"
  fi
}
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM

# wait 被 trap 打断时继续等待同一个应用，最终只保留应用退出码。
set +e
while true; do
  wait "$APP_PID"
  APP_STATUS=$?
  if ! kill -0 "$APP_PID" 2>/dev/null; then break; fi
done
set -e
trap - INT TERM
exit "$APP_STATUS"
