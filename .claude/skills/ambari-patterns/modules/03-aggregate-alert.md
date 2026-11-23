# 03. 집계 알람 (AGGREGATE) + reporting 템플릿

## 원형 (Ambari)
- `stacks/BIGTOP/3.2.0/services/ZOOKEEPER/alerts.json`
  - 호스트 알람 `zookeeper_server_process` (source.type=PORT, `{{zoo.cfg/clientPort}}`, 1.5s warn)
  - 서비스 알람 `zookeeper_server_process_percent` (source.type=AGGREGATE, warn 35% · crit 70%)
- source 타입: PORT · WEB · METRIC · SCRIPT (Agent 판정) / AGGREGATE · SERVER (Server 판정) / RECOVERY
- `reporting.{ok,warning,critical}.text` 에 `{0}` `{1}` 위치 인자 — 문구도 정의의 일부

## 핵심 계약
하위(호스트) 알람 이름 하나를 가리키고, 전체 대비 비정상 비율로 상위 상태를 판정. 개별 노드 알람 폭주 대신 서비스 1건.

## PEP 이식
- 입력 후보: 노드 파라미터 에이전트(`services/node_param_watch/`), NIC 판정(`services/nic_watch/analyze.py`),
  점검 매트릭스 노드 단위 결과.
- 정의 저장: `AlertAggregateRule` 테이블 또는 AppSetting `alerts.aggregate_rules`
  `{name, source_alert, cluster_id|null, warn_pct, crit_pct, min_total, text_template}`
- 평가: 기존 판정이 끝나는 지점에서 계산 → `services/observability/alert_ingest.py` 의 내부 경로로 알람 upsert
  (fingerprint = `agg:{name}:{cluster_id}`) → `alert_router.route_and_notify` 로 기존 라우팅·중복 억제 재사용.
- 화면: `/alerts` 알림 규칙 탭 옆 "집계 규칙" — 편집 시 현재 값 미리보기(“affected 12 / total 300 = 4%”).

## 체크리스트
- [ ] `min_total` — 분모가 작을 때(노드 2대) 50% 튐 방지
- [ ] 유지보수 모드 대상(모듈 04)은 분모·분자에서 제외하고 제외 수를 문구에 표시
- [ ] 집계 알람이 뜨면 하위 노드 알람 알림은 억제 옵션(인박스엔 남김)

## 함정
- 하위 알람이 "수집 실패(collection_error)" 인 노드를 비정상으로 세면 안 된다 — 별도 `unknown` 카운트.
