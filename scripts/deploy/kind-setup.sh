#!/bin/bash
set -euo pipefail

# ============================================
# Phase 1: kind 클러스터 로컬 개발 환경
# Mac/Linux에서 git clone 후 바로 실행
# ============================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CLUSTER_NAME="${CLUSTER_NAME:-k8s-monitor-dev}"
REGISTRY_NAME="${REGISTRY_NAME:-kind-registry}"
REGISTRY_PORT="${REGISTRY_PORT:-5001}"
NAMESPACE="k8s-monitor"

# K8s 버전 고정 (v1.35는 불안정하므로 v1.34 사용)
K8S_VERSION="${K8S_VERSION:-v1.34.0}"
KIND_NODE_IMAGE="kindest/node:${K8S_VERSION}"

# 상세 로그 (VERBOSE=1 또는 -v 옵션)
VERBOSE="${VERBOSE:-0}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# ============================================
# 로깅 함수
# ============================================
log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }
log_debug() {
    if [ "${VERBOSE}" = "1" ]; then
        echo -e "${GRAY}[DEBUG]${NC} $*"
    fi
}

# verbose 모드면 실행 명령도 출력
run_cmd() {
    log_debug "실행: $*"
    if [ "${VERBOSE}" = "1" ]; then
        "$@" 2>&1 | while IFS= read -r line; do
            echo -e "  ${GRAY}${line}${NC}"
        done
        return "${PIPESTATUS[0]}"
    else
        "$@"
    fi
}

# ============================================
# 에러 핸들링 - 실패 시 자동 디버그 정보 출력
# ============================================
on_error() {
    local exit_code=$?
    local line_no=$1
    echo ""
    log_error "스크립트 실패 (line ${line_no}, exit code ${exit_code})"
    echo ""
    echo -e "${RED}========================================${NC}"
    echo -e "${RED} 디버그 정보${NC}"
    echo -e "${RED}========================================${NC}"

    # kind 클러스터 존재하면 디버그 정보 수집
    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
        echo ""
        echo -e "${YELLOW}--- kind 노드 상태 ---${NC}"
        docker ps -a --filter "name=${CLUSTER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || true

        echo ""
        echo -e "${YELLOW}--- control-plane kubelet 로그 (최근 30줄) ---${NC}"
        docker exec "${CLUSTER_NAME}-control-plane" journalctl -u kubelet --no-pager -n 30 2>/dev/null || \
        docker logs "${CLUSTER_NAME}-control-plane" --tail 30 2>/dev/null || \
        echo "(kubelet 로그 수집 실패)"

        echo ""
        echo -e "${YELLOW}--- control-plane 컨테이너 로그 (최근 20줄) ---${NC}"
        docker logs "${CLUSTER_NAME}-control-plane" --tail 20 2>/dev/null || true

        echo ""
        echo -e "${YELLOW}--- kubectl cluster-info dump (요약) ---${NC}"
        kubectl cluster-info --context "kind-${CLUSTER_NAME}" 2>/dev/null || echo "(클러스터 미연결)"
    fi

    echo ""
    echo -e "${YELLOW}해결 방법:${NC}"
    echo "  1. kind delete cluster --name ${CLUSTER_NAME} 로 정리 후 재시도"
    echo "  2. VERBOSE=1 bash $0 ${1:-up} 로 상세 로그 확인"
    echo "  3. K8s 버전 변경: K8S_VERSION=v1.32.2 bash $0 up"
    echo "  4. Docker Desktop 리소스 확인 (CPU 4+, Memory 8GB+ 권장)"
    echo ""
}
trap 'on_error ${LINENO}' ERR

# ============================================
# -v 옵션 파싱
# ============================================
parse_opts() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -v|--verbose) VERBOSE=1; shift ;;
            *) break ;;
        esac
    done
    COMMAND="${1:-}"
    SUBARG="${2:-}"
}

