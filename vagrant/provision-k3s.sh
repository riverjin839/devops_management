#!/bin/bash
# ============================================================
# Vagrant VM provisioner — 단일 노드 k3s 설치 (Apple Silicon)
# ============================================================
# PEP backend 컨테이너가 host.docker.internal:6443 으로 접속하므로
# TLS 인증서에 해당 SAN 을 포함시켜 설치한다.
set -euo pipefail

K3S_VERSION="${K3S_VERSION:-v1.30.5+k3s1}"

echo "[provision] k3s 설치 시작 (version=${K3S_VERSION})"

# 이미 설치돼 있으면 skip (vagrant provision 재실행 대비)
if command -v k3s >/dev/null 2>&1; then
  echo "[provision] k3s 이미 설치됨 — skip"
else
  # --tls-san host.docker.internal : Mac 호스트 경유 접속 시 TLS 검증 통과용
  # --write-kubeconfig-mode 644    : vagrant 사용자가 kubeconfig 읽기 가능
  # --disable traefik              : 테스트용이라 불필요한 컴포넌트 제거(가벼움)
  curl -sfL https://get.k3s.io | \
    INSTALL_K3S_VERSION="${K3S_VERSION}" \
    INSTALL_K3S_EXEC="--tls-san host.docker.internal --tls-san 127.0.0.1 --write-kubeconfig-mode 644 --disable traefik" \
    sh -
fi

echo "[provision] 노드 Ready 대기 중..."
for i in $(seq 1 30); do
  if k3s kubectl get nodes 2>/dev/null | grep -q ' Ready '; then
    break
  fi
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
