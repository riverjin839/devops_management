---
template: plan
version: 1.3
feature: batch-jobs-cron-fix
date: 2026-05-27
author: riverjin839
project: DEVOPS MANAGEMENT
status: Draft
---

# batch-jobs-cron-fix Planning Document

> **Summary**: BatchJob cron 디스패치가 (1) UTC 로 해석되고 (2) 자격증명 없는 잡을 silent skip 하는 두 결함을 한 묶음으로 수정.
>
> **Project**: DEVOPS MANAGEMENT
> **Author**: riverjin839
> **Date**: 2026-05-27
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 사용자가 `0 23 * * *` 처럼 시간 기반 cron 으로 BatchJob 을 등록해도 (a) dispatcher 가 `datetime.utcnow()` 를 anchor 로 croniter 에 넘겨 UTC 해석으로 KST 익일 08:00 에 발화, (b) 자격증명을 비워두고 등록한 경우 dispatcher 가 매분 silent skip 하여 history 에 한 줄도 안 남음. |
| **Solution** | (A) dispatcher 의 croniter 호출을 `settings.batch_jobs_timezone` (default `"Asia/Seoul"`) tz-aware 로 변환. (B) wizard `StepSchedule` 에서 cron 입력 + 자격증명 미입력 조합으로 등록 차단(UI 버튼 disabled), 서버 `BatchJobCreate`/`BatchJobUpdate` pydantic validator 로 동일 invariant 강제. |
| **Function/UX Effect** | 사용자가 입력한 시각(KST)에 정확히 발화. 자격증명 누락된 cron 잡은 등록 자체가 불가하므로 silent skip 케이스 소멸. |
| **Core Value** | "내가 등록한 시각에, 등록한 대로 돈다" — 운영 신뢰 회복. 같은 silent failure 가 반복 신고되는 비용 제거. |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | BatchJob cron 잡이 사용자가 등록한 시각에 발화하지 않거나 아예 발화 자체가 안 됨 — history 에 `trigger="schedule"` row 부재 또는 9 시간 지연 |
| **WHO** | DevOps 운영자 (`etcdctl_defrag` 같은 정기 점검 잡을 다수 클러스터에 등록) |
| **RISK** | dispatcher 의 tz 처리 변경이 기존 등록된 잡들의 다음 발화 시각을 이동시킴. croniter 2.0.5 의 tz-aware anchor 호환성 검증 필요. last_run_at 컬럼은 UTC naive 그대로 유지(마이그레이션 회피) |
| **SUCCESS** | SC-1: `0 23 * * *` 잡이 KST 23:00 (UTC 14:00) 에 dispatch / SC-2: cron + 자격증명 미입력 조합으로는 POST/PUT 모두 422 / SC-3: history 에 `trigger="schedule"` row 정상 누적 |
| **SCOPE** | Backend: `config.py` + `celery_app.py:run_batch_job_dispatcher` + `schemas/batch_job.py` validator + `routers/batch_jobs.py` 422 응답. Frontend: `CreateBatchJobWizard.StepSchedule.tsx` + `BatchJobSlideOver.EditForm.tsx` 버튼 disable. Out: skip 사유 가시화(P2), stampede 방지(P3), 기존 invalid 잡 마이그레이션 |

---

## 1. Overview

### 1.1 Purpose

BatchJob cron 디스패치의 두 가지 신뢰성 결함 — timezone 의미 불일치, 자격증명 미저장 silent skip — 을 동시에 차단하여 등록된 cron 잡이 항상 사용자가 입력한 시각에 발화하도록 보장한다.

### 1.2 Background

2026-05-26 commit 66db5ca 가 docker-compose 의 잘못된 module path (`app.tasks.celery_tasks`) 를 `app.celery_app` 으로 정정하여 Celery Beat 가 다시 살아났다. 그러나 dispatcher 가 살아난 뒤에도 사용자 보고는 동일하게 "history 에 수동 실행만 남고 cron 발화는 0건". 코드 트레이스로 두 결함이 동시에 작용 중임을 확인:

