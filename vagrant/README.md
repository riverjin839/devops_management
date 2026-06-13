# Vagrant K8s 클러스터 (PEP 등록 + MinIO)

PEP(로컬 docker-compose) 에 등록해 모니터링하고, MinIO 를 올려볼 수 있는
kubeadm 기반 테스트 클러스터를 Vagrant 로 띄웁니다.

## 구성

| 노드 | IP (host-only) | 역할 | 비고 |
|---|---|---|---|
| `k8s-control-1` | 192.168.56.10 | control-plane | API 6443 → Mac 호스트로 포워딩 |
| `k8s-worker-1`  | 192.168.56.11 | worker | **+10GB 디스크 → /mnt/disks/minio** (MinIO) |
| `k8s-worker-2`  | 192.168.56.12 | worker | +10GB 디스크 |

- K8s 1.29 / containerd / **Flannel** (Pod CIDR `10.244.0.0/16` — host-only 192.168.x 와 미충돌)
- worker 마다 10GB 추가 디스크를 `/mnt/disks/minio` 로 자동 포맷·마운트

## 요구사항

- Vagrant 2.3+, VirtualBox 6.1+ (Intel Mac / Linux)
- **Apple Silicon(M1~)**: VirtualBox 미지원. `BOX` 를 ARM 박스로 바꾸고 provider 를
  `parallels`(유료) 또는 `vmware_desktop` 으로 교체하세요. `vm.disk` 디스크 추가는
  parallels/vmware 플러그인 버전에 따라 동작이 다를 수 있습니다.

## 실행

```bash
cd vagrant
vagrant up                 # 5~10분 (control-plane → worker 순서로 프로비저닝)
vagrant status
```

완료되면 `vagrant/_out/` 에 산출물이 생성됩니다:

| 파일 | 용도 |
|---|---|
| `_out/pep-kubeconfig.yaml` | **PEP 등록용** (server=`https://host.docker.internal:6443`) |
| `_out/admin.conf` | Mac 에서 kubectl 직접 사용 (server=`192.168.56.10:6443`) |
| `_out/join.sh` | worker join (자동 사용) |

### Mac 에서 kubectl 로 확인

```bash
export KUBECONFIG=$PWD/_out/admin.conf
kubectl get nodes -o wide      # control-1, worker-1, worker-2 가 Ready
```

## PEP 에 등록

1. PEP 풀스택 기동(`docker-compose up -d --build`) 후 로그인.
2. **설정 → 클러스터 → 클러스터 추가**:
   - 프로바이더: `On-Premises` (또는 적절히)
   - **API Endpoint**: `https://host.docker.internal:6443`
   - **kubeconfig**: `_out/pep-kubeconfig.yaml` 전체 붙여넣기 (또는 파일 업로드)
3. 등록 전 도달 확인(선택):
   ```bash
   docker-compose exec backend python -c \
    "import httpx; print(httpx.get('https://host.docker.internal:6443/healthz', verify=False, timeout=5).text)"
   # 'ok' 면 PEP 컨테이너에서 API 서버 도달 성공
   ```

> 포워딩 포인트: Vagrantfile 이 6443 을 `host_ip: 0.0.0.0` 으로 열어 두기 때문에
> Docker Desktop 의 `host.docker.internal` 로 접속됩니다. apiserver 인증서 SAN 에
> `host.docker.internal` 을 넣어 TLS 검증도 정상입니다(=skip-tls 불필요).

## MinIO 설치

```bash
export KUBECONFIG=$PWD/_out/admin.conf
kubectl apply -f manifests/minio.yaml
kubectl -n minio rollout status deploy/minio
```

- API: http://192.168.56.11:30900
- Console: http://192.168.56.11:30901  (`minioadmin` / `minioadmin` — 데모용, 변경 권장)

worker-1 의 10GB 디스크(`/mnt/disks/minio/data`)를 로컬 PV 로 사용합니다.

## 정리

```bash
vagrant destroy -f
rm -rf _out .vagrant
```

## 트러블슈팅

- **worker 가 NotReady**: `vagrant ssh k8s-worker-1 -c 'sudo journalctl -u kubelet -n50'`.
  Flannel pod 가 떠야 Ready 가 됩니다 (`kubectl -n kube-flannel get pod`).
- **추가 디스크 미인식**: `vagrant ssh k8s-worker-1 -c 'lsblk'` 로 10G raw 디스크 확인.
  Vagrant 2.3+ 필요(`VAGRANT_EXPERIMENTAL=disks` 는 Vagrantfile 에서 자동 설정).
- **PEP 에서 offline**: 위 `httpx` 도달 확인부터. 타임아웃이면 6443 포워딩/방화벽,
  인증 오류(401 가 아닌 TLS 오류)면 kubeconfig 의 server/CA 확인.
- **MinIO Pending**: PVC 가 `WaitForFirstConsumer` 라 Pod 스케줄 시 바인딩됩니다.
  Pod 가 k8s-worker-1 로 안 가면 PV nodeAffinity(`k8s-worker-1`) 와 노드명 일치 확인.
