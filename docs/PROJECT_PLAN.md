## DEVOPS MANAGEMENT - DevOps Daily 운영 모니터링 시스템

> ⚠️ **이 문서는 프로젝트 착수 시점(2025년 초, 구명 `k8s_daily_monitor`)의 최초 기획서이며
> 보관용입니다. 이후 "PEP(Platform Engineering Portal)"로 리브랜딩(2026-05)됐고, 아래
> 프로젝트 구조·개발 로드맵(Phase 1~4)은 현재 상태를 반영하지 않습니다(예: Alembic 마이그레이션
> 서술은 실제로 채택되지 않음 — 현재는 `_run_migrations()` 경량 방식). 현재 아키텍처/기능은
> [README.md](../README.md) · [CLAUDE.md](../CLAUDE.md) · [CODE_MAP.md](../CODE_MAP.md) 를
> 신뢰하세요.

---

## 프로젝트 개요

DevOps 팀의 일일 운영 모니터링을 위한 심플하고 모던한 웹 대시보드다. 멀티 Kubernetes 클러스터 환경에서 주요 컴포넌트 상태를 실시간으로 확인하고, Ansible 기반 점검 스크립트를 통해 자동화된 헬스체크를 수행한다.

**GitHub Repository**: `k8s_daily_monitor`

---

## 핵심 목표

- **단일 화면**에서 모든 K8s 클러스터 상태 파악
- **트래픽 라이트 방식** (초록/주황/빨강) 직관적 상태 표시
- **Git 기반** 코드 관리로 지속적 발전 가능
- **모듈화 구조**로 쉬운 확장/수정/삭제

---

## 기술 스택

### Frontend
| 구분 | 기술 | 선택 이유 |
|------|------|-----------|
| Framework | **React 18 + Vite** | 거대한 생태계, TypeScript 네이티브 지원 |
| Language | **TypeScript** | 타입 안정성, 자동완성, 리팩토링 용이 |
| Styling | **Tailwind CSS** | 유틸리티 기반, 빠른 개발 |
| State | **Zustand** | 경량, 간단한 API, 보일러플레이트 최소 |
| Server State | **TanStack Query** | 캐싱, 자동 리페치, 로딩/에러 상태 |
| UI Components | **shadcn/ui** | 커스터마이징 용이, Radix 기반 접근성 |
| Charts | **Recharts** | React 친화적, 선언적 API |
| HTTP | **Axios** | 인터셉터, 에러 핸들링 |

### Backend
| 구분 | 기술 | 선택 이유 |
|------|------|-----------|
| Framework | FastAPI (Python) | 비동기 지원, Ansible 연동 용이 |
| Task Queue | Celery + Redis | 비동기 점검 작업 스케줄링 |
| DB | PostgreSQL | 히스토리/로그 저장, 안정성 |
| ORM | SQLAlchemy | Python 표준 ORM |

### Infra & Automation
| 구분 | 기술 | 선택 이유 |
|------|------|-----------|
| Health Check | Ansible Playbook | 기존 인프라 활용, 유연한 점검 |
| Container | Docker | 일관된 배포 환경 |
| Orchestration | K8s Deployment | 자체 K8s 위 운영 가능 |
| VCS | Git (GitHub) | 버전 관리, 협업, Actions CI/CD |

---

## 프로젝트 구조

```
k8s_daily_monitor/
├── frontend/                       # React Frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── ui/                # shadcn/ui 컴포넌트
│   │   │   ├── layout/
│   │   │   │   ├── Header.tsx
│   │   │   │   └── Sidebar.tsx
│   │   │   ├── dashboard/
│   │   │   │   ├── ClusterCard.tsx
│   │   │   │   ├── StatusBadge.tsx
│   │   │   │   ├── AddonGrid.tsx
│   │   │   │   ├── SummaryStats.tsx
│   │   │   │   └── HistoryLog.tsx
│   │   │   └── common/
│   │   │       ├── Loading.tsx
│   │   │       └── ErrorBoundary.tsx
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── ClusterDetail.tsx
│   │   │   └── Settings.tsx
│   │   ├── stores/
│   │   │   └── clusterStore.ts    # Zustand store
│   │   ├── hooks/
│   │   │   ├── useCluster.ts      # TanStack Query hooks
│   │   │   └── useHealthCheck.ts
│   │   ├── services/
│   │   │   └── api.ts             # Axios instance
│   │   ├── types/
│   │   │   └── index.ts           # TypeScript types
│   │   ├── config/
│   │   │   └── addons.config.ts   # 애드온 설정
│   │   ├── lib/
│   │   │   └── utils.ts           # 유틸리티 함수
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── public/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── Dockerfile
│
├── backend/
│   ├── app/
│   │   ├── main.py                # FastAPI 엔트리
│   │   ├── routers/
│   │   │   ├── clusters.py        # 클러스터 CRUD API
│   │   │   ├── health.py          # 헬스체크 API
│   │   │   └── history.py         # 히스토리 API
│   │   ├── models/
│   │   │   ├── cluster.py         # 클러스터 모델
│   │   │   ├── addon.py           # 애드온 모델
│   │   │   └── check_log.py       # 점검 로그 모델
│   │   ├── schemas/
│   │   │   ├── cluster.py         # Pydantic 스키마
│   │   │   ├── addon.py
│   │   │   └── check_log.py
│   │   ├── services/
│   │   │   ├── ansible_runner.py  # Ansible 실행 서비스
│   │   │   └── health_checker.py  # 헬스체크 로직
│   │   ├── tasks/
│   │   │   └── celery_tasks.py    # Celery 비동기 태스크
│   │   ├── database.py            # DB 연결
│   │   └── config.py              # 환경 설정
│   ├── requirements.txt
│   ├── alembic/                   # DB 마이그레이션
│   ├── alembic.ini
│   └── Dockerfile
│
├── ansible/
│   ├── playbooks/
│   │   ├── check_cluster.yml      # 클러스터 점검 메인
│   │   ├── check_addons.yml       # 애드온별 점검
│   │   └── check_minio.yml        # MinIO S3 점검
│   ├── inventory/
│   │   └── clusters.yml           # 클러스터 인벤토리
│   └── roles/
│       ├── k8s-api/               # API Server 점검
│       ├── k8s-etcd/              # etcd 점검
│       ├── k8s-ingress/           # Ingress 점검
│       ├── k8s-metrics/           # Metrics Server 점검
│       └── minio/                 # MinIO 점검
│
├── docker/
│   ├── docker-compose.yml         # 로컬 개발용
│   └── docker-compose.prod.yml    # 프로덕션용
│
├── k8s-manifests/
│   ├── namespace.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── configmap.yaml
│   └── secret.yaml
│
├── .github/
│   └── workflows/
│       ├── ci.yml                 # CI 파이프라인
│       └── cd.yml                 # CD 파이프라인
│
├── docs/
│   ├── PROJECT_PLAN.md
│   ├── ARCHITECTURE.md
│   ├── API_SPEC.md
│   └── SETUP_GUIDE.md
│
├── .gitignore
├── .env.example
├── Makefile
└── README.md
```

