# 지식허브 · 서비스 카탈로그 · 업무관리 — 목적 적합성 분석

> Feature: `knowledge-services-coherence`
> Date: 2026-05-20
> Branch: `feature/home-v2` @ `ef55620`
> Method: 사용자 명시 의도서를 Design 대체로 사용한 PDCA Check (analyze) — 표준 docs/02-design/ 부재

## 📌 사용자 명시 의도 (Design 대체)

| 구분 | 내용 |
|---|---|
| **WHAT** | 업무관리 + 서비스 카탈로그 + 지식허브 — 운영 지식을 모으는 게시판 군 |
| **WHO** | DevOps 파트원 (운영 멤버) |
| **WHY 1** | 서비스 별로 **업무 이력**을 남긴다 |
| **WHY 2** | 파트원에게 **공유 / 전파**한다 |
| **WHY 3** | **장애 재발 방지** 목표로 정리한다 |

## 📊 Executive Summary

| 목적 | 구조적 매치 | 기능적 깊이 | 결론 |
|---|---|---|---|
| **1. 서비스별 업무 이력** | ⚠️ 부분 — 컬럼은 모든 모델에 있으나 통합 뷰가 분산 | 30% | **불완전 통합** — 같은 서비스의 이력이 4개 뷰로 갈라짐 |
| **2. 파트원 공유 / 전파** | ⚠️ 부분 — 클립보드 복사만 | 25% | **수동 푸시 only** — 자동 알림 인프라는 있으나 헬스체크 전용 |
| **3. 장애 재발 방지** | ❌ 미흡 — placeholder text + 매뉴얼 가이드만 | 15% | **자동 적립 없음** — IncidentAnalysis 가 어디에도 저장 안 됨 |

**종합 Match Rate (의도 vs 구현)**: **23% / 100** — 데이터 모델은 있으나 통합·자동화·전파 흐름이 미완성.

---

## 1. 현재 라우팅 / 데이터 모델 매핑

### 1.1 화면 진입점 9개 — 서비스 / 업무 / 지식 영역

| 경로 | 페이지 | 역할 | 다루는 모델 |
|---|---|---|---|
| `/docs` | `KnowledgeHubPage` | 통합 지식 허브 (목록·검색) | OpsNote + Command + WorkGuide + WorkItem(issue만) + Workflow |
| `/services` | `ServicesCatalogPage` | 서비스 카탈로그 (12 서비스) | 마스터 데이터 |
| `/services/:service` | `ServiceHubPage` | 서비스별 entries 게시판 | ServiceEntry (5 kind) |
| `/tasks-mgmt` | `WorkItemBoardPage` | 통합 업무 게시판 | WorkItem (5 type) |
| `/tasks-mgmt/:id` | `WorkItemDetailPage` | 업무 상세 | WorkItem |
| `/ops-notes` | `OpsNotesPage` | 운영 노트 | OpsNote |
| `/work-guides` | `WorkGuidePage` | 작업 가이드 | WorkGuide |
| `/commands` | `CommandsPage` | 명령어 사전 | Command |
| `/incident-analysis` | `IncidentAnalysisPage` | AI 장애 분석 | (저장 없음 — 화면 표시만) |

### 1.2 데이터 모델 × `service` 컬럼 × 통합 표시

| 모델 | `service` 필드 | KnowledgeHub 통합? | ServiceHub 표시? | 알림 트리거? |
|---|---|---|---|---|
| `WorkItem` (task/issue/meeting/training/etc) | optional | issue 만 (`type !== 'issue' continue`) | ❌ | ❌ |
| `ServiceEntry` (note/guide/troubleshoot/history/link) | **required** | ❌ | ✅ | ❌ |
| `OpsNote` | **required** | ✅ | ❌ | ❌ |
| `WorkGuide` | 없음 | ✅ | ❌ | ❌ |
| `Command` | 없음 | ✅ | ❌ | ❌ |
| `Workflow` | 없음 | ✅ | ❌ | ❌ |

