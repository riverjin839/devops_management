# PEP — Platform Engineering Portal

> Kubernetes 운영·딥 트러블슈팅·팀 협업을 한 곳에서. (구 *K8s Daily Monitor* → 2026년 PEP 로 재정의)

![Version](https://img.shields.io/badge/version-1.0.0-0071E3.svg)
![License](https://img.shields.io/badge/license-Proprietary-lightgrey.svg)
![React](https://img.shields.io/badge/React-18-61DAFB.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.109-009688.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6.svg)
![Kubernetes](https://img.shields.io/badge/Kubernetes-Ready-326CE5.svg)

플랫폼 엔지니어링 포털(PEP)은 다중 K8s 클러스터 운영을 위한 통합 포털이다.
일일 자동 점검과 운영 점검 콘솔, Cilium/Hubble 기반 딥 트러블슈팅, AI 장애 분석,
Ansible 자동화, 읽기전용 리소스 탐색·로그 스트리밍, 그리고 업무/문서 협업까지 제공한다.

## 핵심 기능

| 영역 | 내용 |
|---|---|
| **모니터링** | 일일 자동 점검(3회/일), 클러스터/노드/시스템 파드/애드온 헬스, AI 리뷰 |
| **운영 점검 콘솔** | 점검 항목 리스트 → 선택 일괄/개별 실행(백그라운드 진행률) → 결과·로그. 점검 추가형 구조 |
| **딥 트러블슈팅** | Cilium/Hubble 라이브 트레이스, 패킷 흐름, Pod 병목 진단, AI 장애 분석 |
| **리소스 탐색(읽기전용)** | K8s 리소스 11종 조회 + YAML 보기(Secret 마스킹), 파드 로그 스트리밍 |
| **자동화** | Ansible 플레이북·배치(SSH), etcdctl/mc 콘솔, 노드 일괄 실행 |
| **설정 변경 이력** | 스냅샷(해시 dedup) + diff + 감사 로그 |
| **협업/지식** | 업무·이슈 보드, 주간 타임라인, WBS, 워크플로우, 마인드맵, 문서 에디터(템플릿/.md/표) |
| **배포** | kind / Helm / Kustomize / ArgoCD / Jenkins, JSON 백업·복원, RBAC |

## 기술 스택

- **Frontend**: React 18 · TypeScript 5.3 · Vite · Tailwind + shadcn/ui · Zustand · TanStack Query · TipTap
- **Backend**: FastAPI · SQLAlchemy 2 · Pydantic v2 · Celery · PostgreSQL · Redis · kubernetes SDK · Ansible
- **Infra**: Docker · Kustomize · Helm · Skaffold · kind · ArgoCD · GitHub Actions CI/CD

## 빠른 시작 (로컬, Docker Compose)

```bash
cp .env.example backend/.env   # 환경 변수
docker-compose up -d           # postgres + redis + backend + frontend + celery
# Frontend  http://localhost:5173
# Backend   http://localhost:8000/docs
```

네이티브 개발 / 로컬 K8s(kind) 등 상세는 [docs/DEPLOY_GUIDE.md](docs/DEPLOY_GUIDE.md) 와
`make help` 참고.

## 문서

문서 색인은 [docs/README.md](docs/README.md). 주요 문서:

- [배포 가이드](docs/DEPLOY_GUIDE.md) · [관리자 매뉴얼](docs/ADMIN_MANUAL.md) · [요청 흐름](docs/PROJECT_FLOW_GUIDE.md)
- [브랜치·태그·릴리스 전략](docs/branch-tag-strategy.md) · [CHANGELOG](CHANGELOG.md)
- [OpenLens 차용 아키텍처 로드맵](docs/openlens-architecture-roadmap.md)
- 기여/개발: [CONTRIBUTING.md](CONTRIBUTING.md) · 보안: [SECURITY.md](SECURITY.md)
- AI 어시스턴트 컨텍스트: [CLAUDE.md](CLAUDE.md) · 재사용 작업 플레이북: `.claude/skills/`

## 저장소 구조

```
devops_management/
├── backend/        # FastAPI (app/{models,routers,services,...})
├── frontend/       # React + TS (src/{pages,components,hooks,services,stores})
├── k8s/            # Kustomize base + overlays(dev/prod/airgap/kind)
├── helm/           # Helm chart
├── ansible/        # 플레이북
├── argocd/         # ArgoCD Application/Project
├── scripts/        # kind/airgap/init 스크립트
├── docs/           # 운영/설계/아카이브 문서
└── .claude/skills/ # 재사용 작업 플레이북
```

## 라이선스

Proprietary · 내부 전용. 자세한 내용은 [LICENSE](LICENSE) 참고.