1. **결함 A (UTC 해석)**: `backend/app/celery_app.py:269,288-290`
   ```python
   now = datetime.utcnow()
   anchor = job.last_run_at or (now - timedelta(days=1))
   next_fire = croniter(cron_expr, anchor).get_next(datetime)
   ```
   `croniter` 는 timezone-naive 이며 받은 naive datetime 을 그대로 해석. anchor 가 UTC 이므로 cron 식도 UTC 로 해석됨. Celery Beat 의 하드코딩 스케줄은 `timezone="Asia/Seoul"` 설정으로 KST 해석되는 것과 의미 불일치.

2. **결함 B (silent skip)**: `backend/app/celery_app.py:283-286`
   ```python
   if not (job.encrypted_password or job.encrypted_private_key):
       skipped_reasons["no_credentials"] = ...
       continue
   ```
   cron 이 있는데 자격증명 ciphertext 둘 다 NULL 이면 매분 silent skip. `run_batch_job.delay()` 미호출 → `BatchJobRun` row 0건. Wizard `StepSchedule.tsx:67-72` 는 amber 경고만 띄우고 등록은 통과시킴.

### 1.3 Related Documents

- Recent fix: `66db5ca` — fix(batch-jobs): cron 디스패치 동작 복구 (docker-compose module path)
- Code references: `backend/app/celery_app.py:242-308`, `backend/app/services/batch_jobs/etcdctl_defrag.py`, `frontend/src/components/batch-jobs/CreateBatchJobWizard.StepSchedule.tsx`

---

## 2. Scope

### 2.1 In Scope

- [ ] **A1**. `backend/app/config.py` 에 `batch_jobs_timezone: str = "Asia/Seoul"` 필드 신설 (.env override 가능)
- [ ] **A2**. `backend/app/celery_app.py:run_batch_job_dispatcher` 의 croniter 호출을 tz-aware 로 변환:
  - `now = datetime.now(ZoneInfo(settings.batch_jobs_timezone))`
  - `anchor` = `last_run_at` (naive UTC) 를 `replace(tzinfo=UTC)` 후 `.astimezone(ZoneInfo(...))`
  - `croniter(cron_expr, anchor)` 에 tz-aware datetime 전달 (croniter 2.0.5 는 tz-aware 지원)
- [ ] **B1**. `backend/app/schemas/batch_job.py` `BatchJobCreate` / `BatchJobUpdate` 에 model_validator 추가:
  - `cron` 이 비어있지 않으면 `saved_password` 또는 `saved_private_key` 중 하나 필수
  - `BatchJobUpdate` 는 `clear_saved_password` / `clear_saved_private_key` 까지 함께 평가
- [ ] **B2**. `backend/app/routers/batch_jobs.py` `create_job` / `update_job` 에서 422 응답 메시지 노출
- [ ] **B3**. `frontend/src/components/batch-jobs/CreateBatchJobWizard.tsx` 의 "등록" 버튼: `cron.trim() && !savedPassword && !savedPrivateKey` 이면 disabled. 기존 `credsMissing` amber 경고는 유지(가시성).
- [ ] **B4**. `frontend/src/components/batch-jobs/BatchJobSlideOver.EditForm.tsx`: cron 채우면서 자격증명도 비우는 저장 조합을 클라이언트에서 사전 차단(에러 메시지 표시 + 저장 버튼 disabled).
- [ ] 단위테스트: `backend/tests/test_batch_job_dispatcher.py` 신규 — A2 의 KST 발화 + B1 의 422 검증

### 2.2 Out of Scope

