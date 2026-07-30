#!/bin/bash
set -e

# ============================================
# 폐쇄망 K8s 배포 스크립트
# ============================================

# 프로젝트 루트 경로 (스크립트 위치 기준으로 상위 디렉토리)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 기본값
NAMESPACE="${NAMESPACE:-k8s-monitor}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# 인클러스터 자체 LLM(Ollama) 이미지 — 모델이 pre-baked 된 커스텀 이미지.
# helm/k8s-daily-monitor/values.yaml 의 ollama.image 기본값과 반드시 일치시킬 것.
# SKIP_OLLAMA=1 로 이 이미지의 미러링/저장 단계를 건너뛸 수 있다(사내 LLM 프로필만
# 쓰거나, docs/AIRGAP_LLM_NEXUS.md 의 다른 방법으로 이미 반입한 경우).
OLLAMA_IMAGE="${OLLAMA_IMAGE:-ghcr.io/riverjin839/ollama-qwen2.5-coder}"
OLLAMA_TAG="${OLLAMA_TAG:-7b}"
SKIP_OLLAMA="${SKIP_OLLAMA:-}"

# 폐쇄망 Nexus 프록시 설정 (선택, backend+frontend 모두 Alpine 기반)
# ALPINE_MIRROR_URL - Alpine apk 미러 (예: http://nexus:8081/repository/alpine-proxy)
# PIP_INDEX_URL     - PyPI 프록시 (예: http://nexus:8081/repository/pypi-proxy/simple)
# PIP_TRUSTED_HOST  - pip trusted-host (예: nexus)
# NPM_REGISTRY      - npm 프록시 (예: http://nexus:8081/repository/npm-proxy/)
ALPINE_MIRROR_URL="${ALPINE_MIRROR_URL:-}"
PIP_INDEX_URL="${PIP_INDEX_URL:-}"
PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST:-}"
NPM_REGISTRY="${NPM_REGISTRY:-}"

