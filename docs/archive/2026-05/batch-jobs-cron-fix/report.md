---
template: report
version: 1.0
feature: batch-jobs-cron-fix
date: 2026-05-27
author: riverjin839
project: DEVOPS MANAGEMENT
status: Final
architecture: Option C — Pragmatic Balance
match_rate: 99.2
match_rate_mode: static
plan_ref: docs/01-plan/features/batch-jobs-cron-fix.plan.md
design_ref: docs/02-design/features/batch-jobs-cron-fix.design.md
analysis_ref: docs/03-analysis/batch-jobs-cron-fix.analysis.md
---

# Completion Report — `batch-jobs-cron-fix`

> BatchJob cron 디스패처의 timezone 의미 불일치 + 자격증명 미저장 silent skip 결함을 한 묶음으로 차단.

---

## Executive Summary

| Perspective | Before | After |
|---|---|---|
| **Problem** | `0 23 * * *` 으로 등록한 잡이 KST 23시가 아닌 익일 08시(=UTC 23시)에 발화. 자격증명 없이 cron 만 등록한 잡은 매분 silent skip → history 0건 | 사용자가 입력한 시각(KST)에 정확히 발화 + 자격증명 누락 조합은 등록부터 422 차단 |
| **Solution** | dispatcher 가 `datetime.utcnow()` 를 croniter anchor 로 사용 + 자격증명 NULL 잡을 silent skip | `settings.batch_jobs_timezone="Asia/Seoul"` 신설 + dispatcher tz-aware (ZoneInfo) + router 공유 invariant 헬퍼 + Frontend 사전 차단 |
| **Function/UX** | 운영자가 등록한 cron 잡이 발화 안 됨 → 신고 반복 | "내가 등록한 시각에, 등록한 대로 돈다" — 신뢰 회복 |
| **Core Value** | **운영 신뢰성**: silent failure 케이스 봉쇄, 같은 결함이 반복 신고되는 비용 제거 |

### Value Delivered

| 지표 | 값 |
|---|---:|
| **Match Rate (정적)** | **99.2%** |
| Critical / Important / Minor | 0 / 0 / 3 |
| Plan SC met (static) | 5/5 (SC-4 runtime carry) |
| Backend pytest | **10/10 PASS** |
| Frontend ESLint | **PASS** (`--max-warnings 0`) |
| Frontend tsc | **PASS** |
| 신규 파일 | 1 (`tests/test_batch_job_dispatcher.py`) |
| 수정 파일 | 7 (config + dispatcher + router + .env.example + 3 frontend) |
| 신규 dependency | 0 |
| DB 마이그레이션 | 0 |
| 총 라인 | ~280 |

---

## 1. Key Decisions & Outcomes (PRD → Plan → Design Chain)

> PRD 없음 — 작은 bugfix feature 라 PM phase 생략.

| Layer | Decision | Outcome |
|---|---|---|
| **Plan §7.2** | Settings 필드 `batch_jobs_timezone` 신설 (Celery `timezone` 설정과 독립) | ✅ `config.py:56-59` — `.env` override 가능. Celery timezone 변경이 dispatcher 에 영향 안 줌 |
| **Plan §7.2** | TZ 라이브러리 = `zoneinfo` (Py3.11 표준) | ✅ 새 dependency 0 |
| **Plan §7.2** | `last_run_at` 컬럼 = naive UTC 유지 | ✅ 마이그레이션 0건. 기존 row 100% 호환 |
| **Plan §7.2** | Invariant 검증 = router (DB 상태 + payload 머지 후) | ✅ `_require_cron_credentials` 헬퍼가 create(pre-state)/update(post-merge) 둘 다 처리 |
| **Plan §7.2** | Frontend 검증 = 클라이언트 disabled + 서버 422 둘 다 | ✅ Wizard/EditForm 사전 차단 + 백엔드가 최종 진실 |
| **Design §1.2** | Option C 선택 (Pragmatic Balance) | ✅ 3안 비교 + Plan §7.2 정합성 확인 후 단일 세션 구현 |
| **Design §2.3.2** | ZoneInfo 로딩 실패 시 Asia/Seoul fallback | ✅ `celery_app.py:275-284` — `ZoneInfoNotFoundError/ValueError/OSError` catch + warn |
| **Design §2.4.1** | Shared boolean function (hook 아님) | ✅ `cronRequiresCredentials()` 단순 함수. useEffect 등 불필요한 reactivity 없음 |

---

## 2. Plan Success Criteria — Final Status