핵심 발견: **`service` 컬럼은 4개 모델에 있으나 그 4개를 동시에 보여주는 화면이 0개**.

---

## 2. 목적별 점검

### 🎯 목적 1: 서비스 별 업무 이력

**의도**: "k8s 서비스에 우리 팀이 한 모든 일 (이슈/작업/노트/트러블슈팅/가이드/이력)을 한 자리에서 본다"

#### 점검 결과

✅ **데이터 모델은 준비됨**:
- `WorkItem.service?: string` (`types/index.ts:307` — `통합지식 service tag` 주석)
- `ServiceEntry.service: string` (`types/index.ts:1598`, required)
- `OpsNote.service: string` (`types/index.ts:556`, required)
- 모두 `serviceCatalog.ts:24`의 12개 슬러그 (`k8s` / `keycloak` / ... / `other`) 와 매핑

⚠️ **부분 통합**:
- `ServicesCatalogPage` (`/services`) 가 ServiceCatalogResponse 의 `total + byKind + lastUpdated` 를 보여줌
  → 단 이건 **ServiceEntry 통계만** 집계. WorkItem / OpsNote 갯수는 안 들어감.
- `KnowledgeHubPage` (`/docs`) 가 5종을 통합하지만 **`service` 필터 UI 없음** (`KnowledgeHubPage.tsx:298-303`)
  → HubItem.service 필드를 매핑은 하지만 그걸로 필터링하는 chip/select 없음.

❌ **명확한 갭**:
1. `ServiceHubPage` 가 같은 서비스의 **WorkItem / OpsNote 를 표시하지 않음** — service_entries 만 보여줌 (`ServiceHubPage.tsx:35-42`).
2. `KnowledgeHubPage` 가 **`type === 'task'` 인 WorkItem 을 명시 제외** (`KnowledgeHubPage.tsx:265`: `if (i.type !== 'issue') continue`) — 작업·회의·교육·기타가 모두 빠짐.
3. `KnowledgeHubPage` 가 **`ServiceEntry` 를 통합 대상에서 빠뜨림** — KIND_META 5종에 service_entry 없음.
4. `WorkItemBoardPage` 가 **`service` 필터 없음** (`WorkItemBoardPage.tsx` 에서 service 필터 코드 0건) — service 컬럼은 저장하지만 보드에서 필터할 수 없음.

**점수**: 30/100 — 사용자가 "k8s 의 모든 이력" 을 보려면 `/services/k8s` (ServiceEntry) + `/tasks-mgmt` (필터 없음 → 수동 검색) + `/ops-notes` (필터 없음 → 수동) + `/docs` (service 필터 없음) 를 다 돌아야 함.

---

### 🎯 목적 2: 파트원 공유 / 전파

**의도**: "내가 정리한 업무 이력 / 트러블슈팅 / 장애 처리를 파트원이 알게 한다 (능동 푸시)"

#### 점검 결과

✅ **수동 공유 도구는 존재**:
- `ServiceHubPage.tsx:91-121` — "공유 URL 복사" / "Markdown 복사 (Slack/Teams)" 버튼 (entry 마다)
- `WorkItem.primaryAssignee` + `secondaryAssignee` — 협업자 지정 가능
- `MemberTodayTodos`, `MemberBoardPage` — 멤버 단위 todo 가시화

✅ **알림 인프라는 이미 있음** (`backend/app/services/notifier.py`):
- SlackChannel / EmailChannel / WebhookChannel / K8sEventChannel — strategy 패턴
- 진입점 `notify_for_check_log(db, daily_check_log_id)`

❌ **명확한 갭**:
1. **알림 인프라가 클러스터 헬스체크 전용** — `notifier.py:6` 주석 "진입점: notify_for_check_log". WorkItem / ServiceEntry / OpsNote 등록·변경 시 트리거되지 않음.
2. **댓글 / 멘션 / 구독 모델 없음** — 코드 검색 결과 `@mention` / `subscribe` / `watcher` 모두 0 매치.
3. **변경 알림 없음** — 누가 작성/수정해도 다른 파트원에게 자동 푸시 없음.
4. **공유 = 수동 클립보드 복사 → Slack 붙여넣기** 만 가능. 사용자가 매번 행동해야 함.

