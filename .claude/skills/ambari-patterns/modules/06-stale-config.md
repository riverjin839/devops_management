# 06. 재시작 대기 표시 (stale config)

## 원형 (Ambari)
- host_component 마다 `stale_configs` 플래그 — 저장된 desired config 태그 ≠ 실제 로딩된 태그
- Agent `RecoveryManager.update_config_staleness`, `ActualConfigHandler.py` 가 실제 적용 태그 보고
- UI: 서비스/호스트에 "Restart Required" + 영향 컴포넌트만 재시작 버튼

## 핵심 계약
값이 다른 것(드리프트)과 **적용됐지만 아직 안 읽힌 것(stale)** 은 다른 상태다.

## PEP 이식
- PEP 는 `ServiceConfigDrift`(현재 노드 값 ≠ 적용 버전) 알람이 있음 → stale 은 추가 축:
  `파일 mtime(또는 적용 run 완료 시각) > 프로세스 시작 시각` 이면 stale.
- 수집: 노드 파라미터 에이전트 보고에 `systemctl show -p ActiveEnterTimestamp <svc>` 와 관리 파일 mtime 추가
  (`services/node_param_watch/manifest.py`), 정적 파드는 K8S API 의 컨테이너 `startedAt` vs 매니페스트 해시 주석.
- 상태: `fresh | stale | unknown` 을 `config_snapshot` 옆 현재 값 뷰(`services/service_config/current.py`)에서 계산.
- 화면: `/k8s-services` 노드 목록에 "재시작 필요" 배지 + "stale 노드만 롤링 재시작" (기존 apply 배치 재사용).

## 체크리스트
- [ ] 시각 비교는 노드 시계 오차 허용(AppSetting `stale.clock_skew_s`)
- [ ] 판정 근거(두 시각)를 툴팁에 그대로 노출
- [ ] unknown 은 stale 로 세지 않음

## 함정
- 프로세스 재시작 없이 reload(SIGHUP) 하는 서비스는 시작 시각이 안 바뀐다 → 서비스 정의(01)에 `reload_detect` 방식 선언.