- P2: dispatcher 의 skip 사유 가시화 (`BatchJob.last_skip_reason`, `last_dispatch_check_at` 컬럼 + UI 노출) — 별 사이클
- P3: `execute_job` 시작 시 `last_run_at = started_at` 선기록으로 stampede 방지 — 별 사이클
- 기존 등록된 invalid 잡 (cron 있는데 자격증명 NULL) 의 자동 처리/마이그레이션 — 운영자가 수동 정리하거나 P2 가시화 후 처리
- 다중 timezone 잡 (잡별로 다른 tz 지정) — YAGNI

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | dispatcher 는 `settings.batch_jobs_timezone` 으로 croniter anchor 와 now 를 tz-aware 변환 후 평가한다 | High | Pending |
| FR-02 | `last_run_at` 컬럼은 naive UTC 로 그대로 유지(마이그레이션 없음). dispatcher 내부에서만 변환 적용 | High | Pending |
| FR-03 | `BatchJobCreate` 는 cron 이 비어있지 않은데 `saved_password` AND `saved_private_key` 가 모두 비어있으면 422 | High | Pending |
| FR-04 | `BatchJobUpdate` 는 위 invariant 와 함께 `clear_saved_password=true`/`clear_saved_private_key=true` 가 양쪽 자격증명을 제거하면서 cron 이 남는 경우도 422 | High | Pending |
| FR-05 | Wizard 등록 버튼은 cron 입력 + 자격증명 둘 다 비어있으면 disabled. cron 없으면 자격증명 비어도 활성 (수동 전용 등록 유지) | High | Pending |
| FR-06 | EditForm 저장 버튼도 같은 클라이언트 검증 적용 | High | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Backward compatibility | 기존 등록된 잡 데이터 (DB rows) 는 무수정 — 컬럼 추가/변경 없음 | DB diff 0 |
| Test coverage | dispatcher tz 변환 + validator 422 + wizard disable 세 경로 모두 자동테스트 | pytest + ESLint pass |
| Lint | `npm run lint -- --max-warnings 0` 통과 | CI |
| Type safety | `tsc --noEmit` 통과 | CI |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] SC-1: dispatcher 단위테스트 — `0 23 * * *` 잡 + `last_run_at = NULL` + `now = KST 22:59` → skip / `now = KST 23:00` → dispatch
- [ ] SC-2: `POST /api/v1/batch-jobs` 에 cron + 자격증명 미입력 payload → 422 (메시지에 "cron 사용 시 saved_password 또는 saved_private_key 필수" 포함)
- [ ] SC-3: `PUT /api/v1/batch-jobs/{id}` 에 `clear_saved_password=true, clear_saved_private_key=true` + 기존 cron 유지 payload → 422
- [ ] SC-4: 새로 등록한 cron 잡이 사용자 입력 시각(KST) ±1 분 안에 `trigger="schedule"` row 로 history 에 누적
- [ ] SC-5: Wizard E2E — cron 채우고 자격증명 비운 상태에서 "등록" 버튼 disabled (Playwright 또는 수동)
- [ ] SC-6: 모든 단위테스트 통과, lint/typecheck 통과

### 4.2 Quality Criteria

