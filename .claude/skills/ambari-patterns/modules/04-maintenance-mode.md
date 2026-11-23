# 04. 유지보수 모드 (Maintenance Mode)

## 원형 (Ambari)
- 호스트·서비스·컴포넌트 단위 `maintenance_state` (ON/OFF, 상위 상속)
- 효과: 알람 알림 억제(상태는 계속 계산) + 일괄 작업(롤링 재시작 등) 대상에서 기본 제외
- 업그레이드 체크 `HostMaintenanceModeCheck` · `ServicesMaintenanceModeCheck` 가 이를 입력으로 씀

## 핵심 계약
**판정은 멈추지 않고 알림·대상 선정만 바뀐다.** 끝나면 원래대로. 누가·언제·왜 켰는지 남는다.

## PEP 이식
- 모델 `MaintenanceWindow`: `scope(cluster|node|service)`, `cluster_id`, `target`(노드명 glob 또는 서비스 키),
  `reason`, `starts_at`, `ends_at`(필수 — 무기한 금지), `created_by`, `ended_at`. 감사 로그 기록.
- 판정 함수 하나: `services/maintenance.py::is_under_maintenance(cluster_id, node=None, service=None, at=None)`
  — 모든 소비자가 이것만 호출 (중복 구현 금지).
- 소비자:
  - `/alerts` — `alert_router.route_and_notify` 에서 알림 생략, 인박스 행에 "유지보수 중 억제" 배지
  - `/bulk-exec`, `/k8s-services` 적용 — 대상 목록에서 기본 제외 + "포함하기" 토글(operator)
  - 점검 매트릭스 — 결과는 기록하되 셀을 중립색 + 아이콘
  - 집계 알람(03) 분모 제외, 자동 복구(07) 중지
- Beat: 만료 처리용 별도 엔트리 불필요(조회 시점 판정). 추가한다면 CLAUDE.md §Celery 표 갱신.
- 화면: 클러스터 개요/노드 상세의 "유지보수 시작"(기간·사유 필수) + 전역 목록(진행 중/예정/종료).

## 체크리스트
- [ ] `ends_at` 필수, 최대 기간 AppSetting(`maintenance.max_hours`)
- [ ] 겹치는 창 허용(OR), 종료는 개별
- [ ] 테넌트 범위 — operate 권한 있는 클러스터만 켤 수 있음
- [ ] 백업: 새 테이블은 일반 테이블(LOG_TABLES 아님)

## 함정
- 알람 자체를 버리면 사후 분석이 불가능 — 억제는 **알림** 만.
