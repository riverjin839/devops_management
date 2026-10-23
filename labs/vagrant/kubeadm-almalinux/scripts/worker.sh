#!/usr/bin/env bash
# Worker — MinIO 용 추가 디스크 포맷/마운트 + 클러스터 join.
# 인자: $1 = worker host-only IP
#       $2 = 산출물 디렉터리 (join.sh 위치; 기본 /vagrant/_out, 멀티클러스터 c2 는 /vagrant/_out-c2)
set -euxo pipefail

WORKER_IP="${1:?worker ip required}"
OUT="${2:-/vagrant/_out}"
MOUNT="/mnt/disks/minio"
JOIN="${OUT}/join.sh"

# ── 1. MinIO 용 추가 디스크 찾기 (파티션/FS 없는 ~10G raw 디스크, 디바이스명 비의존) ──
# VMware(sdb)·VirtualBox(sdb)·일부 환경(nvme) 모두 대응하도록 lsblk 로 전체 디스크 순회.
TARGET=""
for dev in $(lsblk -dn -o NAME,TYPE | awk '$2=="disk"{print $1}'); do
  d="/dev/${dev}"
  [ -b "$d" ] || continue
  # 파티션(자식)이 있으면 OS 디스크 → 건너뜀
  if [ "$(lsblk -n "$d" 2>/dev/null | wc -l)" -gt 1 ]; then continue; fi
  # 파일시스템이 이미 있으면 건너뜀
  if [ -n "$(lsblk -no FSTYPE "$d" 2>/dev/null | tr -d '[:space:]')" ]; then continue; fi
  size_bytes="$(lsblk -bdno SIZE "$d" 2>/dev/null || echo 0)"
  # 9G ~ 12G 사이면 MinIO 디스크로 간주
  if [ "$size_bytes" -ge 9000000000 ] && [ "$size_bytes" -le 12884901888 ]; then
    TARGET="$d"; break
  fi
done

if [ -n "$TARGET" ]; then
  if ! blkid "$TARGET" >/dev/null 2>&1; then
    mkfs.xfs -f -L minio "$TARGET"        # RHEL 기본 파일시스템
  fi
  mkdir -p "$MOUNT"
  UUID="$(blkid -s UUID -o value "$TARGET")"
  if ! grep -q "$UUID" /etc/fstab; then
    echo "UUID=${UUID} ${MOUNT} xfs defaults,nofail 0 2" >>/etc/fstab
  fi
  mount -a
  mkdir -p "${MOUNT}/data"
  chmod 0777 "${MOUNT}/data"   # 데모용 — 운영은 적절한 권한/소유자로
  echo "[worker] MinIO 디스크 마운트: ${TARGET} → ${MOUNT} ($(df -h "${MOUNT}" | tail -1 | awk '{print $2}'))"
else
  echo "[worker] 경고: MinIO 용 추가 디스크를 찾지 못함 — Vagrantfile 의 vm.disk 설정 확인."
fi

# ── 2. 클러스터 join (멱등) ──────────────────────────────────────────────────────
if [ ! -f /etc/kubernetes/kubelet.conf ]; then
  if [ ! -f "$JOIN" ]; then
    echo "[worker] join.sh 없음 — control-plane 프로비저닝이 먼저 끝나야 함." >&2
    exit 1
  fi
  bash "$JOIN" --cri-socket=unix:///var/run/crio/crio.sock
fi

echo "[worker] done (${WORKER_IP})"
