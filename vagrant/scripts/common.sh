#!/usr/bin/env bash
# 모든 노드 공통 셋업 — containerd + kubeadm/kubelet/kubectl (k8s 1.29).
# 인자: $1 = 이 노드의 host-only IP (kubelet --node-ip 로 사용)
set -euxo pipefail

NODE_IP="${1:?node ip required}"
ROOT_PW="${2:-}"
K8S_MINOR="v1.29"

export DEBIAN_FRONTEND=noninteractive

# ── 0. root SSH 로그인 + 비번 활성화 (폐쇄망 운영과 동일하게 root+password 수집 테스트) ──
# PEP 의 Host Facts / 대량실행 등 SSH 기능을 운영과 같은 방식(root + 비번)으로 검증하기 위함.
# 테스트 전용 — 실제 운영 노드에서는 절대 이렇게 열지 말 것.
if [ -n "$ROOT_PW" ]; then
  echo "root:${ROOT_PW}" | chpasswd
  sed -ri 's/^#?\s*PermitRootLogin.*/PermitRootLogin yes/'        /etc/ssh/sshd_config || true
  sed -ri 's/^#?\s*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || true
  # cloud-init / 배포본이 sshd_config.d 로 위 설정을 덮는 경우 대비해 최우선 드롭인 추가
  mkdir -p /etc/ssh/sshd_config.d
  printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' >/etc/ssh/sshd_config.d/99-pep-test.conf
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
  echo "[common] root SSH 비번 로그인 활성화 (테스트용)"
fi

# ── 1. 스왑 비활성화 ───────────────────────────────────────────────────────────
swapoff -a || true
sed -ri 's/^([^#].*\sswap\s)/#\1/' /etc/fstab || true

# ── 2. 커널 모듈 / sysctl ──────────────────────────────────────────────────────
cat >/etc/modules-load.d/k8s.conf <<EOF
overlay
br_netfilter
EOF
modprobe overlay || true
modprobe br_netfilter || true

cat >/etc/sysctl.d/k8s.conf <<EOF
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sysctl --system

# ── 3. containerd ──────────────────────────────────────────────────────────────
apt-get update -y
apt-get install -y containerd apt-transport-https ca-certificates curl gpg

mkdir -p /etc/containerd
containerd config default >/etc/containerd/config.toml
# kubelet 의 cgroup driver(systemd) 와 일치시킴
sed -ri 's/(SystemdCgroup = )false/\1true/' /etc/containerd/config.toml
systemctl restart containerd
systemctl enable containerd

# ── 4. kubeadm / kubelet / kubectl ──────────────────────────────────────────────
mkdir -p /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/kubernetes-apt-keyring.gpg ]; then
  curl -fsSL "https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/Release.key" \
    | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
fi
cat >/etc/apt/sources.list.d/kubernetes.list <<EOF
deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/ /
EOF

apt-get update -y
apt-get install -y kubelet kubeadm kubectl
apt-mark hold kubelet kubeadm kubectl

# ── 5. kubelet 이 host-only IP 를 InternalIP 로 광고하도록 ─────────────────────────
echo "KUBELET_EXTRA_ARGS=--node-ip=${NODE_IP}" >/etc/default/kubelet
systemctl daemon-reload
systemctl enable kubelet

echo "[common] done on ${NODE_IP}"
