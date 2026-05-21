# Analysis — 업무관리 메인메뉴 Enterprise 점검

> 작성일: 2026-05-21
> 모드: 정적 분석 (Explore subagent 4개 병렬 + 메인 통합)
> Plan: `docs/01-plan/features/work-mgmt-enterprise-audit.plan.md` (v2, 7 surface)
> Design: `docs/02-design/features/work-mgmt-enterprise-audit.design.md`

---

## TL;DR

**Match Rate 51%** (Plan 목표 80% 대비 -29pt) — Enterprise 기준에 크게 미달. 핵심 원인:

| Axis | 점수 | 핵심 미달 |
|---|---:|---|
| A. Architecture + Data Model | 50% | 인덱스 누락 5개 + assignee 자유 텍스트 + cluster_name 정합성 |
| B. API Consistency | 53% | **페이지네이션 0% + total fake** + Query description 부족 |
| C. Security + RBAC + Audit | **40%** | **GET 인증 0개 + Ownership 0개 + Audit log 0건** |
| D. UX + Accessibility | 67% | MacCard 4/6 미적용 + confirm() + ARIA 부재 |

```
Overall = 0.50×0.25 + 0.53×0.25 + 0.40×0.30 + 0.67×0.20 = 0.51 → 51%
```

→ **C+I+UX 일괄 iterate 필수 (사용자 선택)**, 예상 14건 픽스 + 6건 carry-over.

### 핵심 결론

| 질문 | 답 |
|---|---|
| 잘 설계됐는가? | ❌ Prototype 수준 — Enterprise 기준선(인증/페이지네이션/audit) 미달 |
| 잘 동작하는가? | ⚠️ 동작은 함. 다만 데이터 1000건+ 메모리 폭발 위험, 인증 없는 GET 으로 정보 누출 가능 |
| 사용자 친화적인가? | 🟡 부분 합격 — TodoToday/WorkSummary 는 모범, BoardPage/Detail/Form/Member 는 표준 일관성 부족 |

---

## 🟢 잘된 점 (먼저 짚기)

1. **Mutating endpoint 인증 100%** — POST/PUT/PATCH/DELETE 4개 모두 `Depends(require_operator)` 적용 (`work_items.py:298, 328, 359, 389`). 인프라는 있음.
2. **`require_role` 패턴이 깔끔** (`auth/deps.py:40-60`) — admin/operator/viewer 3 role + legacy 'user' = viewer 호환.
3. **WorkItem 통합 모델 패턴** — task/issue/meeting/training/etc 5종을 단일 테이블 + 디스크리미네이터로 단순화. 마이그레이션 history 깔끔.
4. **WorkSummaryPage 가 디자인 표준 모범** — MacCard 3개 + ClusterSidebar iconOnly + grid responsive (95% 준수, M3 결과).
5. **TodoTodayPage 의 상태 분기 모범** — isLoading/isError/empty/success 모두 distinct visual (`L390-436`).
6. **Dark mode 100% 호환** — 4 페이지 모두 hex literal 없음. hsl(var(--*)) 패턴 준수.
7. **Phase B 작업 누적** — service/component 인덱스, COMPONENT_BY_SERVICE 매핑 잘 작성됨.

---

## 🔴 Critical Findings (5건)

### G-C1. GET endpoint 4개 인증 0건 — IDOR/정보 누출 (Axis C)

**근거**: `routers/work_items.py:65, 93, 172, 286` — 4 GET endpoint 모두 `Depends(require_*)` 없음.

| Endpoint | Verb | 인증 | 영향 |
|---|---|:---:|---|
| `/work-items` | GET | ❌ | 전체 work item 목록 (assignee 실명 + 클러스터 정보) |
| `/work-items/export/csv` | GET | ❌ | **전체 CSV 일괄 다운로드** — bulk exfiltration |
| `/work-items/today/summary` | GET | ❌ | 운영 대시보드 데이터 |
| `/work-items/{id}` | GET | ❌ | UUID 만 알면 누구나 접근 (IDOR) |

→ Plan SC C-SC-1/5 위반. **Severity Critical, Confidence 100%**.

**권고**: 4 endpoint 모두 `_: User = Depends(require_operator)` 추가 (POST/PUT 패턴과 동일).

