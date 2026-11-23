---
name: k8s-ops-health-rollup
description: 클러스터·워크로드·노드·파드의 건강 상태를 계층적으로 계산하고 외부 모니터링(Nagios·Alertmanager·Slack)으로 내보낼 때 사용. KM(K8s Manager) 헬스 모델 — healthSummary(DISABLED·HISTORY_NOT_AVAILABLE·NOT_AVAILABLE·GOOD·CONCERNING·BAD) + healthChecks + maintenanceMode + entityStatus, 그리고 외부 모니터링 상태 매핑·상태 문자열 패턴을 적용한다.
---

# Health rollup (KM 헬스 모델 / 외부 모니터링 연동)

> 레퍼런스 구현: [`reference.py`](reference.py) — `rollup` / `should_alert` / `status_line` / `NAGIOS`·`TRAFFIC_LIGHT` 매핑 /
> `node_checks`·`threshold_check`. 분석 배경: `docs/03-analysis/km-borrow-analysis.md` §4.

## KM 패턴
| KM 개념 | 의미 | K8s 적용 |
|---|---|---|
| `healthSummary` 6단계 | "모름"(NOT_AVAILABLE/HISTORY_NOT_AVAILABLE)과 "정상"을 구분 | 프로브 실패 ≠ 정상. 수집 직후 = pending |
| `healthChecks[{name, summary}]` | 요약 뒤에 **이름 붙은 개별 체크** | NODE_READY, POD_RESTARTS, PVC_USAGE … |
| 계층 롤업 (노드·인스턴스 → 서비스 → 클러스터) | 최악값 전파 | 파드 → 워크로드 → NS/애드온 → 클러스터 |
| `maintenanceMode` | 상태는 계산, 알람만 억제(상속) | 드레인·업그레이드 중 노드/클러스터 |
| `entityStatus` | 운영 상태(STARTED/STOPPED…)와 건강을 **별도 축** | "정지됨"은 BAD 가 아니다 |
| KM 상태 문자열 | `"WARNING: CONCERNING, CHECK=…"` — 비정상 체크만 덧붙임 | 알림 본문·외부 연동 상태 문자열 |
| KM 상태 코드 매핑 | 상태 → 외부 코드 매핑을 한 곳에 | Nagios exit code, 3색(healthy/warning/critical) |

## 규칙
1. 상태 enum 은 **정렬 가능**하게(값이 클수록 나쁨) → 롤업은 `max`.
2. DISABLED·suppressed 체크는 롤업에서 제외. **알려진 값이 모두 GOOD 인데 일부가 모름이면 GOOD 으로 덮지 않는다**(CONCERNING).
3. 유지보수는 상속(클러스터 → 하위). 상태 표시는 그대로, 알람·알림만 억제.
4. 운영 상태(entity_status)와 건강(health)을 한 필드에 섞지 않는다.
5. 외부 매핑(Nagios/3색/Alertmanager severity)은 **단일 dict** 에서만 정의.
6. 임계치는 하드코딩하지 않고 params/thresholds(UI 편집)로 — `threshold_check(name, value, warn, crit)`.
7. 디자인 규칙: 정상은 중립색, 상태색은 비정상에만(DESIGN_SYSTEM §12.12).

## PEP 적용 지점
- 종합 상태: `services/core_bundle_checker.py`(critical > warning > healthy), `services/cluster_status_service.py recompute`.
  → NOT_AVAILABLE/pending 을 "정상"으로 흘리지 않는 규칙, 개별 체크 이름을 상태 문자열로 덧붙이는 규칙이 보강 후보.
- 알람: `alert_event`/`alert_notify_rule` — `should_alert`(유지보수 상속) 를 라우팅 앞단 필터로.

## 체크리스트
- [ ] 6단계(또는 최소 unknown/pending 분리) 상태와 이름 붙은 개별 체크
- [ ] 계층 롤업 + 체크 억제 + 유지보수 상속
- [ ] 외부 매핑 단일 정의, 상태 문자열에 비정상 체크만 나열
- [ ] 임계치 UI 편집
