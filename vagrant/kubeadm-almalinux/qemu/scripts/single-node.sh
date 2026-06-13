#!/usr/bin/env bash
# 단일노드(QEMU) 전용 마무리:
#   1) control-plane taint 제거 → 이 노드 한 대가 워크로드(MinIO 등)도 실행
#   2) MinIO 용 추가 디스크를 찾아 xfs 로 /mnt/disks/minio 에 포맷·마운트
#      (멀티노드 worker.sh 의 디스크 로직과 동일 — 디바이스명 비의존)
# 인자: $1 = 노드 IP
set -euxo pipefail

NODE_IP="${1:?node ip required}"
MOUNT="/mnt/disks/minio"
export KUBECONFIG=/etc/kubernetes/admin.conf

# ── 1. control-plane untaint (멱등) ──────────────────────────────────────────────
kubectl taint nodes --all node-role.kubernetes.io/control-plane- 2>/dev/null || true
kubectl taint nodes --all node-role.kubernetes.io/master-        2>/dev/null || true

# ── 2. MinIO 용 추가 디스크 포맷/마운트 (파티션/FS 없는 ~10G raw 디스크) ─────────────
TARGET=""
for dev in $(lsblk -dn -o NAME,TYPE | awk '$2=="disk"{print $1}'); do
  d="/dev/${dev}"
  [ -b "$d" ] || continue
  if [ "$(lsblk -n "$d" 2>/dev/null | wc -l)" -gt 1 ]; then continue; fi        # 파티션 있으면 OS 디스크
  if [ -n "$(lsblk -no FSTYPE "$d" 2>/dev/null | tr -d '[:space:]')" ]; then continue; fi  # FS 있으면(seed iso 등) skip
  size_bytes="$(lsblk -bdno SIZE "$d" 2>/dev/null || echo 0)"
  if [ "$size_bytes" -ge 9000000000 ] && [ "$size_bytes" -le 12884901888 ]; then
    TARGET="$d"; break
  fi
done

if [ -n "$TARGET" ]; then
  if ! blkid "$TARGET" >/dev/null 2>&1; then
    mkfs.xfs -f -L minio "$TARGET"
  fi
  mkdir -p "$MOUNT"
  UUID="$(blkid -s UUID -o value "$TARGET")"
  if ! grep -q "$UUID" /etc/fstab; then
    echo "UUID=${UUID} ${MOUNT} xfs defaults,nofail 0 2" >>/etc/fstab
  fi
  mount -a
  mkdir -p "${MOUNT}/data"
  chmod 0777 "${MOUNT}/data"
  echo "[single-node] MinIO 디스크 마운트: ${TARGET} → ${MOUNT} ($(df -h "${MOUNT}" | tail -1 | awk '{print $2}'))"
else
  echo "[single-node] 경고: MinIO 용 추가 디스크를 못 찾음 — Vagrantfile 의 extra_qemu_args(minio.qcow2) 확인."
fi

echo "[single-node] done (${NODE_IP}) — 단일노드 schedulable control-plane 준비 완료"
