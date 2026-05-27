---
template: design
version: 1.0
feature: batch-jobs-cron-fix
date: 2026-05-27
author: riverjin839
project: DEVOPS MANAGEMENT
status: Draft
architecture: Option C — Pragmatic Balance
plan_ref: docs/01-plan/features/batch-jobs-cron-fix.plan.md
---

# batch-jobs-cron-fix Design Document

> **Architecture**: Option C — Pragmatic Balance
> **Plan**: [batch-jobs-cron-fix.plan.md](../../01-plan/features/batch-jobs-cron-fix.plan.md)

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | BatchJob cron 잡이 사용자가 등록한 시각에 발화하지 않거나 아예 발화 자체가 안 됨 — history 에 `trigger="schedule"` row 부재 또는 9 시간 지연 |
| **WHO** | DevOps 운영자 (`etcdctl_defrag` 같은 정기 점검 잡을 다수 클러스터에 등록) |
| **RISK** | dispatcher 의 tz 처리 변경이 기존 등록된 잡들의 다음 발화 시각을 이동시킴. croniter 2.0.5 의 tz-aware anchor 호환성 검증 필요. last_run_at 컬럼은 UTC naive 그대로 유지(마이그레이션 회피) |
| **SUCCESS** | SC-1: `0 23 * * *` 잡이 KST 23:00 에 dispatch / SC-2: cron + 자격증명 미입력 조합으로는 POST/PUT 모두 422 / SC-3: history 에 `trigger="schedule"` row 정상 누적 |
| **SCOPE** | Backend: `config.py` + `celery_app.py:run_batch_job_dispatcher` + `routers/batch_jobs.py` invariant 헬퍼. Frontend: `CreateBatchJobWizard.tsx` + `BatchJobSlideOver.EditForm.tsx` 버튼 disable + shared helper. Out: skip 사유 가시화(P2), stampede 방지(P3), invalid 잡 마이그레이션 |

---

## 1. Overview

### 1.1 Goal

dispatcher 의 cron 해석 timezone 을 `settings.batch_jobs_timezone` (default `"Asia/Seoul"`) 로 일원화하고, cron + 자격증명 누락 조합을 등록 단계부터 차단하여 silent skip 케이스를 원천 봉쇄.

### 1.2 Selected Architecture: Option C — Pragmatic Balance

**핵심 결정**:
- Timezone 은 `Settings` 필드로 외부화 (`.env` override 가능)
- Invariant 검증은 **router 내부 private 헬퍼 1개** 로 단일화 (create/update 가 공유)
- Frontend 도 동일 — `CreateBatchJobWizard.shared.ts` 에 `cronRequiresCredentials()` export 해서 Wizard/EditForm 공유
- 기존 layer 구조 유지 — service / model 변경 없음

### 1.3 Why not A / B

- **A (Minimal Patch)**: invariant 로직이 create_job/update_job 양쪽에 if 블록으로 중복. 향후 invariant 명세가 바뀔 때 (예: API key 추가) 2곳을 동시에 고쳐야 하는 동기화 부담. Asia/Seoul 하드코딩으로 .env override 도 불가.
- **B (Clean Architecture)**: dispatcher service / validator module / hook 등 4개 이상의 신규 파일. 2-bug fix 치고는 surface area 가 너무 크고, 회귀 위험만 증가. 도메인 복잡도가 service layer 분리를 정당화하지 않음.

---

## 2. Architecture

### 2.1 Module Map

```
Backend
  app/
    config.py                          ← MODIFY  (+1 field: batch_jobs_timezone)
    celery_app.py                      ← MODIFY  (dispatcher: ZoneInfo 변환)
    routers/batch_jobs.py              ← MODIFY  (_require_cron_credentials helper + create/update 호출)
  tests/
    test_batch_job_dispatcher.py       ← NEW     (SC-1 ~ SC-3 자동테스트)

Frontend
  src/components/batch-jobs/
    CreateBatchJobWizard.shared.ts     ← MODIFY  (+export cronRequiresCredentials)
    CreateBatchJobWizard.tsx           ← MODIFY  (등록 버튼 disabled 조건)
    BatchJobSlideOver.EditForm.tsx     ← MODIFY  (저장 버튼 disabled 조건 + 안내)
```

총 **5 modify + 1 new** = 6 파일.

### 2.2 Data Flow

