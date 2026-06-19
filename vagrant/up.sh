#!/usr/bin/env bash
# ============================================================
# up.sh — Mac(Apple Silicon) 원샷: kubeadm 3노드 + Cilium 테스트 클러스터(클러스터 B)
# ============================================================
# 사전 도구(Vagrant/VirtualBox) 확인·설치 → 기존 VM 확인(있으면 인터랙티브로
# 재생성/유지) → vagrant up → Cilium 설치 → (DNS/이미지풀 자동 보정) →
# kubeconfig 추출 → (선택) PEP 등록.
#
# 사용법:
#   bash up.sh                  # 인터랙티브 원샷
#   bash up.sh --yes            # 비대화(전부 자동, 기본 도구설치 승인·기존은 유지)
#   bash up.sh --recreate       # 기존 VM 강제 삭제 후 재생성
#   bash up.sh --keep           # 기존 VM 유지(없으면 생성)하고 Cilium 만 재적용
#   bash up.sh --register       # 완료 후 PEP 에 클러스터 등록까지
#   bash up.sh --yes --recreate --register
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- options ----
ASSUME_YES=false
MODE=""          # "", recreate, keep
DO_REGISTER=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes)   ASSUME_YES=true ;;
    --recreate) MODE=recreate ;;
    --keep)     MODE=keep ;;
    --register) DO_REGISTER=true ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $arg" >&2; exit 1 ;;
  esac
done

# ---- pretty logging ----
c() { printf '\033[%sm' "$1"; }
log()  { printf '%s[up]%s %s\n' "$(c '1;34')" "$(c 0)" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$(c '1;32')" "$(c 0)" "$*"; }
warn() { printf '%s[!!]%s %s\n' "$(c '1;33')" "$(c 0)" "$*"; }
err()  { printf '%s[xx]%s %s\n' "$(c '1;31')" "$(c 0)" "$*" >&2; }

ask() { # ask "question" [default y/n] -> 0=yes
  local q="$1" def="${2:-y}" ans hint="[Y/n]"
  $ASSUME_YES && return 0
  [ "$def" = n ] && hint="[y/N]"
  read -r -p "$(printf '%s %s ' "$q" "$hint")" ans || true
  ans="${ans:-$def}"
  [[ "$ans" =~ ^[Yy]$ ]]
}

# Vagrant 가 추적하지 않는데 VirtualBox 에만 남은 orphan VM/폴더 정리.
# Vagrantfile 이 vb.name 을 고정(k8s-ctr 등)하므로, 잔존물이 있으면 vagrant up 의
# clone 이 "machine with the name '...' already exists" 로 실패한다.
# 3가지 케이스를 모두 처리(이름만으로 부족했던 이유): ①정상등록 ②inaccessible 등록
# ③중단된 clone 이 남긴 디스크 폴더. 대상은 k8s-ctr/w1/w2 로 한정.
purge_vbox_orphans() {
  command -v VBoxManage >/dev/null 2>&1 || return 0
  local vm uuid base vbxml did=false
  base="$(VBoxManage list systemproperties 2>/dev/null | sed -n 's/^Default machine folder:[[:space:]]*//p')"
  vbxml="$HOME/Library/VirtualBox/VirtualBox.xml"
  for vm in k8s-ctr k8s-w1 k8s-w2; do
    local removed=false
    # ① 정상 등록 (이름으로 보임)
    if VBoxManage list vms 2>/dev/null | grep -q "^\"$vm\" "; then
      VBoxManage controlvm "$vm" poweroff >/dev/null 2>&1 || true
      VBoxManage unregistervm "$vm" --delete >/dev/null 2>&1 || true
      removed=true
    fi
    # ② 등록됐지만 inaccessible → VirtualBox.xml 에서 .vbox 경로로 uuid 찾아 제거
    if [ -f "$vbxml" ]; then
      uuid="$(grep -oE "\{[0-9a-fA-F-]+\}\"[[:space:]]+src=\"[^\"]*/${vm}/${vm}\.vbox\"" "$vbxml" 2>/dev/null | grep -oE "\{[0-9a-fA-F-]+\}" | head -1 || true)"
      if [ -n "${uuid:-}" ]; then
        VBoxManage unregistervm "$uuid" --delete >/dev/null 2>&1 || true
        removed=true
      fi
    fi
    # ③ 디스크에 남은 VM 폴더(중단된 clone)
    for d in ${base:+"$base/$vm"} "$HOME/VirtualBox VMs/$vm"; do
      if [ -e "$d" ]; then rm -rf "$d"; removed=true; fi
    done
    if $removed; then $did || warn "VirtualBox 잔존 VM/폴더 정리:"; did=true; echo "      - $vm"; fi
  done
}

