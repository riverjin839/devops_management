#!/usr/bin/env bash
# 모든 노드 공통 셋업 (AlmaLinux 10 / RHEL 10 호환) — CRI-O + kubeadm/kubelet/kubectl (1.29).
# 인자: $1 = 이 노드의 host-only IP, $2 = root SSH 비번(선택)
set -euxo pipefail

NODE_IP="${1:?node ip required}"
ROOT_PW="${2:-}"
K8S_MINOR="v1.29"
CRIO_MINOR="v1.29"

# ── 0. root SSH 로그인 + 비번 (폐쇄망 운영과 동일하게 root+password 수집 테스트) ──
# 테스트 전용 — 실제 운영 노드에서는 절대 이렇게 열지 말 것.
if [ -n "$ROOT_PW" ]; then
  echo "root:${ROOT_PW}" | chpasswd
  sed -ri 's/^#?\s*PermitRootLogin.*/PermitRootLogin yes/'        /etc/ssh/sshd_config || true
  sed -ri 's/^#?\s*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || true
  mkdir -p /etc/ssh/sshd_config.d
  printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' >/etc/ssh/sshd_config.d/99-pep-test.conf
  systemctl restart sshd 2>/dev/null || true
  echo "[common] root SSH 비번 로그인 활성화 (테스트용)"
fi

# ── 1. 스왑 비활성화 ───────────────────────────────────────────────────────────
swapoff -a || true
sed -ri 's/^([^#].*\sswap\s)/#\1/' /etc/fstab || true
systemctl disable --now swap.target 2>/dev/null || true

# ── 2. SELinux permissive (kubeadm 요건) ─────────────────────────────────────────
setenforce 0 2>/dev/null || true
sed -ri 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config 2>/dev/null || true

# ── 3. firewalld 비활성 (테스트 단순화) ───────────────────────────────────────────
systemctl disable --now firewalld 2>/dev/null || true

# ── 4. 커널 모듈 / sysctl ──────────────────────────────────────────────────────
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

# ── 5. 레포 (Kubernetes + CRI-O, pkgs.k8s.io) ────────────────────────────────────
cat >/etc/yum.repos.d/kubernetes.repo <<EOF
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/rpm/repodata/repomd.xml.key
EOF
cat >/etc/yum.repos.d/cri-o.repo <<EOF
[cri-o]
name=CRI-O
baseurl=https://pkgs.k8s.io/addons:/cri-o:/stable:/${CRIO_MINOR}/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/addons:/cri-o:/stable:/${CRIO_MINOR}/rpm/repodata/repomd.xml.key
EOF

# ── 6. 설치 (CRI-O + kube* + 보조 도구) ──────────────────────────────────────────
dnf install -y container-selinux 2>/dev/null || true
# jq: PEP Host Facts 수집이 노드에서 NIC 필터에 사용. tar: cilium-cli 추출. xfsprogs: MinIO 디스크 포맷.
dnf install -y cri-o kubelet kubeadm kubectl jq tar xfsprogs
systemctl enable --now crio

# ── 7. kubelet 이 host-only IP 를 InternalIP 로 광고하도록 ─────────────────────────
echo 'KUBELET_EXTRA_ARGS=--node-ip='"${NODE_IP}" >/etc/sysconfig/kubelet
systemctl daemon-reload
systemctl enable kubelet

echo "[common] done on ${NODE_IP} (AlmaLinux/RHEL, CRI-O)"
