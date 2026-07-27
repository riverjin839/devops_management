#!/usr/bin/env bash
# ============================================================
# k8s-w.sh — worker 노드 kubeadm join
# ============================================================
# upstream: gasida/vagrant-lab (cilium-study/1w) — 레포 고정본

echo ">>>> K8S Node config Start <<<<"

echo "[TASK 1] Pin kubelet NodeIP to host-only(eth1)"
# kubelet 이 등록할 NodeIP 를 host-only 주소(192.168.10.10X)로 고정한다.
#
# 지정하지 않으면 kubelet 이 default route 인터페이스인 NAT eth0 을 골라
# **10.0.2.15** 로 등록되는데, VirtualBox NAT 는 모든 VM 에 같은 주소를 주므로
# 워커 노드들의 InternalIP 가 전부 동일해진다. 그 결과:
#   - control-plane → 노드 kubelet(10250) 연결이 어긋나 `kubectl logs/exec` 가 깨지고
#   - Cilium native routing 의 autoDirectNodeRoutes 가 노드간 경로를 못 만들며
#   - PEP 의 노드 메트릭/Host Facts 가 중복된 IP 로 수집된다.
NODE_IP="$(ip -4 -o addr show eth1 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
if [ -n "$NODE_IP" ]; then
  echo "KUBELET_EXTRA_ARGS=\"--node-ip=${NODE_IP}\"" > /etc/default/kubelet
  echo "         NodeIP = ${NODE_IP}"
else
  echo "         [WARN] eth1 주소를 찾지 못해 NodeIP 고정을 건너뜁니다."
fi


echo "[TASK 2] K8S Controlplane Join"
kubeadm join --token 123456.1234567890123456 --discovery-token-unsafe-skip-ca-verification 192.168.10.100:6443  >/dev/null 2>&1


echo ">>>> K8S Node config End <<<<"
