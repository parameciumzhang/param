#!/usr/bin/env bash
# 构建期共享工具安装定义：docker/kali 与 docker/all-in-one 必须复用此文件。
set -Eeuo pipefail

APT_MIRROR="${APT_MIRROR:-}"
KALI_PACKAGES="${KALI_PACKAGES:-python3 python3-pip python3-dev libssl-dev libffi-dev build-essential cmake pkg-config pipx git radare2 gdb patchelf binwalk libimage-exiftool-perl steghide tshark zbar-tools python3-gmpy2 python3-sympy ruby ruby-rubygems curl telnet openssh-client vim tmux jq tree htop net-tools nmap sqlmap metasploit-framework dirsearch nuclei hydra john tcpdump python3-impacket impacket-scripts proxychains4 wireguard-tools openvpn iproute2 openresolv}"
EXTRA_APT_PACKAGES="${EXTRA_APT_PACKAGES:-}"

if [[ -n "$APT_MIRROR" ]]; then
  printf 'Types: deb\nURIs: %s/\nSuites: kali-rolling\nComponents: main contrib non-free non-free-firmware\nSigned-By: /usr/share/keyrings/kali-archive-keyring.gpg\n' \
    "$APT_MIRROR" > /etc/apt/sources.list.d/kali.sources
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
# 包列表来自受控构建参数，需要按空白拆分。
# shellcheck disable=SC2086
apt-get install -y $KALI_PACKAGES $EXTRA_APT_PACKAGES

# PEP 668 环境回退到 --break-system-packages；网络断流时进行有限次完整重试，
# 避免 pip 默认恢复次数耗尽后让整个 Docker RUN 失败。
pip_install() {
  local attempt
  for attempt in 1 2 3; do
    if python3 -m pip install "$@" || python3 -m pip install --break-system-packages "$@"; then
      return 0
    fi
    echo "pip 安装失败（第 ${attempt}/3 轮），5 秒后重试: $*" >&2
    sleep 5
  done
  return 1
}

pip_install --upgrade pwntools pycryptodome volatility3 xortool "capstone<6"
gem install zsteg --no-document

# GitHub 偶发 HTTP/2/TLS 断流；浅克隆减少传输量，HTTP/1.1 + 有限重试提高构建稳定性。
git_clone_ok=0
for attempt in 1 2 3 4 5; do
  if git -c http.version=HTTP/1.1 clone --depth 1 https://github.com/ticarpi/jwt_tool.git /opt/jwt_tool; then
    git_clone_ok=1
    break
  fi
  rm -rf /opt/jwt_tool
  echo "jwt_tool 克隆失败（第 ${attempt}/5 次），5 秒后重试" >&2
  sleep 5
done
[[ "$git_clone_ok" == "1" ]]
cd /opt/jwt_tool
pip_install -r requirements.txt
printf '#!/bin/bash\ncd /opt/jwt_tool && exec python3 jwt_tool.py "$@"\n' > /usr/local/bin/jwt_tool
chmod +x /usr/local/bin/jwt_tool
rm -rf /opt/jwt_tool/.git

# container 与 embedded 都识别该标记；All-in-One 另有镜像专用标记。
touch /root/.provisioned
rm -rf /var/lib/apt/lists/* /root/.cache /tmp/pip-* 2>/dev/null || true
