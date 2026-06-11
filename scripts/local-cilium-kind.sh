#!/bin/bash
# ============================================================
# Mac 로컬 테스트 — kind 클러스터를 Cilium CNI 로 생성
# ============================================================
# 기본 CNI(kindnet) 를 비활성화하고 Cilium + Hubble 을 설치한다.
# PEP 의 Cilium/Hubble 딥 트러블슈팅 기능을 테스트하기 위한 용도.
#
# 사전: brew install kind kubectl cilium-cli
#
# 사용법:
#   bash scripts/local-cilium-kind.sh [클러스터이름]
#   CILIUM_VERSION=1.16.5 K8S_VERSION=v1.34.0 bash scripts/local-cilium-kind.sh test-a
set -euo pipefail

CLUSTER_NAME="${1:-test-a}"
K8S_VERSION="${K8S_VERSION:-v1.34.0}"
CILIUM_VERSION="${CILIUM_VERSION:-1.16.5}"

# ── 사전 도구 확인 ─────────────────────────────────────────
for c in kind kubectl cilium; do
  if ! command -v "${c}" >/dev/null 2>&1; then
    echo "ERROR: '${c}' 가 없습니다. 설치:" >&2
    echo "  brew install kind kubectl cilium-cli" >&2
    exit 1
  fi
done

# ── 기본 CNI 비활성화한 kind 클러스터 생성 ─────────────────
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "[1/4] kind '${CLUSTER_NAME}' 이미 존재 — 생성 skip"
else
  echo "[1/4] kind 클러스터 '${CLUSTER_NAME}' 생성 (disableDefaultCNI=true)..."
  cat <<EOF | kind create cluster --name "${CLUSTER_NAME}" --image "kindest/node:${K8S_VERSION}" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true   # kindnet 비활성화 → Cilium 이 CNI 담당
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
fi

kubectl config use-context "kind-${CLUSTER_NAME}"

# ── Cilium 설치 ────────────────────────────────────────────
echo "[2/4] Cilium ${CILIUM_VERSION} 설치 중..."
# kind 환경은 cilium CLI 가 자동 감지해 적절한 값으로 설치한다
cilium install --version "${CILIUM_VERSION}"

echo "[3/4] Cilium Ready 대기 중..."
cilium status --wait

# ── Hubble 활성화 (관찰성 / PEP 트레이스 기능용) ───────────
echo "[4/4] Hubble + UI 활성화 중..."
cilium hubble enable --ui

echo ""
cilium status
echo ""
kubectl get nodes -o wide
echo ""
echo "✓ Cilium kind 클러스터 '${CLUSTER_NAME}' 준비 완료"
echo "  PEP 등록: bash scripts/register-local-cluster.sh --name ${CLUSTER_NAME} --kind ${CLUSTER_NAME}"