⚠️ M4 subagent 가 "라우터 레벨 auth 의존성" 가능성 언급했으나, main.py 실제 등록 확인 필요. 정적 분석 한계.

### G-C2. 페이지네이션 0% + total fake (Axis B)

**근거**: `routers/work_items.py:89-90`
```python
items = query.order_by(...).all()
return WorkItemListResponse(data=items, total=len(items))
```

**문제**:
- `.all()` 이 전체 결과셋을 ORM 메모리로 로드 → 1000+ 건이면 메모리 폭발
- `len(items)` 가 진짜 total 이 아님 (이미 로드된 array 길이)
- `offset/limit` 파라미터 없음 → 페이지 분할 불가
- `export_csv` 동일 패턴

→ Plan SC B-SC-1 위반. **Severity Critical, Confidence 95%**.

**권고**:
```python
offset: int = Query(0, ge=0)
limit: int = Query(50, ge=1, le=200)
total = query.count()  # 별도 COUNT 쿼리
items = query.offset(offset).limit(limit).all()
return WorkItemListResponse(data=items, total=total, offset=offset, limit=limit, has_more=offset+len(items)<total)
```

### G-C3. CSV export 무인증 + 무제한 (Axis B + C)

**근거**: `routers/work_items.py:93-169`

CSV export 가 인증 없이 전체 데이터 + 무제한 (`.all()`). 외부에서 endpoint URL 만 알면 모든 assignee/cluster 정보 일괄 추출 가능.

→ Plan SC B-SC-1 + C-SC-1 위반. **Severity Critical, Confidence 100%**.

**권고**:
```python
def export_csv(..., _: User = Depends(require_operator), limit: int = Query(5000, le=10000), db=...):
    items = query.limit(limit).all()
```

### G-C4. Ownership 검증 0건 — operator 면 누구 work item 이든 수정 (Axis C)

**근거**: `routers/work_items.py:330, 362, 391` — PUT/PATCH/DELETE 모두 role 만 보고 통과. `item.assignee == current_user` 같은 검증 없음.

**문제**: operator role 사용자가 다른 사람 work item 을 자유롭게 수정/삭제. 거버넌스 0.

→ Plan SC C-SC-2 위반. **Severity Critical, Confidence 95%**.

**권고**:
```python
def update_work_item(..., current_user: User = Depends(require_operator), ...):
    item = db.query(WorkItem).filter(...).first()
    if current_user.role != "admin":
        if item.primary_assignee != current_user.username and \
           item.secondary_assignee != current_user.username:
            raise HTTPException(403, "Not authorized to modify others' work items")
    ...
```

⚠️ 비즈니스 룰 확인 필요 — "팀 단위 협업" 이라면 ownership 보다 cluster_id 기반 권한이 더 적합할 수 있음. 우선 admin 외엔 자기 work item 만 수정으로 처리.

### G-C5. Audit log 0건 — 변경 추적 불가 (Axis C)

**근거**: `routers/work_items.py` 전체에 `audit_logger` 호출 없음. 다른 라우터 (`playbooks.py:325`, `clusters.py:374/440`, `etcdctl.py:245`) 는 모두 호출.

**문제**: work_item 생성/수정/삭제/상태변경이 audit_logs 테이블에 안 남음. 사고 시 추적 불가 + 컴플라이언스 위반.

→ Plan SC C-SC-3 위반. **Severity Critical, Confidence 100%**.

**권고**: 4 mutating endpoint 직후 audit_logger 호출 추가 (다른 라우터와 같은 패턴).

---

## 🟠 Important Findings (9건)

