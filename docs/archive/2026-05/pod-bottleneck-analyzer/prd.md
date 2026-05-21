# PRD-lite — Pod-to-Pod Bottleneck Analyzer

> 작성일: 2026-05-21
> 모드: PM-lite (Agent Teams 비활성, 정식 pm-lead 미사용 — 사용자 합의 기반)
> 직전 사이클: lake-service-monitoring (95%, archived)
> 다음: `docs/01-plan/features/pod-bottleneck-analyzer.plan.md`

---

## Executive Summary

| Perspective | Statement |
|---|---|
| **Problem** | DevOps engineer 가 "ns=workbench 의 frontend pod 가 backend 호출 느림" 같은 pod-to-pod 병목을 만났을 때 현재 시스템은 **정성적 verdict (allow/deny/drop)** 만 보여줌. RTT/retransmit/queue depth/conntrack 같은 **정량 메트릭** 은 직접 node ssh + `ss -tin` / `tcpdump` 수동 — 시간 소모 + 비전문가 진입 장벽 |
| **Solution** | PacketFlowPage 와 인접한 신규 도메인 `/pod-bottleneck` (또는 PacketFlowPage 의 신규 탭). 두 pod 선택 → 8 capability (TCP 메트릭 / iperf3 / DNS latency / conntrack / endpoints / L7 trace / 노드 자원 / 비교) 를 한 화면 + 단발 실행 + 결과 저장 |
| **Function UX Effect** | "ns=workbench frontend → backend" 선택 → "지금 진단" 클릭 → 5-10초 내 ① TCP socket state ② RTT/retransmit ③ DNS latency ④ active iperf3 throughput ⑤ 의심 hop hint 한 화면. 결과는 LakeService 패턴처럼 `BottleneckRun` 으로 저장되어 다음 사람이 referenceable |
| **Core Value** | "**병목 진단 → 평균 30분 → 30초**". 비전문가도 1-click. 진단 history 가 ServiceEntry 패턴으로 조직 자산화 (lake 사이클 가치 연장) |

## 1. WHY — Problem Statement

### 1.1 사용자 시나리오 (Trigger)
- "ns=workbench 의 frontend pod 가 backend API 호출 시 지연 발생" 신고 접수
- 운영자가 현재 가능한 일:
  1. `kubectl get pods -n workbench` — 상태 OK
  2. `/packet-flow` 진입 → 두 pod 선택 → 토폴로지 그래프 + hop verdict 봄 — **모두 allow**
  3. Hubble timeline 봄 — flow drop 없음
  4. 이제부터 막힘 — node ssh → tcpdump → ss → 한참 분석

### 1.2 Pain Points
- **정량 데이터 부재**: "허용은 되는데 느림" 시나리오에서 verdict 만으로는 답 안 나옴
- **노드 접근 권한**: ssh 가능한 사용자 제한 — 운영자별 격차
- **history 없음**: 같은 진단을 다음 주에 다른 사람이 다시 처음부터
- **CoreDNS / NetworkPolicy / conntrack** 같은 인프라 layer 가 GUI 에 안 보임

### 1.3 기존 시스템과의 관계 (Reuse 분석)

| 자산 | 활용도 | 비고 |
|---|---|---|
| **PacketFlowPage** | ⭐⭐⭐ 핵심 — 토폴로지/hop verdict/Hubble/Tcpdump 이미 있음 | **신규 도메인 분리 vs PacketFlowPage 의 신규 탭** 결정 필요 |
| `cilium_trace_service` (BPF inspect, hubble/monitor SSE) | ⭐⭐ 그대로 활용 | service mesh layer |
| `topology_trace_service` | ⭐⭐ hop discovery 재사용 | 두 pod 의 path |
| `bulk-exec` (노드 일괄 실행) | ⭐⭐ ss/iperf3/tcpdump 실행 채널 | node command runner 이미 있음 |
| `lake-service-monitoring` 의 Strategy Registry 패턴 | ⭐⭐ Bottleneck Probe 별로 동일 패턴 적용 | airflow/spark/... 처럼 TcpStateProbe/RttProbe/DnsLatencyProbe/Iperf3Probe |
| `ServiceEntry kind=history` | ⭐ 결과 history 저장 | 또는 신규 BottleneckRun 모델 |
| `audit_logger` | ⭐ 진단 실행 audit | 직전 사이클 baseline |