- [ ] 기존 BatchJob 관련 API 회귀 없음 — GET /batch-jobs/types, /run, /test-connection 4xx/5xx 변동 없음
- [ ] Celery Beat 의 다른 스케줄 (daily-check-morning/noon/evening, daily-trend-collect, daily-deep-check-*) 에 영향 없음 — 별도 task 들이라 코드 분리 보장

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| croniter 2.0.5 가 tz-aware datetime 으로 next/prev 계산 시 unexpected behavior | High | Low | 단위테스트로 KST 시각/UTC 시각 변환 양방향 검증. croniter changelog 확인 (2.0+ 는 PEP 495 호환). 문제 시 `pytz` → `zoneinfo` (Py3.9+) 표준 모듈 사용 |
| 기존 등록된 "cron 있는데 자격증명 NULL" 잡들이 fix 이후에도 dispatcher 에서 동일하게 silent skip 됨 (Out of Scope) | Medium | High | Out of scope 명시. P2 visibility 패치에서 처리. 운영자는 SavedCreds 패널로 수동 보강. |
| 기존 잡의 cron 시각 의미가 UTC 에서 KST 로 바뀌어 발화 시각이 -9 h 앞당겨짐. 사용자가 의도적으로 UTC 로 등록했을 가능성 | Medium | Low | 코드/UI 어디에도 "이 cron 은 UTC 다" 라는 안내가 없었고 wizard placeholder 도 KST 의미로 작성. 실질적 사용자는 KST 의도였을 것. 변경 사항을 CHANGELOG / release notes 에 명시 |
| pydantic v2 model_validator 가 `BatchJobUpdate` 의 partial update 시 보유한 `cron`/`encrypted_*` 상태를 모른 채 422 발생 | Medium | Medium | 라우터 단에서 DB 상태 + payload 머지한 최종 상태로 invariant 검증 (validator 가 아닌 router 안에서 raise). schema 는 단순 형식 검증만. |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `Settings` (config.py) | Config | `batch_jobs_timezone: str = "Asia/Seoul"` 필드 신설 |
| `run_batch_job_dispatcher` (celery_app.py) | Celery task | now/anchor 를 tz-aware 변환 후 croniter 에 전달 |
| `BatchJobCreate` (schemas/batch_job.py) | Pydantic schema | (cron + 자격증명) invariant 검증. 형식 검증만 schema 에, 상태 의존 검증은 router |
| `BatchJobUpdate` (schemas/batch_job.py) | Pydantic schema | 동일 invariant 적용. clear 플래그도 함께 평가 |
| `create_job` / `update_job` (routers/batch_jobs.py) | API endpoint | DB 상태 + payload 머지 후 invariant 검증 → 422 |
| `CreateBatchJobWizard.tsx` | React component | "등록" 버튼 disabled 조건 추가 |
| `BatchJobSlideOver.EditForm.tsx` | React component | "저장" 버튼 disabled 조건 추가, 안내 메시지 |
| `tests/test_batch_job_dispatcher.py` | Test | 신규 — A/B 모두 검증 |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|----------|-----------|-----------|--------|
| `run_batch_job_dispatcher` | INVOKED-BY | Celery Beat `batch-job-dispatcher` schedule (매분) | Needs verification — 다음 발화 시각 변경 |
| `run_batch_job_dispatcher` | INVOKES | `run_batch_job.delay()` | None — 시그니처 무변경 |
| `BatchJobCreate` schema | USED-BY | `POST /api/v1/batch-jobs` (routers/batch_jobs.py:93) | Breaking — invariant 위반 payload 는 422 |
| `BatchJobCreate` schema | USED-BY | Frontend `useCreateBatchJob` → wizard | Compatible — wizard 가 같은 invariant 보장하면 422 미발생 |
| `BatchJobUpdate` schema | USED-BY | `PUT /api/v1/batch-jobs/{id}` (routers/batch_jobs.py:127) | Breaking — invariant 위반 payload 는 422 |
| `BatchJobUpdate` schema | USED-BY | Frontend `useUpdateBatchJob` → EditForm, SavedCreds | Compatible — EditForm 가 같은 invariant 보장 |
| `Settings.batch_jobs_timezone` | NEW | `celery_app.py` dispatcher | New consumer only |
| `BatchJob.last_run_at` | UNCHANGED | naive UTC 그대로. dispatcher 내부에서만 변환 | None — 컬럼 의미 보존 |

### 6.3 Verification

- [ ] dispatcher 변경 후 다른 Beat 태스크 정상 동작 — Beat 로그에서 `daily-check-morning` 등 시각 변동 없음 확인
- [ ] 기존 BatchJob 행이 fix 이후에도 GET /batch-jobs 로 정상 조회됨 — `has_saved_password` / `has_saved_private_key` 값 그대로
- [ ] Wizard 가 cron 없이 자격증명도 없는 잡을 여전히 등록 가능 (수동 전용 use case 유지)

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | Selected |
|-------|:--------:|
| Starter | ☐ |
| Dynamic | ☐ |
| **Enterprise** | ☑ |

