#!/bin/bash
set -euo pipefail

# ============================================
# 이미지 태그만 교체해서 재배포 (fast redeploy)
#
# kustomize/helm 전체 apply 없이, 이미 떠 있는 Deployment 의 컨테이너 이미지
# 태그만 kubectl set image 로 바꾸고 롤아웃을 기다린다. CI(cd.yml)가 만드는
# ghcr.io/<owner>/<repo>/{backend,frontend}:<tag> 이미지를 그대로 쓰는 것을 전제로 한다.
#
# 사용법:
#   scripts/redeploy.sh <dev|prod|kind> <tag> [옵션]
#
# 예:
#   scripts/redeploy.sh dev abc1234
#   scripts/redeploy.sh prod v1.2.0 --only backend,frontend
#   scripts/redeploy.sh dev latest --dry-run
# ============================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }

on_error() {
    local exit_code=$? line_no=$1
    log_error "스크립트 실패 (line ${line_no}, exit code ${exit_code})"
    exit "${exit_code}"
}
trap 'on_error ${LINENO}' ERR

usage() {
    cat <<EOF
사용법: $(basename "$0") <dev|prod|kind> <tag> [옵션]

인자:
  env               dev | prod | kind   (네임스페이스/리소스 이름 프리픽스 결정)
  tag               이미지 태그 (git short sha, vX.Y.Z, latest 등)

옵션:
  --only <목록>     콤마로 구분한 컴포넌트만 재배포 (기본: 전체)
                    backend,frontend,celery-worker,celery-beat
  --registry <repo> 이미지 레지스트리/레포 베이스. 기본: ghcr.io/<owner>/<repo> (git remote 에서 추론)
  --context <ctx>   kubectl context 지정 (기본: 현재 컨텍스트)
  --timeout <sec>   rollout status 대기 타임아웃 초 (기본: 300)
  -y, --yes         확인 프롬프트 생략 (prod 자동화용)
  --dry-run         실제로 적용하지 않고 실행할 명령만 출력
  -h, --help        도움말

예:
  $(basename "$0") dev abc1234
  $(basename "$0") prod v1.2.0 --only backend,frontend
  $(basename "$0") dev latest --dry-run
EOF
}

# ── 인자 파싱 ─────────────────────────────────────────────
ENV_NAME="${1:-}"
TAG="${2:-}"
if [[ -z "${ENV_NAME}" || "${ENV_NAME}" == "-h" || "${ENV_NAME}" == "--help" ]]; then
    usage
    exit 0
fi
if [[ -z "${TAG}" ]]; then
    log_error "tag 인자가 필요합니다."
    usage
    exit 1
fi
shift 2

ONLY=""
REGISTRY_OVERRIDE=""
CONTEXT=""
TIMEOUT=300
ASSUME_YES=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --only)     ONLY="$2"; shift 2 ;;
        --registry) REGISTRY_OVERRIDE="$2"; shift 2 ;;
        --context)  CONTEXT="$2"; shift 2 ;;
        --timeout)  TIMEOUT="$2"; shift 2 ;;
        -y|--yes)   ASSUME_YES=1; shift ;;
        --dry-run)  DRY_RUN=1; shift ;;
        -h|--help)  usage; exit 0 ;;
        *) log_error "알 수 없는 옵션: $1"; usage; exit 1 ;;
    esac
done

# ── env → 네임스페이스 / 리소스 이름 프리픽스 (k8s/overlays/{dev,prod} 와 동일) ──
case "${ENV_NAME}" in
    dev)  NAMESPACE="k8s-monitor-dev";  PREFIX="dev-"  ;;
    prod) NAMESPACE="k8s-monitor-prod"; PREFIX="prod-" ;;
    kind) NAMESPACE="k8s-monitor";      PREFIX=""      ;;
    *) log_error "env 는 dev|prod|kind 중 하나여야 합니다: '${ENV_NAME}'"; exit 1 ;;
esac

# ── 이미지 레지스트리 베이스 — git remote 에서 <owner>/<repo> 추론 (cd.yml 과 동일 규칙) ──
if [[ -n "${REGISTRY_OVERRIDE}" ]]; then
    REGISTRY_BASE="${REGISTRY_OVERRIDE}"
else
    ORIGIN_URL="$(git -C "${PROJECT_ROOT}" config --get remote.origin.url 2>/dev/null || true)"
    # git@host:owner/repo.git / https://host/owner/repo.git 등 어떤 형태든 마지막 두 세그먼트(owner/repo)만 추출.
    OWNER_REPO="$(echo "${ORIGIN_URL}" | sed -E 's#\.git$##' | grep -oE '[^/:]+/[^/:]+$' || true)"
    if [[ -z "${OWNER_REPO}" ]]; then
        log_error "git remote 에서 owner/repo 를 추론하지 못했습니다. --registry 로 직접 지정하세요 (예: ghcr.io/owner/repo)."
        exit 1
    fi
    REGISTRY_BASE="ghcr.io/${OWNER_REPO,,}"
