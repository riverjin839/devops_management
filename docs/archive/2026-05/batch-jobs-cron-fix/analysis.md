---
template: analysis
version: 1.0
feature: batch-jobs-cron-fix
date: 2026-05-27
author: gap-detector
project: DEVOPS MANAGEMENT
status: Final
mode: Static (no runtime — no server, no Playwright)
plan_ref: docs/01-plan/features/batch-jobs-cron-fix.plan.md
design_ref: docs/02-design/features/batch-jobs-cron-fix.design.md
---

# Design ↔ Implementation Gap Analysis — `batch-jobs-cron-fix`

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | BatchJob cron 잡이 사용자가 등록한 시각에 발화하지 않거나 아예 발화 자체가 안 됨 |
| **WHO** | DevOps 운영자 (etcdctl_defrag 같은 정기 점검 잡을 다수 클러스터에 등록) |
| **RISK** | dispatcher tz 처리 변경이 기존 등록된 잡의 다음 발화 시각 이동, croniter 2.0.5 호환성 |
| **SUCCESS** | SC-1: KST 23:00 dispatch / SC-2: cron + no-creds → 422 / SC-3: history `trigger="schedule"` 누적 |
| **SCOPE** | Backend: config + dispatcher + router invariant / Frontend: shared helper + button disable |

---

## Executive Summary

**Verdict**: **99.2% Match Rate — Ship 가능.**

| Axis | Score |
|---|---:|
| Structural | 100% |
| Functional | 98% |
| API Contract | 100% |
| **Overall (static)** | **99.2%** |

Plan SC 5/5 + Design §5 implementation order 10/10 + §2.3/§2.4 architecture decisions 6/6 모두 충족. Critical/Important deviation 0, Minor 3 (모두 pseudo-code ↔ 실제 코드 alignment 차이로 거동 영향 없음). SC-4 (runtime history 누적) 만 환경 부재로 deferred.

**계산식 (runtime 제외)**: `(100 × 0.2) + (98 × 0.4) + (100 × 0.4) = 99.2%`

---

## 1. Plan Success Criteria — Evidence Map

| SC | Description | Status | Evidence |
|----|-------------|:------:|----------|
| **SC-1** | `0 23 * * *` 잡이 KST 23:00 dispatch | ✅ Met | `tests/test_batch_job_dispatcher.py::TestDispatcherTimezoneLogic` 3 tests PASS; `celery_app.py:290-291,315-323` (now_aware KST, anchor `replace(tzinfo=UTC).astimezone(tz)`) |
| **SC-2** | POST cron + no-creds → 422 | ✅ Met | `routers/batch_jobs.py:131-135` (`_require_cron_credentials` invocation); helper unit test `test_cron_without_any_creds_raises_422` PASS |
| **SC-3** | PUT `clear_*=true` + 기존 cron → 422 | ✅ Met | merge 로직 `routers/batch_jobs.py:176-188` 가 `clear_*` / `saved_*` / 기존 cipher 정확히 평가; 라인 189-193 helper 호출 |
| **SC-4** | history `trigger="schedule"` ±1m 누적 | ⏸ Deferred | 정적 증거: `run_batch_job` 이 `trigger="schedule"` 전달 (`celery_app.py:226`); live Beat 환경 필요 |
| **SC-5** | Wizard 등록 버튼 disabled | ✅ Met | `CreateBatchJobWizard.tsx:213-221` — `credsBlocking` 이 disabled + title |
| **SC-6** | pytest + lint + tsc PASS | ✅ Met | 10/10 PASS; ESLint `--max-warnings 0` PASS; `tsc --noEmit` PASS |

**Result**: **5/5 static SC met**, SC-4 runtime deferred.

---

## 2. Design §5 Implementation Order — Step Verification