## 2. WHO — Persona

### 2.1 Primary — DevOps SRE (junior-mid)
- 매일 ns=workbench (사용자 application 공간) 의 incident 대응
- kubectl 정도는 능숙, 깊은 네트워크 (tcpdump 분석, BPF, NetworkPolicy 디버깅) 는 약함
- 30 분 안에 1차 진단 + 결론 (escalate / fix) 내려야 함

### 2.2 Secondary — DevOps Lead
- 진단 history 를 보고 패턴 (이 클러스터의 만성 문제 vs 일회성) 식별
- 신규 입사자에게 "이 진단부터 해봐" 안내

### 2.3 Anti-persona (out)
- 개발자 — 앱 코드 디버깅은 다른 도구 (APM, profiler)
- 네트워크 엔지니어 — 이미 자체 도구 (Wireshark, mtr) 사용 — 본 도구는 보조

## 3. JTBD (Jobs To Be Done)

> *"When a user reports that ns=workbench frontend → backend is slow, I want to identify the bottleneck layer (network drop / TCP queue / DNS / app) in under 5 minutes without ssh, so that I can either fix it or escalate with concrete evidence."*

핵심 동사: **identify** (binary judgment — 어디가 막혔는지) + **evidence** (history-able)

## 4. MVP Scope — 8 Capability 우선순위

직전 답변의 8 capability 를 ROI (가치 / 구현 비용) 로 정렬:

| # | Capability | 가치 | 구현 비용 | MVP 후보? |
|---|---|---|---|:---:|
| 1 | **TCP socket state** (pod 안에서 `ss -tin` 결과 파싱) | ⭐⭐⭐ — 가장 흔한 병목 직접 증거 | 중 (`kubectl exec` + parser) | ✅ |
| 2 | **TCP perf counters** (`/proc/net/snmp` + retransmit rate 계산) | ⭐⭐⭐ — RTT/loss 분리 | 중 | ✅ |
| 3 | **Active iperf3** (양 pod 안에 iperf3 sidecar 가정) | ⭐⭐ — baseline throughput | 큼 (iperf3 prerequisite + 양 pod ephemeral container) | ⚠️ carry |
| 4 | **CoreDNS latency** (CoreDNS metrics scrape) | ⭐⭐ — DNS 병목은 의외로 흔함 | 중 (Prometheus + CoreDNS metrics endpoint) | ✅ |
| 5 | **conntrack / iptables** (node ssh 로 `conntrack -L` summary) | ⭐⭐ — NAT exhaustion | 중 (bulk-exec 채널 재활용) | ⚠️ 시범만 |
| 6 | **Service endpoints** (EndpointSlice + ready ratio) | ⭐⭐ — "backend 1개만 받음" 분배 문제 | 작 (K8s SDK 만) | ✅ |
| 7 | **L7 HTTP** (Hubble L7 metric 활용 + p95) | ⭐⭐ — 앱 vs 네트워크 구분 | 큼 (Hubble L7 enabled 가정) | ⚠️ carry |
| 8 | **노드 자원** (NIC PPS, softirq, CPU) | ⭐ — 1차 진단엔 후순위 | 중 (node-exporter Prometheus) | ⚠️ carry |

### 4.1 MVP Final Scope (확정안)

**IN** (4 capability):
- C1: TCP socket state (ss -tin)
- C2: TCP perf counters (/proc/net/snmp diff)
- C4: CoreDNS latency
- C6: Service endpoints (ready ratio + EndpointSlice)

→ "병목 4축" 으로 통합 view. 각각 status (healthy/warning/critical) + raw 데이터 + 권고 액션.

**OUT** (4 carry-over):
- C3 iperf3 (`pod-bottleneck-iperf3` 별도 PDCA — ephemeral container 인프라 필요)
- C5 conntrack (`pod-bottleneck-node-layer` — node ssh 채널 통합 필요)
- C7 L7 HTTP (`pod-bottleneck-l7-trace` — Hubble L7 enable 전제)
- C8 노드 자원 (`pod-bottleneck-node-resource` — Prometheus + Grafana 통합)

