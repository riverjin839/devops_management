#!/usr/bin/env bash
# AlmaLinux 10(RHEL 10 호환) GenericCloud qcow2 → vagrant-qemu provider 박스 빌드.
#
# 왜 필요한가:
#   AlmaLinux 는 aarch64 용 *qemu* provider 박스를 배포하지 않는다(VirtualBox/VMware/
#   Parallels 만). 그래서 Apple Silicon 에서 무료 QEMU 로 돌리려면 공식 클라우드
#   qcow2 이미지를 받아 vagrant-qemu 박스로 직접 패키징해야 한다.
#
# 이 스크립트가 하는 일:
#   1) AlmaLinux 10 GenericCloud aarch64 qcow2 다운로드
#   2) 루트 디스크 30G 로 확장(kubeadm 여유 — 클라우드 이미지는 부팅 시 자동 grow)
#   3) cloud-init NoCloud seed.iso 생성(= vagrant 유저 + insecure key + root 비번)
#   4) {box.img, metadata.json, Vagrantfile} 를 .box(tar.gz) 로 묶어 vagrant 에 add
#
# 산출물:
#   - vagrant box:  pep/almalinux10-qemu   (vagrant box list 에 등록)
#   - ./seed.iso    (Vagrantfile 이 부팅 시 cloud-init datasource 로 첨부)
#
# 사용:
#   cd vagrant/qemu
#   bash build-almalinux-box.sh           # 박스가 이미 있으면 skip (FORCE=1 로 재빌드)
#
# 요구: qemu(brew install qemu) — qemu-img 사용. macOS 는 seed.iso 를 hdiutil 로,
#       Linux 는 genisoimage/mkisofs 로 만든다.
set -euo pipefail

ALMA_VER="${ALMA_VER:-10}"
ARCH="${ARCH:-aarch64}"
BOX_NAME="${BOX_NAME:-pep/almalinux10-qemu}"
ROOT_PW="${ROOT_PW:-rootpass}"          # Vagrantfile 의 ROOT_PASSWORD 와 일치시킬 것
DISK_SIZE="${DISK_SIZE:-30G}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED_OUT="${HERE}/seed.iso"

IMG="AlmaLinux-${ALMA_VER}-GenericCloud-latest.${ARCH}.qcow2"
URL="${ALMA_URL:-https://repo.almalinux.org/almalinux/${ALMA_VER}/cloud/${ARCH}/images/${IMG}}"

# Vagrant 잘 알려진 insecure 공개키(첫 부팅 후 vagrant 가 자동으로 새 키로 교체).
VAGRANT_INSECURE_PUBKEY='ssh-rsa AAAAB3NzaC1yc2EAAAABIwAAAQEA6NF8iallvQVp22WDkTkyrtvp9eWW6A8YVr+kz4TjGYe7gHzIw+niNltGEFHzD8+v1I2YJ6oXevct1YeS0o9HZyN1Q9qgCgzUFtdOKLv6IedplqoPkcmF0aYet2PkEDo3MlTBckFXPITAMzF8dJSIFo9D8HfdOV0IAdx4O7PtixWKn5y2hMNG0zQPyUecp4pzC6kivAIhyfHilFR61RGL+GPXQ2MWZWFYbAGjyiYJnAmCP3NOTd0jMZEnDkbUvxhMmBYSdETk1rRgm+R4LOzFUGaHqHDLKLX+FIPKcF96hrucXzcWyLbIbEgE98OHlnVYCzRdK8jlqm8tehUc9c9WhQ== vagrant insecure public key'

command -v qemu-img >/dev/null || { echo "qemu-img 없음 — 'brew install qemu' 후 다시 실행" >&2; exit 1; }

if [ "${FORCE:-0}" != "1" ] && vagrant box list 2>/dev/null | grep -q "^${BOX_NAME} "; then
  echo "[build] '${BOX_NAME}' 박스가 이미 있음 (재빌드는 FORCE=1). seed.iso 만 점검."
  [ -f "$SEED_OUT" ] && { echo "[build] seed.iso 존재 — 완료."; exit 0; }
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "[build] 작업 디렉터리: $WORK"

# ── 1. qcow2 다운로드 ──────────────────────────────────────────────────────────
echo "[build] 다운로드: $URL"
curl -fL --retry 3 "$URL" -o "$WORK/box.img"

# ── 2. 루트 디스크 확장(클라우드 이미지가 부팅 시 자동 grow) ──────────────────────
qemu-img resize "$WORK/box.img" "$DISK_SIZE"

# ── 3. cloud-init NoCloud seed (vagrant 유저 + insecure key + root 비번) ──────────
SEEDDIR="$WORK/seed"
mkdir -p "$SEEDDIR"
cat >"$SEEDDIR/meta-data" <<EOF
instance-id: pep-almalinux10-qemu
local-hostname: k8s-control-1
EOF
cat >"$SEEDDIR/user-data" <<EOF
#cloud-config
ssh_pwauth: true
disable_root: false
users:
  - name: vagrant
    groups: [wheel]
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    shell: /bin/bash
    lock_passwd: false
    plain_text_passwd: vagrant
    ssh_authorized_keys:
      - ${VAGRANT_INSECURE_PUBKEY}
chpasswd:
  expire: false
  users:
    - {name: root, password: ${ROOT_PW}, type: text}
    - {name: vagrant, password: vagrant, type: text}
runcmd:
  - [systemctl, enable, --now, sshd]
EOF

echo "[build] seed.iso 생성 → $SEED_OUT"
if command -v hdiutil >/dev/null 2>&1; then              # macOS
  rm -f "$SEED_OUT"
  hdiutil makehybrid -iso -joliet -default-volume-name CIDATA -o "$SEED_OUT" "$SEEDDIR" >/dev/null
elif command -v genisoimage >/dev/null 2>&1; then        # Linux
  genisoimage -output "$SEED_OUT" -volid CIDATA -joliet -rock "$SEEDDIR"
elif command -v mkisofs >/dev/null 2>&1; then
  mkisofs -output "$SEED_OUT" -volid CIDATA -joliet -rock "$SEEDDIR"
else
  echo "ERROR: ISO 생성 도구(hdiutil/genisoimage/mkisofs) 없음" >&2; exit 1
fi

# ── 4. 박스 패키징 ──────────────────────────────────────────────────────────────
cat >"$WORK/metadata.json" <<'EOF'
{"provider":"qemu","format":"qcow2"}
EOF
# 박스 안 Vagrantfile: vagrant-qemu 가 SSH 유저를 vagrant 로 잡도록 기본값 명시.
cat >"$WORK/Vagrantfile" <<'EOF'
Vagrant.configure("2") do |config|
  config.ssh.username = "vagrant"
  config.ssh.password = "vagrant"
end
EOF

BOX_FILE="$WORK/${BOX_NAME//\//_}.box"
echo "[build] tar.gz 패키징..."
( cd "$WORK" && tar czf "$BOX_FILE" box.img metadata.json Vagrantfile )

echo "[build] vagrant box add ${BOX_NAME}"
vagrant box add --force --name "$BOX_NAME" "$BOX_FILE"

echo
echo "[build] 완료 ✅"
echo "  - box   : ${BOX_NAME}"
echo "  - seed  : ${SEED_OUT}  (Vagrantfile 이 부팅 시 첨부)"
echo "  다음: cd ${HERE} && vagrant up --provider=qemu"
