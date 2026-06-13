#!/usr/bin/env bash
# 폐쇄망 충실도용 dummy bond0/bond1 구성.
# 목적: PEP "Host Facts 수집" 이 채우는 bond0_ip/bond0_mac/bond1_ip/bond1_mac 필드를
#       운영 노드처럼 채워 동일 검증이 가능하게 함.
# 안전: k8s 트래픽(192.168.56.x / Pod 10.244 / Svc 10.96)과 분리된 10.20/10.30 대역의
#       dummy 슬레이브 기반이라 클러스터 네트워킹에 영향 없음. 테스트 전용.
set -euxo pipefail

NODE_IP="${1:?node ip required}"
OCTET="${NODE_IP##*.}"   # 192.168.56.11 → 11 (노드별 고유 bond IP)

# 부팅마다 재구성되도록 setup 스크립트 + systemd oneshot 으로 영속화.
cat >/usr/local/sbin/pep-bond-setup.sh <<EOF
#!/usr/bin/env bash
set -e
modprobe bonding 2>/dev/null || true
modprobe dummy 2>/dev/null || true

setup_bond() {
  bond="\$1"; addr="\$2"; s1="\$3"; s2="\$4"
  ip link show "\$bond" >/dev/null 2>&1 || ip link add "\$bond" type bond mode active-backup miimon 100
  for s in "\$s1" "\$s2"; do
    ip link show "\$s" >/dev/null 2>&1 || ip link add "\$s" type dummy
    ip link set "\$s" down 2>/dev/null || true
    ip link set "\$s" master "\$bond" 2>/dev/null || true
  done
  ip -o addr show dev "\$bond" | grep -q "\$addr" || ip addr add "\${addr}/24" dev "\$bond"
  ip link set "\$bond" up
}

setup_bond bond0 10.20.0.${OCTET} pep0a pep0b
setup_bond bond1 10.30.0.${OCTET} pep1a pep1b
EOF
chmod +x /usr/local/sbin/pep-bond-setup.sh

cat >/etc/systemd/system/pep-test-bond.service <<'EOF'
[Unit]
Description=PEP test dummy bonds (bond0/bond1)
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pep-bond-setup.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now pep-test-bond.service

ip -br addr show bond0 2>/dev/null || true
ip -br addr show bond1 2>/dev/null || true
echo "[bond] bond0=10.20.0.${OCTET} / bond1=10.30.0.${OCTET} (테스트용 dummy)"
