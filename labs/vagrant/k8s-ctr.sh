#!/usr/bin/env bash
# ============================================================
# k8s-ctr.sh — control-plane kubeadm init + 편의 설정
# ============================================================
# args: $1 = worker 노드 수 N (/etc/hosts 채우기용)
# CNI 는 설치하지 않는다 → 노드는 Cilium 설치 전까지 NotReady.
# upstream: gasida/vagrant-lab (cilium-study/1w) — 레포 고정본

echo ">>>> K8S Controlplane config Start <<<<"

echo "[TASK 0] Pin kubelet NodeIP to host-only(eth1)"
# 워커(k8s-w.sh)와 동일하게 NodeIP 를 host-only 주소로 고정한다. 고정하지 않으면
# kubelet 이 NAT eth0(10.0.2.15 — 모든 VM 공통)을 골라 노드를 등록할 수 있다.
# ※ 여기에 문서용 플레이스홀더(<그_노드_사설IP> 등)를 그대로 넣으면 kubelet 이
#    "Could not parse some node IP(s), ignoring them" 로 무시하니 주의.
NODE_IP="$(ip -4 -o addr show eth1 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
if [ -n "$NODE_IP" ]; then
  echo "KUBELET_EXTRA_ARGS=\"--node-ip=${NODE_IP}\"" > /etc/default/kubelet
  echo "         NodeIP = ${NODE_IP}"
else
  echo "         [WARN] eth1 주소를 찾지 못해 NodeIP 고정을 건너뜁니다."
fi


echo "[TASK 1] Initial Kubernetes"
kubeadm init --token 123456.1234567890123456 --token-ttl 0 --pod-network-cidr=10.244.0.0/16 --service-cidr=10.96.0.0/16 --apiserver-advertise-address=192.168.10.100 --cri-socket=unix:///run/containerd/containerd.sock >/dev/null 2>&1


echo "[TASK 2] Setting kube config file"
mkdir -p /root/.kube
cp -i /etc/kubernetes/admin.conf /root/.kube/config
chown $(id -u):$(id -g) /root/.kube/config


echo "[TASK 3] Source the completion"
echo 'source <(kubectl completion bash)' >> /etc/profile
echo 'source <(kubeadm completion bash)' >> /etc/profile


echo "[TASK 4] Alias kubectl to k"
echo 'alias k=kubectl' >> /etc/profile
echo 'alias kc=kubecolor' >> /etc/profile
echo 'complete -F __start_kubectl k' >> /etc/profile


echo "[TASK 5] Install Kubectx & Kubens"
git clone https://github.com/ahmetb/kubectx /opt/kubectx >/dev/null 2>&1
ln -s /opt/kubectx/kubens /usr/local/bin/kubens
ln -s /opt/kubectx/kubectx /usr/local/bin/kubectx


echo "[TASK 6] Install Kubeps & Setting PS1"
git clone https://github.com/jonmosco/kube-ps1.git /root/kube-ps1 >/dev/null 2>&1
cat <<"EOT" >> /root/.bash_profile
source /root/kube-ps1/kube-ps1.sh
KUBE_PS1_SYMBOL_ENABLE=true
function get_cluster_short() {
  echo "$1" | cut -d . -f1
}
KUBE_PS1_CLUSTER_FUNCTION=get_cluster_short
KUBE_PS1_SUFFIX=') '
PS1='$(kube_ps1)'$PS1
EOT
kubectl config rename-context "kubernetes-admin@kubernetes" "HomeLab" >/dev/null 2>&1


echo "[TASK 7] Setting /etc/hosts"
echo "192.168.10.100 k8s-ctr" >> /etc/hosts
for (( i=1; i<=$1; i++  )); do echo "192.168.10.10$i k8s-w$i" >> /etc/hosts; done


echo ">>>> K8S Controlplane Config End <<<<"