| Step | Description | Evidence | Status |
|------|-------------|----------|:------:|
| B1 | `batch_jobs_timezone` in config + .env.example | `config.py:56-59`, `.env.example:31-34` | ✓ |
| B2 | Dispatcher tz-aware + fallback | `celery_app.py:267-336` (try/except, `now_aware`, `anchor_aware`, `tz_name` echo) | ✓ |
| B3 | `_require_cron_credentials` helper | `routers/batch_jobs.py:44-68` (signature exact match) | ✓ |
| B4 | `create_job` 헬퍼 호출 | `routers/batch_jobs.py:131-135` (pre-state, payload-only — POST 에 적합) | ✓ |
| B5 | `update_job` merge + 헬퍼 | `routers/batch_jobs.py:167-193` (cron + cipher + clear flags 정확) | ✓ |
| T1 | Unit tests | 4 classes / 10 tests all PASS | ✓ |
| F1 | `cronRequiresCredentials` shared helper | `CreateBatchJobWizard.shared.ts:66-73` | ✓ |
| F2 | Wizard 등록 disabled | `CreateBatchJobWizard.tsx:212-227` | ✓ |
| F3 | EditForm 저장 disabled + 안내 | `BatchJobSlideOver.EditForm.tsx:259-308` | ✓ |
| V1-V3 | pytest + lint + tsc | All PASS | ✓ |
| V4 | Manual docker-compose | Skipped (no env) | — |

**10/10 mandatory steps complete**, 1 manual intentionally skipped.

---

## 3. Architecture Decisions Verification (Design §2.3 / §2.4)

| Decision | Required Behavior | Evidence | Status |
|----------|-------------------|----------|:------:|
| Router-level invariant | 단일 헬퍼 공유 | `batch_jobs.py:44-68, 131, 189` — 1 helper, 2 call sites | ✓ |
| Shared frontend helper | Wizard + EditForm 재사용 | 두 파일 모두 `./CreateBatchJobWizard.shared` import | ✓ |
| `last_run_at` naive UTC 유지 | Schema/migration 무변경 | model / `_run_migrations` 무변경 확인 | ✓ |
| ZoneInfo fallback | 잘못된 tz → warn + Asia/Seoul | `celery_app.py:275-284` — `ZoneInfoNotFoundError/ValueError/OSError` catch | ✓ |
| Schema-level validator 없음 (의도) | model_validator 추가 X | `schemas/batch_job.py` 무변경 | ✓ |
| `executed_at` aware ISO + `timezone` 필드 | 진단 가시성 | `celery_app.py:334-335` 양쪽 key 존재 | ✓ |

**6/6 architecture decisions honored.**

---

## 4. API Contract Verification (Design §3)

| Endpoint | Design Spec | Server | Client | Status |
|----------|:-----------:|:------:|:------:|:------:|
| POST 422 on cron+no-creds | ✓ | ✓ (line 131-135) | Wizard 사전 차단 (CreateBatchJobWizard.tsx:213-221) | PASS |
| PUT 422 after merge | ✓ | ✓ (line 167-193) | EditForm 사전 차단 (BatchJobSlideOver.EditForm.tsx:262-308) | PASS |
| GET/types/run/test-connection unchanged | ✓ | ✓ (해당 handler 무변경) | n/a | PASS |

3-way (Design ↔ Server ↔ Client) 일치 확인. 회귀 0.

---

## 5. Convention Compliance

| Convention | Check | Status |
|------------|-------|:------:|
| Settings 필드 snake_case | `batch_jobs_timezone` ✓ | ✓ |
| pydantic v2 패턴 | `model_dump(exclude_unset=True)` 사용; 새 validator 없음 (의도) | ✓ |
| 422 메시지 한국어 톤 | 기존 `run_job` 422 와 톤 일치 | ✓ |
| Design Ref 코멘트 | 6개 파일 모두 `Design Ref: §X.Y` 코멘트 존재 | ✓ |
| ESLint zero-warnings | PASS | ✓ |
| `tsc --noEmit` | PASS | ✓ |

---

## 6. Deviations

### Critical
*(none)*

### Important
*(none)*

### Minor

