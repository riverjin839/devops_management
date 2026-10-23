# deploy/ — 운영 배포 정의

| 디렉터리 | 내용 | 진입 |
|---|---|---|
| [`k8s/`](k8s/README.md) | Kustomize `base/` + `overlays/{dev,prod,airgap,kind,vagrant}` + `components/` + `superpod/` | `kubectl apply -k deploy/k8s/overlays/<env>` |
| `helm/k8s-daily-monitor/` | Helm 차트 (`values{,-dev,-prod,-airgap}.yaml`) | `helm install k8s-monitor ./deploy/helm/k8s-daily-monitor -f ...` |
| `argocd/` | ArgoCD `Application`/`AppProject` | `kubectl apply -f deploy/argocd/application.yaml` |

⚠ 이미 클러스터에 적용된 ArgoCD Application 은 `spec.source.path` 가 옛 값(`helm/k8s-daily-monitor`)이다.
이 PR 이 머지되면 `deploy/helm/k8s-daily-monitor` 로 **다시 apply** 해야 한다(안 하면 ArgoCD 가 옛 경로를 찾지 못해 sync 실패).

이미지 빌드 정의(`docker/`)는 최상위에 둔다. 배포 스크립트는 `scripts/deploy/`, 로컬 테스트 환경은 `labs/`.
전체 지도: `docs/DEPLOY_GUIDE.md` 상단 표.