```
[운영자] ─POST /batch-jobs─→ [router.create_job]
                              │
                              ├─ _require_cron_credentials(payload)  ← invariant
                              │   └─ cron && !saved_pw && !saved_key  → HTTPException(422)
                              │
                              └─ DB insert (encrypted_password=cipher)

[운영자] ─PUT /batch-jobs/{id}─→ [router.update_job]
                                  │
                                  ├─ merged = _apply_update(db_job, payload)  ← 기존 + 변경 머지
                                  ├─ _require_cron_credentials(merged)         ← 머지 후 invariant
                                  │
                                  └─ DB commit

[Celery Beat / 매분] ─→ [run_batch_job_dispatcher]
                          │
                          ├─ tz = ZoneInfo(settings.batch_jobs_timezone)
                          ├─ now_aware = datetime.now(tz)
                          ├─ for job:
                          │   ├─ anchor_naive = job.last_run_at or (now_utc - 1d)
                          │   ├─ anchor_aware = anchor_naive.replace(tzinfo=UTC).astimezone(tz)
                          │   ├─ next_fire = croniter(cron, anchor_aware).get_next(datetime)
                          │   └─ if next_fire <= now_aware: run_batch_job.delay(job.id)
                          │
                          └─ return {checked, dispatched, skipped, executed_at}
```

### 2.3 Backend Detail

#### 2.3.1 `config.py` 변경

```python
class Settings(BaseSettings):
    # ... (기존)

    # ─── Batch Jobs ──────────────────────────────────────
    # croniter 가 cron 식을 해석할 timezone (IANA name).
    # 변경 시 기존 등록된 cron 잡들의 다음 발화 시각이 이동한다.
    batch_jobs_timezone: str = "Asia/Seoul"
```

`.env.example` 에도 동기 추가:
```
BATCH_JOBS_TIMEZONE=Asia/Seoul
```

#### 2.3.2 `celery_app.py:run_batch_job_dispatcher` 변경

기존 (line 268-298):
```python
now = datetime.utcnow()
# ...
anchor = job.last_run_at or (now - timedelta(days=1))
next_fire = croniter(cron_expr, anchor).get_next(datetime)
```

변경 후:
```python
from datetime import datetime, timedelta, timezone as _tz
from zoneinfo import ZoneInfo
from app.config import settings

try:
    tz = ZoneInfo(settings.batch_jobs_timezone)
except Exception:
    log.warning(
        "invalid BATCH_JOBS_TIMEZONE=%r — falling back to Asia/Seoul",
        settings.batch_jobs_timezone,
    )
    tz = ZoneInfo("Asia/Seoul")

now_utc = datetime.now(_tz.utc)
now_aware = now_utc.astimezone(tz)

for job in jobs:
    # ... (invalid_cron / no_credentials 체크 동일)

    # last_run_at 은 naive UTC 컬럼 (마이그레이션 회피).
    # tz-aware 로 변환 후 croniter 에 전달.
    raw_anchor = job.last_run_at or (now_utc - timedelta(days=1)).replace(tzinfo=None)
    anchor_aware = raw_anchor.replace(tzinfo=_tz.utc).astimezone(tz)

    try:
        next_fire = croniter(cron_expr, anchor_aware).get_next(datetime)
    except Exception:
        skipped_reasons["cron_eval_error"] = skipped_reasons.get("cron_eval_error", 0) + 1
        continue
    if next_fire > now_aware:
        continue

    run_batch_job.delay(str(job.id))
    dispatched.append(str(job.id))

return {
    "checked": len(jobs),
    "dispatched": len(dispatched),
    "dispatched_ids": dispatched,
    "skipped": skipped_reasons,
    "executed_at": now_aware.isoformat(),
    "timezone": settings.batch_jobs_timezone,
}
```

**핵심 포인트**:
- `last_run_at` 컬럼은 그대로 naive UTC (DB schema 변경 0).
- dispatcher 내부에서만 tz-aware 로 변환.
- ZoneInfo 로딩 실패 시 Asia/Seoul fallback + 경고 로그 (운영자 오타 보호).
- `executed_at` 반환값을 aware 로 — Beat 로그 가독성 향상.
- `timezone` 필드 신설 — 운영자가 어떤 tz 로 평가됐는지 즉시 확인.

#### 2.3.3 `routers/batch_jobs.py` 변경