# 색상 출력
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ============================================
# 컨테이너 런타임 선택
# ============================================
select_container_cli() {
    if [ -n "${CTR_CLI:-}" ]; then
        # 환경변수로 이미 지정된 경우
        if ! command -v "${CTR_CLI}" &>/dev/null; then
            echo -e "${RED}오류: ${CTR_CLI} 명령어를 찾을 수 없습니다.${NC}"
            exit 1
        fi
        echo -e "${GREEN}컨테이너 런타임: ${YELLOW}${CTR_CLI}${NC}"
        return
    fi

    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN} 컨테이너 런타임 선택${NC}"
    echo -e "${CYAN}========================================${NC}"

    # 사용 가능한 CLI 탐지
    local available=()
    for cli in podman nerdctl docker; do
        if command -v "${cli}" &>/dev/null; then
            available+=("${cli}")
        fi
    done

    if [ ${#available[@]} -eq 0 ]; then
        echo -e "${RED}오류: 사용 가능한 컨테이너 런타임이 없습니다.${NC}"
        echo -e "${RED}podman, nerdctl, docker 중 하나를 설치해 주세요.${NC}"
        exit 1
    fi

    echo ""
    echo -e "사용 가능한 컨테이너 런타임:"
    for i in "${!available[@]}"; do
        local ver
        ver=$("${available[$i]}" --version 2>/dev/null | head -1)
        echo -e "  ${YELLOW}$((i+1)))${NC} ${available[$i]}  ${CYAN}(${ver})${NC}"
    done
    echo ""

    if [ ${#available[@]} -eq 1 ]; then
        CTR_CLI="${available[0]}"
        echo -e "자동 선택: ${YELLOW}${CTR_CLI}${NC}"
    else
        while true; do
            read -rp "선택 [1-${#available[@]}] (기본: 1): " choice
            choice="${choice:-1}"
            if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#available[@]} ]; then
                CTR_CLI="${available[$((choice-1))]}"
                break
            fi
            echo -e "${RED}잘못된 입력입니다.${NC}"
        done
    fi

    echo -e "${GREEN}선택됨: ${YELLOW}${CTR_CLI}${NC}"
    echo ""
}

# ============================================
# 레지스트리 정보 입력
# ============================================
input_registry_info() {
    if [ -n "${REGISTRY:-}" ]; then
        echo -e "레지스트리: ${YELLOW}${REGISTRY}${NC}"
        return
    fi

    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN} Private 레지스트리 설정${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""

    read -rp "레지스트리 주소 (예: harbor.local:5000): " REGISTRY
    if [ -z "${REGISTRY}" ]; then
        echo -e "${RED}오류: 레지스트리 주소를 입력해 주세요.${NC}"
        exit 1
    fi

    echo -e "${GREEN}레지스트리: ${YELLOW}${REGISTRY}${NC}"
    echo ""
}

# ============================================
# 레지스트리 로그인
# ============================================
registry_login() {
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN} 레지스트리 로그인${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""

    # 이미 로그인 되어있는지 확인 시도
    if [ -n "${REGISTRY_USER:-}" ] && [ -n "${REGISTRY_PASS:-}" ]; then
        echo -e "환경변수에서 계정정보 사용: ${YELLOW}${REGISTRY_USER}${NC}"
        echo "${REGISTRY_PASS}" | ${CTR_CLI} login "${REGISTRY}" -u "${REGISTRY_USER}" --password-stdin
        echo -e "${GREEN}✓ 로그인 성공${NC}"
        return
    fi

    read -rp "로그인이 필요합니까? [Y/n]: " need_login
    need_login="${need_login:-Y}"

    if [[ "${need_login}" =~ ^[Yy]$ ]]; then
        read -rp "사용자명: " REGISTRY_USER
        read -rsp "비밀번호: " REGISTRY_PASS
        echo ""

        if [ -z "${REGISTRY_USER}" ] || [ -z "${REGISTRY_PASS}" ]; then
            echo -e "${RED}오류: 사용자명과 비밀번호를 입력해 주세요.${NC}"
            exit 1
        fi

        echo "${REGISTRY_PASS}" | ${CTR_CLI} login "${REGISTRY}" -u "${REGISTRY_USER}" --password-stdin
        echo -e "${GREEN}✓ 로그인 성공${NC}"
    else
        echo -e "${YELLOW}로그인 건너뜀${NC}"
    fi
    echo ""
}

# ============================================
# 설정 요약 출력
# ============================================
print_config() {
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN} K8s Daily Monitor - 폐쇄망 배포${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "  프로젝트 경로 : ${YELLOW}${PROJECT_ROOT}${NC}"
    echo -e "  컨테이너 CLI  : ${YELLOW}${CTR_CLI}${NC}"
    echo -e "  Registry      : ${YELLOW}${REGISTRY}${NC}"
    echo -e "  Namespace     : ${YELLOW}${NAMESPACE}${NC}"
    echo -e "  Image Tag     : ${YELLOW}${IMAGE_TAG}${NC}"
    if [ -n "${ALPINE_MIRROR_URL}" ]; then
        echo -e "  Alpine Mirror : ${YELLOW}${ALPINE_MIRROR_URL}${NC}"
    fi
    if [ -n "${PIP_INDEX_URL}" ]; then
        echo -e "  PyPI Proxy    : ${YELLOW}${PIP_INDEX_URL}${NC}"
    fi
    if [ -n "${NPM_REGISTRY}" ]; then
        echo -e "  NPM Registry  : ${YELLOW}${NPM_REGISTRY}${NC}"
    fi
    if [ -n "${SKIP_OLLAMA}" ]; then
        echo -e "  Ollama 이미지 : ${YELLOW}건너뜀 (SKIP_OLLAMA=1)${NC}"
    else
        echo -e "  Ollama 이미지 : ${YELLOW}${OLLAMA_IMAGE}:${OLLAMA_TAG}${NC}"
    fi
    echo ""
}

# ============================================
# Ollama(자체 LLM) 이미지 미러링 — build 가 아니라 pull+retag.
# 모델이 이미 이미지에 구워져 있으므로 backend/frontend 처럼 빌드하지 않는다.
# 이 함수를 호출하는 쪽(build_images/save_images)이 각자의 흐름에 맞게 pull 시점을
# 정한다 — 여기서는 pull 성공 여부만 판단해 이후 tag 를 건다.
# ============================================
_ollama_pull_ok=""
pull_ollama_image() {
    if [ -n "${SKIP_OLLAMA}" ]; then
        echo -e "  ${YELLOW}Ollama 이미지 미러링 건너뜀 (SKIP_OLLAMA=1)${NC}"
        return
    fi
    echo -e "  → Ollama 이미지 pull 중 (${OLLAMA_IMAGE}:${OLLAMA_TAG})..."
    if ${CTR_CLI} pull "${OLLAMA_IMAGE}:${OLLAMA_TAG}"; then
        ${CTR_CLI} tag "${OLLAMA_IMAGE}:${OLLAMA_TAG}" "${REGISTRY}/ollama-qwen2.5-coder:${OLLAMA_TAG}"
        _ollama_pull_ok=1
    else
        echo -e "  ${YELLOW}⚠ Ollama 이미지 pull 실패 — 이 빌드 네트워크에서 ghcr.io 에 접근할 수 없다면${NC}"
        echo -e "  ${YELLOW}  docs/AIRGAP_LLM_NEXUS.md 의 Nexus 경유 방법을 사용하거나 SKIP_OLLAMA=1 로 건너뛰세요.${NC}"
    fi
}

# ============================================
# 1. 컨테이너 이미지 빌드
# ============================================
build_images() {
    echo -e "${GREEN}[1/4] 컨테이너 이미지 빌드 중...${NC}"
    echo ""

    # 폐쇄망 프록시 build-arg 구성 (backend + frontend 모두 Alpine)
    local backend_args=()
    if [ -n "${ALPINE_MIRROR_URL}" ]; then
        backend_args+=(--build-arg "ALPINE_MIRROR_URL=${ALPINE_MIRROR_URL}")
    fi
    if [ -n "${PIP_INDEX_URL}" ]; then
        backend_args+=(--build-arg "PIP_INDEX_URL=${PIP_INDEX_URL}")
    fi
    if [ -n "${PIP_TRUSTED_HOST}" ]; then
        backend_args+=(--build-arg "PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}")
    fi

    local frontend_args=()
    if [ -n "${NPM_REGISTRY}" ]; then
        frontend_args+=(--build-arg "NPM_REGISTRY=${NPM_REGISTRY}")
    fi
    if [ -n "${ALPINE_MIRROR_URL}" ]; then
        frontend_args+=(--build-arg "ALPINE_MIRROR_URL=${ALPINE_MIRROR_URL}")
    fi

    echo -e "  → backend 빌드 중..."
    ${CTR_CLI} build \
        "${backend_args[@]}" \
        -t "${REGISTRY}/k8s-monitor/backend:${IMAGE_TAG}" \
        -f "${PROJECT_ROOT}/backend/Dockerfile" \
        "${PROJECT_ROOT}/backend"

    echo ""
    echo -e "  → frontend 빌드 중..."
    ${CTR_CLI} build \
        "${frontend_args[@]}" \
        -t "${REGISTRY}/k8s-monitor/frontend:${IMAGE_TAG}" \
        -f "${PROJECT_ROOT}/frontend/Dockerfile" \
        "${PROJECT_ROOT}/frontend"

    echo ""
    echo -e "  → Ollama(자체 LLM) 이미지 미러링 중..."
    pull_ollama_image

    echo ""
    echo -e "${GREEN}✓ 이미지 빌드 완료${NC}"
    echo ""
}

# ============================================
# 2. 이미지 푸시
# ============================================
push_images() {
    echo -e "${GREEN}[2/4] 이미지 푸시 중...${NC}"

    ${CTR_CLI} push "${REGISTRY}/k8s-monitor/backend:${IMAGE_TAG}"
    ${CTR_CLI} push "${REGISTRY}/k8s-monitor/frontend:${IMAGE_TAG}"

    # Monitoring stack images
    for img in prom/prometheus:v2.51.0 grafana/grafana:10.4.0 kube-state-metrics/kube-state-metrics:v2.12.0 prom/node-exporter:v1.7.0; do
        ${CTR_CLI} push "${REGISTRY}/${img}" 2>/dev/null || true
    done

    # Ollama(자체 LLM) — build 단계에서 미러링된 태그가 있을 때만 푸시.
    # 없으면(SKIP_OLLAMA 또는 pull 실패) 조용히 건너뛴다: 사내 LLM 프로필만 쓰는
    # 배포도 유효한 구성이라 이 단계 실패로 전체 push 를 막지 않는다.
    if [ -z "${SKIP_OLLAMA}" ]; then
        if ${CTR_CLI} push "${REGISTRY}/ollama-qwen2.5-coder:${OLLAMA_TAG}" 2>/dev/null; then
            echo -e "  ${GREEN}✓ Ollama 이미지 푸시 완료${NC}"
        else
            echo -e "  ${YELLOW}⚠ Ollama 이미지 푸시 건너뜀 (로컬에 미러링된 태그 없음 — 먼저 'build' 를 실행했는지 확인)${NC}"
        fi
    fi

    echo -e "${GREEN}✓ 이미지 푸시 완료${NC}"
    echo ""
}

# ============================================
# 3. 이미지 저장 (오프라인 전송용)
# ============================================
save_images() {
    echo -e "${GREEN}[2/4] 이미지를 tar 파일로 저장 중...${NC}"

    local img_dir="${PROJECT_ROOT}/images"
    mkdir -p "${img_dir}"

    ${CTR_CLI} save "${REGISTRY}/k8s-monitor/backend:${IMAGE_TAG}" | gzip > "${img_dir}/backend.tar.gz"
    ${CTR_CLI} save "${REGISTRY}/k8s-monitor/frontend:${IMAGE_TAG}" | gzip > "${img_dir}/frontend.tar.gz"

    # 기반 이미지도 저장
    ${CTR_CLI} pull postgres:15-alpine 2>/dev/null || true
    ${CTR_CLI} pull redis:7-alpine 2>/dev/null || true
    ${CTR_CLI} save postgres:15-alpine | gzip > "${img_dir}/postgres.tar.gz"
    ${CTR_CLI} save redis:7-alpine | gzip > "${img_dir}/redis.tar.gz"

    # Monitoring stack images
    for img in prom/prometheus:v2.51.0 grafana/grafana:10.4.0 prom/node-exporter:v1.7.0; do
        ${CTR_CLI} pull "${img}" 2>/dev/null || true
        local name="${img//\//-}"
        ${CTR_CLI} save "${img}" | gzip > "${img_dir}/${name}.tar.gz"
    done
    ${CTR_CLI} pull registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.12.0 2>/dev/null || true
    ${CTR_CLI} save registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.12.0 | gzip > "${img_dir}/kube-state-metrics.tar.gz"

    # Ollama(자체 LLM) — build_images() 가 이미 pull_ollama_image() 로 미러링했다.
    # 수 GB 크기라 오프라인 전송 매체 용량을 확인할 것.
    if [ -z "${SKIP_OLLAMA}" ]; then
        if ${CTR_CLI} image inspect "${REGISTRY}/ollama-qwen2.5-coder:${OLLAMA_TAG}" &>/dev/null; then
            echo -e "  → Ollama 이미지 저장 중 (수 GB — 시간이 걸릴 수 있습니다)..."
            ${CTR_CLI} save "${REGISTRY}/ollama-qwen2.5-coder:${OLLAMA_TAG}" | gzip > "${img_dir}/ollama.tar.gz"
        else
            echo -e "  ${YELLOW}⚠ Ollama 이미지가 로컬에 없어 저장을 건너뜁니다.${NC}"
        fi
    fi

    echo -e "${GREEN}✓ 이미지 저장 완료 (${img_dir}/)${NC}"
    echo ""
}

# ============================================
# 4. 이미지 로드 (오프라인 전송 받은 후)
# ============================================
load_images() {
    echo -e "${GREEN}이미지 로드 중...${NC}"

    local img_dir="${PROJECT_ROOT}/images"

    if [ ! -d "${img_dir}" ]; then
        echo -e "${RED}오류: ${img_dir} 디렉토리가 없습니다.${NC}"
        exit 1
    fi

    for tarfile in "${img_dir}"/*.tar.gz; do
        if [ -f "${tarfile}" ]; then
            echo -e "  → $(basename "${tarfile}") 로드 중..."
            ${CTR_CLI} load < "${tarfile}"
        fi
    done

    echo -e "${GREEN}✓ 이미지 로드 완료${NC}"
    echo ""
}

# ============================================
# 5. Kustomize 이미지 경로 업데이트
# ============================================
update_kustomization() {
    echo -e "${GREEN}[3/4] Kustomization 이미지 경로 업데이트 중...${NC}"

    cd "${PROJECT_ROOT}/k8s/overlays/airgap"

    if command -v kustomize &>/dev/null; then
        kustomize edit set image \
            "k8s-daily-monitor/backend=${REGISTRY}/k8s-monitor/backend:${IMAGE_TAG}" \
            "k8s-daily-monitor/frontend=${REGISTRY}/k8s-monitor/frontend:${IMAGE_TAG}"
        if [ -z "${SKIP_OLLAMA}" ]; then
            kustomize edit set image \
                "${OLLAMA_IMAGE}=${REGISTRY}/ollama-qwen2.5-coder:${OLLAMA_TAG}"
        fi
    else
        echo -e "${YELLOW}kustomize CLI 없음 - kustomization.yaml 직접 확인 필요${NC}"
        echo -e "${YELLOW}  (images: 블록의 backend/frontend/ollama newName 을 REGISTRY=${REGISTRY} 에 맞게 수동 확인)${NC}"
    fi

    cd "${PROJECT_ROOT}"
    echo -e "${GREEN}✓ Kustomization 업데이트 완료${NC}"
    echo ""
}

# ============================================
# 6. K8s 배포
# ============================================
deploy() {
    echo -e "${GREEN}[4/4] Kubernetes에 배포 중...${NC}"

    # 네임스페이스 생성
    kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

    # 배포
    kubectl apply -k "${PROJECT_ROOT}/k8s/overlays/airgap"

    echo ""
    echo -e "${GREEN}✓ 배포 완료!${NC}"
    echo ""

    # Node IP 자동 탐지
    local node_ip
    node_ip=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || echo "<NODE_IP>")

    echo -e "Frontend:    ${YELLOW}http://${node_ip}:30080${NC}"
    echo -e "Backend API: ${YELLOW}http://${node_ip}:30800${NC}"
    echo -e "API Docs:    ${YELLOW}http://${node_ip}:30800/docs${NC}"
    echo ""
}

# ============================================
# 7. 상태 확인
# ============================================
status() {
    echo -e "${GREEN}배포 상태 확인 중...${NC}"
    echo ""
    kubectl get all -n "${NAMESPACE}"
    echo ""
    echo -e "${CYAN}--- Pod 상태 상세 ---${NC}"
    kubectl get pods -n "${NAMESPACE}" -o wide
}

# ============================================
# 8. K8s API 서버 헬스 체크
# ============================================
check_api_server() {
    echo -e "${GREEN}K8s API 서버 상태 확인 중...${NC}"

    if kubectl cluster-info &>/dev/null; then
        echo -e "${GREEN}✓ API 서버 정상${NC}"
        kubectl get --raw='/healthz' 2>/dev/null && echo ""
        kubectl get nodes -o wide
        return 0
    else
        echo -e "${RED}✗ API 서버 연결 실패${NC}"
        return 1
    fi
}

# ============================================
# 메인
# ============================================
case "${1:-}" in
    build)
        select_container_cli
        input_registry_info
        print_config
        build_images
        ;;
    push)
        select_container_cli
        input_registry_info
        registry_login
        print_config
        push_images
        ;;
    save)
        select_container_cli
        input_registry_info
        print_config
        build_images
        save_images
        ;;
    load)
        select_container_cli
        load_images
        ;;
    deploy)
        input_registry_info
        update_kustomization
        deploy
        ;;
    all)
        select_container_cli
        input_registry_info
        registry_login
        print_config
        build_images
        push_images
        update_kustomization
        deploy
        ;;
    status)
        status
        ;;
    check)
        check_api_server
        ;;
    *)
        echo -e "${GREEN}========================================${NC}"
        echo -e "${GREEN} K8s Daily Monitor - 폐쇄망 배포${NC}"
        echo -e "${GREEN}========================================${NC}"
        echo ""
        echo "사용법: $0 {build|push|save|load|deploy|all|status|check}"
        echo ""
        echo "  build   - 컨테이너 이미지 빌드"
        echo "  push    - 레지스트리에 이미지 푸시 (로그인 포함)"
        echo "  save    - 이미지를 tar.gz로 저장 (오프라인 전송용)"
        echo "  load    - tar.gz 이미지 로드 (폐쇄망에서 수신 후)"
        echo "  deploy  - K8s에 배포"
        echo "  all     - 빌드 → 로그인 → 푸시 → 배포"
        echo "  status  - 배포 상태 확인"
        echo "  check   - K8s API 서버 헬스 체크"
        echo ""
        echo "환경변수 (선택, 미입력시 대화형으로 입력받음):"
        echo "  CTR_CLI        - 컨테이너 런타임 (docker|podman|nerdctl)"
        echo "  REGISTRY       - 컨테이너 레지스트리 주소"
        echo "  REGISTRY_USER  - 레지스트리 사용자명"
        echo "  REGISTRY_PASS  - 레지스트리 비밀번호"
        echo "  NAMESPACE      - K8s 네임스페이스 (기본: k8s-monitor)"
        echo "  IMAGE_TAG      - 이미지 태그 (기본: latest)"
        echo ""
        echo "폐쇄망 Nexus 프록시 환경변수 (선택, backend+frontend 모두 Alpine):"
        echo "  ALPINE_MIRROR_URL - Alpine apk 미러 URL"
        echo "  PIP_INDEX_URL     - PyPI 프록시 URL"
        echo "  PIP_TRUSTED_HOST  - pip trusted-host 도메인"
        echo "  NPM_REGISTRY      - npm 레지스트리 프록시 URL"
        echo ""
        echo "예시:"
        echo "  $0 build                             # 대화형으로 CLI/레지스트리 입력"
        echo "  $0 all                               # 빌드부터 배포까지 전체 수행"
        echo "  CTR_CLI=podman REGISTRY=10.0.0.1:5000 $0 build  # 환경변수로 지정"
        echo ""
        echo "  # 폐쇄망 Nexus 프록시 빌드 예시:"
        echo "  ALPINE_MIRROR_URL=http://nexus:8081/repository/alpine-proxy \\"
        echo "  PIP_INDEX_URL=http://nexus:8081/repository/pypi-proxy/simple \\"
        echo "  NPM_REGISTRY=http://nexus:8081/repository/npm-proxy/ \\"
        echo "  REGISTRY=10.0.0.1:5000 $0 build"
        echo ""
        exit 1
        ;;
esac
