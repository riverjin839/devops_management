# 지식베이스(서비스별 문서·노트) 설계 — Knowledge Base

> PEP 의 "파트 담당 업무를 **서비스별 하위로 나눠** 페이지/노트/문서로 만들어 **공유·히스토리 관리**" 요구에 대한 설계 문서.
> 벤치마킹 기준: **AppFlowy** (`https://github.com/AppFlowy-IO/AppFlowy.git`), **AFFiNE** (`https://github.com/toeverything/AFFiNE.git`) — CLAUDE.md "참고 프로젝트" 참조.

상태: **설계 합의용 초안** (구현 전). 구현은 단계(P1~)별로 별도 진행.

---

## 1. 목적 / 범위

- 서비스(K8s, Keycloak, Nexus …)별로 담당 업무를 **고도화 / 운영업무 / 기술학습 / 구축** 으로 나눠 문서화.
- 문서를 **파트 내 공유**하고, 변경 **히스토리(버전)** 를 남겨 추적·복원.
- **고도화** 분류는 일반 문서 트리 외에 **년 / 분기 / 월 / 주 / 스프린트** 단위 **로드맵(타임라인) 뷰** 제공.
- 두 오픈소스(Notion 계열)에서 **트리/Space, DB뷰, 캘린더·타임라인, 버전 히스토리, 백링크, 블록 강화, 공유** 개념을 우리 스택(React+TipTap / FastAPI)에 맞게 차용.

### 결정된 사항 (사용자 합의)
| 항목 | 결정 |
|---|---|
| 데이터 모델 | **신규 `KnowledgePage` 전용 모델** (에디터·트리 UI 는 재사용) |
| 히스토리 | **자동 스냅샷 + 수동 마일스톤 버전** 병행 |
| 공유/권한 | **파트 전체 공유 기본 + 문서별 '비공개' 토글 + 소유자** (외부 공유 링크는 미채택) |
| 착수 | **설계문서 먼저** → 합의 후 구현 |

---

## 2. 정보 구조 (IA)

```
서비스(Service)            ← K8s, Keycloak, Nexus, Cilium, ArgoCD, Jenkins …  (SERVICE_CATALOG 12종 + custom)
└ 분류(Category)           ← 고도화 / 운영업무 / 기술학습 / 구축   (표준 enum, 확장 가능)
   └ 하위분류(Sub)          ← 예) 운영업무 → 업무대응 / 운영프로세스   (parent_id 중첩, 깊이 제한 없음)
      └ 문서(Document)      ← 실제 페이지(TipTap) — 공유·히스토리 대상
```

- **분류(Category)** 표준값: `enhancement`(고도화), `operation`(운영업무), `learning`(기술학습), `build`(구축). 자유 추가 가능.
- 노드 종류(`kind`): `folder`(폴더) · `doc`(문서) · `board`(칸반/그리드) · `roadmap`(타임라인). 고도화는 보통 `roadmap`, 업무대응은 `board`, 그 외는 `doc`.
- 트리 루트는 **서비스 = Space** (AppFlowy 의 Space 개념 차용).

---

## 3. 데이터 모델 (백엔드)

> 신규 모델. 경량 마이그레이션(`_safe_add_column` / `_safe_create_index`)으로 추가. Alembic 없음(프로젝트 규칙).

