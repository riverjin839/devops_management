---
name: backend-feature
description: FastAPI 백엔드에 새 기능(모델/라우터/서비스/스키마 변경)을 추가할 때 사용. SQLAlchemy 모델, APIRouter 등록, 경량 마이그레이션(_safe_* 헬퍼), 백업 서비스 호환까지 안전하게 반영한다.
---

# 백엔드 기능 추가 (모델 · 라우터 · 마이그레이션)

## 모델
- `backend/app/models/<name>.py` 에 `Base` 상속 모델. UUID PK 기본.
- `backend/app/models/__init__.py` 의 import + `__all__` 에 등록(안 하면 `create_all` 이 테이블을 안 만듦).
- **신규 테이블**은 lifespan 의 `Base.metadata.create_all` 이 자동 생성 — ALTER 불필요.

## 라우터
- `backend/app/routers/<name>.py` 에 `APIRouter(prefix=..., tags=[...])`.
- 핸들러는 서비스 호출을 try/except 로 감싸 **구체적 detail 로 HTTPException(빈 500 금지)**.
- `backend/app/routers/__init__.py` 에 `from ... import router as <name>_router` + `__all__`.
- `backend/app/main.py` import 블록 + `app.include_router(<name>_router, prefix="/api/v1", dependencies=_auth)`
  (인증 필요 시 `_auth`; 공개면 별도). 현재 사용자(actor)는 `user: User = Depends(get_current_user)`.

## 마이그레이션 (Alembic 없음 — 경량 인라인)
- 기존 테이블 변경은 **반드시 `_safe_*` 헬퍼** (`main.py`):
  - `_safe_add_column(table, col, type)` — ADD COLUMN IF NOT EXISTS.
  - `_safe_exec(sql, label=)` — DROP/SET NOT NULL, ALTER TYPE ... USING, ADD CONSTRAINT, backfill UPDATE.
  - `_safe_create_index(name, table, expr)` — CREATE INDEX IF NOT EXISTS.
- raw `ALTER` 직접 실행 금지. 각 단계는 부팅을 막지 않도록 격리되어 있다(로그만 남김).

## 백업 호환 (CLAUDE.md 규칙)
- `backend/app/services/backup_service.py`:
  - 대용량/로그성 테이블 → `LOG_TABLES` 등록(`include_logs=False` 시 제외).
  - 민감 컬럼 → `SENSITIVE_COLUMNS` 등록(마스킹).
  - per-table fault-tolerant 패턴 유지(한 테이블 실패가 전체 백업을 깨지 않게).

## 비동기/Celery
- async 서비스 메서드를 Celery(sync) 에서 부를 땐
  `loop = asyncio.new_event_loop(); asyncio.set_event_loop(loop); loop.run_until_complete(...)`
  브리지 (`celery_app.py` 의 기존 task 패턴 참고, 예: `run_batch_job`). `asyncio.run(...)` 은
  Celery 밖 동기 서비스 코드(예: `check_matrix_service.py`)에서 쓰는 패턴이니 혼동하지 말 것.
- 새 task 추가 시 **celery-worker 재배포** 필요(워커가 task 를 알아야 `.delay()` 가 실행됨).

## 자격증명
- SSH/비밀번호/키는 평문 DB 저장 금지 — `services/secret_box.py`(encrypt/decrypt) + `BatchJob.encrypted_*` 패턴.

## 검증
- CI: 프론트(lint/tsc/build) + 백엔드 `pytest`(Postgres/Redis 서비스 컨테이너). 로컬 의존성 설치
  불가 시 최소 `ast` 구문 점검 + 시그니처 대조.