| ID | Axis | Finding | 근거 | Confidence |
|---|---|---|---|---:|
| **G-I1** | A | 인덱스 누락 5개 (kanban_status, primary_assignee, cluster_id, closed_at, kanban_status+started_at 복합) | `models/work_item.py` index 정의 + `main.py` 마이그레이션 | 92% |
| **G-I2** | A | `created_at/updated_at` server_default 부재 | `work_item.py:66-67` | 82% |
| **G-I3** | A | WorkItemResponse subtasks 직렬화 validator 실제 작동 안 함 (`return data` 만) | `schemas/work_item.py:102-105` | 95% |
| **G-I4** | B | Query parameter 에 description/example 없음 (OpenAPI 빈약) | `work_items.py:67-76` | 100% |
| **G-I5** | B | HTTPException detail 이 string only — 에러 코드 없음 (i18n 불가) | `work_items.py:290, 304, 332, 342, 364, 392` | 90% |
| **G-I6** | B | `WorkItemListResponse` 에 offset/limit/has_more 필드 없음 | `schemas/work_item.py:114-116` | 95% |
| **G-I7** | C | `RichContent.tsx:19` 가 `dangerouslySetInnerHTML` + DOMPurify 없음 — XSS 위험 | `frontend/src/components/editor/RichContent.tsx` | 85% |
| **G-I8** | D | MacCard 표준 4/6 페이지 미적용 (WorkItemBoardPage Filter Bar, MemberSection, TodoToday 통계) | M3 결과 | 90% |
| **G-I9** | D | `window.confirm()` 사용 (WorkItemBoardPage:146, WorkItemDetailPage:40) — ConfirmDialog 컴포넌트 존재함에도 미사용 | `pages/WorkItemBoardPage.tsx:146`, `WorkItemDetailPage.tsx:40` | 95% |

---

## 🟡 UX / Minor / Carry-over (6건)

| ID | Axis | Finding | 처리 |
|---|---|---|---|
| **G-U1** | D | aria-label 6 페이지 전반 부재 (SortTh, filter buttons) | iterate 부분 + 차기 PDCA |
| **G-U2** | D | WorkItemBoardPage TanStack error 분기 없음 (isLoading 만) | iterate |
| **G-U3** | D | Container padding 반응형 일관성 (px-4 sm:px-6 lg:px-8) | iterate 또는 carry |
| **G-CO1** | A | **assignee User FK 마이그레이션** — 큰 변경, 마이그레이션 + UI 변경 동반 | **차기 PDCA `assignee-user-fk-migration`** |
| **G-CO2** | A | **cluster_name 정합성** — cluster.name 변경 시 work_items 동기화 (trigger 또는 view 도입) | **차기 PDCA `denormalized-sync-policy`** |
| **G-CO3** | C | **PII 마스킹 정책** — assignee 이름 노출. 운영 도구 특성상 의도일 수 있음 (사용자 결정 필요) | **차기 PDCA `pii-masking-policy`** |
| **G-CO4** | D | ClusterSidebar 미적용 페이지 (TodoToday, Detail, Form, Member) — 의도 vs 누락 판별 필요 | **차기 PDCA `cluster-sidebar-coverage`** |

---

## 📊 Axis 별 점수 산정

### Axis A — Architecture + Data Model (50%, 가중치 0.25)

| SC | 평가 | 점수 |
|---|---|---:|
| A-SC-1 cascade 정책 | parent CASCADE + related SET NULL 명시 OK, 일관성 의문 | 0.6 |
| A-SC-2 핵심 인덱스 | kanban_status/assignee/started_at 누락 | 0.4 |
| A-SC-3 referential integrity | assignee 자유 텍스트 | 0.3 |
| A-SC-4 N+1 회피 | cluster_name denorm 으로 회피 | 0.7 |
| A-SC-5 cross-model 일관 | cluster_name sync 누락 | 0.5 |
| **평균** | | **0.50** |

### Axis B — API Consistency (53%, 가중치 0.25)

| SC | 평가 | 점수 |
|---|---|---:|
| B-SC-1 페이지네이션 | `.all()` + `len()` | 0.0 |
| B-SC-2 응답 shape 통일 | total 만, offset/limit 없음 | 0.4 |
| B-SC-3 URL 일관 | `/work-items` 일관 | 0.9 |
| B-SC-4 OpenAPI 정확 | Query description 없음 | 0.4 |
| B-SC-5 HTTP verb 정확 | GET/POST/PUT/PATCH/DELETE 정확 | 0.95 |
| **평균** | | **0.53** |

### Axis C — Security + RBAC + Audit (40%, 가중치 0.30) 🚨 가장 낮음

| SC | 평가 | 점수 |
|---|---|---:|
| C-SC-1 Mutating 인증 | 4/4 적용 | 1.0 |
| C-SC-2 Ownership | 0/4 적용 | 0.0 |
| C-SC-3 Audit log | 0/4 적용 | 0.0 |
| C-SC-4 XSS | DOMPurify 없음 | 0.3 |
| C-SC-5 IDOR | GET 인증 0 + ownership 0 | 0.5 |
| C-SC-6 PII | 마스킹 없음 (의도 가능성) | 0.6 |
| **평균** | | **0.40** |

