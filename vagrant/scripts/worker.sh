#!/usr/bin/env bash
# Worker — MinIO 용 추가 디스크 포맷/마운트 + 클러스터 join.
# 인자: $1 = worker host-only IP
set -euxo pipefail

WORKER_IP="${1:?worker ip required}"
MOUNT="/mnt/disks/minio"
JOIN="/vagrant/_out/join.sh"

# ── 1. MinIO 용 추가 디스크 찾기 (파티션/FS 없는 ~10G raw 디스크) ───────────────────
TARGET=""
for d in /dev/sd[b-z] /dev/vd[b-z]; do
  [ -b "$d" ] || continue
  # 이미 파티션/파일시스템이 있으면 건너뜀 (OS 디스크 보호)
  if [ -n "$(lsblk -no FSTYPE "$d" 2>/dev/null | tr -d '[:space:]')" ]; then continue; fi
  if lsblk -no NAME "$d" 2>/dev/null | grep -q "$(basename "$d")[0-9]"; then continue; fi
  size_bytes="$(lsblk -bdno SIZE "$d" 2>/dev/null || echo 0)"
  # 9G ~ 12G 사이면 MinIO 디스크로 간주
  if [ "$size_bytes" -ge 9000000000 ] && [ "$size_bytes" -le 12884901888 ]; then
    TARGET="$d"; break
  fi
done

if [ -n "$TARGET" ]; then
  if ! blkid "$TARGET" >/dev/null 2>&1; then
    mkfs.ext4 -F -L minio "$TARGET"
  fi
  mkdir -p "$MOUNT"
  UUID="$(blkid -s UUID -o value "$TARGET")"
  if ! grep -q "$UUID" /etc/fstab; then
    echo "UUID=${UUID} ${MOUNT} ext4 defaults,nofail 0 2" >>/etc/fstab
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
  bash "$JOIN" --cri-socket=unix:///run/containerd/containerd.sock
fi

echo "[worker] done (${WORKER_IP})"
