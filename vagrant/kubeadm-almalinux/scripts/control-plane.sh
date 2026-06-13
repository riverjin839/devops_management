#!/usr/bin/env bash
# Control-plane 초기화 + Cilium CNI + PEP/worker 용 산출물 생성.
# 인자: $1 = control-plane host-only IP
set -euxo pipefail

CP_IP="${1:?cp ip required}"
POD_CIDR="10.244.0.0/16"          # kubeadm 이 노드별 PodCIDR 할당 (Cilium ipam=kubernetes 가 사용)
CILIUM_CLI_VERSION="v0.16.9"      # cilium-cli 버전 (조정 가능)
CILIUM_VERSION="1.15.6"           # Cilium 자체 버전 (k8s 1.29 호환)
OUT="/vagrant/_out"

mkdir -p "${OUT}"

# ── 1. kubeadm init (멱등) ──────────────────────────────────────────────────────
if [ ! -f /etc/kubernetes/admin.conf ]; then
  kubeadm init \
    --apiserver-advertise-address="${CP_IP}" \
    --apiserver-cert-extra-sans="${CP_IP},127.0.0.1,localhost,host.docker.internal" \
    --pod-network-cidr="${POD_CIDR}" \
    --cri-socket=unix:///var/run/crio/crio.sock
fi

# ── 2. kubectl (root + vagrant) ────────────────────────────────────────────────
export KUBECONFIG=/etc/kubernetes/admin.conf
mkdir -p /home/vagrant/.kube /root/.kube
cp -f /etc/kubernetes/admin.conf /home/vagrant/.kube/config
cp -f /etc/kubernetes/admin.conf /root/.kube/config
chown -R vagrant:vagrant /home/vagrant/.kube

# ── 3. Cilium CNI (cilium-cli, ipam=kubernetes → kubeadm PodCIDR 사용) ───────────
case "$(uname -m)" in
  x86_64)  ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;            # Apple Silicon 게스트
  *)       ARCH=amd64 ;;
esac
if ! command -v cilium >/dev/null 2>&1; then
  curl -fsSL "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${ARCH}.tar.gz" \
    -o /tmp/cilium-cli.tgz
  tar -C /usr/local/bin -xzf /tmp/cilium-cli.tgz cilium
fi
if ! kubectl -n kube-system get daemonset cilium >/dev/null 2>&1; then
  # ipam.mode=kubernetes → controller-manager(=--pod-network-cidr)가 할당한 노드별
  # PodCIDR 를 그대로 사용 → service CIDR / host-only 망과 충돌 없음.
  cilium install --version "${CILIUM_VERSION}" --set ipam.mode=kubernetes
fi
cilium status --wait --wait-duration=5m || true

# ── 4. worker join 명령 생성 ────────────────────────────────────────────────────
kubeadm token create --print-join-command >"${OUT}/join.sh"
chmod +x "${OUT}/join.sh"

# ── 5. PEP 용 kubeconfig (server → host.docker.internal:6443) ────────────────────
# PEP backend 컨테이너가 Mac 호스트의 포워딩된 6443 으로 접속.
# cert SAN 에 host.docker.internal 을 넣었으므로 TLS 검증도 정상.
cp -f /etc/kubernetes/admin.conf "${OUT}/admin.conf"
sed "s#server: https://${CP_IP}:6443#server: https://host.docker.internal:6443#" \
  /etc/kubernetes/admin.conf >"${OUT}/pep-kubeconfig.yaml"

# worker join 후 노드가 Ready 되려면 Cilium 이 각 노드에 떠야 함 (자동).
echo "[control-plane] 완료. 산출물:"
echo "  - ${OUT}/pep-kubeconfig.yaml  → PEP '클러스터 추가' 에 붙여넣기"
echo "  - ${OUT}/admin.conf           → Mac 에서 kubectl 용 (server=${CP_IP}:6443)"
echo "  - ${OUT}/join.sh              → worker 자동 join 에 사용"
