#!/bin/bash
set -euo pipefail

# ============================================
# 이미지 태그만 교체해서 재배포 (fast redeploy)
#
# kustomize/helm 전체 apply 없이, 이미 떠 있는 Deployment 의 컨테이너 이미지
# 태그만 kubectl set image 로 바꾸고 rollout restart 로 재기동시킨다.
#
# 사용법:
#   scripts/redeploy.sh [-n <namespace>] <image> <deployment>:<container> [<deployment>:<container> ...]
#
# -n 을 생략하면 현재 kubectl context 의 네임스페이스를 그대로 쓴다.
#
# 예:
#   scripts/redeploy.sh -n k8s-monitor-prod ghcr.io/riverjin839/devops_management/backend:abc1234 \
#       prod-backend:backend prod-celery-worker:celery-worker prod-celery-beat:celery-beat
#
#   scripts/redeploy.sh -n k8s-monitor-prod ghcr.io/riverjin839/devops_management/frontend:abc1234 \
#       prod-frontend:frontend
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step() { echo -e "${CYAN}[STEP]${NC}  $*"; }

usage() {
    cat <<EOF
사용법: $(basename "$0") [-n <namespace>] <image> <deployment>:<container> [<deployment>:<container> ...]

인자:
  -n <namespace>          네임스페이스 (생략 시 현재 kubectl context 의 네임스페이스 사용)
  image                   전체 이미지 참조 (예: ghcr.io/owner/repo/backend:abc1234)
  deployment:container    재배포할 Deployment 이름:컨테이너 이름 (여러 개 지정 가능)

예:
  $(basename "$0") -n k8s-monitor-prod ghcr.io/riverjin839/devops_management/backend:abc1234 \\
      prod-backend:backend prod-celery-worker:celery-worker prod-celery-beat:celery-beat
EOF
}

NAMESPACE=""
while [[ "${1:-}" == "-n" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; do
    case "$1" in
        -n) NAMESPACE="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
    esac
done

IMAGE="${1:-}"
if [[ -z "${IMAGE}" ]]; then
    log_error "image 인자가 필요합니다."
    usage
    exit 1
fi
shift

if [[ $# -eq 0 ]]; then
    log_error "재배포할 <deployment>:<container> 를 최소 1개 이상 지정하세요."
    usage
    exit 1
fi
TARGETS=("$@")

KCTL=(kubectl)
NS_FLAG=()
[[ -n "${NAMESPACE}" ]] && NS_FLAG=(-n "${NAMESPACE}")

echo ""
log_step "재배포 계획"
echo -e "  namespace : ${NAMESPACE:-<현재 context 기본 네임스페이스>}"
echo -e "  image     : ${IMAGE}"
for t in "${TARGETS[@]}"; do
    echo -e "  target    : ${t}"
done
echo ""

# 주의: 태그가 latest 처럼 변하지 않는 문자열이면 `kubectl set image` 는 이미지 문자열이
# 그대로라 아무 변화가 없고 파드가 재시작/재-pull 되지 않는다. 그래서 set image 뒤에
# 항상 rollout restart 를 함께 호출해 태그 변경 여부와 무관하게 항상 새로 pull 하도록 한다.
for t in "${TARGETS[@]}"; do
    dep="${t%%:*}"
    container="${t#*:}"
    if [[ -z "${dep}" || -z "${container}" || "${dep}" == "${t}" ]]; then
        log_error "형식이 잘못됨: '${t}' (deployment:container 형태여야 함)"
        exit 1
    fi
    log_info "${dep}: ${container} → ${IMAGE}"
    "${KCTL[@]}" set image "deployment/${dep}" "${container}=${IMAGE}" "${NS_FLAG[@]}"
    "${KCTL[@]}" rollout restart "deployment/${dep}" "${NS_FLAG[@]}"
done

log_step "롤아웃 대기 중..."
for t in "${TARGETS[@]}"; do
    dep="${t%%:*}"
    if "${KCTL[@]}" rollout status "deployment/${dep}" "${NS_FLAG[@]}"; then
        log_info "${dep} 롤아웃 완료"
    else
        log_error "${dep} 롤아웃 실패/타임아웃"
        exit 1
    fi
done

echo ""
log_info "재배포 완료"
