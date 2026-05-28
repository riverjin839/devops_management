# PEP — Platform Engineering Portal 재정의 설계

**날짜**: 2026-05-28
**브랜치**: feature/home-v2
**범위**: 앱 전체 재정의 — 브랜딩 + 내비게이션 + 홈 페이지 듀얼모드

---

## 1. 개요

### 1.1 배경

현재 앱은 "DevOps Management (K8s Daily Monitor)"로 시작했으나,
K8s 모니터링을 넘어 인프라 전체(Storage, Network, GPU, Server), DevOps 자동화,
팀 협업, 기술 공유까지 아우르는 도구로 성장했다.

이를 반영하여 **PEP (Platform Engineering Portal)** 로 정체성을 재정의한다.

### 1.2 Platform Engineer 정의

```
Platform Engineer = DevOps Engineer
                  + 인프라 영역 (Storage / Network / GPU / Server)
```

PEP는 Platform Engineer의 세 가지 역할을 지원한다:

1. **운영 도구** — 클러스터·인프라·네트워크·스토리지 상태 모니터링 및 제어
2. **팀 협업** — 엔지니어 간 업무 관리, 워크플로우, 커뮤니케이션
3. **기술 공유** — 운영 지식, 온톨로지, AI 분석, 트렌드 공유

### 1.3 이번 사이클 범위 (Option B — Phase 1)

| 작업 | 상태 |
|---|---|
| 앱 브랜딩 변경 (PEP) | 이번 사이클 |
| 내비게이션 9개 PE 도메인 재구조화 | 이번 사이클 |
| 홈 페이지 듀얼모드 (업무 ↔ 플랫폼 토글) | 이번 사이클 |
| Settings — 홈 클러스터 필터 옵션 (placeholder) | 이번 사이클 (UI만, 동작 미구현) |
| Network/SDN 도메인 확장 | 다음 사이클 |
| Storage 도메인 확장 | 이후 사이클 |
| DC 랙/물리 토폴로지 | 이후 사이클 |
| GPU/AI 도메인 | 이후 사이클 |

---

## 2. 브랜딩

| 항목 | 현재 | 변경 후 |
|---|---|---|
| 앱 이름 | DevOps Management | **PEP** |
| 풀네임 | K8s Daily Monitor | **Platform Engineering Portal** |
| HTML `<title>` | DevOps Management | `PEP — Platform Engineering Portal` |
| Header 타이틀 | (현재) | `PEP` + 부제 `Platform Engineering Portal` |
| CLAUDE.md 프로젝트 설명 | K8s Daily Monitor | Platform Engineering Portal |

---

## 3. 내비게이션 재구조화

### 3.1 설계 원칙

K8s 클러스터를 중심 허브로, 물리 레이어(서버/인프라)부터 논리 레이어(네트워크/스토리지),
애플리케이션 레이어까지 방사형으로 구성한다.

```
                    ┌──────────────┐
                    │  K8s 클러스터 │  ← 중심 허브
                    └──────┬───────┘
           ┌───────────────┼────────────────────┐
           ↓               ↓                    ↓
    물리 레이어          연결 레이어           앱 레이어
  (서버/인프라/OS)    (네트워크/스토리지)    (서비스/앱/플로우)
```

### 3.2 그룹 매핑 (9개)

| # | 그룹 ID | 레이블 | 아이콘 | 포함 경로 |
|---|---|---|---|---|
| 1 | `cluster` | 클러스터 | `Layers` | `/cluster-overview`, `/daily-check/review`, `/daily-check/settings`, `/pod-bottleneck`, `/versions`, `/bulk-exec`, `/etcdctl`, `/cluster-manage` |
| 2 | `server` | 서버/인프라 | `Server` | `/node-specs`, `/node-labels`, `/node-images`, `/kernel-params`, `/infra-topology` |
| 3 | `network` | 네트워크 | `Network` | `/cilium-trace`, `/packet-flow`, `/cidr`, `/links` |
| 4 | `storage` | 스토리지 | `Database` | `/mc` |
| 5 | `services` | 서비스/앱 | `Package` | `/lake-services` |
| 6 | `devops` | DevOps | `GitBranch` | `/playbooks`, `/batch-jobs`, `/commands` |
| 7 | `collab` | 협업 | `Users` | `/tasks-mgmt`, `/todo-today`, `/work-summary`, `/members`, `/workflow`, `/wbs` |
| 8 | `knowledge` | 지식/분석 | `BookOpen` | `/docs`, `/ops-notes`, `/mindmap`, `/incident-analysis`, `/ontology`, `/trends` |
| 9 | `system` | 시스템 | `Settings` | `/settings` |