**점수**: 25/100 — 인프라는 있으나 회로가 끊겨 있음.

---

### 🎯 목적 3: 장애 재발 방지 목표로 정리

**의도**: "한 번 발생한 장애의 원인·조치·재발방지책을 구조화해 다음에 같은 일이 안 일어나게 한다"

#### 점검 결과

✅ **재발 방지에 쓸 수 있는 조각들**:
- `WorkItem.type='issue'` + `resolution` 필드 (조치 내용) — `types/index.ts:298`
- `ServiceEntry kind='troubleshoot'` (트러블슈팅 항목)
- `WorkItem.relatedWorkItemId` — 재발 케이스를 원래 이슈에 연결 가능 (`types/index.ts:318`)
- `IncidentAnalysisPage` 별도 존재 (AI 기반 분석)

❌ **명확한 갭 — 자동 적립 흐름 없음**:
1. **IncidentAnalysisPage 가 분석 결과를 저장하지 않음** — `api.post|save|create|opsNotes|workItem|service_entry` 모두 0 매치 (`IncidentAnalysisPage.tsx`). AI가 분석해도 화면 닫으면 끝.
2. **Issue 해결 → Troubleshoot 지식 자동 승격 없음** — WorkItem 의 resolution 을 ServiceEntry kind='troubleshoot' 로 전환하는 코드 0건.
3. **재발 감지 없음** — 같은 (service + category) 또는 같은 에러 메시지의 신규 이슈가 들어와도 과거 케이스를 자동 매칭/경고하지 않음.
4. **Post-mortem 템플릿 없음** — ServiceEntryEditModal placeholder 에 `'증상 / 원인 / 해결 과정 / 재발 방지...'` 가이드 텍스트만 있고 (`ServiceEntryEditModal.tsx:206`), 구조화된 필드/체크리스트 없음.
5. **매뉴얼 가이드는 있음** — `docs/ADMIN_MANUAL.md:117`: "조치 내용(원인, 대응, 재발 방지)을 운영 메모 또는 티켓에 기록" — **자동 강제·검증 없음**.

**점수**: 15/100 — 재료는 있으나 학습 루프가 사람의 자율에 맡겨져 있음.

---

## 3. Gap List (severity ≥ Important, confidence ≥ 80%)

