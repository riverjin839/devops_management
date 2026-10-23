# labs/ — 로컬 테스트 환경 (PEP 가 모니터링할 가짜 클러스터)

운영 배포물이 아니다. 개발자 PC 에서 테스트 K8s 를 띄우고 PEP 를 붙여 보는 실험실이다.
**운영 배포(`deploy/`)와 섞이지 않도록 한 곳에 모았다.** 전체 지도는 [`docs/DEPLOY_GUIDE.md`](../docs/DEPLOY_GUIDE.md) 상단 표.

| 디렉터리 | 호스트 | 형태 | 가이드 |
|---|---|---|---|
| [`vagrant/`](vagrant/README.md) | Apple Silicon Mac (VirtualBox) | Ubuntu kubeadm 3노드 + Cilium. `deploy-pep.sh` 로 PEP 를 클러스터 안에 배포도 가능 | [MAC_LOCAL_TEST_GUIDE](../docs/MAC_LOCAL_TEST_GUIDE.md) |
| [`vagrant/kubeadm-almalinux/`](vagrant/kubeadm-almalinux/README.md) | Mac·Windows·Linux (VMware/VirtualBox/QEMU) | AlmaLinux(RHEL 호환) kubeadm — 폐쇄망 충실도 | [WIN_LOCAL_TEST_GUIDE](../docs/WIN_LOCAL_TEST_GUIDE.md) |
| [`windows-docker/`](windows-docker/README.md) | Windows (Docker Desktop) | kind 2노드 + SSH 노드 컨테이너 | [WIN_LOCAL_TEST_GUIDE](../docs/WIN_LOCAL_TEST_GUIDE.md) |

kind 기반 로컬 환경은 여기가 아니라 `scripts/deploy/kind-setup.sh`(PEP 배포 포함)와
`scripts/lab/local-cilium-kind.sh`(Cilium kind) 를 쓴다.
