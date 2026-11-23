# 07. 자동 복구 예산

## 원형 (KM)
- 노드 에이전트 `RecoveryManager` 기본값
  `max_count=6`, `window_in_min=60`, `retry_gap=5`, `max_lifetime_count=12`
- desired=STARTED, current=INSTALLED → Agent 가 같은 명령 스크립트로 START. 예산 초과 → RECOVERY 알람으로 사람 호출
- 다른 명령 실행 중(`has_active_command`)이면 복구 보류

## 핵심 계약
자동 조치는 **예산 안에서만**. 예산은 창(window)·간격(gap)·누적(lifetime) 3중.

## PEP 이식
- 범위: opt-in 조치 경로만 (예: kubelet/containerd 비활성 시 재기동, k8s_efficiency 자동 rightsizing).
  `services/analyzers/` 에는 절대 넣지 않는다(분석 전용 규칙).
- 공용 헬퍼 `services/recovery_budget.py::try_consume(key, policy) -> (allowed, reason)` — Redis 카운터
  (`zset` 타임스탬프), key = `{cluster_id}:{node}:{action}`. 정책은 AppSetting `recovery.policy` 화면 편집.
- 차단 조건: 유지보수 모드(04), 같은 대상에 진행 중 run, 테넌트 동시성 슬롯(`tenant_concurrency.acquire_run_slot`).
- 예산 초과 시 알람 `AutoRecoveryExhausted`(alert_ingest 내부 경로) + 실행 로그에 남은 예산 기록.

## 체크리스트
- [ ] 모든 시도가 run 로그에 남음(성공·실패·예산 거부 포함)
- [ ] 누적(lifetime) 리셋은 사람만 — 화면 버튼 + 감사 로그
- [ ] 조치 후 성공 판정은 모듈 09 방식

## 함정
- 플래핑(재기동 직후 다시 죽음)은 gap 이 짧으면 예산을 순식간에 소진 — gap 최소값 강제.