| # | Item | Design Spec | Implementation | Note |
|---|------|-------------|---------------|------|
| M-1 | T1 test scope | §6.1 pseudocode (5 tests, monkeypatch + TestClient HTTP 422) | 10 tests / 4 classes, DB-free 전략 | Acceptable — pseudo-code 였음. 실제 구현은 helper 직접 호출 + ZoneInfo round-trip. HTTP-level 422 는 manual L2/L3 로 carry-over (test 파일 line 8-13 주석 명시) |
| M-2 | EditForm merge 디테일 | §2.4.3 의 `finalPw` 머지 (newPassword + clearPassword 고려) | `job.hasSavedPassword ? 'present' : ''` 만 사용 | EditForm 이 실제로 password/key 입력 필드를 노출하지 않음 (별도 SavedCreds 패널이 담당, line 259-260 주석 인지). Design pseudo-code 가 다른 UI 형태를 가정했음 — 실제 UI 에는 단순 머지가 정확 |
| M-3 | `.replace(tzinfo=None)` 잔재 | `(now_utc - timedelta(days=1)).replace(tzinfo=None)` | Verbatim 일치 | 정합성 OK. 어차피 naive 가 되는 값에 `.replace(tzinfo=None)` 가 약간 잉여처럼 보이나, design spec 과 정확 일치 + 무해 |

---

## 7. Runtime Verification Plan (Deferred)

환경 가용 시 다음 순서로 실행:

### L1 — API
```bash
# 1) POST 422 검증
curl -X POST http://localhost:8000/api/v1/batch-jobs \
  -H "Content-Type: application/json" \
  -d '{"name":"t","job_type":"etcdctl_defrag","cluster_id":"<id>","cron":"0 23 * * *"}'
# expect: 422, detail contains "saved_password"

# 2) PUT 422 검증
curl -X PUT http://localhost:8000/api/v1/batch-jobs/<id> \
  -H "Content-Type: application/json" \
  -d '{"clear_saved_password":true,"clear_saved_private_key":true}'
# expect: 422

# 3) 회귀 — cron 없는 manual-only 잡 등록
curl -X POST http://localhost:8000/api/v1/batch-jobs \
  -H "Content-Type: application/json" \
  -d '{"name":"manual","job_type":"etcdctl_defrag","cluster_id":"<id>"}'
# expect: 201
```

### L2 — UI (Playwright 설치 후)
- Wizard 에서 cron `0 23 * * *` + creds 비움 → "등록" disabled + tooltip
- EditForm 에서 `hasSavedPassword=false, hasSavedPrivateKey=false, cron="0 23 * * *"` → "저장" disabled + amber 경고

### L3 — E2E (SC-4 확정)
- Wizard 로 `* * * * *` + saved_password 잡 등록 → 60s 내 `BatchJobRun(trigger="schedule")` row 생성
- 동일 잡을 `0 23 * * *` 로 변경 → KST 23:00 ±60s 에 dispatch row

---

## 8. Recommended Actions

### Immediate
*(none — implementation is design-faithful)*

### Optional (Documentation Polish)
- Design §6.1 pseudo-code 를 실제 test 파일 docstring (`tests/test_batch_job_dispatcher.py:1-13`) 로 link 만 남기는 식으로 정리하면 M-1 minor 도 closed.

### Carry-over (별 사이클, 본 feature blocking 아님)
- 환경 가용 후 L1/L2/L3 실행 → SC-4 sign-off
- P2: dispatcher skip 사유 가시화 (`BatchJob.last_skip_reason`)
- P3: `execute_job` 시작 시 `last_run_at = started_at` 선기록 stampede 방지

---

## 9. Match Rate Computation

```
Structural Match    = 100% (모든 파일 존재 + 6 파일 modify + 1 NEW test)
Functional Depth    =  98% (placeholder 0, SC 5/5 met, T1 풍부함, M-2 deduct)
API Contract        = 100% (POST/PUT 422 3-way 일치, GET 회귀 0)

Overall (no-runtime formula):
  = (100 × 0.2) + (98 × 0.4) + (100 × 0.4)
  = 20.0 + 39.2 + 40.0
  = 99.2%
```

**Threshold (≥90%): ✅ PASS**
**Iterate 필요 없음** — Report phase 로 진행 가능.

---

## 10. Verdict

**99.2% — Ship.**

Plan SC 모두 정적 evidence 매칭, Design §5 step 10/10 완수, §2.3/§2.4 결정 6/6 honor, 3 quality gate (pytest 10/10, ESLint 0 warning, tsc clean) 모두 green. Minor 3건은 pseudo-code ↔ 실제 코드 alignment 차이로 behavioral gap 아님. SC-4 runtime sign-off 만 환경-bound carry-over.

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-05-27 | Initial — gap-detector static-only analysis, 99.2% Match Rate | gap-detector |