## 5. 도메인 위치 결정 — 신규 페이지 vs PacketFlow 확장

| 옵션 | 장점 | 단점 |
|---|---|---|
| **A. PacketFlowPage 신규 탭 "Bottleneck"** | UX 연속 (병목 진단 = 토폴로지 그 다음 step), 코드 재사용 | PacketFlowPage 가 이미 큼 (373줄), 더 비대해짐 |
| **B. 신규 `/pod-bottleneck` 페이지** | 도메인 격리, MacCard 표준 다시 적용, 진입점 명확 | UX 단절 ("토폴로지는 PacketFlow, 병목은 PodBottleneck") |
| **C. 신규 페이지 + PacketFlowPage 에 "병목 진단으로 이동" CTA 링크** | 둘 다 — 도메인 격리 + UX 연결 | 약간의 navigation overhead |

→ **선택: C (신규 페이지 + cross-link)**. lake-service-monitoring 패턴 동일 (별도 도메인 + 카드/상세). 단 PacketFlowPage 에 "이 pod-pair 의 병목 진단 →" 버튼 추가.

## 6. Success Criteria (Plan 단계로 이관 예정)

- SC-1. `/pod-bottleneck` 진입 → 두 pod 선택 (cluster + ns + pod 이름) → "지금 진단" → 10초 내 4축 결과 표시
- SC-2. 4축 각각이 status badge + raw 데이터 + 권고 액션
- SC-3. 진단 결과는 `BottleneckRun` 으로 저장 + 같은 pod-pair history view
- SC-4. PacketFlowPage 에서 "병목 진단" 버튼으로 cross-link
- SC-5. 직전 사이클 baseline (인증/페이지네이션/audit/error code dict) 모두 충족

## 7. Beachhead Segment (Geoffrey Moore-style)

- **Cluster**: workbench namespace 가 있는 production 클러스터 (사용자 환경)
- **Use case 빈도**: 주 2-3회 incident 대응
- **Time saved per use**: 25분/회 (30분 → 5분)
- **연간 ROI**: 50 incident × 25분 = ~20시간/년/엔지니어
- 운영 팀 규모가 3명이면 60시간/년 = 약 1.5 주 절약

## 8. Pre-Mortem (실패 시나리오)

| 실패 시나리오 | 확률 | 회피책 |
|---|---|---|
| `kubectl exec` 가 production pod 에 거부 (PSA restricted) | 중 | sidecar / ephemeral container 옵션 + fallback "manual command suggest" |
| ss 결과 parsing 이 distro/version 별 다름 | 중 | regex 대신 `-J` (json output) 우선, fallback parser |
| pod 가 distroless 면 ss/tcpdump 없음 | 높음 | "no_diag_binary" 명시적 표시 + node 레벨 fallback |
| CoreDNS metrics endpoint 접근 권한 없음 | 중 | DNS resolution probe (양 pod 안에서 nslookup) 대체 |
| EndpointSlice 가 너무 빨리 변해 race | 낮음 | snapshot view + "이 시점의 endpoints" timestamp |

## 9. 의사결정 요청 — Checkpoint

PRD-lite 완성. Plan phase 진입 전 사용자에게 4가지 확인:

| # | 결정 | 권장 |
|---|---|---|
| **D1. MVP 4축** | C1+C2+C4+C6 합의? | OK if 위 §4.1 scope OK |
| **D2. 도메인 위치** | 신규 `/pod-bottleneck` + PacketFlowPage cross-link (옵션 C) | OK if §5 OK |
| **D3. `kubectl exec` 정책** | pod 안에서 ss 실행 — distroless / PSA restricted 대응은 fallback "manual command suggest" 로 충분? | 또는 시작 시 capability probe 먼저 |
| **D4. 결과 저장** | 신규 `BottleneckRun` 모델 + 별도 history view? 또는 ServiceEntry kind=history 재활용? | 신규 모델 권장 (구조화된 4축 데이터 보존) |

이 4 결정 받은 후 plan 으로 진행.
