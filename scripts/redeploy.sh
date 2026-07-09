#!/bin/bash
set -euo pipefail

# ============================================
# 이미지 태그만 교체해서 재배포 (fast redeploy)
#
# kustomize/helm 전체 apply 없이, 이미 떠 있는 Deployment 의 컨테이너 이미지
# 태그만 kubectl set image 로 바꾸고 rollout restart 로 재기동시킨다.
#
# 두 가지 사용법:
#
# 1) 전체 이미지 참조를 직접 지정 (레지스트리/저장소를 바꿀 때 등):
#   scripts/redeploy.sh [-n <namespace>] <image> <deployment>:<container> [<deployment>:<container> ...]
#
# 2) -t 로 태그만 지정 (권장 — 저장소 경로는 클러스터에 이미 떠 있는 이미지에서 그대로 읽어와
#    태그만 바꿔치기하므로, 레지스트리 경로를 매번 입력할 필요가 없다):
#   scripts/redeploy.sh [-n <namespace>] -t <tag> <deployment>:<container> [<deployment>:<container> ...]
#
# -n 을 생략하면 현재 kubectl context 의 네임스페이스를 그대로 쓴다.
#
# 예 (전체 이미지 참조):
#   scripts/redeploy.sh -n k8s-monitor-prod ghcr.io/riverjin839/devops_management/backend:abc1234 \
#       prod-backend:backend prod-celery-worker:celery-worker prod-celery-beat:celery-beat
#
# 예 (태그만, 백엔드/프론트엔드 한 번에 — 각자 현재 저장소 경로를 유지한 채 태그만 교체):
#   scripts/redeploy.sh -n k8s-monitor-prod -t v1.4.0 \
#       prod-backend:backend prod-celery-worker:celery-worker prod-celery-beat:celery-beat \
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
사용법:
  전체 이미지 참조 지정: $(basename "$0") [-n <namespace>] <image> <deployment>:<container> [...]
  태그만 지정(권장):      $(basename "$0") [-n <namespace>] -t <tag> <deployment>:<container> [...]

인자:
  -n <namespace>          네임스페이스 (생략 시 현재 kubectl context 의 네임스페이스 사용)
  -t <tag>                태그만 교체 — 저장소 경로는 각 컨테이너의 현재 배포 이미지에서 그대로
                           읽어와 태그만 바꿔친다. 지정 시 image 인자는 생략(각 target 만 나열).
  image                   전체 이미지 참조 (예: ghcr.io/owner/repo/backend:abc1234). -t 미사용 시 필수.
  deployment:container    재배포할 Deployment 이름:컨테이너 이름 (여러 개 지정 가능)

예 (전체 이미지 참조):
  $(basename "$0") -n k8s-monitor-prod ghcr.io/riverjin839/devops_management/backend:abc1234 \\
      prod-backend:backend prod-celery-worker:celery-worker prod-celery-beat:celery-beat

예 (태그만, 백엔드/프론트엔드 한 번에):
  $(basename "$0") -n k8s-monitor-prod -t v1.4.0 \\
      prod-backend:backend prod-celery-worker:celery-worker prod-celery-beat:celery-beat \\
      prod-frontend:frontend
EOF
}

# 현재 배포된 이미지 참조에서 태그/다이제스트를 떼어낸 저장소 경로만 반환.
# 레지스트리에 포트가 있는 경우(host:5000/repo:tag)도 마지막 path segment 만 보고 판단해
# 포트를 태그로 착각하지 않는다.
strip_tag() {
    local ref="$1"
    local last_segment="${ref##*/}"
    if [[ "${last_segment}" == *@* ]]; then
        local digest_part="${last_segment#*@}"
        echo "${ref%@"${digest_part}"}"
    elif [[ "${last_segment}" == *:* ]]; then
        local tag_part="${last_segment##*:}"
        echo "${ref%:"${tag_part}"}"
    else
        echo "${ref}"
    fi
}

NAMESPACE=""
TAG=""
while [[ "${1:-}" == "-n" || "${1:-}" == "-t" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; do
    case "$1" in
        -n) NAMESPACE="$2"; shift 2 ;;
        -t) TAG="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
    esac
done

KCTL=(kubectl)
NS_FLAG=()
[[ -n "${NAMESPACE}" ]] && NS_FLAG=(-n "${NAMESPACE}")

if [[ -n "${TAG}" ]]; then
    IMAGE=""
else
    IMAGE="${1:-}"
    if [[ -z "${IMAGE}" ]]; then
        log_error "image 인자가 필요합니다 (또는 -t <tag> 로 태그만 지정)."
        usage
        exit 1
    fi
    shift
fi

if [[ $# -eq 0 ]]; then
    log_error "재배포할 <deployment>:<container> 를 최소 1개 이상 지정하세요."
    usage
    exit 1
fi
TARGETS=("$@")

echo ""
log_step "재배포 계획"
echo -e "  namespace : ${NAMESPACE:-<현재 context 기본 네임스페이스>}"
if [[ -n "${TAG}" ]]; then
    echo -e "  mode      : 태그만 교체 (-t ${TAG})"
else
    echo -e "  image     : ${IMAGE}"
fi
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

    if [[ -n "${TAG}" ]]; then
        current_image="$("${KCTL[@]}" get "deployment/${dep}" "${NS_FLAG[@]}" \
            -o jsonpath="{.spec.template.spec.containers[?(@.name=='${container}')].image}")"
        if [[ -z "${current_image}" ]]; then
            log_error "${dep} 에서 컨테이너 '${container}' 의 현재 이미지를 찾지 못했습니다 (이름 확인)."
            exit 1
        fi
        target_image="$(strip_tag "${current_image}"):${TAG}"
    else
        target_image="${IMAGE}"
    fi

    log_info "${dep}: ${container} → ${target_image}"
    "${KCTL[@]}" set image "deployment/${dep}" "${container}=${target_image}" "${NS_FLAG[@]}"
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
