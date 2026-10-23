#!/bin/bash
# ============================================================
# Vagrant kubeadm 클러스터 안에 PEP 를 직접 배포 (k8s/overlays/vagrant)
# ============================================================
# 레지스트리가 없으므로: Mac 에서 이미지 빌드 → docker save → 각 VM containerd(k8s.io)로 import
# → kubectl apply -k. 모든 단계의 상세 로그를 출력한다(LOG=quiet 로 요약만).
#
# 사용법 (레포 어디서든):
#   bash vagrant/deploy-pep.sh            # 빌드 + 주입 + 배포
#   bash vagrant/deploy-pep.sh build      # 이미지 빌드 + 노드 주입만
#   bash vagrant/deploy-pep.sh apply      # overlay 적용 + 롤아웃 대기만
#   bash vagrant/deploy-pep.sh reload     # 재빌드 + 주입 + 롤아웃 재시작 (코드 수정 후)
#   bash vagrant/deploy-pep.sh status|logs [deploy]|destroy
#
# 전제: `vagrant/` 에서 클러스터가 Ready (bash up.sh) 이고 kubeadm-kubeconfig.yaml 이 있다.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
export KUBECONFIG="${KUBECONFIG_FILE:-${HERE}/kubeadm-kubeconfig.yaml}"
NS=k8s-monitor
NODES=(k8s-ctr k8s-w1 k8s-w2)
TAG=vagrant
LOG="${LOG:-verbose}"

log()  { echo "[$(date +%H:%M:%S)] $*"; }
run()  { [ "$LOG" = quiet ] && "$@" >/dev/null || "$@"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

preflight() {
  for c in docker kubectl vagrant; do command -v "$c" >/dev/null || die "$c 미설치 (brew install ...)"; done
  [ -f "$KUBECONFIG" ] || die "kubeconfig 없음: $KUBECONFIG — (cd vagrant && bash up.sh) 로 먼저 클러스터를 만든다"
  kubectl get nodes >/dev/null 2>&1 || die "API 도달 불가 — curl -k https://192.168.10.100:6443/livez 확인 (절전이면 bash up.sh --keep)"
  local notready; notready=$(kubectl get nodes --no-headers | grep -vc ' Ready' || true)
  [ "$notready" = 0 ] || die "NotReady 노드 ${notready}개 — Cilium 설치 확인(vagrant provision k8s-ctr --provision-with cilium)"
}

build_images() {
  log "[1/3] 이미지 빌드 (linux/arm64 — VM 과 동일 아키텍처)"
  run docker build --platform linux/arm64 -t "pep/backend:${TAG}"  -f "${ROOT}/backend/Dockerfile"  "${ROOT}/backend"
  run docker build --platform linux/arm64 -t "pep/frontend:${TAG}" -f "${ROOT}/frontend/Dockerfile" "${ROOT}/frontend"
  log "[2/3] 노드 containerd 로 이미지 주입 (${NODES[*]})"
  local tar; tar="$(mktemp -t pep-images.XXXXXX)"
  docker save "pep/backend:${TAG}" "pep/frontend:${TAG}" -o "$tar"
  ls -lh "$tar" | awk '{print "  이미지 tar: " $5}'
  for n in "${NODES[@]}"; do
    log "  → ${n}"
    ( cd "$HERE" && vagrant ssh "$n" -c 'sudo ctr -n k8s.io images import -' < "$tar" 2>&1 | sed 's/^/    /' )
  done
  rm -f "$tar"
  ( cd "$HERE" && vagrant ssh k8s-ctr -c 'sudo crictl images 2>/dev/null | grep -E "pep/(backend|frontend)"' ) || die "노드에 이미지가 보이지 않는다"
}

apply_overlay() {
  log "[3/3] overlay 적용 (k8s/overlays/vagrant)"
  run kubectl apply -k "${ROOT}/k8s/overlays/vagrant"
  for d in postgres:statefulset redis:deployment backend:deployment celery-worker:deployment celery-beat:deployment frontend:deployment; do
    log "  롤아웃 대기: ${d%%:*}"
    kubectl -n "$NS" rollout status "${d##*:}/${d%%:*}" --timeout=300s || {
      kubectl -n "$NS" get pods -o wide; kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -15
      die "${d%%:*} 롤아웃 실패 — 위 이벤트 확인 (Pending 이면 노드 메모리 부족)"
    }
  done
  kubectl -n "$NS" get pods -o wide
  cat <<MSG

배포 완료
  UI       : http://192.168.10.100:30080   (admin / admin)
  API 문서 : http://192.168.10.100:30800/docs
  이 클러스터는 in-cluster ServiceAccount 로 자기 자신을 모니터링한다.
  로그     : bash vagrant/deploy-pep.sh logs backend
MSG
}

case "${1:-all}" in
  all)     preflight; build_images; apply_overlay ;;
  build)   preflight; build_images ;;
  apply)   preflight; apply_overlay ;;
  reload)  preflight; build_images; apply_overlay
           for d in backend frontend celery-worker celery-worker-llm celery-beat; do kubectl -n "$NS" rollout restart "deploy/$d"; done ;;
  status)  kubectl -n "$NS" get pods -o wide; kubectl -n "$NS" get svc ;;
  logs)    kubectl -n "$NS" logs -f "deploy/${2:-backend}" --tail=100 ;;
  destroy) kubectl delete -k "${ROOT}/k8s/overlays/vagrant" --ignore-not-found
           echo "※ postgres 데이터(k8s-w1:/var/lib/pep-postgres)는 Retain 이라 남는다. 완전 삭제: vagrant ssh k8s-w1 -c 'sudo rm -rf /var/lib/pep-postgres'" ;;
  *) echo "사용법: $0 {all|build|apply|reload|status|logs [deploy]|destroy}"; exit 1 ;;
esac