# ---- 0) OS check ----
[ "$(uname -s)" = "Darwin" ] || { err "macOS 전용입니다 (현재: $(uname -s))."; exit 1; }
log "macOS / $(uname -m) 감지"

# ---- 1) Homebrew ----
command -v brew >/dev/null 2>&1 || { err "Homebrew 필요 — https://brew.sh 에서 먼저 설치하세요."; exit 1; }

# ---- 2) 사전 도구 ----
ensure_cask() { # <cmd> <cask> <label>
  if command -v "$1" >/dev/null 2>&1; then ok "$3 설치됨"; return; fi
  warn "$3 미설치."
  if ask "  brew install --cask $2 로 설치할까요?"; then brew install --cask "$2"; ok "$3 설치 완료"
  else err "$3 없이는 진행 불가. 중단."; exit 1; fi
}
ensure_formula() { # <cmd> <formula> <label> (선택)
  if command -v "$1" >/dev/null 2>&1; then ok "$3 설치됨"; return; fi
  if ask "  brew install $2 로 설치할까요? (선택)"; then brew install "$2"; ok "$3 설치 완료"
  else warn "$3 건너뜀"; fi
}

log "사전 도구 확인..."
ensure_cask VBoxManage virtualbox "VirtualBox"
VBOXV="$(VBoxManage --version 2>/dev/null || echo '?')"
case "$VBOXV" in 7.*) ok "VirtualBox $VBOXV" ;; *) warn "VirtualBox 7.1+ 권장 (현재 $VBOXV) — Apple Silicon 은 7.1 이상 필요." ;; esac
ensure_cask vagrant vagrant "Vagrant"
ensure_formula kubectl kubectl "kubectl(호스트 검증용)"

# 이 프로젝트는 VirtualBox 전용. qemu 흔적이 있으면 정리 안내/제거.
if [ "${VAGRANT_DEFAULT_PROVIDER:-}" = "qemu" ]; then
  warn "쉘에 VAGRANT_DEFAULT_PROVIDER=qemu 가 있습니다(이 프로젝트는 virtualbox 로 강제됨)."
  warn "  완전히 끄려면 ~/.zshrc 등에서 'export VAGRANT_DEFAULT_PROVIDER=qemu' 줄을 삭제하세요."
fi
if vagrant plugin list 2>/dev/null | grep -q vagrant-qemu; then
  if ask "  안 쓰는 vagrant-qemu 플러그인을 제거할까요?" n; then
    vagrant plugin uninstall vagrant-qemu >/dev/null 2>&1 && ok "vagrant-qemu 제거됨" || warn "vagrant-qemu 제거 실패(무시 가능)"
  fi
fi

# ---- 3) 기존 VM 확인 ----
created="$(vagrant status --machine-readable 2>/dev/null | awk -F, '$3=="state"{print $2"="$4}' | grep -v '=not_created$' || true)"
if [ -n "$created" ]; then
  warn "기존 Vagrant VM 이 있습니다:"; printf '%s\n' "$created" | sed 's/^/      /'
  if [ -z "$MODE" ]; then
    if $ASSUME_YES; then MODE=keep
    else
      echo "  [r] 삭제 후 재생성   [k] 유지하고 Cilium 재적용   [a] 중단"
      read -r -p "  선택 [r/k/a] (기본 k): " ch || true
      case "${ch:-k}" in r|R) MODE=recreate ;; a|A) log "중단."; exit 0 ;; *) MODE=keep ;; esac
    fi
  fi
  if [ "$MODE" = recreate ]; then
    log "기존 VM 삭제 중 (vagrant destroy -f)..."; vagrant destroy -f; ok "삭제 완료"; MODE=""
  else
    log "기존 VM 유지 — 부팅 보장 후 Cilium 재적용."
  fi