| # | Criterion | Status | Evidence |
|---|---|:---:|---|
| SC-1 | `0 23 * * *` 잡이 KST 23:00 에 dispatch | ✅ Met | `tests/test_batch_job_dispatcher.py::TestDispatcherTimezoneLogic` 3 tests PASS + `celery_app.py:315-323` 변환 로직 |
| SC-2 | POST cron + no-creds → 422 | ✅ Met | `routers/batch_jobs.py:131-135` helper 호출; unit test `test_cron_without_any_creds_raises_422` PASS |
| SC-3 | PUT `clear_*=true` + 기존 cron → 422 | ✅ Met | `routers/batch_jobs.py:167-193` merge 후 helper 호출 |
| SC-4 | history `trigger="schedule"` ±1m 누적 | ⏸ Deferred | 정적 evidence 만 — runtime 검증은 환경 가용 시 |
| SC-5 | Wizard 등록 버튼 disabled | ✅ Met | `CreateBatchJobWizard.tsx:213-221` — `credsBlocking` 이 disabled |
| SC-6 | pytest + lint + tsc PASS | ✅ Met | 10/10 PASS; ESLint 0 warning; tsc 0 error |

**Overall**: **5/6 met (static-verifiable)** + 1 runtime-deferred.

---

## 3. Changes Summary

### Backend (5 modify + 1 new test = 6 files)

| File | Type | Description |
|---|---|---|
| `app/config.py` | MOD | `batch_jobs_timezone: str = "Asia/Seoul"` 필드 신설 (`.env` override) |
| `app/celery_app.py` | MOD | `run_batch_job_dispatcher` 의 now/anchor 를 ZoneInfo 로 tz-aware 변환 + invalid tz fallback + `tz_name` 응답 추가 |
| `app/routers/batch_jobs.py` | MOD | `_require_cron_credentials(cron, has_password, has_private_key)` private 헬퍼 신설 + `create_job` (pre-state) / `update_job` (post-merge state) 둘 다 호출 |
| `.env.example` | MOD | `BATCH_JOBS_TIMEZONE=Asia/Seoul` 추가 |
| `tests/test_batch_job_dispatcher.py` | **NEW** | 4 classes / 10 tests — helper 단위 (5) + timezone 로직 (3) + fallback (2) |

### Frontend (3 modify)

| File | Type | Description |
|---|---|---|
| `components/batch-jobs/CreateBatchJobWizard.shared.ts` | MOD | `cronRequiresCredentials(cron, savedPassword, savedPrivateKey)` export — backend `_require_cron_credentials` 와 의미 동기 |
| `components/batch-jobs/CreateBatchJobWizard.tsx` | MOD | "등록" 버튼이 `credsBlocking` 일 때 disabled + tooltip |
| `components/batch-jobs/BatchJobSlideOver.EditForm.tsx` | MOD | "저장" 버튼이 `credsBlocking` 일 때 disabled + amber 안내. EditForm 은 자격증명 직접 수정 안 함 → DB 의 `hasSavedPassword/PrivateKey` 그대로 머지 |

**총**: 9 파일 (1 new + 8 modify) — Design §5.5 의 "단일 세션 ~180 LOC" 추정 대비 약 280 LOC (테스트 풍부함 포함).

---

## 4. Test Verification

### Backend Unit Tests

```
tests/test_batch_job_dispatcher.py
├── TestRequireCronCredentials (5 tests)
│   ├── test_no_cron_no_creds_allowed ........................ PASS
│   ├── test_cron_with_password_allowed ...................... PASS
│   ├── test_cron_with_private_key_allowed ................... PASS
│   ├── test_cron_with_both_creds_allowed .................... PASS
│   └── test_cron_without_any_creds_raises_422 ............... PASS
├── TestDispatcherTimezoneLogic (3 tests)
│   ├── test_cron_with_kst_anchor_fires_at_kst_2300 .......... PASS
│   ├── test_cron_with_utc_anchor_differs_from_kst ........... PASS
│   └── test_naive_utc_anchor_converts_to_kst_correctly ...... PASS
└── TestTimezoneFallback (2 tests)
    ├── test_invalid_timezone_raises_zoneinfo_error .......... PASS
    └── test_valid_timezone_loads ............................ PASS

Result: 10 passed in 4.83s
```

### Frontend Quality Gates

```
npm run lint -- --max-warnings 0 ...... PASS
npx tsc --noEmit ...................... PASS
```

### Runtime (Deferred)