신규 private 헬퍼:
```python
def _require_cron_credentials(
    *,
    cron: Optional[str],
    has_password: bool,
    has_private_key: bool,
) -> None:
    """Raise 422 if cron is set but no credential will be persisted.

    `has_password` / `has_private_key` 는 머지 후 최종 상태 기준
    (saved_password 가 payload 에 들어왔으면 True, clear_saved_password=True 면 False).
    """
    if not (cron and cron.strip()):
        return
    if has_password or has_private_key:
        return
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=(
            "cron 을 사용하려면 saved_password 또는 saved_private_key 중 "
            "하나가 필요합니다. 둘 다 비우면 스케줄러가 매분 silent skip 합니다."
        ),
    )
```

`create_job` 변경 (line 93~):
```python
@router.post("", response_model=BatchJobResponse, status_code=status.HTTP_201_CREATED)
def create_job(payload: BatchJobCreate, db: Session = Depends(get_db)):
    _require_cron_credentials(
        cron=payload.cron,
        has_password=bool(payload.saved_password),
        has_private_key=bool(payload.saved_private_key),
    )
    # ... (기존 encrypt + insert 로직)
```

`update_job` 변경 (line 127~):
```python
@router.put("/{job_id}", response_model=BatchJobResponse)
def update_job(job_id: UUID, payload: BatchJobUpdate, db: Session = Depends(get_db)):
    db_job = db.query(BatchJob).filter(BatchJob.id == job_id).first()
    if not db_job:
        raise HTTPException(404, "BatchJob not found")

    # Merge: 최종 상태 = (DB 현재) ⊕ (payload 변경)
    final_cron = payload.cron if payload.cron is not None else db_job.cron

    # saved_password 의 최종 존재 여부:
    #   payload.saved_password (plaintext) 있으면 True
    #   clear_saved_password=True 면 False (기존 cipher 삭제)
    #   둘 다 아니면 기존 cipher 유지 → bool(db_job.encrypted_password)
    if payload.saved_password:
        final_has_pw = True
    elif payload.clear_saved_password:
        final_has_pw = False
    else:
        final_has_pw = bool(db_job.encrypted_password)

    if payload.saved_private_key:
        final_has_key = True
    elif payload.clear_saved_private_key:
        final_has_key = False
    else:
        final_has_key = bool(db_job.encrypted_private_key)

    _require_cron_credentials(
        cron=final_cron,
        has_password=final_has_pw,
        has_private_key=final_has_key,
    )

    # ... (기존 update + commit 로직)
```

#### 2.3.4 Schema 변경 없음

`BatchJobCreate` / `BatchJobUpdate` 는 형식 검증만 담당. Invariant 는 DB 상태 의존이라 router 에서.

### 2.4 Frontend Detail

#### 2.4.1 `CreateBatchJobWizard.shared.ts` — 공유 헬퍼

```typescript
/**
 * cron 식이 비어있지 않고 자격증명도 둘 다 비어있으면 true.
 * 백엔드의 _require_cron_credentials 와 의미 동일.
 */
export function cronRequiresCredentials(
  cron: string | null | undefined,
  savedPassword: string | null | undefined,
  savedPrivateKey: string | null | undefined,
): boolean {
  if (!cron || !cron.trim()) return false;
  return !savedPassword && !savedPrivateKey;
}
```

#### 2.4.2 `CreateBatchJobWizard.tsx` 변경

기존 amber 경고 (`credsMissing`) 는 가시성 위해 유지. 등록 버튼만 disabled 추가:

```tsx
import { cronRequiresCredentials } from './CreateBatchJobWizard.shared';

const credsBlocking = cronRequiresCredentials(
  form.cron,
  form.savedPassword,
  form.savedPrivateKey,
);

<button
  disabled={isSubmitting || credsBlocking}
  title={credsBlocking ? 'cron 을 비우거나 자격증명을 입력하세요' : undefined}
  ...
>
  등록
</button>
```

#### 2.4.3 `BatchJobSlideOver.EditForm.tsx` 변경

EditForm 은 partial update — 기존 DB 상태(`hasSavedPassword`, `hasSavedPrivateKey`) 도 같이 봐야 함:

```tsx
import { cronRequiresCredentials } from './CreateBatchJobWizard.shared';

// 머지 후 최종 자격증명 상태
const finalPw = newPassword || (!clearPassword && job.hasSavedPassword) ? 'present' : '';
const finalKey = newPrivateKey || (!clearPrivateKey && job.hasSavedPrivateKey) ? 'present' : '';

const credsBlocking = cronRequiresCredentials(form.cron, finalPw, finalKey);

{credsBlocking && (
  <div className="text-sm text-amber-600">
    cron 을 사용하려면 자격증명이 필요합니다. 비밀번호 또는 개인키를 입력하거나
    cron 을 비우세요.
  </div>
)}

<button disabled={isSubmitting || credsBlocking}>저장</button>
```