Backend FastAPI + Celery + PostgreSQL + 모듈 분리(routers/services/models/schemas) + K8s 인프라.

### 7.2 Key Architectural Decisions

| Decision | Selected | Rationale |
|----------|----------|-----------|
| Timezone source | `settings.batch_jobs_timezone` (default `"Asia/Seoul"`) | .env 로 override 가능. Celery 의 timezone 과 독립(Celery 설정 변경 시 dispatcher 가 영향 안 받게) |
| TZ 라이브러리 | `zoneinfo` (Py3.11 표준) | 별도 의존성 추가 없음. paramiko/celery 가 이미 Py3.11 사용 |
| `last_run_at` 컬럼 의미 | naive UTC 유지 | 마이그레이션 회피. dispatcher 내부에서만 KST 로 변환. 기존 row 100% 호환 |
| Invariant 검증 위치 | router (DB 상태 + payload 머지 후) | partial update 의 정확한 최종 상태로 검증 가능. schema-only 검증은 PUT 의 partial 특성과 어긋남 |
| Frontend 검증 | 클라이언트 disabled + 서버 422 둘 다 | UI 가 막혀도 직접 API 호출 가능. 서버가 최종 진실 |

### 7.3 Clean Architecture Approach

이미 분리된 layer 를 그대로 사용:

```
Backend (Enterprise):
  config.py                   — Settings
  routers/batch_jobs.py       — HTTP layer, invariant 최종 검증
  schemas/batch_job.py        — DTO 형식 검증
  services/batch_job_service  — execute_job 변경 없음
  celery_app.py               — dispatcher 의 tz 변환만 변경
  models/batch_job.py         — 컬럼 변경 없음

Frontend:
  components/batch-jobs/CreateBatchJobWizard.tsx     — 버튼 disabled
  components/batch-jobs/BatchJobSlideOver.EditForm   — 버튼 disabled
```

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] `CLAUDE.md` 코딩 컨벤션 섹션 ("Backend Architecture Details", "Key Conventions")
- [x] ESLint (frontend) — `--max-warnings 0`
- [x] pydantic v2 — `model_dump()`, `model_validator`
- [x] TypeScript strict — `tsc --noEmit`

### 8.2 Conventions to Define/Verify

| Category | Current State | To Define |
|----------|---------------|-----------|
| Settings 필드 명명 | snake_case (예: `celery_broker_url`, `superpod_mode`) | `batch_jobs_timezone` ← 컨벤션 준수 |
| Pydantic validator 위치 | 서버 상태 의존이면 router, 형식만이면 schema | 이 plan 의 결정 사항과 일치 |
| 422 에러 메시지 한국어 | 기존 router 에서 한국어 메시지 사용 (`run_job` 의 "password 또는 private_key…") | 같은 톤으로 통일 |

### 8.3 Environment Variables Needed

| Variable | Purpose | Scope | To Be Created |
|----------|---------|-------|:-------------:|
| `BATCH_JOBS_TIMEZONE` | dispatcher cron 해석 timezone | Server (Backend + Celery) | ☑ |

`.env.example` 에도 추가 — default `Asia/Seoul`.

### 8.4 Pipeline Integration

이 feature 는 9-phase Development Pipeline 의 별 phase 가 아닌 단일 PDCA cycle.

---

## 9. Next Steps

1. [ ] Design 문서 작성 (`/pdca design batch-jobs-cron-fix`) — 3 안 (A: 최소 변경, B: 깔끔한 분리, C: 균형) 비교 후 1 안 선택
2. [ ] Do 단계 진행 (`/pdca do batch-jobs-cron-fix`)
3. [ ] Analyze 로 design ↔ implementation match rate ≥ 90% 확인
4. [ ] QA 로 SC-1 ~ SC-6 검증
5. [ ] Report → Archive

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-05-27 | Initial draft — Checkpoint 1/2 결정 반영 (A+B 묶음, settings.batch_jobs_timezone, PUT 도 invariant) | riverjin839 |