---

## 데이터 모델

### clusters 테이블
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | UUID | PK |
| name | VARCHAR(100) | 클러스터 이름 |
| api_endpoint | VARCHAR(255) | K8s API 주소 |
| kubeconfig_path | VARCHAR(255) | kubeconfig 경로 |
| status | ENUM | healthy/warning/critical |
| created_at | TIMESTAMP | 생성일 |
| updated_at | TIMESTAMP | 수정일 |

### addons 테이블
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | UUID | PK |
| cluster_id | UUID | FK → clusters |
| name | VARCHAR(50) | 애드온 이름 |
| type | VARCHAR(50) | 카테고리 |
| check_playbook | VARCHAR(100) | 점검 playbook 경로 |
| status | ENUM | healthy/warning/critical |
| last_check | TIMESTAMP | 마지막 점검 시간 |

### check_logs 테이블
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | UUID | PK |
| cluster_id | UUID | FK → clusters |
| addon_id | UUID | FK → addons (nullable) |
| status | ENUM | 점검 결과 |
| message | TEXT | 상세 메시지 |
| raw_output | JSONB | Ansible 원본 출력 |
| checked_at | TIMESTAMP | 점검 시간 |

---

## API 엔드포인트

### Clusters
```
GET    /api/v1/clusters              # 전체 클러스터 목록
POST   /api/v1/clusters              # 클러스터 추가
GET    /api/v1/clusters/{id}         # 클러스터 상세
PUT    /api/v1/clusters/{id}         # 클러스터 수정
DELETE /api/v1/clusters/{id}         # 클러스터 삭제
```

### Health Check
```
POST   /api/v1/health/check/{cluster_id}     # 수동 점검 실행
GET    /api/v1/health/status/{cluster_id}    # 현재 상태 조회
GET    /api/v1/health/addons/{cluster_id}    # 애드온별 상태
```

### History
```
GET    /api/v1/history/{cluster_id}          # 점검 히스토리
GET    /api/v1/history/{cluster_id}/export   # CSV 내보내기
```

---

## 상태 판단 기준

| 상태 | 색상 | 조건 |
|------|------|------|
| Healthy | 🟢 초록 | 모든 체크 통과 |
| Warning | 🟠 주황 | 일부 체크 실패 or 응답 지연 |
| Critical | 🔴 빨강 | 핵심 컴포넌트 실패 |

---

## 개발 로드맵

### Phase 1: MVP (2주)
- [ ] 프로젝트 초기 설정 (React + FastAPI)
- [ ] 단일 클러스터 상태 표시
- [ ] 기본 Ansible playbook 작성
- [ ] 수동 점검 기능

### Phase 2: Core Features (3주)
- [ ] 멀티 클러스터 지원
- [ ] 애드온별 상태 카드
- [ ] 자동 점검 스케줄링 (Celery)
- [ ] 히스토리 로그 저장

### Phase 3: Enhancement (2주)
- [ ] 알림 연동 (Slack/Email)
- [ ] 대시보드 커스터마이징
- [ ] 권한 관리 (RBAC)
- [ ] 메트릭 차트 추가

### Phase 4: Production Ready (2주)
- [ ] 성능 최적화
- [ ] 테스트 코드 작성
- [ ] 문서화 완료
- [ ] CI/CD 파이프라인 구축

---

## Git 브랜칭 전략

```
main (production)
  └── develop
        ├── feature/cluster-crud
        ├── feature/health-check
        ├── feature/ansible-playbook
        └── bugfix/status-display
```

### 커밋 컨벤션
- `feat:` 새 기능
- `fix:` 버그 수정
- `docs:` 문서 수정
- `refactor:` 리팩토링
- `test:` 테스트 코드
- `chore:` 빌드, 설정 변경

---

## 실행 방법

### 로컬 개발
```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/k8s_daily_monitor.git
cd k8s_daily_monitor

# 2. Backend
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 3. Frontend
cd ../frontend
npm install
npm run dev

# 4. Docker Compose (전체)
docker-compose up -d
```

---

## 확장 가능성

- **Prometheus 연동**: 메트릭 수집 및 시각화
- **Grafana 임베딩**: 상세 대시보드 연결
- **ArgoCD 연동**: GitOps 배포 상태 확인
- **Cost 모니터링**: 클러스터별 비용 추적
