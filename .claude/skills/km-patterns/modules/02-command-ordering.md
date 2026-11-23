# 02. 명령 선후 그래프 (role_command_order → Stage)

## 원형 (KM)
- `role_command_order.json`
  - 형식: `"막히는ROLE-COMMAND": ["먼저끝날ROLE-COMMAND", ...]`
  - `general_deps`(항상) + 조건부 섹션(`namenode_optional_ha`, `optional_no_glusterfs` …)
  - 정지는 역방향을 따로 선언: `"ZOOKEEPER_SERVER-STOP": ["HBASE_MASTER-STOP", ...]`
- RoleGraph(stage planner) — 그래프 위상 정렬 → 같은 레벨 = 한 Stage(병렬), 레벨 순서대로 실행

## 핵심 계약
요청 1건 = Stage N개. Stage 안 Task 는 병렬, Stage 사이는 직렬. 앞 Stage 실패 시 뒤 Stage 미실행(또는 재시도 정책).

## PEP 이식
- 대상: `/k8s-services` 다중 서비스 적용 (`services/service_config/apply_nodes.py` 의 `_run_batches` 는 **한 서비스 안의 노드 배치**만 다룸).
- 그래프 저장: AppSetting `service_config.command_order` (JSON), 시드 예:
  ```json
  {"general": {
     "KUBE-APISERVER-RESTART": ["ETCD-RESTART"],
     "CONTROLLER-MANAGER-RESTART": ["KUBE-APISERVER-RESTART"],
     "SCHEDULER-RESTART": ["KUBE-APISERVER-RESTART"],
     "KUBELET-RESTART": ["KUBE-APISERVER-RESTART", "CONTAINERD-RESTART"]},
   "when_external_etcd": {}}
  ```
- 플래너: `services/service_config/stage_planner.py` — Kahn 위상 정렬, 사이클이면 저장 단계에서 거부(422 + 사이클 경로).
- 실행: 상위 Run(`ServiceConfigApplyRun` 확장 또는 `parent_run_id`) 아래 Stage 별 하위 run. 기존 `_run_batches`
  를 Stage 안에서 그대로 재사용 → 노드 배치·`stop_on_failure` 유지.
- 화면: 적용 다이얼로그에 "실행 계획" 미리보기(Stage 1: ETCD · Stage 2: APISERVER …) → 실행 시 `RunLogPanel`
  에 Stage 칩. 로그 보기 키 `useLogPref('service-config-plan')`.
- 의존 규칙(`ServiceConfigRule` require/impact)과 구분: 규칙 = **값** 제약, 순서 그래프 = **실행** 제약.

## 체크리스트
- [ ] 저장 시 사이클 검출, 존재하지 않는 서비스 키 경고
- [ ] 계획(plan) 을 실행 전에 그대로 보여주고, 실행은 그 계획 스냅샷으로(중간 편집 영향 없음)
- [ ] Stage 실패 시 남은 Stage 를 "실행 안 됨" 으로 명시 기록 (생략·성공 처리 금지)
- [ ] 정지/역방향 명령이 필요하면 별도 키로 선언 (자동 역전 추론 금지)

## 함정
- 조건부 섹션 판정(예: 외부 etcd 여부)을 문자열 매칭으로 하지 말 것 — 클러스터 속성(구조화 값)으로 (모듈 09).
