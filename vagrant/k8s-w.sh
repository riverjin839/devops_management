#!/usr/bin/env bash
# ============================================================
# k8s-w.sh — worker 노드 kubeadm join
# ============================================================
# upstream: gasida/vagrant-lab (cilium-study/1w) — 레포 고정본

echo ">>>> K8S Node config Start <<<<"

echo "[TASK 1] K8S Controlplane Join"
kubeadm join --token 123456.1234567890123456 --discovery-token-unsafe-skip-ca-verification 192.168.10.100:6443  >/dev/null 2>&1


echo ">>>> K8S Node config End <<<<"
