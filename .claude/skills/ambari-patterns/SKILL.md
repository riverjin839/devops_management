---
name: ambari-patterns
description: Apache Ambari 의 검증된 클러스터 운영 패턴(선언형 서비스 정의, 명령 선후 그래프, 집계 알람, 유지보수 모드, 업그레이드 사전 점검, 재시작 대기 표시, 자가복구 예산, 텔레메트리 할당, 구조화 결과 판정, 배치 스케줄)을 PEP 에 이식할 때 사용. "Ambari 처럼", "실행 순서/의존 순서", "유지보수 모드", "알람 억제", "업그레이드 준비도/사전 점검", "재시작 필요 표시", "자동 복구 횟수 제한", "집계 알람", "롤링 재시작 배치" 요청이 오면 이 스킬의 해당 모듈만 읽고 시작한다.
---

# Ambari 패턴 이식 (모듈형)

Apache Ambari(3.0.0, trunk 2026-11 기준)는 베어메탈 하둡 클러스터 관리 도구다. PEP 는 Ambari 를
**도입하지 않는다** — 대신 10년 넘게 운영 현장에서 다듬어진 **패턴**을 PEP 의 모델·서비스·화면 언어로 옮긴다.

> 원본 분석(구조·다이어그램): devopser 레포 `ambari-study/ambari.md`, 노션 STUDY ▸ "Apache Ambari - 구조와 PEP 적용 패턴".

## 읽는 방법 — 필요한 모듈만

이 폴더의 `modules/*.md` 는 서로 독립이다. **요청에 해당하는 모듈 1~2개만 Read 한다**(전체를 읽지 않는다).
모듈마다 고정 구성: `원형(Ambari 근거 파일)` → `핵심 계약` → `PEP 이식` → `체크리스트` → `함정`.

| # | 모듈 | 한 줄 | PEP 현황 | 우선순위 |
|---|---|---|---|---|
| 01 | [declarative-service-def](modules/01-declarative-service-def.md) | 서비스 지식을 코드 대신 선언(정의 행)으로 | 부분 — `service_config` 시드가 코드에 흩어짐 | 중 |
| 02 | [command-ordering](modules/02-command-ordering.md) | `role_command_order` → Stage 분할 실행 | 없음 — 서비스 단위 배치만 | **상** |
| 03 | [aggregate-alert](modules/03-aggregate-alert.md) | 노드 결과 → 서비스 단위 % 임계 알람 | 없음 | 중 |
| 04 | [maintenance-mode](modules/04-maintenance-mode.md) | 알림 억제 + 일괄 작업 기본 제외 플래그 | 없음 (`maintenanceCron`·상태값만) | **상** |
| 05 | [upgrade-checks](modules/05-upgrade-checks.md) | 업그레이드 사전 점검 레지스트리(BLOCK/WARN) | 없음 | **상** |
| 06 | [stale-config](modules/06-stale-config.md) | "설정은 바뀌었는데 프로세스는 옛 값" 배지 | 부분 — 값 드리프트 알람만 | 중 |
| 07 | [recovery-budget](modules/07-recovery-budget.md) | 자동 조치에 창·간격·누적 상한 | 없음 | 중 |
| 08 | [telemetry-assignment](modules/08-telemetry-assignment.md) | 서버가 수집 대상 컴파일, 에이전트는 LKG 캐시 | 부분 — 노드 에이전트 보고 | 하 |
| 09 | [reliable-result](modules/09-reliable-result.md) | exit code·로그 문자열로 성공 판정 금지 | 관례 수준 | **상**(규칙) |
| 10 | [batch-schedule](modules/10-batch-schedule.md) | order_id 배치 + 실패 시 중단 | **있음** — 매핑만 | 참고 |

## 모든 모듈 공통 규칙 (PEP 불변 규칙과 겹치는 부분)

1. **UI-First** — Ambari 가 JSON/XML 파일에 두는 정의(순서 그래프, 알람 임계, 복구 예산, 체크 등급)는 PEP 에선
   **DB 행 또는 `AppSetting`** 이고 화면에서 편집한다. 시드는 첫 부팅 기본값일 뿐이다 (CLAUDE.md §UI-First).
2. **실행 = 실시간 로그** — 실행 버튼이 생기면 `RunLogPanel`(SSE) + `useLogPref('<key>')` 로 "로그 보기"를
   사용자가 고를 수 있게 한다. 레이아웃은 `DESIGN_SYSTEM.md` §12.6.1 로그 중심 패턴(레퍼런스 `EtcdCtlPage.tsx`).
3. **권한** — 변경·실행 버튼은 viewer 에게 숨기지 않고 `useCanOperate()` + `withHint` 로 비활성. 백엔드는
   `require_operator` + 클러스터 operate 판정(`services/cluster_access.py`).
4. **실행 이력 = append-only 로그 테이블** — `steps`/`log_lines` 를 단계별 커밋(`K8sEfficiencyRun`·
   `ServiceConfigApplyRun` 과 같은 철학). 새 테이블은 `LOG_TABLES` 등록 + 보존 기간(`log_retention_service`).
5. **마이그레이션** — `_safe_add_column` / `_safe_exec` / `_safe_create_index` 만. 백업 호환(`backup_service`).
6. **Fail-safe** — 외부 호출(K8S API, SSH, Prometheus) 실패는 구조화된 error dict, 500 금지.
7. **분석 ≠ 조치** — `services/analyzers/` 는 분석 전용. 모듈 07(자동 복구)은 별도 opt-in 경로에만 둔다.
8. **문서 동기화** — 새 라우터/모델/페이지/Beat 엔트리는 `docs-sync` 스킬 체크리스트(CODE_MAP·SCREENS·
   CLAUDE.md §Celery 표·CHANGELOG `[Unreleased]`).

## 추천 착수 순서

```
09 결과 판정 규칙(관례 먼저)  →  04 유지보수 모드  →  05 업그레이드 사전 점검
        →  02 실행 순서 그래프  →  06 재시작 대기  →  03 집계 알람  →  07 복구 예산
```

- 04 가 먼저인 이유: 05·02·07 이 전부 "유지보수 중인 대상은 제외/허용" 을 판정 입력으로 쓴다.
- 05 는 기존 `registered_checks`(DeepCheckerBase) 를 그대로 체크 단위로 재사용할 수 있어 비용이 낮다.

## 관련 스킬

- 체커 추가 → `add-deep-checker` · 모델/라우터 → `backend-feature` · 화면 → `frontend-page` · 문서 → `docs-sync`