### 3.1 `knowledge_pages`
| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | UUID PK | |
| `service` | VARCHAR(64) | SERVICE_CATALOG slug. `null` = 서비스 공통 |
| `parent_id` | UUID FK→self, null | 트리 부모. null = 서비스 직속 루트 |
| `kind` | VARCHAR(16) | `folder` \| `doc` \| `board` \| `roadmap` (default `doc`) |
| `category` | VARCHAR(32), null | `enhancement` \| `operation` \| `learning` \| `build` \| … (L2 분류 표식) |
| `title` | VARCHAR(200) | |
| `icon` | VARCHAR(64), null | 이모지 / lucide 이름 / data-url (AppFlowy 페이지 아이콘 차용) |
| `content` | TEXT, null | TipTap HTML. folder/board/roadmap 은 비거나 뷰 설정 보관 |
| `summary` | VARCHAR(500), null | 목록/검색용 요약 |
| `tags` | JSONB | `list[str]` |
| `status` | VARCHAR(16) | `draft` \| `active` \| `archived` (default `active`) |
| `visibility` | VARCHAR(16) | `part`(파트공유) \| `private`(소유자만) (default `part`) |
| `pinned` | BOOL | default false |
| `sort_order` | INT | 동일 부모 내 정렬 |
| `confluence_url` | TEXT, null | 외부 링크 호환 |
| `jira_url` | TEXT, null | 외부 링크 호환 |
| `start_at` | DateTime, null | 로드맵/일정 항목 시작 |
| `due_at` | DateTime, null | 로드맵/일정 항목 마감 |
| `sprint_id` | UUID FK→sprints, null | 고도화 항목의 스프린트 매핑 (기존 sprints 재사용) |
| `created_by` | VARCHAR(64) | 소유자 username |
| `updated_by` | VARCHAR(64), null | 마지막 수정자 |
| `created_at` / `updated_at` | DateTime | |

인덱스: `(service, parent_id, sort_order)`, `(service, category)`, `(sprint_id)`, `(visibility, created_by)`.

### 3.2 `knowledge_page_versions` (히스토리)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | UUID PK | |
| `page_id` | UUID FK→knowledge_pages | |
| `version_no` | INT | 페이지별 증가 번호 |
| `kind` | VARCHAR(8) | `auto`(자동 스냅샷) \| `milestone`(수동 고정) |
| `label` | VARCHAR(200), null | 마일스톤 이름 (kind=milestone) |
| `title` | VARCHAR(200) | 스냅샷 당시 제목 |
| `content` | TEXT | 스냅샷 당시 본문(HTML) |
| `author` | VARCHAR(64) | 작성자 |
| `created_at` | DateTime | |

- **자동 스냅샷**: `PUT` 저장 시 직전 버전과 내용이 다르면 `auto` 버전 생성. 과다 방지를 위해 **디바운스/병합**(예: 동일 작성자가 N분 내 연속 저장하면 마지막 것만 유지) — 보존 정책은 §9.
- **수동 마일스톤**: 사용자가 "버전 저장"하면 `milestone` + `label`. 영구 보존(자동 정리 대상 제외).
- **복원**: 특정 버전을 현재로 되돌리면, 되돌리기 직전 상태를 먼저 `auto` 로 스냅샷한 뒤 본문 교체(되돌리기도 추적).

### 3.3 `knowledge_backlinks` (P3, 선택)
`source_page_id`, `target_page_id` — 본문의 `[[문서]]` 링크를 파싱해 인덱싱. "이 문서를 참조하는 곳"(AFFiNE linked references) 패널용.

### 3.4 백업 호환 (CLAUDE.md 규칙)
- `knowledge_page_versions` 는 대용량 가능 → `backup_service.LOG_TABLES` 에 등록(`include_logs=False` 시 제외).
- 민감 컬럼 없음(SENSITIVE 불필요).
- 신규 컬럼/테이블은 `_run_migrations()` 에 `_safe_*` 로 추가하고 `export_all`/`compute_diff` per-table 패턴 유지.

---

## 4. API (FastAPI, `/api/v1`)

라우터 신규: `backend/app/routers/knowledge.py` → `__init__.py` export → `main.py` include.

### 페이지/트리
| Method | Path | 설명 |
|---|---|---|
| GET | `/knowledge/pages` | 평면 목록 (filter: `service`,`category`,`kind`,`status`,`parent_id`,`q`) |
| GET | `/knowledge/pages/tree` | 중첩 트리 (filter: `service`) |
| POST | `/knowledge/pages` | 생성 (require_operator) |
| GET | `/knowledge/pages/{id}` | 단건 (private 면 소유자만) |
| PUT | `/knowledge/pages/{id}` | 수정 — 저장 시 자동 버전 |
| DELETE | `/knowledge/pages/{id}` | 삭제 (소유권 검사) |
| POST | `/knowledge/pages/{id}/move` | `parent_id`/`sort_order` 재배치 (드래그 정렬) |