---

## 3. API Contract

### 3.1 변경된 응답 코드

| Endpoint | 기존 | 변경 | 조건 |
|---|---|---|---|
| `POST /api/v1/batch-jobs` | 201 | **422** 신규 | `cron && !saved_password && !saved_private_key` |
| `PUT /api/v1/batch-jobs/{id}` | 200 | **422** 신규 | 머지 후 `final_cron && !final_pw && !final_key` |

### 3.2 422 Response Schema (기존 FastAPI 표준)

```json
{
  "detail": "cron 을 사용하려면 saved_password 또는 saved_private_key 중 하나가 필요합니다. 둘 다 비우면 스케줄러가 매분 silent skip 합니다."
}
```

### 3.3 무변경 (regression 0)

- `GET /api/v1/batch-jobs` — 응답 schema 동일
- `GET /api/v1/batch-jobs/types` — 무관
- `POST /api/v1/batch-jobs/{id}/run` — 무관 (수동 실행은 자격증명 inline 받음)
- `POST /api/v1/batch-jobs/{id}/test-connection` — 무관

---

## 4. Data Model

**변경 없음**.

- `batch_jobs` 테이블 schema 동일
- `last_run_at` 컬럼 naive UTC 유지 (dispatcher 내부 변환만)
- 마이그레이션 0건

---

## 5. Implementation Order

### 5.1 Backend (순차)

1. **B1**. `config.py` 에 `batch_jobs_timezone: str = "Asia/Seoul"` 추가 + `.env.example` 업데이트
2. **B2**. `celery_app.py:run_batch_job_dispatcher` 의 now/anchor tz-aware 변환 + fallback
3. **B3**. `routers/batch_jobs.py` 에 `_require_cron_credentials` 헬퍼 신설
4. **B4**. `create_job` 에서 헬퍼 호출
5. **B5**. `update_job` 에서 머지 후 헬퍼 호출 (DB 상태 + payload 머지 로직 포함)

### 5.2 Backend Test (B1~B5 직후)

6. **T1**. `tests/test_batch_job_dispatcher.py` 신규:
   - SC-1: `0 23 * * *` + `last_run_at=None` + freeze time `KST 22:59` → dispatched=0, `KST 23:00` → dispatched=1
   - SC-2: `POST /batch-jobs {cron:"0 23 * * *"}` → 422
   - SC-3: `PUT /batch-jobs/{id} {clear_saved_password:true, clear_saved_private_key:true}` (기존 cron 보유) → 422
   - 회귀: cron 없는 잡 등록은 자격증명 없이도 201

### 5.3 Frontend (순차)

7. **F1**. `CreateBatchJobWizard.shared.ts` 에 `cronRequiresCredentials` export
8. **F2**. `CreateBatchJobWizard.tsx` 의 등록 버튼 disabled + title
9. **F3**. `BatchJobSlideOver.EditForm.tsx` 의 저장 버튼 disabled + 안내 메시지

### 5.4 검증

10. **V1**. `cd backend && pytest tests/test_batch_job_dispatcher.py -v` PASS
11. **V2**. `cd frontend && npm run lint -- --max-warnings 0` PASS
12. **V3**. `cd frontend && npx tsc --noEmit` PASS
13. **V4**. (manual / 환경 가능 시) docker-compose restart → wizard 에서 cron 잡 등록 시도 → 버튼 disabled 확인

### 5.5 Session Guide

이 feature 는 ~180 LOC, 6 파일이라 **단일 세션**으로 충분. 분리 불필요.

| Session | Scope | 예상 시간 |
|---|---|---|
| 1 (only) | B1~B5 + T1 + F1~F3 + V1~V3 | 60~90분 |

---

## 6. Test Plan

### 6.1 L1 — Backend Unit (자동)

`backend/tests/test_batch_job_dispatcher.py`:

