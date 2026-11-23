---
name: k8s-ops-diagnostics-bundle
description: 장애 대응용 "지원 번들"(이벤트·describe·로그·노드 상태·메트릭을 시간창/크기 예산으로 묶어 내려받기) 또는 파드 단위 진단 명령(스레드 덤프·열린 파일·소켓·힙 히스토그램)을 만들 때 사용. Cloudera cm_api 의 collect_diagnostic_data_45(end·bundle_size·start·roles·metrics, 티켓 번호/코멘트)와 역할 단위 lsof/jstack/jmap 명령 패턴을 옮긴다.
---

# Diagnostics bundle (cm_api `collect_diagnostic_data` / jstack·lsof 차용)

> 레퍼런스 구현: [`reference.py`](reference.py) — `assemble`(우선순위·예산·시간창·마스킹·manifest) /
> `redact` / `DIAG_COMMANDS` + `diag_argv`(kubectl exec/debug 인자 목록). 분석 배경: `docs/03-analysis/cm-api-borrow-analysis.md` §7.

## 원본에서 가져오는 것
| cm_api | 의미 | K8s 적용 |
|---|---|---|
| `collect_diagnostic_data_45(end, bundle_size_bytes, cluster, roles, collect_metrics, start)` | **start 있으면** 기간 전체(초과 시 실패), **없으면** end 부터 거꾸로 예산까지 | 두 모드 그대로: "이 시간대 전부" vs "최근부터 N MB" |
| `roles` 제한 | 수집 범위 축소 | 네임스페이스·파드·노드 대상 제한 |
| `create_yarn_application_diagnostics_bundle(ticket_number, comments)` | 번들에 티켓/코멘트 | manifest 에 티켓 번호·코멘트 → Jira/ServiceNow 첨부 |
| `lsof/jstack/jmap_histo/jmap_dump(*roles)` → ApiCommand | 대상 프로세스 진단 명령 | `kubectl exec`/`kubectl debug`(distroless) 읽기 전용 카탈로그 |

## 규칙
1. 우선순위 고정: manifest > events > describe > node_conditions > 에러 로그 > previous 로그 > 로그 > 메트릭.
   예산이 모자라면 **뒤에서부터 잘리고** 잘린 목록을 manifest `dropped` 에 남긴다(조용히 누락 금지).
2. 기간을 명시한 요청은 잘라서 거짓 완결을 만들지 않는다 — 예산 초과면 실패 + 안내.
3. 모든 텍스트는 번들에 넣기 전 **마스킹**(password/token/Bearer/PRIVATE KEY). Secret 리소스 본문은 수집하지 않는다.
4. 진단 명령은 **argv 리스트**로만 구성(셸 문자열 결합 금지). 카탈로그 밖 임의 명령은 이 기능으로 받지 않는다.
5. 수집 자체가 명령(`k8s-ops-command-tracking`) — 수집 단계별 실시간 로그 + 로그 보기 토글, 결과는 다운로드 링크.
6. 수집기는 fail-safe: 한 소스 실패는 manifest `errors` 에 기록하고 계속.

## PEP 적용 지점
- 앱 자체 진단: `services/system_diagnostics.py`(섹션별 fail-safe) — 같은 철학을 **대상 클러스터** 번들로 확장.
- 장애 분석: `services/incident_context_builder.py`, `services/k8s_diagnose.py` — 번들 `files` 를 분석기 입력으로 재사용 가능.
- 파드 exec: `routers/k8s_exec.py`, `services/kubectl_exec.py`, 명령 마스킹 `services/command_mask.py`.

## 체크리스트
- [ ] 두 모드(기간 전체 / 최근부터 예산) + 대상 범위 제한
- [ ] 우선순위·예산·dropped 기록·마스킹·manifest(티켓/코멘트)
- [ ] 진단 명령 카탈로그(읽기 전용, argv), distroless 는 debug 컨테이너
- [ ] 명령 + 실시간 로그 + 로그 보기 토글, 결과 다운로드
