# 08. 텔레메트리 할당 (control plane / data plane 분리)

## 원형 (Ambari)
- `docs/ambari-agent-prometheus-telemetry-architecture.md`
- Stack `telemetry.json`(포맷·경로·설정 참조·HA 접두사·타임아웃·응답 상한) + 토폴로지 + 실효 설정
  → Server 가 호스트별 할당 컴파일 → STOMP `telemetry-v1` 배포 → Agent 는 **last-known-good** 할당만 저장
- 데이터: vmagent ← Ambari HTTP SD → Agent `/metrics`, `/metrics/components/{routeId}` → VictoriaMetrics
- routeId 는 Server 발급 → 임의 URL 프록시 불가(모르는 경로 404). 라벨 카디널리티 상한을 계약으로 둠

## 핵심 계약
무엇을 수집할지는 서버가 결정, 에이전트는 마지막 정상 설정으로 계속 동작. 값은 에이전트가 캐시하지 않음.

## PEP 이식
- 노드 파라미터 에이전트(`/os-param-watch`)의 감시 규칙 배포를 같은 모양으로: 서버가 노드별 manifest 를 컴파일
  (`services/node_param_watch/manifest.py`), 에이전트는 버전 해시 + LKG 저장, 실패 시 이전 manifest 유지.
- 에이전트가 `/metrics` 를 노출한다면 PEP 가 Prometheus `http_sd_configs` 엔드포인트 제공
  (`GET /api/v1/.../sd` — 토큰 fail-closed, `*_INGEST_TOKEN` 패턴).

## 체크리스트
- [ ] manifest 에 `schema_version` + 해시, 에이전트 보고에 적용 해시 포함 → 화면에 "적용된 규칙 버전"
- [ ] 라벨 금지 목록(프로세스·명령줄·사용자) 명시

## 함정
- 에이전트가 값까지 캐시해 하트비트로 보내면 수집 경로가 두 개가 된다 — 값은 scrape 경로 하나만.
