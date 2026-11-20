# syntax=docker/dockerfile:1

# 与运行阶段同为 glibc Linux；npm 原生/预构建依赖按同一架构复制。
FROM node:24-bookworm AS build
WORKDIR /opt/param

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && node --check dist/orchestrator.js \
    && node --check dist/kali.js

# 角色扩展只复制锁定依赖与静态配置，不复制 auth/models/cache。
COPY .pi-agent/npm/package.json .pi-agent/npm/package-lock.json ./.pi-agent/npm/
RUN npm ci --omit=dev --prefix .pi-agent/npm \
    && npm cache clean --force

FROM kalilinux/kali-rolling
ARG APT_MIRROR=""
ARG PIP_INDEX_URL=""
# 空值使用共享 provision.sh 的唯一默认工具清单。
ARG KALI_PACKAGES=""

COPY --from=build /usr/local/ /usr/local/
COPY docker/kali/provision.sh /usr/local/sbin/param-provision-kali
RUN chmod 0755 /usr/local/sbin/param-provision-kali \
    && APT_MIRROR="$APT_MIRROR" KALI_PACKAGES="$KALI_PACKAGES" \
       PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.org/simple}" \
       EXTRA_APT_PACKAGES="postgresql postgresql-client tini" \
       /usr/local/sbin/param-provision-kali

WORKDIR /opt/param
COPY --from=build /opt/param/dist ./dist
COPY --from=build /opt/param/node_modules ./node_modules
COPY --from=build /opt/param/.pi-agent/npm ./.pi-agent/npm
COPY package.json package-lock.json ./
COPY prompts/templates ./prompts/templates
COPY skills ./skills
COPY wordlists ./wordlists
COPY .mcp.json ./.mcp.json
COPY .env ./.env
COPY input/ctf.txt /input/ctf.txt
COPY .pi-agent/settings.json .pi-agent/mcp-adapter.json ./.pi-agent/
COPY docker/all-in-one/entrypoint.sh /usr/local/bin/param-entrypoint

RUN set -eu; \
    chmod 0755 /usr/local/bin/param-entrypoint; \
    chmod 0600 /opt/param/.env /opt/param/.mcp.json; \
    mkdir -p /output/report /output/history_db /output/workspaces; \
    ln -s /output/workspaces /work; \
    ln -s /opt/param/wordlists /wordlists; \
    PG_BIN="$(dirname "$(find /usr/lib/postgresql -type f -name postgres | sort -V | tail -n 1)")"; \
    PG_VERSION="$($PG_BIN/postgres --version | awk '{print $3}')"; \
    PG_MAJOR="${PG_VERSION%%.*}"; \
    test "$PG_MAJOR" -ge 16; \
    test "$(node --version | cut -d. -f1)" = "v24"; \
    PARAM_PG_VERSION="$PG_VERSION" PARAM_NODE_VERSION="$(node --version)" node -e \
      'require("node:fs").writeFileSync("/opt/param/image-manifest.json", JSON.stringify({node:process.env.PARAM_NODE_VERSION,postgresql:process.env.PARAM_PG_VERSION,kaliRuntime:"embedded",provisionedAt:new Date().toISOString()},null,2)+"\n")'; \
    dpkg-query -W -f='${binary:Package}\t${Version}\n' > /opt/param/image-packages.txt; \
    touch /opt/param/.all-in-one-provisioned; \
    rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

LABEL org.opencontainers.image.title="param-ctf-all-in-one" \
      org.opencontainers.image.description="Node.js 24 + PostgreSQL >=16 + Kali CTF orchestrator"

ENV KALI_RUNTIME=embedded \
    KALI_ENABLED=true \
    KALI_SKIP_PROVISION=true \
    PARAM_OUTPUT_DIR=/output \
    PGHOST=127.0.0.1 \
    PGPORT=55432 \
    CTF_INPUT_FILE=/input/ctf.txt \
    PI_CODING_AGENT_DIR=/opt/param/.pi-agent

# PostgreSQL 不 EXPOSE；tini 只做僵尸回收，entrypoint 精确转发应用信号。
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/param-entrypoint"]