| ID | Severity | 영역 | 갭 | 영향 | 권장 조치 |
|---|---|---|---|---|---|
| G1 | **Critical** | 목적 1 | `ServiceHubPage` 가 같은 service 의 WorkItem · OpsNote 를 표시 안 함 | 사용자가 한 서비스의 이력을 보려면 3-4개 화면 순회 | ServiceHubPage 에 "이슈 (WorkItem)" "운영 메모 (OpsNote)" 섹션 추가 — 동일 `service` 키로 동시 fetch |
| G2 | **Critical** | 목적 3 | `IncidentAnalysisPage` 가 분석 결과를 저장하지 않음 — 휘발성 | 재발 방지의 핵심 자산이 매번 휘발 | "이 분석 결과 → 이슈로 저장 / 트러블슈팅으로 저장" 액션 버튼 추가 (WorkItem 또는 ServiceEntry kind='troubleshoot' 로 변환) |
| G3 | **Important** | 목적 1 | `KnowledgeHubPage` 의 5종 통합에서 `type='task'` WorkItem + 전체 ServiceEntry 가 빠짐 | "한 대장" 슬로건과 실제 커버리지 괴리 | (a) `if (i.type !== 'issue') continue` 제거하고 모든 type 노출 (b) ServiceEntry 6번째 종으로 추가 |
| G4 | **Important** | 목적 1 | `KnowledgeHubPage` 에 service 필터 chip 없음 (데이터는 있는데 UI 미노출) | "k8s 관련 전부" 같은 가장 흔한 운영 시나리오를 못 처리 | 기존 kind chip 옆에 service chip 12개 추가 (`HubItem.service` 이미 있음) |
| G5 | **Important** | 목적 1 | `WorkItemBoardPage` 에 service 필터 없음 | service 태그된 업무를 보드에서 골라낼 수 없어 service-centric 운영 불가 | BatchJobFilters 패턴으로 service chip 행 추가 |
| G6 | **Important** | 목적 2 | WorkItem · ServiceEntry · OpsNote 등록·변경 시 알림 트리거 없음 | 작성자가 별도 슬랙 알림을 수동으로 보내야 정보 전파됨 | 기존 `notifier.py` 의 channel strategy 재사용 — `notify_for_work_item_created` / `notify_for_service_entry_created` 추가 |
| G7 | **Important** | 목적 3 | Issue resolution → Troubleshoot 지식 자동 승격 없음 | 해결한 노하우가 다음 사람에게 전달되려면 작성자가 양쪽에 두 번 써야 함 | WorkItemDetailPage 에 "이 조치를 트러블슈팅 카드로 등록" 버튼 — ServiceEntry kind='troubleshoot' 자동 생성 (service · title · content · resolution · relatedWorkItemId 채움) |
| G8 | Moderate | 목적 3 | 동일 패턴 재발 자동 감지 없음 | 같은 장애가 또 발생해도 시스템이 모름 | 신규 issue 작성 시 같은 service + 유사 category·keyword 의 과거 issue/troubleshoot 를 inline 으로 추천 |
| G9 | Moderate | 목적 3 | Troubleshoot 구조화 부족 — placeholder text 만 안내 | 작성자마다 형식이 달라 자산화 어려움 | ServiceEntry kind='troubleshoot' 일 때 구조 필드 도입: `symptom` `root_cause` `resolution` `prevention` (DB 컬럼 또는 meta JSONB) |
| G10 | Moderate | 목적 1 | `ServicesCatalogPage` 카운트 (total / byKind) 가 ServiceEntry 만 집계 | 카탈로그 화면이 서비스의 "활동량" 을 과소표현 | catalog endpoint 가 WorkItem + ServiceEntry + OpsNote 합산하도록 확장 |

## 4. Decision Record 점검

| 결정 (추정) | 따른 결과 | 평가 |
|---|---|---|
| WorkItem 으로 task/issue/meeting 통합 (work_items.py) | 모델은 일원화 | ✅ 좋은 결정 — 그러나 service 측 통합으로 이어지지 못함 |
| ServiceEntry 라는 별도 모델 도입 (5 kind) | 서비스별 카탈로그 페이지에 적합 | ⚠️ WorkItem 과 개념 중복 (issue ↔ troubleshoot, task ↔ history 등) — 통합 검토 필요 |
| `notifier.py` 는 DailyCheckLog 진입점만 | 클러스터 헬스체크 알림은 잘 됨 | ❌ 다른 등록 이벤트로 확장 안 됨 — 미완성 |
| KnowledgeHubPage 가 5종 통합 시도 | hub 컨셉은 옳음 | ⚠️ ServiceEntry 누락, task 제외, service 필터 누락 — hub 가 hub 가 못 됨 |
| IncidentAnalysisPage 가 분석만 하고 저장 안 함 | MVP 로 빠르게 출시 | ❌ 재발 방지 목적과 정면 충돌 — 핵심 가치가 휘발 |

---

## 5. 권장 우선순위 (재발 방지 → 통합 → 전파 순)

### Phase A: 핵심 가치 보존 (Critical, 1주)
- **A1 (= G2)**: IncidentAnalysisPage 결과 → WorkItem(issue) 또는 ServiceEntry(troubleshoot) 저장 액션. AI 분석이 휘발하는 가장 큰 손실 봉합.
- **A2 (= G1)**: ServiceHubPage 에 같은 service 의 WorkItem + OpsNote 섹션 추가. "/services/k8s 가서 다 본다" 의도가 그제야 성립.

