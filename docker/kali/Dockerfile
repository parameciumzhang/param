# 渗透测试 worker 执行环境：kali-rolling + 全量预装工具
# 构建：npm run kali:image（自动带 .env 中的 KALI_APT_MIRROR / KALI_INSTALL_PACKAGES）
# 离线分发：npm run kali:export → 目标机 npm run kali:import → KALI_IMAGE=param-kali-ctf
FROM kalilinux/kali-rolling

ARG APT_MIRROR=""
ARG KALI_PACKAGES="python3 python3-pip python3-dev libssl-dev libffi-dev build-essential cmake pkg-config pipx git radare2 gdb patchelf binwalk libimage-exiftool-perl steghide tshark zbar-tools python3-gmpy2 python3-sympy ruby ruby-rubygems curl telnet openssh-client vim tmux jq tree htop net-tools nmap sqlmap metasploit-framework dirsearch nuclei hydra john tcpdump python3-impacket impacket-scripts proxychains4 wireguard-tools openvpn iproute2 openresolv"

# All-in-One 复用同一安装脚本，避免两个 Dockerfile 的工具清单漂移。
COPY provision.sh /usr/local/sbin/param-provision-kali
RUN chmod 0755 /usr/local/sbin/param-provision-kali \
    && APT_MIRROR="$APT_MIRROR" KALI_PACKAGES="$KALI_PACKAGES" /usr/local/sbin/param-provision-kali

# 编排器 docker run 时显式 sleep infinity；CMD 仅供手动调试。
CMD ["sleep", "infinity"]
