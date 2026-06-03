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