# ============================================
# 사전 요구사항 확인
# ============================================
check_prerequisites() {
    log_step "필수 도구 확인 중..."
    local missing=()

    for cmd in docker kind kubectl; do
        if ! command -v "${cmd}" &>/dev/null; then
            missing+=("${cmd}")
        else
            local ver
            ver=$("${cmd}" version --client 2>/dev/null | head -1 || "${cmd}" --version 2>/dev/null | head -1)
            log_info "  ${cmd}: ${ver}"
        fi
    done

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "누락된 도구: ${missing[*]}"
        echo ""
        echo "설치 방법 (Mac):"
        echo "  brew install docker kind kubectl"
        echo "  또는 Docker Desktop 설치 후: brew install kind"
        exit 1
    fi

    # Docker 데몬 실행 확인
    if ! docker info &>/dev/null; then
        log_error "Docker 데몬이 실행되고 있지 않습니다."
        echo "  Docker Desktop을 시작해 주세요."
        exit 1
    fi

    # Docker 리소스 확인
    local docker_mem
    docker_mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo "0")
    local mem_gb=$(( docker_mem / 1024 / 1024 / 1024 ))
    if [ "${mem_gb}" -lt 4 ]; then
        log_warn "Docker 메모리: ${mem_gb}GB (8GB+ 권장, 3노드 kind 클러스터용)"
    else
        log_info "  Docker 메모리: ${mem_gb}GB"
    fi

    log_info "모든 도구 확인 완료"
    echo ""
}

# ============================================
# Local Registry 생성 (kind용)
# ============================================
create_local_registry() {
    if docker inspect "${REGISTRY_NAME}" &>/dev/null; then
        log_warn "로컬 레지스트리 이미 실행 중 (localhost:${REGISTRY_PORT})"
        return
    fi

    log_step "[1/5] 로컬 레지스트리 생성 중..."
    run_cmd docker run -d --restart=always \
        -p "127.0.0.1:${REGISTRY_PORT}:5000" \
        --network bridge \
        --name "${REGISTRY_NAME}" \
        registry:2

    log_info "로컬 레지스트리: localhost:${REGISTRY_PORT}"
}

# ============================================
# kind 클러스터 생성
# ============================================
create_cluster() {
    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
        log_warn "kind 클러스터 '${CLUSTER_NAME}' 이미 존재"
        kubectl cluster-info --context "kind-${CLUSTER_NAME}" 2>/dev/null || true
        return
    fi

    log_step "[2/5] kind 클러스터 생성 중..."
    log_info "  K8s 버전: ${K8S_VERSION}"
    log_info "  노드 이미지: ${KIND_NODE_IMAGE}"
    log_info "  구성: control-plane 1 + worker 2"
    echo ""

    # kind 클러스터 생성 (K8s 버전 고정)
    cat <<KINDEOF | kind create cluster --name "${CLUSTER_NAME}" --image "${KIND_NODE_IMAGE}" --config=- --verbosity=${VERBOSE_KIND_LEVEL:-0}
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:${REGISTRY_PORT}"]
      endpoint = ["http://${REGISTRY_NAME}:5000"]
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30080
        hostPort: 30080
        protocol: TCP
      - containerPort: 30800
        hostPort: 30800
        protocol: TCP
  - role: worker
  - role: worker
KINDEOF

    # 레지스트리를 kind 네트워크에 연결
    if ! docker network inspect kind 2>/dev/null | grep -q "${REGISTRY_NAME}"; then
        docker network connect kind "${REGISTRY_NAME}" 2>/dev/null || true
    fi

    # 레지스트리 ConfigMap (kind에서 로컬 레지스트리 인식용)
    kubectl apply -f - <<CMEOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${REGISTRY_PORT}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
CMEOF

    echo ""
    log_info "kind 클러스터 생성 완료"

    # 생성 후 노드 상태 출력
    echo ""
    kubectl get nodes -o wide
    echo ""
}

# ============================================
# 이미지 빌드 & 푸시
# ============================================
build_and_push() {
    log_step "[3/5] 이미지 빌드 및 레지스트리 푸시 중..."

    log_info "  → backend 빌드 중..."
    run_cmd docker build \
        -t "localhost:${REGISTRY_PORT}/k8s-monitor/backend:latest" \
        -f "${PROJECT_ROOT}/backend/Dockerfile" \
        "${PROJECT_ROOT}/backend"

    log_info "  → frontend 빌드 중..."
    run_cmd docker build --no-cache \
        -t "localhost:${REGISTRY_PORT}/k8s-monitor/frontend:latest" \
        -f "${PROJECT_ROOT}/frontend/Dockerfile" \
        "${PROJECT_ROOT}/frontend"

    log_info "  → 이미지 푸시 중..."
    run_cmd docker push "localhost:${REGISTRY_PORT}/k8s-monitor/backend:latest"
    run_cmd docker push "localhost:${REGISTRY_PORT}/k8s-monitor/frontend:latest"

    log_info "이미지 빌드 & 푸시 완료"

    # 빌드된 이미지 확인
    log_debug "빌드된 이미지:"
    docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" | grep k8s-monitor || true
    echo ""
}