### 버전(히스토리)
| Method | Path | 설명 |
|---|---|---|
| GET | `/knowledge/pages/{id}/versions` | 버전 타임라인 |
| GET | `/knowledge/versions/{vid}` | 버전 본문(읽기/diff용) |
| POST | `/knowledge/pages/{id}/versions` | 수동 마일스톤 저장 (`label`) |
| POST | `/knowledge/pages/{id}/restore/{vid}` | 해당 버전으로 복원 |

### 고도화 로드맵
| Method | Path | 설명 |
|---|---|---|
| GET | `/knowledge/roadmap` | 일정 항목 조회 (filter: `service`, `bucket=year\|quarter\|month\|week`, `from`,`to`, `category=enhancement`) → `start_at/due_at/sprint_id` 보유 항목 반환 |

### 백링크 (P3)
| Method | Path | 설명 |
|---|---|---|
| GET | `/knowledge/pages/{id}/backlinks` | 이 문서를 참조하는 페이지 목록 |

**권한**: 생성/수정/삭제는 `require_operator` + `_assert_ownership` 패턴(기존 work_items 와 동일). 조회는 `visibility=private` 이면 `created_by == actor` 만. 외부 무인증 공유 링크는 본 설계 범위 밖(미채택).

---

## 5. 프런트엔드

### 타입 / API / 훅
- `types/index.ts`: `KnowledgePage`, `KnowledgePageVersion`, `RoadmapItem`, enums(`KnowledgeKind`,`KnowledgeCategory`,`Visibility`).
- `services/api.ts`: `knowledgeApi` (pages/tree/move/versions/restore/roadmap/backlinks). camelCase↔snake_case 인터셉터 자동 변환 사용.
- `hooks/`: `useKnowledgeTree`, `useKnowledgePage`, `usePageVersions`, `useRoadmap`, mutations(`useCreate/Update/Delete/MovePage`, `useSaveMilestone`, `useRestoreVersion`).

### 페이지: `KnowledgeBasePage` (`/knowledge`, '지식/분석' 그룹에 메뉴 추가)
레이아웃: 좌측 트리 + 우측 본문 (MacCard 컨벤션).

- **좌: 트리 사이드바** (AppFlowy 차용) — 서비스(Space) → 분류 → 하위 → 문서. 펼침/접힘, 드래그 정렬(`/move`), `+` 하위 추가, 인라인 이름변경, 아이콘/이모지, 즐겨찾기/최근.
  - ⚠ 이건 **문서 탐색 트리**라 라벨이 필요 → 클러스터 `ClusterSidebar`(iconOnly) 규칙과는 다른 별도 컴포넌트. (클러스터 선택 UI 아님)
- **우: 선택 노드 종류별 뷰**
  - `doc` → `RichTextEditor`(편집) / `RichContent`(읽기) + **breadcrumb**(서비스/분류/문서) + **버전 히스토리 패널** + **백링크 패널**(P3).
  - `board` → 칸반/그리드 (예: 운영업무>업무대응 — 각 카드=문서, AppFlowy "row=document" 차용).
  - `roadmap` → §6 타임라인 뷰.
  - 헤더에 **공유 토글**(파트공유/비공개) + 소유자 표시.

### 사이드바/라우팅 등록
- `Sidebar.tsx` '지식/분석' 그룹(`paths`)에 `/knowledge` 추가, `NAV_MAP` 메뉴 엔트리.
- `App.tsx` 라우트: `/knowledge`, `/knowledge/:id`.

---

## 6. 고도화 로드맵 뷰 (년/분기/월/주/스프린트)

> 사용자 강조 요구. 기존 자산 재사용: **Sprint(`useSprints`)**, **WBS 간트(`WbsFlowPage`)**, 그리고 AppFlowy 의 **Calendar/타임라인 DB뷰** 개념.

- 고도화 분류의 항목(문서 또는 board row)에 `start_at` / `due_at` / `sprint_id` 부여.
- **뷰 토글**: `년`(분기 칼럼) · `분기`(월) · `월`(주/일) · `주`(일) · `스프린트`(스프린트 swimlane).
- 같은 데이터를 **타임라인(간트) / 캘린더 / 리스트** 로 토글(AppFlowy 다중 뷰).
- 항목 클릭 → 문서로 오픈(편집/히스토리/공유 그대로). "계획(로드맵)"과 "내용(문서)"이 한 객체.
- 구현은 `WbsFlowPage` 의 간트 렌더/기간 계산 로직을 추출·재사용하고 bucket 단위만 추가.

