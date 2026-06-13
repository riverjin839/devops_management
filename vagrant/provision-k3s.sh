#!/bin/bash
# ============================================================
# Vagrant VM provisioner — 단일 노드 k3s + Cilium (Apple Silicon)
# ============================================================
# k3s 기본 CNI(flannel) 를 비활성화하고 Cilium + Hubble 을 설치한다.
# backend 컨테이너가 host.docker.internal:6443 으로 접속하므로
# TLS 인증서에 해당 SAN 을 포함시켜 설치한다.
#
# 환경변수:
#   K3S_CNI=cilium|flannel   (기본 cilium). flannel 로 두면 기본 CNI 사용.
#   K3S_VERSION              k3s 버전
#   CILIUM_VERSION           Cilium 버전
set -euo pipefail

K3S_VERSION="${K3S_VERSION:-v1.30.5+k3s1}"
CILIUM_VERSION="${CILIUM_VERSION:-1.16.5}"
K3S_CNI="${K3S_CNI:-cilium}"

K3S_KC="/etc/rancher/k3s/k3s.yaml"

echo "[provision] k3s 설치 (version=${K3S_VERSION}, CNI=${K3S_CNI})"

# ── k3s 설치 (Cilium 모드면 flannel/네트워크정책 비활성화) ──
if command -v k3s >/dev/null 2>&1; then
  echo "[provision] k3s 이미 설치됨 — skip"
else
  BASE_EXEC="--tls-san host.docker.internal --tls-san 127.0.0.1 --write-kubeconfig-mode 644 --disable traefik"
  if [ "${K3S_CNI}" = "cilium" ]; then
    # flannel/내장 networkpolicy/servicelb 비활성화 → Cilium 이 CNI 담당
    EXEC="${BASE_EXEC} --flannel-backend=none --disable-network-policy --disable servicelb"
  else
    EXEC="${BASE_EXEC}"
  fi
  curl -sfL https://get.k3s.io | \
    INSTALL_K3S_VERSION="${K3S_VERSION}" \
    INSTALL_K3S_EXEC="${EXEC}" \
    sh -
fi

# ── Cilium 설치 (CNI=cilium 일 때) ─────────────────────────
if [ "${K3S_CNI}" = "cilium" ]; then
  echo "[provision] k3s API 기동 대기..."
  for i in $(seq 1 30); do
    if k3s kubectl get --raw='/readyz' >/dev/null 2>&1; then break; fi
    sleep 3
  done

  if ! command -v cilium >/dev/null 2>&1; then
    echo "[provision] cilium CLI 설치 중..."
    CILIUM_CLI_VERSION="$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)"
    curl -sL --fail -o /tmp/cilium.tar.gz \
      "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-arm64.tar.gz"
    tar xzf /tmp/cilium.tar.gz -C /usr/local/bin
    rm -f /tmp/cilium.tar.gz
  fi

  export KUBECONFIG="${K3S_KC}"
  if ! cilium status >/dev/null 2>&1; then
    echo "[provision] Cilium ${CILIUM_VERSION} 설치 중..."
    # k3s 의 CNI 경로에 맞춰 설치 (kubelet 이 읽는 위치)
    cilium install --version "${CILIUM_VERSION}" \
      --set cni.binPath=/var/lib/rancher/k3s/data/current/bin \
      --set cni.confPath=/var/lib/rancher/k3s/agent/etc/cni/net.d
    cilium status --wait
    cilium hubble enable --ui
  fi
fi

echo "[provision] 노드 Ready 대기 중..."
for i in $(seq 1 40); do
  if k3s kubectl get nodes 2>/dev/null | grep -q ' Ready '; then break; fi
  sleep 3
done

echo ""
echo "[provision] ===== 노드 상태 ====="
k3s kubectl get nodes -o wide || true
echo ""
echo "[provision] ===== 시스템 파드 ====="
k3s kubectl get pods -A || true

echo ""
echo "[provision] 완료. Mac 호스트에서 kubeconfig 를 가져오려면:"
echo "    vagrant ssh -c 'sudo cat /etc/rancher/k3s/k3s.yaml' > k3s-kubeconfig.yaml"
echo "  그 후 PEP 에 등록:"
echo "    bash ../scripts/register-local-cluster.sh \\"
echo "      --name vagrant-k3s --kubeconfig k3s-kubeconfig.yaml \\"
echo "      --server https://host.docker.internal:6443"
