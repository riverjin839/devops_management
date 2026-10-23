#!/usr/bin/env bash
# 게스트에서 kubeconfig 산출물을 Mac 의 _out/ 으로 추출.
# (vagrant-qemu 는 synced folder 를 끄므로 SSH 로 가져온다.)
#
#   bash extract-kubeconfig.sh
#
# 생성물:
#   _out/pep-kubeconfig.yaml  → PEP 등록용 (server=https://host.docker.internal:6443)
#   _out/admin.conf           → Mac kubectl 용 (server=https://127.0.0.1:6443, 포워딩된 6443)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${HERE}/_out"
mkdir -p "$OUT"

# control-plane.sh 가 게스트 /vagrant/_out 에 써둔 산출물을 가져온다.
vagrant ssh -c 'sudo cat /vagrant/_out/pep-kubeconfig.yaml' >"$OUT/pep-kubeconfig.yaml"

# admin.conf 는 server 가 10.0.2.15(slirp) → Mac 에서는 포워딩된 127.0.0.1:6443 으로 교체.
vagrant ssh -c 'sudo cat /etc/kubernetes/admin.conf' \
  | sed -E 's#server: https://[0-9.]+:6443#server: https://127.0.0.1:6443#' \
  >"$OUT/admin.conf"

echo "[extract] 완료:"
echo "  - $OUT/pep-kubeconfig.yaml  → PEP '클러스터 추가' 에 붙여넣기"
echo "  - $OUT/admin.conf           → export KUBECONFIG=$OUT/admin.conf && kubectl get nodes"
