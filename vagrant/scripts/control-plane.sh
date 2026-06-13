#!/usr/bin/env bash
# Control-plane 초기화 + Flannel CNI + PEP/worker 용 산출물 생성.
# 인자: $1 = control-plane host-only IP
set -euxo pipefail

CP_IP="${1:?cp ip required}"
POD_CIDR="10.244.0.0/16"          # Flannel 기본 (host-only 192.168.x 와 미충돌)
OUT="/vagrant/_out"

mkdir -p "${OUT}"

# ── 1. kubeadm init (멱등) ──────────────────────────────────────────────────────
if [ ! -f /etc/kubernetes/admin.conf ]; then
  kubeadm init \
    --apiserver-advertise-address="${CP_IP}" \
    --apiserver-cert-extra-sans="${CP_IP},127.0.0.1,localhost,host.docker.internal" \
    --pod-network-cidr="${POD_CIDR}" \
    --cri-socket=unix:///run/containerd/containerd.sock
fi

# ── 2. kubectl (root + vagrant) ────────────────────────────────────────────────
export KUBECONFIG=/etc/kubernetes/admin.conf
mkdir -p /home/vagrant/.kube /root/.kube
cp -f /etc/kubernetes/admin.conf /home/vagrant/.kube/config
cp -f /etc/kubernetes/admin.conf /root/.kube/config
chown -R vagrant:vagrant /home/vagrant/.kube

# ── 3. Flannel CNI ─────────────────────────────────────────────────────────────
if ! kubectl -n kube-flannel get ds kube-flannel-ds >/dev/null 2>&1; then
  kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml
fi

# ── 4. worker join 명령 생성 ────────────────────────────────────────────────────
kubeadm token create --print-join-command >"${OUT}/join.sh"
chmod +x "${OUT}/join.sh"

# ── 5. PEP 용 kubeconfig (server → host.docker.internal:6443) ────────────────────
# PEP backend 컨테이너가 Mac 호스트의 포워딩된 6443 으로 접속.
# cert SAN 에 host.docker.internal 을 넣었으므로 TLS 검증도 정상.
cp -f /etc/kubernetes/admin.conf "${OUT}/admin.conf"
sed "s#server: https://${CP_IP}:6443#server: https://host.docker.internal:6443#" \
  /etc/kubernetes/admin.conf >"${OUT}/pep-kubeconfig.yaml"

echo "[control-plane] 완료. 산출물:"
echo "  - ${OUT}/pep-kubeconfig.yaml  → PEP '클러스터 추가' 에 붙여넣기"
echo "  - ${OUT}/admin.conf           → Mac 에서 kubectl 용 (server=${CP_IP}:6443)"
echo "  - ${OUT}/join.sh              → worker 자동 join 에 사용"
