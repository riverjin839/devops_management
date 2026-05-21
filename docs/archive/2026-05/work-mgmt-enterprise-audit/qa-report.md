# QA Report — 업무관리 메인메뉴 Enterprise 점검

> 작성일: 2026-05-21
> Iterate-1 후 정적 Match Rate: 82%
> Plan: `docs/01-plan/features/work-mgmt-enterprise-audit.plan.md`
> Report: `docs/04-report/work-mgmt-enterprise-audit.report.md`
> 최종 Verdict: **QA_SKIP** (환경 미충족 — 수동 체크리스트로 대체)

---

## 1. Pre-flight 결과

| 항목 | 상태 |
|---|---|
| Backend (localhost:8000) | ❌ unreachable |
| Frontend (localhost:5173) | ❌ unreachable |
| `frontend/node_modules/dompurify` | ❌ missing — `npm install` 필요 |
| Docker / Playwright | ❌ 미설치 (직전 사이클과 동일) |

→ 자동 L1-L5 SKIP. 수동 체크리스트 제공.

## 2. 자동 정적 검증 결과

| 항목 | 결과 |
|---|---|
| Python AST parse — 4 파일 (work_items/schemas/model/main) | ✅ OK |
| Backend import test — `work_items` module | ✅ 8 endpoint 모두 인증 deps 확인 (4 GET → get_current_user / 4 mutating + CSV → require_operator) |
| Frontend bracket balance — 5 파일 | ✅ 모두 0 |

## 3. L1 — API Smoke Tests (수동, 사용자 환경 띄운 뒤)

전제: `docker-compose up -d` + JWT 토큰 (`POST /auth/login`)

```powershell
$BASE = "http://localhost:8000/api/v1"
$TOKEN = "<your-bearer-token>"
$H = @{ Authorization = "Bearer $TOKEN" }

# L1.1 G-C1: GET 인증 — 토큰 없이 401
curl -s -o /dev/null -w "%{http_code}`n" $BASE/work-items
# 기대: 401

# L1.2 G-C1 + G-C2: 토큰 + 페이지네이션
curl -s $BASE/work-items?limit=5 -H "Authorization: Bearer $TOKEN" | python -m json.tool
# 기대: { data: [...], total: <int>, offset: 0, limit: 5, has_more: <bool> }

# L1.3 G-C3: CSV 인증
curl -s -o /dev/null -w "%{http_code}`n" $BASE/work-items/export/csv
# 기대: 401 (이전엔 200 + 전체 데이터)

curl -s $BASE/work-items/export/csv?limit=100 -H "Authorization: Bearer $TOKEN" -o test.csv
# 기대: CSV 100행 + audit_logs 에 work_item.export_csv 기록

# L1.4 G-C4: Ownership — 다른 사람 work item PUT
# (your_id 가 아닌 다른 사람의 item_id 로 시도)
curl -s -X PUT $BASE/work-items/<other-user-item-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"category":"test"}'
# 기대: 403 + {"error": "WORK_ITEM_FORBIDDEN", ...}

# L1.5 G-C5: Audit log 확인
docker-compose exec postgres psql -U postgres -d k8s_monitor \
  -c "SELECT action, target_id, created_at FROM audit_logs WHERE action LIKE 'work_item.%' ORDER BY created_at DESC LIMIT 10"
# 기대: work_item.create / work_item.update / work_item.status_change / work_item.delete / work_item.export_csv 5종 표시
```

## 4. L2 — UI Tests (브라우저)

전제: `cd frontend && npm install && npm run dev`

| # | 시나리오 | 합격 기준 |
|---|---|---|
| L2.1 | `/tasks-mgmt` 진입 | Filter Bar 가 MacCard 안 (예전 hardcoded div 아님) — 라벨 "필터" + 본문 영역 명확 |
| L2.2 | 필터 input 에 마우스 hover | aria-label 5개 (담당자/분류/우선순위/시작일이전/시작일이후) 확인 — DevTools accessibility 탭 |
| L2.3 | 업무 삭제 버튼 클릭 (Board) | **ConfirmDialog modal** 표시 (window.confirm 아님) — 한국어 본문 + "삭제"/"취소" 버튼 |
| L2.4 | 업무 삭제 (Detail) | 같은 ConfirmDialog 일관 |
| L2.5 | 일부러 backend 끄고 페이지 진입 | "업무 목록 조회 실패" 빨간 박스 표시 (이전엔 empty 로 흡수) |
| L2.6 | WorkItemBoardPage 페이지네이션 | API 요청 query 에 `offset=0&limit=...` 보임 (Network 탭) |
| L2.7 | RichContent 가 들어간 페이지 (work-items 상세) | `<script>alert(1)</script>` 가 들어가도 alert 안 뜸 (DOMPurify sanitize) — DB 직접 INSERT 로 테스트 |

## 5. L3 — E2E (Playwright, 옵션)

설치 안 됐으므로 자동 SKIP. 수동 검증으로 L2 시나리오 5개가 통과하면 sufficient.

## 6. Plan SC 검증 매핑

| SC | 자동 가능? | 비고 |
|---|:---:|---|
| A-SC-2 인덱스 5개 | ✅ | `\d work_items` 로 확인 가능 (1분) |
| B-SC-1 페이지네이션 | ✅ | L1.2 |
| C-SC-1 인증 | ✅ | L1.1, L1.3 |
| C-SC-2 ownership | ✅ | L1.4 |
| C-SC-3 audit log | ✅ | L1.5 |
| C-SC-4 XSS | ⚠️ | L2.7 (수동) |
| D-SC-1 MacCard | ⚠️ | L2.1 (브라우저) |
| D-SC-5 error state | ⚠️ | L2.5 (백엔드 끄기 필요) |

## 7. Verdict

```
L1 (API):        SKIP (backend down) → 수동 §3 체크리스트
L2 (UI):         SKIP (frontend deps missing) → 수동 §4
L3 (E2E):        SKIP
L4 (Perf):       SKIP
L5 (Security):   SKIP
─────────────────────────────────────────────────────
정적 검증:        PASS (syntax + import + bracket balance + endpoint deps)
─────────────────────────────────────────────────────
최종 Verdict:    QA_SKIP (환경 미충족, 사용자 수동 spot check 필요)
```

## 8. 사용자 즉시 실행 명령

```powershell
# (1) 의존성 + 환경
cd C:\dev_env\devops_management\frontend; npm install
cd ..; docker-compose up -d

# (2) backend 재시작 로그
docker-compose logs backend | Select-String "ix_work_items_kanban_status|migration"
# → 5개 새 인덱스 라인 보여야 함

# (3) §3 L1 + §4 L2 차례로 진행 (10분)
# (4) verdict 업데이트
```

## 9. 다음 단계

- `/pdca archive work-mgmt-enterprise-audit --summary` — 사이클 종료