### Axis D — UX + Accessibility (67%, 가중치 0.20)

| SC | 평가 | 점수 |
|---|---|---:|
| D-SC-1 MacCard | 4/6 미적용 | 0.4 |
| D-SC-2 ClusterSidebar | 3/6 미적용 (의도 가능) | 0.6 |
| D-SC-3 rounded-2xl + shadow | 일관 | 0.85 |
| D-SC-4 dark mode | hex literal 없음 | 1.0 |
| D-SC-5 빈/로딩/에러 | TodoToday 모범 | 0.7 |
| D-SC-6 Mobile responsive | grid breakpoint 있음 | 0.85 |
| D-SC-7 ARIA | aria-label 없음 | 0.3 |
| **평균** | | **0.67** |

---

## 📋 Iterate-1 액션 플랜 (사용자 선택: C+I+UX 일괄, 예상 14건)

### Critical (5건) — 즉시 픽스
1. **G-C1** — work_items.py 의 4 GET endpoint 에 `Depends(require_operator)` 추가
2. **G-C2** — list_work_items 페이지네이션 (offset/limit + db.count())
3. **G-C3** — export_csv 인증 + limit 추가
4. **G-C4** — 4 mutating endpoint 에 ownership 검증 (admin 외엔 자기 work item 만)
5. **G-C5** — 4 mutating endpoint 에 audit_logger 호출 (다른 라우터와 같은 패턴)

### Important (9건) — 단기 픽스
6. **G-I1** — main.py 에 `_safe_create_index` 5개 추가 (kanban_status / primary_assignee / cluster_id / closed_at / kanban_status+started_at 복합)
7. **G-I2** — work_item.py 의 created_at/updated_at 에 `server_default=func.now()` 추가
8. **G-I3** — WorkItemResponse._drop_circular_subtask_children 실제 작동하도록 수정
9. **G-I4** — Query parameter 에 description 추가 (8개 endpoint)
10. **G-I5** — HTTPException detail 에 error code 추가 (`{"error": "WORK_ITEM_NOT_FOUND", ...}`)
11. **G-I6** — WorkItemListResponse 에 offset/limit/has_more 필드 추가
12. **G-I7** — RichContent 에 DOMPurify 도입 (npm install dompurify + ALLOWED_TAGS 화이트리스트)
13. **G-I8** — MacCard 적용 3곳 (WorkItemBoardPage Filter Bar + MemberSection wrapper + TodoToday 통계 카드)
14. **G-I9** — window.confirm() 2곳 → ConfirmDialog 컴포넌트로 교체

### UX (3건) — 가벼운 픽스
15. **G-U1** — aria-label 추가 (SortTh, 주요 filter buttons)
16. **G-U2** — WorkItemBoardPage 에 error state 분기 추가
17. **G-U3** — container padding 반응형 통일 (선택)

### Carry-over (4건) — 별도 PDCA
- **G-CO1** `assignee-user-fk-migration` — assignee → User FK
- **G-CO2** `denormalized-sync-policy` — cluster_name 동기화 정책
- **G-CO3** `pii-masking-policy` — assignee 마스킹 비즈니스 결정
- **G-CO4** `cluster-sidebar-coverage` — ClusterSidebar 적용 페이지 정책

---

## 🔄 다음 단계 (Phase 4 Iterate)

자동 진행. Critical 5 + Important 9 + UX 3 = **17건** 픽스 시도. 변경 파일 예상:
- backend: `work_items.py`, `schemas/work_item.py`, `main.py`, `models/work_item.py`
- frontend: `WorkItemBoardPage.tsx`, `WorkItemDetailPage.tsx`, `MemberBoardPage.tsx`, `TodoTodayPage.tsx`, `RichContent.tsx`, `package.json`, `services/api.ts`

예상 라인: backend ~200줄 + frontend ~150줄 = **~350줄 변경**.

Iterate-1 후 Match Rate 재산정 → 목표 80%+ (현재 51% → +29pt 필요).
