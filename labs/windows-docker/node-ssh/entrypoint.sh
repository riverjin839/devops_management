#!/usr/bin/env bash
# node-ssh 컨테이너 진입점: dummy bond0/bond1 구성(가능하면) 후 sshd 포그라운드 실행.
# Host Facts 의 bond0_ip/mac, bond1_ip/mac 필드까지 운영처럼 채우기 위함.
set -e

# 컨테이너 IP 마지막 옥텟을 bond IP 에 반영(노드별 고유).
OCTET="$(hostname -i 2>/dev/null | awk '{print $1}' | awk -F. '{print $4}')"
OCTET="${OCTET:-50}"

# bond 는 호스트 커널 모듈에 의존 → --privileged 가 아니거나 모듈이 없으면 조용히 skip.
setup_bond() {
  bond="$1"; addr="$2"; s1="$3"; s2="$4"
  ip link add "$bond" type bond mode active-backup miimon 100 2>/dev/null || return 0
  for s in "$s1" "$s2"; do
    ip link add "$s" type dummy 2>/dev/null || true
    ip link set "$s" down 2>/dev/null || true
    ip link set "$s" master "$bond" 2>/dev/null || true
  done
  ip addr add "${addr}/24" dev "$bond" 2>/dev/null || true
  ip link set "$bond" up 2>/dev/null || true
}

modprobe bonding 2>/dev/null || true
modprobe dummy   2>/dev/null || true
setup_bond bond0 "10.20.0.${OCTET}" pep0a pep0b
setup_bond bond1 "10.30.0.${OCTET}" pep1a pep1b

if ip -br addr show bond0 >/dev/null 2>&1; then
  echo "[node-ssh] bond0=10.20.0.${OCTET} / bond1=10.30.0.${OCTET} 구성됨"
else
  echo "[node-ssh] bond 미구성(권한/모듈 부족) — bond 외 Host Facts 는 정상 수집됨"
fi

echo "[node-ssh] sshd 시작 (root / 비번: 컨테이너 빌드 시 ROOT_PASSWORD)"
exec /usr/sbin/sshd -D -e
