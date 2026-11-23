# 05. 업그레이드 사전 점검 레지스트리

## 원형 (KM)
- SPI: `spi/upgrade/{UpgradeCheck, UpgradeCheckDescription, UpgradeCheckGroup,
  UpgradeCheckStatus, UpgradeCheckType, CheckQualification}.java`
- 레지스트리: `UpgradeCheckRegistry` (+ 플러그인 로딩 `PluginChecksLoadedCheck`)
- 체크 예: `HostsHeartbeatCheck` `ServicesUpCheck` `HostMaintenanceModeCheck` `PreviousUpgradeCompleted`
  `ComponentsInstallationCheck` `ConfigurationMergeCheck` `VersionMismatchCheck`
- 각 체크 = 그룹 + 결과(PASS/WARNING/FAIL/BYPASS) + 적용 조건(업그레이드 종류별)

## 핵심 계약
업그레이드 버튼 앞에 **체크 목록 = 실행 가능 여부**. FAIL 이 하나라도 있으면 진행 불가, WARNING 은 확인 후 진행.

## PEP 이식
- 체크 단위는 기존 `backend/app/services/registered_checks/`(DeepCheckerBase) 재사용 — 새 체커는 `add-deep-checker` 절차.
- 신규 체커 후보: `api_deprecation`(대상 버전에서 제거되는 API 사용 리소스), `pdb_blocking`(drain 막는 PDB),
  `version_skew`(kubelet·apiserver skew), `etcd_health`, `node_ready_ratio`, `previous_run_done`(진행 중 적용/효율화 run).
- 프로필: AppSetting `upgrade_checks.profiles` — `{"k8s-minor": [{"check": "pdb_blocking", "severity": "BLOCK"},
  {"check": "api_deprecation", "severity": "BLOCK", "params": {"target": "1.33"}}, ...]}` (등급·파라미터 화면 편집).
- 실행: `POST /versions/clusters/{id}/upgrade-readiness` → Celery 실행, 체크별 step 로그 → SSE.
- 화면: `/versions` 에 "업그레이드 준비도" — 좌 프로필·대상 버전·실행 바 / 우 상단 `RunLogPanel` /
  우 하단 체크 표(등급·결과·근거·조치 링크). 로그 보기 `useLogPref('upgrade-readiness')`.

## 체크리스트
- [ ] 결과는 append-only run 으로 보관(언제 기준 판정이었는지)
- [ ] 수집 실패는 FAIL 이 아니라 UNKNOWN(= 진행 불가로 취급하되 사유 구분)
- [ ] 유지보수 모드(04) 노드 수를 별도 표기

## 함정
- "kubectl 출력에 Ready 가 있으니 OK" 식 문자열 판정 금지 (모듈 09) — `status.conditions[type=Ready].status`.