### 3.3 페이지 이동 (현재 → 신규 그룹)

| 페이지 | 현재 그룹 | 신규 그룹 |
|---|---|---|
| `/infra-topology`, `/node-specs`, `/node-labels`, `/node-images`, `/kernel-params` | cluster | server |
| `/cilium-trace`, `/packet-flow`, `/cidr`, `/links` | cluster / analysis | network |
| `/mc` | cluster | storage |
| `/lake-services` | monitoring | services |
| `/playbooks`, `/batch-jobs`, `/commands` | monitoring / cluster | devops |
| `/incident-analysis`, `/ontology`, `/trends` | analysis | knowledge |
| `/workflow`, `/wbs` | docs | collab |
| `/ops-notes`, `/mindmap` | docs | knowledge |

### 3.4 신규 도메인 슬롯 (미래 사이클)

| 도메인 | 예정 경로 | 설명 |
|---|---|---|
| Network/SDN | `/sdn-topology` | SDN 논리 네트워크 맵 |
| 물리 DC | `/dc-rack` | 랙·서버·스위치·포트·DC 위치 가상화 |
| Storage | `/storage-overview` | Ceph/NFS/Isilon/PVC 통합 대시보드 |
| GPU/AI | `/gpu-nodes` | GPU 노드 상태 + AI 워크로드 |

---

## 4. 홈 페이지 — 듀얼모드 토글

### 4.1 핵심 개념

홈에 두 가지 뷰가 존재하며, **사이드바 홈 아이콘을 이미 홈(`/`)에 있을 때 다시 클릭**하면 토글된다.

| 모드 | 이름 | 내용 | 홈 아이콘 |
|---|---|---|---|
| **Mode A** (기본) | 업무 모드 | 나의 업무 현황 — 전체 화면, 클러스터 사이드바 없음 | `Home` |
| **Mode B** | 플랫폼 모드 | 인프라 건강 KPI + 인시던트 + 도메인 빠른 접근 | `LayoutDashboard` |

### 4.2 토글 동작

```
사이드바 홈 아이콘 클릭
  ├─ 현재 경로 ≠ '/'  →  navigate('/')  + mode = 'work' (기본)
  └─ 현재 경로 = '/'  →  mode 토글 ('work' ↔ 'platform')
```

**아이콘 & 오버레이 메시지 (tooltip)**:

| 현재 모드 | 홈 아이콘 | hover 툴팁 |
|---|---|---|
| Mode A (업무) | `Home` | `"플랫폼 현황 보기"` |
| Mode B (플랫폼) | `LayoutDashboard` | `"업무 현황으로 돌아가기"` |

**상태 저장**: `localStorage('pep:homeMode')` — `'work' | 'platform'`, 기본값 `'work'`

### 4.3 Mode A — 업무 모드 (기본)

> **ClusterSidebar 제거** — 업무 모드는 클러스터 컨텍스트 없이 개인/팀 업무에 집중.
> 클러스터 필터 원하는 경우 Settings에서 추후 활성화 가능 (4.5 참고).

```
┌─────────────────────────────────────────────────┐
│  인사말 + 날짜 + KPI 알약  (full width)           │
├──────────────────────┬──────────────────────────┤
│  MemberTodayTodos    │  WorkCalendar             │
│  (좌, 더 크게)       │  (우)                     │
│                      │                           │
└──────────────────────┴──────────────────────────┘
```

변경 사항:
- `ClusterSidebar` 제거 → full-width 레이아웃으로 전환
- 기존 `MemberTodayTodos`, `WorkCalendar`, KPI 알약 — 유지

### 4.4 Mode B — 플랫폼 모드

```
┌──────────────────────────────────────────────────────┐
│  [InfraHealthBar — 1줄 소형 pill 바]                  │
│  ☸️ 클러스터 N/N healthy  🖥️ 노드 N  ⚠️ 경고 N      │
├──────────────────────────────────────────────────────┤
│  [IncidentMiniPanel — 기본 collapsed, 토글 가능]      │
│  🔴 critical N건  🟡 warning N건  [전체보기 →]        │
│  └─ 클러스터명: 메시지 최대 3건                       │
├──────────────────────────────────────────────────────┤
│  [DomainQuickAccess — 9개 도메인 소형 카드 그리드]    │
│  ☸️클러스터  🖥️서버  🌐네트워크  🗄️스토리지          │
│  📦서비스    ⚙️DevOps  👥협업   📚지식/분석           │
└──────────────────────────────────────────────────────┘
```

