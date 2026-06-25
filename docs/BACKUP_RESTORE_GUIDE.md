# 백업 · 복구 가이드 (Backup & Restore)

PEP 의 애플리케이션 데이터를 **JSON 단일 파일**로 내보내고(export) 되돌리는(import) 기능 가이드.
DB 덤프(`pg_dump`)가 아니라 **애플리케이션 레벨 백업**이라, 스키마가 조금 달라도(컬럼 추가/타입 변경)
**테이블별로 격리**되어 전체가 깨지지 않는다(per-table fault-tolerant).

> 코드: 라우터 `backend/app/routers/backup.py`, 서비스 `backend/app/services/backup_service.py`,
> UI `frontend/src/components/settings/BackupRestorePanel.tsx` (Settings → **백업 / 복구** 탭).

---

## 1. 무엇을 백업하나

- **대상**: 애플리케이션 DB 의 모든 ORM 테이블(클러스터, 업무, 점검 정의, 지식 문서, 멤버/계정, 설정 등).
- **기본 제외 — 로그성 테이블**: 용량이 큰 이력성 테이블은 `include_logs=false`(기본)면 빠진다.
  ```
  check_logs, daily_check_logs, cluster_config_snapshots, topology_audit_logs,
  ontology_events, trend_items, trend_digests, audit_logs,
  ops_check_runs, ops_check_run_items, os_param_changes,
  resource_count_snapshots, metric_check_states
  ```
- **기본 마스킹 — 민감 컬럼**: `include_sensitive=false`(기본)면 다음 컬럼은 `null` 로 마스킹된다.
  | 테이블 | 컬럼 |
  |---|---|
  | `clusters` | `kubeconfig_content`, `kubeconfig_path` |
  | `users` | `hashed_password` |
  | `user_jira_credentials` | `token_encrypted` |

> ⚠️ 민감 필드를 포함(`include_sensitive=true`)하면 **kubeconfig·비밀번호 해시·암호화 토큰**이 평문 JSON 에 담긴다.
> 안전한 곳에만 보관하고, 일반 백업은 마스킹(기본)을 권장한다.

---

## 2. 내보내기 (Export)

### UI (권장)
1. **Settings → 백업 / 복구** 탭.
2. 옵션 선택:
   - ☐ **로그성 테이블 포함** — 점검/이력까지 통째로 보존하려면 체크(파일 커짐).
   - ☐ **민감 필드 포함** — kubeconfig/비밀번호까지(보안 위험, 기본 해제).
3. **백업 파일 다운로드** → `k8s-monitor-backup-<YYYYMMDD-HHMMSS>.json` 저장.

### API
```bash
# 기본(로그 제외 · 민감 마스킹)
curl -H "Authorization: Bearer <TOKEN>" \
  "http://<host>/api/v1/backup/export" -o backup.json

# 전체 보존(로그 + 민감 포함)
curl -H "Authorization: Bearer <TOKEN>" \
  "http://<host>/api/v1/backup/export?include_logs=true&include_sensitive=true" -o backup-full.json
```

### 백업 파일 구조(envelope)
```jsonc
{
  "version": "1.0",
  "created_at": "2026-06-25T12:34:56+00:00",
  "options": { "include_logs": false, "include_sensitive": false },
  "counts":  { "clusters": 5, "work_items": 45, ... },   // 테이블별 행 수
  "tables":  { "clusters": [ ... ], "work_items": [ ... ], ... },
  "errors":  { "<table>": "SELECT failed: <사유>" },      // 읽기 실패한 테이블
  "skipped_tables": [ "<table>" ]                          // 건너뛴 테이블
}
```
> `errors` / `skipped_tables` 가 비어있지 않으면 **스키마 드리프트(모델↔DB 불일치) 신호**다.
> UI 의 export 결과 영역에 그대로 노출되니, 운영 중 조기 감지에 쓴다.

---

## 3. 되돌리기 (Import / Restore)

복구는 **두 단계**: ① 미리보기(diff, dry-run) → ② 적용. 모드는 두 가지.