---

## 7. 차용 기능 매핑 (AppFlowy / AFFiNE → PEP)

| 출처 | 차용 기능 | PEP 적용 | 단계 | 난이도 |
|---|---|---|---|---|
| AppFlowy | Space + 중첩 페이지 트리(드래그 정렬·하위추가·아이콘) | 서비스=Space, 분류·문서 트리 사이드바 | P1 | 中 |
| AppFlowy | 페이지 = 문서/DB뷰(Grid·Board·Calendar), row=문서 | 업무대응 board, 고도화 roadmap, row 오픈 | P4 | 中~高 |
| AppFlowy | 페이지 이모지/아이콘, breadcrumb, 즐겨찾기/최근 | 시각 식별·탐색 | P1 | 低 |
| AFFiNE | **문서 버전 히스토리 + 복원(타임트래블)** | versions 테이블 + 타임라인·diff·복원 | P2 | 中 |
| AFFiNE | 백링크 + "참조하는 곳"(linked references) | `[[ ]]` 인덱싱 → 역참조 패널 | P3 | 中 |
| AFFiNE | 블록 강화(슬래시/드래그핸들/토글/콜아웃) | TipTap 확장 | P5 | 低~中 |
| AFFiNE | 공유 + 문서 권한/공개범위 | visibility(파트/비공개)+소유자 | P3 | 中 |
| AFFiNE | 실시간 협업(Yjs CRDT, 멀티커서) | **보류** — LWW + 버전 히스토리 + "편집중" 표시로 대체 | P5(선택) | 高 |

---

## 8. 단계 계획

- **P1 — 구조/트리/문서**: `KnowledgePage` 모델·API, 서비스 트리 사이드바, 문서 편집/읽기, breadcrumb, 메뉴/라우팅.
- **P2 — 히스토리**: 자동 스냅샷 + 수동 마일스톤, 타임라인·diff·복원.
- **P3 — 공유/백링크**: visibility(파트/비공개)+소유자, 백링크 역참조 패널.
- **P4 — 고도화 로드맵**: 년/분기/월/주/스프린트 타임라인 + 캘린더/리스트 토글 (Sprint·WBS 재사용). *사용자 강조 요구라 P2와 병행 앞당김 가능.*
- **P5 — 블록 강화·DB뷰·(선택)실시간 협업**.

---

## 9. 미해결 / 추후 결정

- **자동 스냅샷 보존 정책**: 개수 상한 + 기간(예: 최근 30개 + 일자별 1개 + 마일스톤 영구) — 구현 시 확정.
- **기존 자산 흡수**: `ServiceEntry`(kind=note/guide…) · `WorkGuide`(트리) · `OpsNote` 와 개념 중복. 장기적으로 `KnowledgePage` 로 흡수/마이그레이션할지 별도 결정(초기엔 공존, KnowledgeHub 에 `kind=knowledge` 로 통합 노출).
- **실시간 협업(Yjs)** 도입 시점.
- **외부 공유 링크** 필요해지면 토큰 모델 추가(현재 미채택).

---

## 10. 영향 받는 파일 (구현 시)

- 백엔드: `models/knowledge_page.py`(신규), `schemas/knowledge.py`(신규), `routers/knowledge.py`(신규), `routers/__init__.py`·`main.py`(등록·마이그레이션), `services/backup_service.py`(LOG_TABLES).
- 프런트: `types/index.ts`, `services/api.ts`, `hooks/useKnowledge*.ts`(신규), `pages/KnowledgeBasePage.tsx`(신규), `components/knowledge/*`(트리·히스토리·로드맵·공유), `components/layout/Sidebar.tsx`, `App.tsx`.
- 재사용: `components/editor/*`(RichTextEditor/RichContent/docTemplates), `serviceCatalog.ts`, `useSprints`, `WbsFlowPage` 간트 로직.