else
  log "기존 VM 없음 — 새로 생성합니다."
fi

# ---- 4) vagrant up ----
# keep 모드(기존 유지)가 아니면, 부팅 전에 VirtualBox 잔존 VM 을 정리해
# 'machine with the name ... already exists' 클론 충돌을 예방한다.
[ "$MODE" = keep ] || purge_vbox_orphans
log "VM 부팅 (vagrant up --provider=virtualbox) — 첫 실행은 수 분 소요..."
vagrant up --provider=virtualbox
ok "VM 부팅 완료 (CNI 미설치라 노드는 아직 NotReady 가 정상)"

# ---- 5) VM DNS 점검/보정 (quay.io 이미지 풀 실패 예방) ----
log "VM DNS 점검 (quay.io 도달)..."
for n in k8s-ctr k8s-w1 k8s-w2; do
  if vagrant ssh "$n" -c 'getent hosts quay.io >/dev/null 2>&1' 2>/dev/null; then
    ok "$n DNS OK"
  else
    warn "$n: DNS 보정(8.8.8.8/1.1.1.1) + containerd 재시작"
    vagrant ssh "$n" -c 'sudo resolvectl dns eth0 8.8.8.8 1.1.1.1 2>/dev/null; sudo resolvectl flush-caches 2>/dev/null; sudo systemctl restart containerd' 2>/dev/null || true
  fi
done
# 이미 떠 있던 cilium 파드가 ImagePullBackOff 면 DNS 보정 후 재시도하도록 삭제
vagrant ssh k8s-ctr -c 'sudo kubectl -n kube-system delete pod -l k8s-app=cilium 2>/dev/null; sudo kubectl -n kube-system delete pod -l name=cilium-operator 2>/dev/null' 2>/dev/null || true

# ---- 6) Cilium 설치 ----
log "Cilium 설치 (vagrant provision k8s-ctr --provision-with cilium)..."
vagrant provision k8s-ctr --provision-with cilium
ok "Cilium 설치 단계 완료"

# ---- 7) 노드 상태 ----
log "노드 상태:"; vagrant ssh k8s-ctr -c 'sudo kubectl get nodes -o wide' 2>/dev/null || true

# ---- 8) kubeconfig 추출 ----
log "kubeconfig 추출 → $(pwd)/kubeadm-kubeconfig.yaml"
vagrant ssh k8s-ctr -c 'sudo cat /etc/kubernetes/admin.conf' > kubeadm-kubeconfig.yaml
ok "kubeadm-kubeconfig.yaml 생성 (server: https://192.168.10.100:6443)"

# ---- 9) (선택) PEP 등록 ----
REG_CMD="bash ../scripts/register-local-cluster.sh --name vagrant-kubeadm --kubeconfig vagrant/kubeadm-kubeconfig.yaml --server https://192.168.10.100:6443"
if $DO_REGISTER; then
  if curl -fsS --max-time 5 http://localhost:8000/health >/dev/null 2>&1; then
    log "PEP 에 등록..."
    bash ../scripts/register-local-cluster.sh --name vagrant-kubeadm \
      --kubeconfig kubeadm-kubeconfig.yaml --server https://192.168.10.100:6443
  else
    warn "PEP 백엔드(localhost:8000) 미기동 → 등록 생략. 'docker compose up -d' 후 레포 루트에서:"
    echo "    $REG_CMD"
  fi
fi

echo
ok "완료!"
echo "  - 노드 확인:  vagrant ssh k8s-ctr -c 'sudo kubectl get nodes -o wide'"
echo "  - Cilium:     vagrant ssh k8s-ctr -c 'sudo cilium status'"
$DO_REGISTER || echo "  - PEP 등록:   (레포 루트에서) $REG_CMD"
