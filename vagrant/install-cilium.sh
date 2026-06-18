#!/usr/bin/env bash
# ============================================================
# install-cilium.sh — k8s-ctr 에서 Cilium 을 Helm 으로 설치 (kube-proxy 대체)
# ============================================================
# Vagrant 의 named provisioner 로 등록돼 있어 control-plane(k8s-ctr)에서만 실행된다:
#   vagrant provision k8s-ctr --provision-with cilium
# 설정값은 Cilium 스터디 1주차 기준(native routing + cluster-pool IPAM 172.20.0.0/16).
#
# 환경변수:
#   CILIUM_VERSION   Cilium chart 버전 (기본 1.17.5)
set -euo pipefail

CILIUM_VERSION="${CILIUM_VERSION:-1.17.5}"

echo "[cilium] helm repo 추가"
helm repo add cilium https://helm.cilium.io/ >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1 || true

if helm status cilium -n kube-system >/dev/null 2>&1; then
  echo "[cilium] 이미 설치됨 — skip (재설치하려면 helm uninstall cilium -n kube-system)"
else
  echo "[cilium] Cilium ${CILIUM_VERSION} 설치 중..."
  helm install cilium cilium/cilium --version "${CILIUM_VERSION}" --namespace kube-system \
    --set k8sServiceHost=192.168.10.100 --set k8sServicePort=6443 \
    --set kubeProxyReplacement=true \
    --set routingMode=native \
    --set autoDirectNodeRoutes=true \
    --set ipam.mode="cluster-pool" \
    --set ipam.operator.clusterPoolIPv4PodCIDRList={"172.20.0.0/16"} \
    --set ipv4NativeRoutingCIDR=172.20.0.0/16 \
    --set endpointRoutes.enabled=true \
    --set installNoConntrackIptablesRules=true \
    --set bpf.masquerade=true \
    --set ipv6.enabled=false
fi

# cilium CLI (상태 확인용)
if ! command -v cilium >/dev/null 2>&1; then
  echo "[cilium] cilium CLI 설치 중..."
  CILIUM_CLI_VERSION="$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)"
  CLI_ARCH=amd64; [ "$(uname -m)" = "aarch64" ] && CLI_ARCH=arm64
  curl -L --fail --remote-name-all \
    "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${CLI_ARCH}.tar.gz"
  tar xzvfC "cilium-linux-${CLI_ARCH}.tar.gz" /usr/local/bin
  rm -f "cilium-linux-${CLI_ARCH}.tar.gz"
fi

echo "[cilium] 상태 대기..."
cilium status --wait

echo ""
echo "[cilium] ===== 노드 상태 ====="
kubectl get nodes -o wide || true

echo ""
echo "[cilium] 완료. Mac 호스트에서 kubeconfig 를 가져오려면:"
echo "    vagrant ssh k8s-ctr -c 'sudo cat /etc/kubernetes/admin.conf' > kubeadm-kubeconfig.yaml"
echo "  그 후 PEP 에 등록:"
echo "    bash ../scripts/register-local-cluster.sh \\"
echo "      --name vagrant-kubeadm --kubeconfig kubeadm-kubeconfig.yaml \\"
echo "      --server https://192.168.10.100:6443"