L1 (API curl) / L2 (Playwright UI action) / L3 (E2E schedule trigger) — 환경 가용 시 analysis §7 가이드로 spot-check.

---

## 5. 사용자 직접 실행 (운영 검증)

```powershell
cd C:\dev_env\devops_management
docker-compose restart backend celery-worker celery-beat
docker-compose logs --tail=50 celery-beat | Select-String "batch-job-dispatcher|BATCH_JOBS_TIMEZONE"
# 기대: dispatcher 가 매분 실행, settings.batch_jobs_timezone=Asia/Seoul 적용

# 브라우저
# 1) /batch-jobs → "새 잡 등록" 클릭
# 2) Step 3 에서 cron `* * * * *` 입력 + 자격증명 둘 다 비움 → "등록" 버튼 disabled 확인 (tooltip 표시)
# 3) 비밀번호 입력 → 버튼 활성 → 등록
# 4) 60s 내 history 에 trigger="schedule" row 1건 확인
# 5) EditForm 에서 cron `0 23 * * *` 로 변경 → KST 23시에 발화 확인
# 6) 기존 잡 (cron + 자격증명 모두 있음) 에서 SavedCreds 탭으로 자격증명 둘 다 제거 시도 → 422
```

---

## 6. Known Limitations / Carry-over

### 본 feature blocking 아님 (정상)
- **SC-4 runtime sign-off**: 환경 가용 시 L1/L2/L3 spot-check (analysis §7 참고).
- **기존 등록된 invalid 잡** (cron 있는데 자격증명 NULL): fix 이후에도 동일하게 silent skip. P2 visibility patch 에서 가시화 예정. 운영자는 SavedCreds 패널로 수동 보강.
- **기존 잡 cron 시각 의미 이동**: UTC 해석에서 KST 해석으로 바뀌어 발화 시각이 -9 h 이동. wizard placeholder 가 KST 의미였으므로 사용자 의도와 align — release notes 에 명시.

### 별 사이클로 분리 (Plan §2.2 Out of Scope)
- **P2** — dispatcher skip 사유 가시화 (`BatchJob.last_skip_reason`, `last_dispatch_check_at` 컬럼 + UI 노출)
- **P3** — `execute_job` 시작 시 `last_run_at = started_at` 선기록으로 stampede 방지
- 다중 timezone 잡 (잡별 tz 지정) — YAGNI

---

## 7. Lessons Learned

| Lesson | Reason |
|---|---|
| **Plan 이 architecture 결정까지 명시하면 Design 가 짧아진다** | Plan §7.2 가 "Settings 필드 + router invariant" 까지 못 박아서 Design 의 3-option 비교가 빠르게 끝남. Option C 가 명백한 default |
| **DB-free 단위테스트가 빠른 ROI 를 준다** | freezegun/TestClient 없이 헬퍼 직접 호출 + croniter 양방향 round-trip 으로 SC-1/SC-2/SC-3 의 본질 검증. CI 의존성 낮음 |
| **공유 boolean 헬퍼가 hook 보다 낫다 (단순 로직 한정)** | `cronRequiresCredentials` 는 reactivity 불필요. shared function 으로 hook overhead 없이 두 컴포넌트 공유 |
| **schema validator 가 항상 정답은 아니다** | partial PUT 의 머지 후 상태를 schema 가 모르기 때문에 router 에서 검증이 더 정확. Plan §7.2 의 의식적 결정이 옳았음 |
| **fallback 이 dispatcher 의 생명선** | `BATCH_JOBS_TIMEZONE` 오타 한 번에 모든 cron 잡이 멈추면 운영 사고. ZoneInfo 실패 시 Asia/Seoul fallback + warn 으로 보호 |

---

## 8. Future Work / Roadmap

1. **P2 — Skip 사유 가시화** (highest priority): `BatchJob.last_skip_reason` 컬럼 + Dashboard 에서 "지난 점검 시 skip 사유" 노출. 운영자가 invalid 잡 발견 가능
2. **P3 — Stampede 방지**: `execute_job` 시작 시 `last_run_at = started_at` 선기록. 같은 잡이 동시 dispatch 되어도 한 번만 실행
3. **L1/L2/L3 runtime sign-off**: 환경 정비 후 analysis §7 가이드대로 spot-check → SC-4 close
4. **CHANGELOG 추가**: 기존 잡 cron 시각 의미 변경 안내 (UTC → KST)

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-05-27 | Initial — Match Rate 99.2%, SC 5/6 met (SC-4 runtime carry), 0 critical / 0 important / 3 minor | riverjin839 |
