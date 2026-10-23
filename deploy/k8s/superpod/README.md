# Super Pod — In-Cluster Mode

이 번들은 **대상 클러스터 내부**에 super pod CronJob 을 설치해 자기 자신을 점검하고
결과를 관리 backend 의 `/api/v1/deep-check/ingest` API 로 push 하기 위한 것입니다.

관리 클러스터에서 외부 kubectl 로 점검할 수 없는 환경 (예: 폐쇄망, kubeconfig 미배포)
에서 사용합니다. 두 모드는 상호 배타가 아니며 같은 클러스터에 동시 적용해도 됩니다.

## 사용법

```bash
# 1) 시크릿 채우기
cp secret.yaml.tmpl secret.yaml
$EDITOR secret.yaml
#   SUPERPOD_INGEST_URL   = https://<관리 backend>/api/v1/deep-check/ingest
#   SUPERPOD_INGEST_TOKEN = 관리 backend Helm values 의 deepcheck.ingestToken 과 동일
#   SUPERPOD_CLUSTER_ID   = 관리 backend 의 Cluster 행 UUID

# 2) kustomization 에 secret 포함시키기
sed -i 's|# - secret.yaml|- secret.yaml|' kustomization.yaml

# 3) 배포
kubectl apply -k .

# 4) 동작 확인
kubectl get cronjob -n k8s-monitor-agent
kubectl create job --from=cronjob/superpod-agent test-now -n k8s-monitor-agent
kubectl logs -n k8s-monitor-agent -l job-name=test-now
```

## 필요한 권한

`serviceaccount.yaml` 의 ClusterRole 이 다음을 허용합니다:

- nodes / pods / configmaps / pv / pvc / sa / rbac 조회
- kube-system 의 etcd / api-server 파드에 `exec` (`kubeadm certs check-expiration`,
  `etcdctl alarm list` 실행용)
- pod 로그 조회 (crash-loop 직전 로그 수집용)

`pods/exec` 가 거부되면 관련 체커는 `pending` 으로 응답하여 안전하게 동작합니다.

## 트러블슈팅

| 증상 | 원인 |
|---|---|
| 401 Unauthorized | INGEST_TOKEN 불일치 |
| 404 Cluster not found | CLUSTER_ID 가 관리 backend 에 등록되지 않음 |
| `cert_expiry` 가 항상 pending | kubeadm 미설치 또는 pods/exec 거부 |
| `cni_flow` 가 항상 pending | Cilium / Hubble 미설치 (정상 동작) |
| `pod_to_pod` 가 항상 pending | `devops` ns 미존재 또는 pods.create 거부 |

`pod_to_pod` 체커는 일회용 busybox probe pod 를 `devops` ns 에 띄웁니다.
`namespace.yaml` 이 해당 ns 도 함께 생성하므로 별도 작업이 필요 없습니다.
다른 ns 를 쓰려면 UI 에서 정의의 `probe_namespace` 파라미터를 변경하세요.