# ============================================
# K8s 배포
# ============================================
deploy() {
    log_step "[4/5] K8s 배포 중..."

    kubectl config use-context "kind-${CLUSTER_NAME}"

    # 네임스페이스
    kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

    # kind 전용 overlay 사용 (namePrefix 없음, 로컬 레지스트리 이미지)
    log_info "  Kustomize 적용 중 (kind overlay)..."
    run_cmd kubectl apply -k "${PROJECT_ROOT}/k8s/overlays/kind"

    log_info "배포 완료"
    echo ""
}

# ============================================
# 상태 확인 및 대기
# ============================================
wait_and_verify() {
    log_step "[5/5] 배포 확인 중..."
    echo ""

    local ns="${NAMESPACE}"

    log_info "Pod 상태 대기 중 (최대 3분)..."
    kubectl wait --for=condition=ready pod \
        -l app.kubernetes.io/part-of=k8s-daily-monitor \
        -n "${ns}" --timeout=180s 2>/dev/null || true

    echo ""
    echo -e "${CYAN}--- Pod 상태 ---${NC}"
    kubectl get pods -n "${ns}" -o wide
    echo ""

    # 비정상 Pod 자동 감지 & 로그 출력
    local bad_pods
    bad_pods=$(kubectl get pods -n "${ns}" --no-headers 2>/dev/null | grep -v "Running\|Completed" || true)
    if [ -n "${bad_pods}" ]; then
        echo -e "${YELLOW}--- 비정상 Pod 감지 ---${NC}"
        echo "${bad_pods}"
        echo ""
        echo -e "${YELLOW}--- 비정상 Pod describe ---${NC}"
        kubectl get pods -n "${ns}" --no-headers | grep -v "Running\|Completed" | awk '{print $1}' | while read -r pod; do
            echo -e "${RED}[${pod}]${NC}"
            kubectl describe pod "${pod}" -n "${ns}" 2>/dev/null | tail -20
            echo ""
        done
    fi

    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN} 접속 정보${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "  Frontend:  ${YELLOW}http://localhost:30080${NC}"
    echo -e "  Backend:   ${YELLOW}http://localhost:30800${NC}"
    echo -e "  API Docs:  ${YELLOW}http://localhost:30800/docs${NC}"
    echo ""
    echo -e "  kubectl:   ${CYAN}kubectl get all -n ${ns}${NC}"
    echo -e "  로그:      ${CYAN}kubectl logs -f deploy/backend -n ${ns}${NC}"
    echo ""
}

# ============================================
# 클러스터 삭제
# ============================================
destroy() {
    log_warn "kind 클러스터 삭제 중..."
    kind delete cluster --name "${CLUSTER_NAME}"
    docker rm -f "${REGISTRY_NAME}" 2>/dev/null || true
    log_info "정리 완료"
}

# ============================================
# 이미지만 재빌드 + 재배포 (코드 수정 후)
# ============================================
reload() {
    log_step "이미지 재빌드 & 재배포 중..."
    build_and_push

    local ns="${NAMESPACE}"

    # kustomize 재적용 (imagePullPolicy: Always 보장)
    log_info "  Kustomize 재적용 중..."
    run_cmd kubectl apply -k "${PROJECT_ROOT}/k8s/overlays/kind"

    # 노드에 캐시된 이미지 제거 후 재시작 (latest 태그 갱신 보장)
    log_info "  Pod 재시작 중 (이미지 재pull 강제)..."
    kubectl rollout restart deployment/backend -n "${ns}"
    kubectl rollout restart deployment/frontend -n "${ns}"
    kubectl rollout restart deployment/celery-worker -n "${ns}"
    kubectl rollout restart deployment/celery-beat -n "${ns}"

    log_info "롤아웃 대기 중..."
    kubectl rollout status deployment/frontend -n "${ns}" --timeout=120s || true
    kubectl rollout status deployment/backend -n "${ns}" --timeout=120s || true

    echo ""
    kubectl get pods -n "${ns}"
    log_info "재배포 완료"
}

