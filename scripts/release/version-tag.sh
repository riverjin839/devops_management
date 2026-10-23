#!/bin/bash
set -euo pipefail

# ============================================
# Image Version Tag Manager
# Builds and pushes images with auto-incrementing semver tags.
#
# Usage:
#   bash scripts/release/version-tag.sh build          # Build with current version
#   bash scripts/release/version-tag.sh bump patch     # 0.1.0 → 0.1.1
#   bash scripts/release/version-tag.sh bump minor     # 0.1.1 → 0.2.0
#   bash scripts/release/version-tag.sh bump major     # 0.2.0 → 1.0.0
#   bash scripts/release/version-tag.sh show           # Show current version
#   bash scripts/release/version-tag.sh deploy         # Build + push + kustomize set image
# ============================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VERSION_FILE="${PROJECT_ROOT}/VERSION"

# Registry (override via env)
REGISTRY="${IMAGE_REGISTRY:-localhost:5001}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }

# ---- Version helpers ----

get_version() {
    if [ -f "${VERSION_FILE}" ]; then
        cat "${VERSION_FILE}"
    else
        echo "0.1.0"
    fi
}

set_version() {
    echo "$1" > "${VERSION_FILE}"
    log_info "Version set to $1"
}

bump_version() {
    local current
    current=$(get_version)
    local major minor patch
    IFS='.' read -r major minor patch <<< "${current}"

    case "${1}" in
        major) major=$((major + 1)); minor=0; patch=0 ;;
        minor) minor=$((minor + 1)); patch=0 ;;
        patch) patch=$((patch + 1)) ;;
        *)
            echo "Usage: $0 bump {major|minor|patch}"
            exit 1
            ;;
    esac

    local new_version="${major}.${minor}.${patch}"
    set_version "${new_version}"
    echo "${new_version}"
}

# ---- Build & push ----

build_images() {
    local version
    version=$(get_version)
    local git_sha
    git_sha=$(git -C "${PROJECT_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "unknown")

    log_step "Building images v${version} (git: ${git_sha})..."

    # Backend
    log_info "  → backend:${version}"
    docker build \
        -t "${REGISTRY}/k8s-monitor/backend:${version}" \
        -t "${REGISTRY}/k8s-monitor/backend:latest" \
        --label "version=${version}" \
        --label "git.sha=${git_sha}" \
        -f "${PROJECT_ROOT}/backend/Dockerfile" \
        "${PROJECT_ROOT}/backend"

    # Frontend
    log_info "  → frontend:${version}"
    docker build \
        -t "${REGISTRY}/k8s-monitor/frontend:${version}" \
        -t "${REGISTRY}/k8s-monitor/frontend:latest" \
        --label "version=${version}" \
        --label "git.sha=${git_sha}" \
        -f "${PROJECT_ROOT}/frontend/Dockerfile" \
        "${PROJECT_ROOT}/frontend"

    log_info "Build complete: v${version}"
}

push_images() {
    local version
    version=$(get_version)

    log_step "Pushing images v${version} to ${REGISTRY}..."

    docker push "${REGISTRY}/k8s-monitor/backend:${version}"
    docker push "${REGISTRY}/k8s-monitor/backend:latest"
    docker push "${REGISTRY}/k8s-monitor/frontend:${version}"
    docker push "${REGISTRY}/k8s-monitor/frontend:latest"

    log_info "Push complete"
}

# ---- Kustomize image update ----

update_kustomize() {
    local version
    version=$(get_version)
    local overlay="${1:-kind}"
    local kustomize_dir="${PROJECT_ROOT}/k8s/overlays/${overlay}"

    if [ ! -d "${kustomize_dir}" ]; then
        log_info "Overlay '${overlay}' not found — skipping kustomize update."
        return
    fi

    log_step "Updating kustomize overlay '${overlay}' to v${version}..."

    cd "${kustomize_dir}"
    kustomize edit set image \
        "k8s-daily-monitor/backend=${REGISTRY}/k8s-monitor/backend:${version}" \
        "k8s-daily-monitor/frontend=${REGISTRY}/k8s-monitor/frontend:${version}" \
        2>/dev/null || \
    kubectl kustomize edit set image \
        "k8s-daily-monitor/backend=${REGISTRY}/k8s-monitor/backend:${version}" \
        "k8s-daily-monitor/frontend=${REGISTRY}/k8s-monitor/frontend:${version}" \
        2>/dev/null || \
    log_info "  (kustomize CLI not found — update kustomization.yaml manually)"

    cd "${PROJECT_ROOT}"
    log_info "Kustomize updated for overlay '${overlay}'"
}

# ---- Deploy (build + push + update kustomize) ----

deploy() {
    local bump_type="${1:-patch}"
    local overlay="${2:-kind}"

    log_step "Deploy workflow: bump ${bump_type} → build → push → update ${overlay}"
    echo ""

    local new_version
    new_version=$(bump_version "${bump_type}")
    log_info "New version: ${new_version}"
    echo ""

    build_images
    echo ""

    push_images
    echo ""

    update_kustomize "${overlay}"
    echo ""

    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN} Deploy complete: v${new_version}${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "  Images: ${YELLOW}${REGISTRY}/k8s-monitor/backend:${new_version}${NC}"
    echo -e "          ${YELLOW}${REGISTRY}/k8s-monitor/frontend:${new_version}${NC}"
    echo ""
    echo -e "  Apply:  ${CYAN}kubectl apply -k k8s/overlays/${overlay}${NC}"
    echo ""
}

# ---- Main ----

COMMAND="${1:-show}"
ARG2="${2:-}"
ARG3="${3:-}"

case "${COMMAND}" in
    show)
        echo "$(get_version)"
        ;;
    bump)
        bump_version "${ARG2:-patch}"
        ;;
    build)
        build_images
        ;;
    push)
        push_images
        ;;
    deploy)
        deploy "${ARG2:-patch}" "${ARG3:-kind}"
        ;;
    *)
        echo -e "${GREEN}========================================${NC}"
        echo -e "${GREEN} Image Version Tag Manager${NC}"
        echo -e "${GREEN}========================================${NC}"
        echo ""
        echo "Usage: $0 {show|bump|build|push|deploy}"
        echo ""
        echo "  show                  Show current version"
        echo "  bump {patch|minor|major}  Bump version"
        echo "  build                 Build images with current version tag"
        echo "  push                  Push images to registry"
        echo "  deploy [bump] [overlay]   Full deploy: bump → build → push → kustomize"
        echo ""
        echo "Examples:"
        echo "  $0 deploy patch kind       # 0.1.0→0.1.1, deploy to kind"
        echo "  $0 deploy minor airgap     # 0.1.1→0.2.0, deploy to airgap"
        echo ""
        echo "Environment:"
        echo "  IMAGE_REGISTRY   Registry URL (default: localhost:5001)"
        echo ""
        exit 1
        ;;
esac