| 모드 | 동작 | 위험도 |
|---|---|---|
| **병합 (merge)** *(기본)* | PK 기준 upsert — 들어온 행을 신규 INSERT / 기존 UPDATE. 백업에 없는 기존 행은 **유지**. | 안전 |
| **덮어쓰기 (replace)** | 테이블을 **DELETE 후 INSERT** — 백업에 없는 기존 행은 **삭제됨**. | 파괴적 (확인 필요) |

### UI
1. **Settings → 백업 / 복구** → 백업 JSON 선택.
2. 모드 선택(병합/덮어쓰기), 필요 시 ☐ 로그성 테이블 포함.
3. **미리보기 (diff)** — 테이블별 `신규 / 업데이트 / 삭제 후보` 건수 확인(덮어쓰기는 삭제 후보가 빨갛게 표시).
4. **병합 적용** 또는 **덮어쓰기 실행**. 덮어쓰기는 *"전체 덮어쓰기 확인"* 다이얼로그를 거친다.
5. 결과: `✓ 복구 완료 — 신규 X · 업데이트 Y · 삭제 Z`.

### API
```bash
# ① 미리보기(dry-run) — 적용 안 함
curl -H "Authorization: Bearer <TOKEN>" \
  -F "file=@backup.json" -F "mode=merge" \
  "http://<host>/api/v1/backup/import/preview"

# ② 적용 (replace 는 confirm=true 필수)
curl -H "Authorization: Bearer <TOKEN>" \
  -F "file=@backup.json" -F "mode=merge" \
  "http://<host>/api/v1/backup/import"
```

### 안전장치
- **권한**: import 계열은 **admin** 전용(`require_admin`). export 도 인증 필요.
- **테이블별 격리**: 한 테이블 INSERT 실패는 `errors` 에 기록하고 다음 테이블로 진행(SAVEPOINT 롤백).
- **시퀀스 동기화**: INSERT 후 PostgreSQL identity 시퀀스를 `setval()` 로 맞춰 PK 충돌을 방지.
- **감사 로그**: 모든 import 는 모드·건수·오류를 `audit_logs` 에 기록.

---

## 4. 엔드포인트 요약

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/v1/backup/meta` | 현재 DB 테이블별 행 수 · 요약 |
| GET | `/api/v1/backup/export` | 전체 백업 JSON 다운로드 (`include_logs`, `include_sensitive` 쿼리) |
| POST | `/api/v1/backup/import/preview` | 업로드 + 모드 → dry-run diff 리포트 |
| POST | `/api/v1/backup/import` | 업로드 + 모드(+confirm) → 실제 적용 |

---

## 5. 운영 권장 사항

- **정기 백업**: 주 1회 이상 export(로그 제외·민감 마스킹) 후 안전한 스토리지에 보관.
- **마이그레이션 전**: 큰 스키마 변경/업그레이드 직전 **전체 백업(로그+민감 포함)** 1부.
- **재해 복구**: 새 환경에 빈 DB 로 기동(자동 `create_all`/마이그레이션) → **병합(merge)** import.
- **부분 이관**: 같은 데이터셋을 다른 환경에 동기화할 땐 병합으로 반복 적용(idempotent upsert).
- **DB 레벨 백업 병행**: 본 기능은 애플리케이션 데이터용이다. 인프라 차원 복구는
  `pg_dump`/PV 스냅샷을 별도로 병행하는 것을 권장.

---

## 6. 스키마 변경 시 체크리스트 (개발자)

새 컬럼/테이블을 추가하면 백업 호환을 함께 점검한다(상세는 `CLAUDE.md` "Backup / Restore" 절).

1. `_run_migrations()` 에 `_safe_add_column` 으로 구버전 DB 보강.
2. 민감 정보면 `SENSITIVE_COLUMNS` 등록(마스킹).
3. 대용량 로그성이면 `LOG_TABLES` 등록(`include_logs=false` 시 제외).
4. 새 PK/FK 가 `apply_import` 의 upsert/replace 로직에 영향 없는지 확인.
5. 모든 테이블 순회는 per-table try/except + `db.rollback()` 패턴 유지.