# ============================================
# 디버그 정보 수집
# ============================================
debug_info() {
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN} 디버그 정보 수집${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""

    echo -e "${YELLOW}--- Docker 상태 ---${NC}"
    docker info --format "OS: {{.OperatingSystem}} | CPUs: {{.NCPU}} | Memory: {{.MemTotal}}" 2>/dev/null || true
    echo ""

    echo -e "${YELLOW}--- kind 클러스터 ---${NC}"
    kind get clusters 2>/dev/null || echo "(없음)"
    echo ""

    echo -e "${YELLOW}--- kind 노드 컨테이너 ---${NC}"
    docker ps -a --filter "name=${CLUSTER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || true
    echo ""

    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
        echo -e "${YELLOW}--- K8s 노드 ---${NC}"
        kubectl get nodes -o wide --context "kind-${CLUSTER_NAME}" 2>/dev/null || true
        echo ""

        local ns="${NAMESPACE}"
        echo -e "${YELLOW}--- Pod 상태 ---${NC}"
        kubectl get pods -n "${ns}" -o wide 2>/dev/null || echo "(네임스페이스 없음)"
        echo ""

        echo -e "${YELLOW}--- 이벤트 (최근 20개) ---${NC}"
        kubectl get events -n "${ns}" --sort-by='.lastTimestamp' 2>/dev/null | tail -20 || true
        echo ""

        echo -e "${YELLOW}--- control-plane kubelet 상태 ---${NC}"
        docker exec "${CLUSTER_NAME}-control-plane" systemctl status kubelet --no-pager -l 2>/dev/null | head -20 || \
        echo "(kubelet 상태 확인 불가)"
        echo ""

        echo -e "${YELLOW}--- control-plane kubelet 로그 (최근 50줄) ---${NC}"
        docker exec "${CLUSTER_NAME}-control-plane" journalctl -u kubelet --no-pager -n 50 2>/dev/null || \
        echo "(kubelet 로그 확인 불가)"
    fi
}

# ============================================
# 메인
# ============================================

# -v 옵션 처리
ARGS=("$@")
VERBOSE_FLAG=0
POSITIONAL=()
for arg in "${ARGS[@]}"; do
    case "${arg}" in
        -v|--verbose) VERBOSE=1; VERBOSE_FLAG=1 ;;
        *) POSITIONAL+=("${arg}") ;;
    esac
done

# verbose면 kind도 상세 로그
if [ "${VERBOSE}" = "1" ]; then
    VERBOSE_KIND_LEVEL=6
    echo -e "${GRAY}[VERBOSE 모드 활성화]${NC}"
else
    VERBOSE_KIND_LEVEL=0
fi

COMMAND="${POSITIONAL[0]:-}"
SUBARG="${POSITIONAL[1]:-}"

case "${COMMAND}" in
    up)
        check_prerequisites
        create_local_registry
        create_cluster
        build_and_push
        deploy
        wait_and_verify
        ;;
    build)
        build_and_push
        ;;
    deploy)
        deploy
        wait_and_verify
        ;;
    reload)
        reload
        ;;
    status)
        kubectl get all -n "${NAMESPACE}"
        echo ""
        kubectl get pods -n "${NAMESPACE}" -o wide
        ;;
    logs)
        kubectl logs -f "deploy/${SUBARG:-backend}" -n "${NAMESPACE}"
        ;;
    debug)
        debug_info
        ;;
    destroy)
        destroy
        ;;
    *)
        echo -e "${GREEN}========================================${NC}"
        echo -e "${GREEN} K8s Daily Monitor - kind 로컬 개발${NC}"
        echo -e "${GREEN}========================================${NC}"
        echo ""
        echo "사용법: $0 [-v] {up|build|deploy|reload|status|logs|debug|destroy}"
        echo ""
        echo "  up       - 전체 환경 구축 (kind + 빌드 + 배포)"
        echo "  build    - 이미지 빌드만"
        echo "  deploy   - K8s 배포만"
        echo "  reload   - 코드 수정 후 재빌드 & 재배포"
        echo "  status   - Pod 상태 확인"
        echo "  logs     - 로그 확인 (예: $0 logs backend)"
        echo "  debug    - 디버그 정보 전체 수집"
        echo "  destroy  - 전체 환경 삭제"
        echo ""
        echo "옵션:"
        echo "  -v, --verbose   상세 로그 출력 (kind/docker 내부 로그 포함)"
        echo ""
        echo "환경변수:"
        echo "  K8S_VERSION     K8s 버전 (기본: v1.34.0)"
        echo "  VERBOSE         상세 로그 (기본: 0, 활성화: 1)"
        echo "  CLUSTER_NAME    kind 클러스터 이름 (기본: k8s-monitor-dev)"
        echo ""
        echo "일반적인 흐름:"
        echo "  1. $0 up                       # 최초 1회"
        echo "  2. (코드 수정)"
        echo "  3. $0 reload                   # 수정 후 재배포"
        echo "  4. $0 destroy                  # 테스트 완료 후 정리"
        echo ""
        echo "에러 발생 시:"
        echo "  $0 -v up                       # 상세 로그로 재시도"
        echo "  $0 debug                       # 디버그 정보 수집"
        echo "  K8S_VERSION=v1.32.2 $0 up      # K8s 버전 변경"
        echo ""
        exit 1
        ;;
esac