### Phase B: 학습 루프 (Important, 1~2주)
- **B1 (= G7)**: Issue resolution → Troubleshoot 자동 승격 버튼. "한 번 해결하면 다음엔 검색만." 의 시드 자산 적립.
- **B2 (= G3, G4)**: KnowledgeHubPage 의 통합 범위 + service 필터 보강. "한 대장" 약속 이행.
- **B3 (= G9)**: Troubleshoot 구조화 (symptom/root_cause/resolution/prevention). 자산 품질이 일정해져야 검색·매칭이 가치를 가짐.

### Phase C: 자동 전파 (Important, 2주)
- **C1 (= G6)**: 기존 `notifier.py` 채널 패턴을 work_item / service_entry / ops_note 등록 이벤트로 확장. 인프라 재사용이라 적은 비용.
- **C2 (= G5)**: WorkItemBoardPage 의 service 필터 — service-centric 운영자 동선 제공.
- **C3 (= G8)**: 신규 issue 작성 시 과거 유사 케이스 inline 추천. 재발 사전 차단의 핵심.

### Phase D: 마무리 (Moderate, 1주)
- **D1 (= G10)**: `/services` 카탈로그의 활동량 카운트를 4개 모델 합산으로 확장.

---

## 6. Match Rate (정량)

```
Static analysis (가용한 design 부재로 의도서 기반):

Structural Match    : 70% — 데이터 모델 (service 컬럼, type/kind enum) 은 잘 깔렸음
Functional Depth    : 15% — 통합 뷰 + 자동 흐름이 거의 비어 있음
Integration Coverage: 20% — 4 모델이 service 공유하지만 같은 화면에 동시 표시되는 곳 0개

가중 평균 (도메인 적합성 점검의 경우 functional · integration 가중치 ↑):
Overall = 70 × 0.2 + 15 × 0.4 + 20 × 0.4 = 14 + 6 + 8 = 28%

목적별 평균 (위 표): (30 + 25 + 15) / 3 = 23%

종합 Match Rate: ~25%
```

PDCA 기준 90% 게이트 대비 **65 포인트 미달** — `iterate` 단계로 자동 진입 권고 수준이나, 문제가 단순 코드 수정이 아닌 **설계·도메인 통합** 이슈라 사람이 우선순위 결정 후 점진 진행이 적합.

---

## 7. Checkpoint 5 — 사용자 의사결정 옵션 (offline 자율 작성)

향후 사용자 복귀 시 아래 중 선택:

- **A. 지금 모두 수정 (Phase A→B→C→D 전부)** — 약 4-5주 작업
- **B. Critical 만 수정 (G1, G2)** — 약 1주, 가장 큰 가치 손실 봉합
- **C. 핵심 가치 + 학습 루프 (Phase A + B)** — 약 2-3주, "재발 방지" 흐름까지 완성
- **D. 그대로 진행, 본 문서로 향후 PRD/Design 작성 시 reference 로 사용**

권장: **C** — 사용자 의도서의 3가지 목적 중 1번 + 3번을 충족하는 최소 묶음. 전파(2번)는 인프라가 이미 있어 후순위로 미뤄도 큰 손실 없음.

---

## 8. 다음 단계 (자동)

- 본 분석은 휘발성이 아니라 `docs/03-analysis/` 에 영구 저장됨.
- PDCA 다음 단계: 사용자 선택 후 `/pdca plan knowledge-services-coherence` 로 정식 Plan 문서 작성 → Design → Do.
- 본 분석에서 `IncidentAnalysisPage` 가 결과를 저장하지 않는 G2 는 가장 명확한 single-file fix 후보이므로 단독 처리 가능 (`/pdca plan incident-analysis-persist`).