```python
# Pseudo-code
import pytest
from datetime import datetime
from zoneinfo import ZoneInfo
from freezegun import freeze_time

def test_dispatcher_fires_at_kst_2300(db_session, create_batch_job):
    """SC-1: 0 23 * * * 잡이 KST 23:00 에 발화"""
    job = create_batch_job(
        cron="0 23 * * *",
        last_run_at=None,
        encrypted_password=b"cipher",
    )
    # KST 22:59 = UTC 13:59
    with freeze_time("2026-05-27 13:59:00", tz_offset=0):
        result = run_batch_job_dispatcher()
        assert result["dispatched"] == 0
    with freeze_time("2026-05-27 14:00:00", tz_offset=0):
        result = run_batch_job_dispatcher()
        assert result["dispatched"] == 1
        assert str(job.id) in result["dispatched_ids"]

def test_create_job_rejects_cron_without_credentials(client):
    """SC-2: cron + 자격증명 없음 → 422"""
    resp = client.post("/api/v1/batch-jobs", json={
        "name": "t", "job_type": "etcdctl_defrag",
        "cluster_id": "...", "cron": "0 23 * * *",
    })
    assert resp.status_code == 422
    assert "saved_password" in resp.json()["detail"]

def test_update_job_rejects_clear_credentials_with_cron(client, existing_job):
    """SC-3: cron 유지하면서 자격증명 둘 다 제거 → 422"""
    resp = client.put(f"/api/v1/batch-jobs/{existing_job.id}", json={
        "clear_saved_password": True,
        "clear_saved_private_key": True,
    })
    assert resp.status_code == 422

def test_dispatcher_uses_configured_timezone(monkeypatch, db_session, create_batch_job):
    """settings.batch_jobs_timezone='UTC' 면 UTC 로 해석"""
    monkeypatch.setattr(settings, "batch_jobs_timezone", "UTC")
    # ... (KST 23:00 = UTC 14:00 vs UTC 23:00 차이 검증)

def test_create_job_allows_no_cron_no_credentials(client):
    """회귀: cron 없으면 자격증명 없어도 201 (수동 전용 잡)"""
    resp = client.post("/api/v1/batch-jobs", json={
        "name": "manual-only", "job_type": "etcdctl_defrag",
        "cluster_id": "...",
        # no cron
    })
    assert resp.status_code == 201
```

### 6.2 L2 — UI Action (수동 — Playwright 미설치)

| # | 시나리오 | 기대 결과 |
|---|---|---|
| L2-1 | Wizard → cron `0 23 * * *` 입력 + 자격증명 둘 다 비움 | "등록" 버튼 disabled + amber 경고 표시 |
| L2-2 | Wizard → cron 입력 + 비밀번호 입력 | "등록" 버튼 활성 |
| L2-3 | EditForm → 기존 cron 잡에서 `clear_saved_password` + `clear_saved_private_key` 동시 체크 | "저장" 버튼 disabled + 안내 메시지 |
| L2-4 | EditForm → cron 만 비우기 → 자격증명 비어도 저장 가능 | "저장" 버튼 활성 |

### 6.3 L3 — E2E (운영자 수동, 환경 부재 시 carry-over)

| # | 시나리오 | 기대 결과 |
|---|---|---|
| L3-1 | wizard 로 `* * * * *` (매분) + saved_password 입력 → 등록 | history 에 1분 이내 `trigger="schedule"` row 1건 |
| L3-2 | 같은 잡을 `0 23 * * *` (KST 23시) 로 변경 → 23시 대기 | KST 23:00:00 ±1 분 안에 dispatch |
| L3-3 | 이전 fix 이전 등록된 invalid 잡 (cron 있는데 자격증명 NULL) | 매분 silent skip (out-of-scope, P2 에서 처리) |

---

## 7. Risk and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| croniter 2.0.5 가 tz-aware anchor 로 next_fire 계산 시 의도와 다른 결과 | High | Low | L1-1, L1-4 단위테스트로 양방향 검증. 실패 시 anchor 를 KST naive 로 잘라서 전달하는 fallback |
| 기존 등록된 잡의 발화 시각이 KST 로 이동 → -9h 앞당겨짐 | Medium | Low | CHANGELOG 명시. wizard placeholder 가 KST 의미였으므로 사용자 의도 align |
| `last_run_at` 이 naive 인데 dispatcher 가 잘못 utc 로 가정 (DST 영향?) | Low | Very Low | Asia/Seoul 은 DST 없음. 만약 UTC 가 아닌 다른 tz 였다면 미스매치 — 코드 주석으로 invariant 명시 |
| Frontend `cronRequiresCredentials` 가 EditForm 의 머지 로직과 어긋남 | Medium | Low | 헬퍼는 단순 boolean. EditForm 이 머지 후 결과를 헬퍼에 전달하는 책임. 단위테스트 어렵지만 L2-3/L2-4 수동 검증 |
| 운영자가 `BATCH_JOBS_TIMEZONE` 에 오타 입력 (예: `Asia/seoul`) | Low | Medium | ZoneInfo 실패 시 Asia/Seoul fallback + 경고 로그. dispatcher 가 죽지 않음 |

