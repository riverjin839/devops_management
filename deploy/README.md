# deploy/ — 운영 배포 매니페스트

| 디렉터리 | 내용 | 진입 |
|---|---|---|
| [`k8s/`](k8s/README.md) | Kustomize `base/` + `overlays/{dev,prod,airgap,kind,vagrant}` + `components/` + `superpod/` | `kubectl apply -k deploy/k8s/overlays/<env>` |

Helm 차트(`helm/`)·ArgoCD 앱(`argocd/`)·이미지 정의(`docker/`)는 ArgoCD `path:` 와 Jenkinsfile 이 직접 가리켜
아직 최상위에 둔다. 배포 스크립트는 `scripts/deploy/`, 로컬 테스트 환경은 `labs/`. 전체 지도: `docs/DEPLOY_GUIDE.md` 상단 표.
