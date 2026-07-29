---
name: add-deep-checker
description: 새로운 점검(deep check) 항목을 추가할 때 사용. 예) 인증서 만료, OS 파라미터, 스토리지(MinIO/Ceph) health, 네트워크 도달성 등 클러스터/노드 상태를 점검하는 체커를 만들고 운영 점검(Ops Checks) 콘솔과 cron 에 자동 노출되게 등록한다.
---

# 새 deep checker 추가

점검은 `DeepCheckerBase` 를 상속한 체커 한 개 = registry 한 항목으로 모듈화된다.
registry 에 등록만 하면 ① cron(`run_deep_check_all`) ② 운영 점검 콘솔(`/ops-checks`)
카탈로그에 **자동 노출**된다.

## 절차
1. **체커 작성** — `backend/app/services/deep_checkers/<name>_checker.py`
   - `class XChecker(DeepCheckerBase)`, 클래스 속성 `check_type` / `display_name`.
   - `def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome` 구현. (`safe_run` 이 예외·duration 처리)
   - `ctx.cluster`(Optional), `ctx.thresholds`, `ctx.params`, `ctx.in_cluster` 사용.
   - **운영 클러스터 무해 원칙**: 가능하면 K8s API 읽기 또는 이미 수집된
     `ClusterConfigSnapshot` 비교로 처리. SSH/파드 생성이 필요하면 신중히(creds·부하 고려),
     `ctx.cluster is None`(in_cluster/DB 없음) 이면 `StatusEnum.pending` 으로 종료.
   - 결과: `DeepCheckOutcome(status, message, details)` — status 는 healthy/warning/critical/pending.
   - 예시(스냅샷 비교형): `kernel_param_drift_checker.py` 참고.
2. **registry 등록** — `backend/app/services/deep_checkers/registry.py`
   - import 추가 + `REGISTRY` 에 `(Checker, DeepCheckTypeSpec(...))` 항목.
   - `DeepCheckTypeSpec` 에 `category`(os|k8s|storage|network|app), `default_enabled`(위험/무거운 건 False),
     `threshold_fields`/`param_fields`(UI 동적 폼), `default_thresholds`/`default_params`.
   - `STEP_PLANS` 에도 `(step_id, label)` 튜플 목록을 추가하면 별도 계측(`_step`) 없이도
     운영 점검 콘솔이 실행 메커니즘을 실시간 애니메이션으로 그린다.
3. **시드** — `_seed_default_deep_check_definitions()` (main.py) 가 registry 를 돌며 글로벌 정의를
   자동 생성한다. `enabled=spec.default_enabled` 를 따른다. 별도 작업 불필요.
4. **이력 테이블이 필요하면** (예: 변경 이력) `backend/app/models/` 에 모델 추가 →
   `models/__init__.py` 등록 → `create_all` 이 테이블 생성, 인덱스는 `_run_migrations()` 의
   `_safe_create_index` 로. 대용량/로그성이면 `backup_service.LOG_TABLES` 에 등록.

## 검증
- 백엔드: CI 의 `pytest` (Postgres 서비스 컨테이너) 가 import/기동 검증. 로컬 의존성 설치가
  안 되면 `python -c "import ast; ast.parse(open(f).read())"` 로 최소 구문 점검.
- 콘솔: 배포 후 `/ops-checks` 에서 새 항목이 카탈로그에 보이는지, 실행 시 결과/로그가 뜨는지.

## 주의
- in_cluster(superpod) 모드는 DB 가 없다 — DB 비교형 체커는 그 경우 pending 반환.
- 카탈로그는 비활성 정의도 노출(수동 실행 가능), cron 은 enabled 만 실행.

## UI-First (CLAUDE.md §UI-First 원칙 — 위반 시 리뷰 반려)
- 환경마다 달라지는 값(네임스페이스·라벨 셀렉터·경로·엔드포인트·타임아웃·실행 경로)은
  **코드에 리터럴로 박지 말고** `param_fields`/`threshold_fields` 에 선언한다 —
  선언해야만 UI(매트릭스 셀 ▸ 실행 방식 ▸ 설정 편집 / Ops Checks 정의 편집)에서 고칠 수 있다.
- 필드마다 `label` 과 `help` 를 채운다. 동작이 갈리면 `source: auto|pod|snapshot` 처럼
  분기 자체를 파라미터로 노출하고 `auto` 폴백을 준다.
- 자격증명은 params(JSONB — 런북/로그 노출)에 저장하지 않는다. SSH 수집이 필요하면 기존
  수집 화면이 남긴 `ClusterConfigSnapshot` 을 읽는다(`etcd_defrag` 의 snapshot 경로 참고).
- 체커를 추가/변경하면 같은 커밋에서 `services/check_matrix_runbook.py` 의 명령 목록과
  `registry.py` 의 `CELL_VALUE_SPECS`(셀 대표값) 도 갱신한다 — 테스트가 전 타입 커버리지를 검사한다.
