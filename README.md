# PEP — Platform Engineering Portal

> Kubernetes 기반 인프라 서비스 운영·딥 트러블슈팅·팀 협업을 한 곳에서.

![Version](https://img.shields.io/badge/version-1.6.0-0071E3.svg)
![License](https://img.shields.io/badge/license-Proprietary-lightgrey.svg)
![React](https://img.shields.io/badge/React-18-61DAFB.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.109-009688.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6.svg)
![Kubernetes](https://img.shields.io/badge/Kubernetes-Ready-326CE5.svg)

플랫폼 엔지니어링 포털(PEP)은 다중 K8s 클러스터 운영을 위한 통합 포털이다.
일일 자동 점검과 운영 점검 콘솔, Cilium/Hubble 기반 딥 트러블슈팅, AI 장애 분석,
자원 사용률·용량 추이 분석, Ansible 자동화, 읽기전용 리소스 탐색·로그 스트리밍,
그리고 업무/문서 협업(지식 허브)까지 제공한다.

## 핵심 기능

| 영역 | 내용 |
|---|---|
| **모니터링** | check-matrix cron 기반 자동 점검, 클러스터/노드/시스템 파드/애드온 헬스, AI 리뷰, kubewatch 실시간 이벤트 수집(심각 이벤트 인앱 알림) |
| **운영 점검 콘솔** | 점검 항목 리스트 → 선택 일괄/개별 실행(백그라운드 진행률) → 결과·로그. Deep Check 프레임워크(인증서 만료·etcd·CoreDNS·OOM·PVC 등 16종, in-cluster CronJob 지원)로 점검 추가형 구조 |
| **자원/용량** | K8s 자원 관리(노드·NS·랭킹, req/lim/use + 사용률 R·L, 카드 열수/페이징/검색, 대형 클러스터 가상 스크롤·Redis 공유 스냅샷), **자원 효율화**(request 축소 추천·드라이런/적용/롤백·NS 자동 적용 opt-in·NS 자원 추이/저효율 랭킹·ResourceQuota 탄력·오퍼레이터 CR 어댑터·실행 로그), 클러스터 추이(per-node 메트릭 시계열, Prometheus) |
| **딥 트러블슈팅** | Cilium/Hubble 라이브 트레이스, 패킷 흐름, Pod 병목 진단, AI 장애 분석(분석 전용 — 조치 실행 없음) |
| **리소스 탐색(읽기전용)** | K8s 리소스 40여 종 조회 + YAML 보기(Secret 마스킹), 파드 로그 스트리밍, 실시간 이벤트 |
| **자동화** | Ansible 플레이북·배치(SSH), Batch Jobs(cron), etcdctl/mc 콘솔, 노드 일괄 실행 |
| **설정 변경 이력** | 스냅샷(해시 dedup) + diff + 감사 로그, OS/커널 파라미터 드리프트 |
| **인프라/스토리지** | 인프라 물리 토폴로지, 노드 서버스펙 자산 대장, Isilon NFS 모니터링, 서비스 토폴로지, LAKE 서비스 카탈로그 |
| **협업/지식** | 업무 보드(칸반/표/캘린더), 스프린트, Jira 양방향 연동(Excel 가져오기·상태/내용 반영), 문서 관리 대시보드(Confluence 문서 가져오기/게시 + 동기화 상태 + AI 시맨틱 검색), 주간 타임라인, WBS, 워크플로우, 마인드맵, 온톨로지 그래프, 지식 허브(문서 에디터·도구 탭 통합), 기술 트렌드 다이제스트 |
| **개인화** | Your Island — 자주 쓰는 화면을 개인 화면 하나에 모아 탭/좌측 레일로 전환(기존 페이지를 그대로 임베드), 아일랜드 여러 개 + 팀 공유·복제 |
| **소통/알림** | 사용자 VOC 게시판, 인앱 알림, 릴리즈 노트 패널(CHANGELOG 자동 파싱), 👍 공감 |
| **배포/운영** | kind / Helm / Kustomize / ArgoCD / Jenkins, 폐쇄망(airgap) 배포, JSON 백업·복원, 사용자 관리(RBAC: viewer/operator/admin) |

## 기술 스택

- **Frontend**: React 18 · TypeScript 5.3 · Vite · Tailwind + shadcn/ui · Zustand · TanStack Query · TipTap
- **Backend**: FastAPI · SQLAlchemy 2 · Pydantic v2 · Celery · PostgreSQL · Redis · kubernetes SDK · Ansible
- **Infra**: Docker · Kustomize · Helm · Skaffold · kind · ArgoCD · GitHub Actions CI/CD

## 빠른 시작 (로컬, Docker Compose)

```bash
cp .env.example backend/.env   # 환경 변수
docker-compose up -d           # postgres + redis + backend + frontend + celery(+beat) + kubewatch + grafana-renderer
# Frontend  http://localhost:5173
# Backend   http://localhost:8000/docs
```

네이티브 개발 / 로컬 K8s(kind) / 폐쇄망 등 상세는 [docs/DEPLOY_GUIDE.md](docs/DEPLOY_GUIDE.md) 와
`make help` 참고. 로컬 테스트 클러스터를 띄워 검증하려면 OS 별 가이드:

- **Mac(Apple Silicon)**: kind + Vagrant 2대 — [docs/MAC_LOCAL_TEST_GUIDE.md](docs/MAC_LOCAL_TEST_GUIDE.md)
- **Windows**: VirtualBox kubeadm 2대 — [docs/WIN_LOCAL_TEST_GUIDE.md](docs/WIN_LOCAL_TEST_GUIDE.md)
- **폐쇄망(airgap) 운영**: [docs/DEPLOY_GUIDE.md](docs/DEPLOY_GUIDE.md) 3단계 + [docs/AIRGAP_LLM_NEXUS.md](docs/AIRGAP_LLM_NEXUS.md)(LLM/Nexus)

## 문서

문서 색인은 [docs/README.md](docs/README.md). 주요 문서:

- 배포: [배포 가이드](docs/DEPLOY_GUIDE.md) · [Mac 로컬](docs/MAC_LOCAL_TEST_GUIDE.md) · [Windows 로컬](docs/WIN_LOCAL_TEST_GUIDE.md) · [폐쇄망 LLM/Nexus](docs/AIRGAP_LLM_NEXUS.md) · [폐쇄망 LLM 아키텍처](docs/AIRGAP_LLM_ARCHITECTURE.md)
- 운영: [관리자 매뉴얼](docs/ADMIN_MANUAL.md) · [백업·복구 가이드](docs/BACKUP_RESTORE_GUIDE.md) · [요청 흐름](docs/PROJECT_FLOW_GUIDE.md)
- [브랜치·태그·릴리스 전략](docs/branch-tag-strategy.md) · [CHANGELOG](CHANGELOG.md)
- [OpenLens 차용 아키텍처 로드맵](docs/openlens-architecture-roadmap.md)
- 기여/개발: [CONTRIBUTING.md](CONTRIBUTING.md) · 보안: [SECURITY.md](SECURITY.md)
- AI 어시스턴트 컨텍스트: [CLAUDE.md](CLAUDE.md) · 재사용 작업 플레이북: `.claude/skills/`

## 저장소 구조

```
devops_management/
├── backend/        # FastAPI (app/{models,routers,services,...})
├── frontend/       # React + TS (src/{pages,components,hooks,services,stores})
├── k8s/            # Kustomize base + overlays(dev/prod/airgap/kind) + superpod(딥체크 CronJob)
├── helm/           # Helm chart
├── ansible/        # 플레이북
├── argocd/         # ArgoCD Application/Project
├── scripts/        # kind/airgap/init/release/docs 스크립트
├── docs/           # 운영/설계/아카이브 문서 (색인: docs/README.md)
├── docker/ vagrant/ windows-docker/  # 로컬 실험 환경
└── .claude/skills/ # 재사용 작업 플레이북
```

기능 → 파일 위치는 [CODE_MAP.md](CODE_MAP.md), 화면별 명세는 [docs/SCREENS.md](docs/SCREENS.md) 참고.

## 라이선스

Proprietary · 내부 전용. 자세한 내용은 [LICENSE](LICENSE) 참고.