### 4.5 Settings — 홈 클러스터 필터 옵션 (이번 사이클: placeholder만)

Settings 페이지 "홈 화면" 섹션에 토글 항목 추가:

```
홈 화면 설정
  └─ [ ] 업무 모드에서 클러스터 필터 표시   (비활성, "추후 지원 예정" 배지)
```

실제 동작은 구현하지 않고 UI 항목만 추가. 향후 사이클에서 기능 확장.

---

## 5. 신규 컴포넌트

### `homeStore.ts` (Zustand)
```ts
interface HomeStore {
  mode: 'work' | 'platform';
  toggle: () => void;
  setMode: (m: 'work' | 'platform') => void;
}
// localStorage('pep:homeMode') 동기화
```

### `InfraHealthBar`
- 위치: Mode B 최상단
- 데이터: `useQuery(['infra-health'])` → `GET /api/v1/clusters/` + `GET /api/v1/daily-check/summary`
- staleTime: 5분
- 크기: `h-9` 1줄 pill 바

### `IncidentMiniPanel`
- 위치: Mode B 중단, 기본 `collapsed={true}`
- 데이터: daily-check summary에서 critical/warning 추출
- 표시: severity별 카운트 + 최신 메시지 최대 3건
- 클릭 → `/daily-check/review?cluster=X`

### `DomainQuickAccess`
- 위치: Mode B 하단
- 9개 도메인 아이콘+레이블 카드 (`grid-cols-4 md:grid-cols-9`)
- 각 카드 → 해당 그룹 첫 페이지 navigate

---

## 6. 구현 대상 파일

| 파일 | 변경 유형 | 내용 |
|---|---|---|
| `frontend/src/components/layout/Sidebar.tsx` | 수정 | GROUPS 9개 PE 도메인 + 홈 토글 로직 (아이콘 + 툴팁) |
| `frontend/src/components/layout/Header.tsx` | 수정 | PEP 이름/부제 표시 |
| `frontend/src/pages/HomePage.tsx` | 수정 | 듀얼모드 분기: Mode A(ClusterSidebar 제거, full-width) / Mode B(3개 신규 컴포넌트) |
| `frontend/src/stores/homeStore.ts` | 신규 | homeMode zustand store + localStorage 동기화 |
| `frontend/src/components/dashboard/InfraHealthBar.tsx` | 신규 | 인프라 건강 KPI 바 |
| `frontend/src/components/dashboard/IncidentMiniPanel.tsx` | 신규 | 인시던트 미니 패널 (기본 collapsed) |
| `frontend/src/components/dashboard/DomainQuickAccess.tsx` | 신규 | 도메인 빠른 접근 카드 |
| `frontend/src/pages/SettingsPage.tsx` | 수정 | "홈 화면" 섹션 + 클러스터 필터 placeholder 토글 추가 |
| `frontend/index.html` | 수정 | `<title>PEP — Platform Engineering Portal</title>` |
| `CLAUDE.md` | 수정 | 프로젝트 이름 및 설명 업데이트 |

---

## 7. 기술 제약

- **ESLint max-warnings 0** — 신규 컴포넌트 모두 lint-clean
- **TypeScript strict** — `any` 금지
- **TanStack Query** — InfraHealthBar/IncidentMiniPanel 데이터는 `useQuery`, staleTime 5분
- **Tailwind only** — 인라인 스타일 금지
- **MacCard 패턴** — Mode B 패널에도 MacCard 사용
- **Zustand** — homeMode는 homeStore, localStorage 동기화

---

## 8. 다음 사이클 계획

| 사이클 | 주제 |
|---|---|
| Cycle 2 | Network/SDN — cilium-trace/packet-flow 통합 + SDN 토폴로지 신규 |
| Cycle 3 | Storage — MinIO/Ceph/NFS/Isilon/PVC 통합 대시보드 |
| Cycle 4 | 물리 DC 랙 뷰 — 서버/스위치/포트/DC 위치 가상화 |
| Cycle 5 | GPU/AI — GPU 노드 모니터링 + AI 워크로드 |
| Cycle 6 | 홈 업무모드 클러스터 필터 (Settings 옵션 실제 동작 구현) |