fi

BACKEND_IMAGE="${REGISTRY_BASE}/backend:${TAG}"
FRONTEND_IMAGE="${REGISTRY_BASE}/frontend:${TAG}"

# ── 컴포넌트 정의: "<deployment 접미사>:<컨테이너명>:<이미지>" ──
# celery-worker/celery-beat 는 backend 이미지를 재사용한다 (k8s/base/celery/*.yaml 과 동일).
ALL_COMPONENTS=(
    "backend:backend:${BACKEND_IMAGE}"
    "frontend:frontend:${FRONTEND_IMAGE}"
    "celery-worker:celery-worker:${BACKEND_IMAGE}"
    "celery-beat:celery-beat:${BACKEND_IMAGE}"
)

if [[ -n "${ONLY}" ]]; then
    SELECTED=()
    IFS=',' read -ra WANT <<< "${ONLY}"
    for c in "${ALL_COMPONENTS[@]}"; do
        name="${c%%:*}"
        for w in "${WANT[@]}"; do
            [[ "${name}" == "${w}" ]] && SELECTED+=("${c}")
        done
    done
    if [[ ${#SELECTED[@]} -eq 0 ]]; then
        log_error "--only 에 매칭되는 컴포넌트가 없습니다: '${ONLY}'"
        exit 1
    fi
else
    SELECTED=("${ALL_COMPONENTS[@]}")
fi

KCTL=(kubectl)
[[ -n "${CONTEXT}" ]] && KCTL+=(--context "${CONTEXT}")

CUR_CONTEXT="${CONTEXT:-$(kubectl config current-context 2>/dev/null || echo '(알 수 없음)')}"

# ── 요약 출력 ─────────────────────────────────────────────
echo ""
log_step "재배포 계획"
echo -e "  env         : ${ENV_NAME}  (namespace: ${NAMESPACE})"
echo -e "  kube context: ${CUR_CONTEXT}"
echo -e "  tag         : ${TAG}"
echo ""
printf "  %-16s %-24s %-20s %s\n" "컴포넌트" "deployment" "container" "image"
for c in "${SELECTED[@]}"; do
    IFS=':' read -r dep container image <<< "${c}"
    printf "  %-16s %-24s %-20s %s\n" "${dep}" "${PREFIX}${dep}" "${container}" "${image}"
done
echo ""

if [[ "${DRY_RUN}" -eq 1 ]]; then
    log_warn "--dry-run 모드 — 아래 명령만 출력하고 실행하지 않습니다."
    for c in "${SELECTED[@]}"; do
        IFS=':' read -r dep container image <<< "${c}"
        echo "  ${KCTL[*]} set image deployment/${PREFIX}${dep} ${container}=${image} -n ${NAMESPACE}"
    done
    for c in "${SELECTED[@]}"; do
        IFS=':' read -r dep _ _ <<< "${c}"
        echo "  ${KCTL[*]} rollout status deployment/${PREFIX}${dep} -n ${NAMESPACE} --timeout=${TIMEOUT}s"
    done
    exit 0
fi

if [[ "${ASSUME_YES}" -ne 1 ]]; then
    if [[ "${ENV_NAME}" == "prod" ]]; then
        log_warn "prod 네임스페이스(${NAMESPACE})에 재배포합니다."
    fi
    read -rp "계속하시겠습니까? [y/N] " CONFIRM
    if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
        log_info "취소했습니다."
        exit 0
    fi
fi

# ── 이미지 태그 교체 ──────────────────────────────────────
log_step "이미지 태그 교체 중..."
for c in "${SELECTED[@]}"; do
    IFS=':' read -r dep container image <<< "${c}"
    name="${PREFIX}${dep}"
    if ! "${KCTL[@]}" get deployment "${name}" -n "${NAMESPACE}" >/dev/null 2>&1; then
        log_warn "  ${name} — 네임스페이스 ${NAMESPACE} 에 존재하지 않음, 건너뜀"
        continue
    fi
    log_info "  ${name}: ${container} → ${image}"
    "${KCTL[@]}" set image "deployment/${name}" "${container}=${image}" -n "${NAMESPACE}"
done

# ── 롤아웃 대기 ───────────────────────────────────────────
log_step "롤아웃 대기 중 (timeout ${TIMEOUT}s)..."
for c in "${SELECTED[@]}"; do
    IFS=':' read -r dep _ _ <<< "${c}"
    name="${PREFIX}${dep}"
    if ! "${KCTL[@]}" get deployment "${name}" -n "${NAMESPACE}" >/dev/null 2>&1; then
        continue
    fi
    if "${KCTL[@]}" rollout status "deployment/${name}" -n "${NAMESPACE}" --timeout="${TIMEOUT}s"; then
        log_info "  ${name} 롤아웃 완료"
    else
        log_error "  ${name} 롤아웃 실패/타임아웃"
        exit 1
    fi
done

echo ""
log_info "재배포 완료 (${ENV_NAME} / ${TAG})"