---

## 8. Open Questions

| Q | Status | Decision |
|---|---|---|
| Plan §7.2 가 이미 router 검증 결정 — schema 도 형식 검증으로 model_validator 추가? | Closed | 추가 안 함. router 가 단일 진실 소스. schema 는 형식만. |
| `executed_at` 응답을 aware 로 바꾸면 기존 monitor/log 깨지나? | Closed | 응답값은 디버그용. consumer 없음 확인됨. |
| `BATCH_JOBS_TIMEZONE` 환경변수 docker-compose.yml 에 explicit pass 필요? | Open | pydantic-settings 가 .env 자동 로드. compose 에 explicit 안 해도 동작. 명시적 환경변수가 필요하면 Do 단계에서 추가. |

---

## 9. Architecture Decisions Record

| ID | Decision | Rationale |
|----|----------|-----------|
| AD-1 | Option C (Pragmatic Balance) 선택 | Plan §7.2 정합성, YAGNI 위반 없음, 단일 헬퍼로 중복 제거 |
| AD-2 | `last_run_at` naive UTC 유지 | DB 마이그레이션 0. 기존 row 100% 호환 |
| AD-3 | Invariant 검증을 router 안에서 (schema 가 아닌) | partial update 의 머지 후 최종 상태로 검증 가능 |
| AD-4 | ZoneInfo 로딩 실패 시 Asia/Seoul fallback | dispatcher 가 죽으면 모든 잡 영향. 운영자 오타 보호 |
| AD-5 | Frontend `cronRequiresCredentials` 를 별 hook 이 아닌 shared function | 단순 boolean 로직. hook 으로 만들면 useEffect 등 불필요한 reactivity |

---

## 10. Definition of Done (Design Review)

- [x] Plan SC-1 ~ SC-6 가 모두 §5 Implementation Order 의 step 으로 매핑됨
- [x] Plan §6.1 Changed Resources 가 §2.1 Module Map 과 1:1 일치
- [x] Plan §6.2 USED-BY 가 §3.1 의 Breaking endpoint 와 일치
- [x] 3 안 비교 + 선택 근거 문서화 (§1.3)
- [x] Test Plan 이 SC-1 ~ SC-3 + 회귀 케이스 포함 (§6.1)
- [x] Risk + Mitigation 5건 (§7)
- [x] Open Questions 모두 close 또는 Do 단계로 defer (§8)

---

## 11. Implementation Guide

### 11.1 Pre-Implementation Checklist

- [ ] `git status` clean — 다른 변경 없음 확인
- [ ] `feature/home-v2` 브랜치 또는 새 브랜치 `feature/batch-jobs-cron-fix` 결정
- [ ] `backend/.env` 에 `BATCH_JOBS_TIMEZONE=Asia/Seoul` 줄이 없거나 의도된 값인지 확인

### 11.2 Code Comment Convention

각 파일에 Design reference 코멘트 추가:

```python
# backend/app/celery_app.py
# Design Ref: §2.3.2 — tz-aware dispatcher (Asia/Seoul default)
```

```python
# backend/app/routers/batch_jobs.py
# Design Ref: §2.3.3 — _require_cron_credentials shared invariant
# Plan SC: SC-2, SC-3 (cron + creds invariant)
```

```typescript
// frontend/.../CreateBatchJobWizard.shared.ts
// Design Ref: §2.4.1 — shared boolean for Wizard + EditForm
```

### 11.3 Session Guide

| Module | Files | Tests | Verification |
|---|---|---|---|
| **M1 — Config + Dispatcher** | `config.py`, `celery_app.py`, `.env.example` | (covered in M2) | import 검증 |
| **M2 — Router Invariant + Tests** | `routers/batch_jobs.py`, `tests/test_batch_job_dispatcher.py` | pytest -v | SC-1 ~ SC-3 PASS |
| **M3 — Frontend** | `CreateBatchJobWizard.shared.ts`, `CreateBatchJobWizard.tsx`, `BatchJobSlideOver.EditForm.tsx` | (수동 L2) | lint + tsc PASS |

권장 순서: **M1 → M2 → M3**. M2 에서 backend invariant 가 먼저 보장된 뒤 frontend 가 wrapper 로 동작.

`--scope M1,M2` 또는 `--scope M3` 로 분리 가능하지만 LOC 가 작아 단일 세션 권장.

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-05-27 | Initial draft — Option C selected, Plan §7.2 정합성 검증, 3 안 비교 + ADR 5건 | riverjin839 |
