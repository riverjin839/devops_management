# Plan — Pod-to-Pod Bottleneck Analyzer

> 작성일: 2026-05-21
> 모드: Fresh PDCA (신규 개발)
> PRD: `docs/00-pm/pod-bottleneck-analyzer.prd.md`
> 직전 사이클: lake-service-monitoring (95%, archived)
> 다음: `docs/02-design/features/pod-bottleneck-analyzer.design.md`

---

## Executive Summary

| Perspective | Statement |
|---|---|
| **Problem** | Pod ↔ pod 병목 정량 진단 (TCP socket state, RTT/retransmit, DNS latency, endpoint 분배) 이 GUI 에 없음. 매번 node ssh + `ss -tin` / nslookup / `kubectl get endpointslices` 수동 = 평균 30분 |
| **Solution** | 신규 `/pod-bottleneck` 도메인 — 두 pod 선택 → "지금 진단" → 4축 (TCP state / TCP perf / DNS latency / Service endpoints) 통합 결과 + 권고 액션 + `BottleneckRun` history 저장. PacketFlowPage 와 cross-link |
| **Function UX Effect** | 운영자가 ns + source pod + dest pod 선택 → 10초 내 4축 status badge + raw 데이터 + "queue 가득" 같은 권고. distroless / PSA restricted 면 manual command 안내 fallback |
| **Core Value** | **병목 진단 30분 → 30초** + 진단 history 조직 자산화 (lake 사이클 가치 연장) |

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | "정성 verdict (allow/deny) 만으로 못 푸는 시나리오" — '허용은 되는데 느림' 의 정량 증거 확보. 비전문가 진입 장벽 ↓ |
| **WHO** | DevOps SRE (junior-mid) — kubectl 능숙, BPF/tcpdump 약함. 30분 안에 1차 진단 후 escalate/fix |
| **RISK** | 4축 다 깊으면 1500줄+ 될 수 있음. exec 실패 (distroless/PSA) 대응이 큰 if. 결과 false-positive 시 운영자 신뢰 손상 |
| **SUCCESS** | 4축 결과 < 10초 + history 저장 + PacketFlow cross-link + 직전 사이클 baseline 충족 + manual fallback 명확 |
| **SCOPE** | (in) BottleneckRun 모델 + 4 Probe (Strategy/Registry) + `/pod-bottleneck` 메인+상세 + ServiceEntry 통합 + PacketFlowPage CTA. (out) iperf3 active probe, conntrack, L7 HTTP, 노드 자원 (4 carry-over) |

## 1. Requirements

### FR — Functional

- FR-1. **두 pod 선택**: cluster + namespace + source_pod + dest_pod (autocomplete via K8s SDK `list_namespaced_pod`)
- FR-2. **"지금 진단" 버튼**: 4축 Probe 를 병렬 실행 (asyncio.gather) → 결과 BottleneckRun 1 row 저장
- FR-3. **4축 결과 view**: 각각 MacCard — status badge (healthy/warning/critical/pending) + 핵심 수치 + raw details JSON expand + 권고 액션 1-2줄
- FR-4. **History view**: 같은 cluster+ns+source+dest pair 의 BottleneckRun 시간순 timeline (LakeService 패턴)
- FR-5. **PacketFlowPage cross-link**: 토폴로지에서 두 pod 선택 시 "이 pod-pair 의 병목 진단 →" 버튼 → `/pod-bottleneck?cluster=...&ns=...&src=...&dst=...`
- FR-6. **Manual command fallback**: exec 실패 (distroless / no `ss` / PSA restricted) → "이 명령을 node 에서 직접 실행하세요" 명령어 + 결과 붙여넣기 input
- FR-7. **Strategy + Registry**: 신규 Probe 추가 = `BottleneckProbe` 클래스 1개 + `BOTTLENECK_PROBE_REGISTRY` 1줄

### NFR — Non-Functional

- NFR-1. **인증/권한**: 직전 사이클 baseline — GET `get_current_user`, mutating `require_operator`, audit_logger 호출
- NFR-2. **응답 시간**: 4 Probe 병렬 + 각 5초 timeout = 전체 응답 ≤ 10초
- NFR-3. **Fail-safe**: 한 Probe 실패가 다른 Probe 막지 않음 (각자 safe_run 으로 wrap)
- NFR-4. **UX 표준**: ClusterSidebar iconOnly, MacCard, ConfirmDialog, dark mode, error state
- NFR-5. **마이그레이션 안전**: `_safe_add_column` / `_safe_create_index` + Base.metadata.create_all 자동
- NFR-6. **신규 의존성 0**: 폐쇄망 + 기존 (kubernetes SDK + httpx + axios + TanStack Query + lucide-react) 만 사용
- NFR-7. **PSA 호환**: pod exec 실패 시 fallback 안내 — 운영 환경 정책과 충돌 없음

## 2. Success Criteria

| # | Criterion | 측정 |
|---|---|---|
| SC-1 | `/pod-bottleneck` 진입 → 두 pod 선택 → "지금 진단" → 10초 내 4축 결과 표시 | manual timing |
| SC-2 | 4축 각각 status badge + 핵심 수치 + 권고 액션 1-2줄 | UI inspection |
| SC-3 | BottleneckRun 으로 저장 + 같은 pod-pair history view 시간순 | DB + UI |
| SC-4 | PacketFlowPage 에서 "병목 진단" CTA 클릭 → 사전 채워진 form 으로 이동 | manual test |
| SC-5 | 직전 사이클 baseline (인증/페이지네이션/audit/error code dict/ConfirmDialog) 충족 | code review |
| SC-6 | 신규 Probe 추가 = Probe 클래스 1 + REGISTRY 1줄 + 카탈로그 1 entry | code review |
| SC-7 | exec 실패 시 manual command 안내 + 결과 paste 가능 | code review |

## 3. Constraints

- C-1. 정적 분석 only (이전 사이클 동일)
- C-2. 신규 dependency 0 — 폐쇄망 친화
- C-3. ServiceEntry 모델 변경 X — 가이드/히스토리는 그대로 활용
- C-4. PacketFlowPage 코드 변경 최소 (CTA 1개 추가만)
- C-5. 직전 두 사이클의 cluster.tls_verify / work_items ownership 정책 영향 없음

## 4. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `kubectl exec` 가 PSA restricted 클러스터에서 거부 | High | manual command suggest fallback (FR-6) |
| pod 가 distroless — ss/nslookup 없음 | High | capability probe (없으면 alternative path) |
| ss 결과 parsing 이 distro 별 다름 | Med | `-J` (json) 우선 시도, fallback regex |
| CoreDNS metrics endpoint 권한 부족 | Med | dual-pod `nslookup <dest>` 직접 측정 fallback |
| EndpointSlice race (조회 중 변경) | Low | snapshot + timestamp 표시 |
| 4 Probe 병렬 timeout 누적 | Med | asyncio.gather + 5초 hard timeout per probe |

## 5. Out of Scope (Carry-Over)

- `pod-bottleneck-iperf3` — Active throughput probe (ephemeral container 필요)
- `pod-bottleneck-node-layer` — conntrack / iptables hit rate (node ssh 채널 통합)
- `pod-bottleneck-l7-trace` — Hubble L7 metric (Hubble L7 enable 전제)
- `pod-bottleneck-node-resource` — NIC PPS / softirq / NUMA (Prometheus 통합)

## 6. 4-Axis MVP Spec

### C1. TCP Socket State (`ss -tin` in source pod)

| 항목 | 값 |
|---|---|
| 명령 | `kubectl exec -n {ns} {src_pod} -- ss -tinJ` (JSON 우선) |
| 파싱 | Recv-Q / Send-Q / RTT(avg) / cwnd / lost / retrans / unacked |
| Threshold (warning) | RTT > 100ms OR Recv-Q > 1024 OR retrans > 0 |
| Threshold (critical) | RTT > 500ms OR Recv-Q > 16384 OR retrans > 10 |
| 권고 (예) | "Recv-Q 8192 — 앱이 reads 못 따라옴. backend pod CPU/profile 확인" |

### C2. TCP Perf Counters (`/proc/net/snmp` + `/proc/net/netstat` diff)

| 항목 | 값 |
|---|---|
| 명령 | `kubectl exec ... -- cat /proc/net/snmp /proc/net/netstat` (1차) + 2초 대기 + 2차 → diff |
| 파싱 | RetransSegs / OutSegs / InErrs / TCPLostRetransmit / TCPSynRetrans |
| Threshold (warning) | retrans_rate = RetransSegs / OutSegs > 1% |
| Threshold (critical) | retrans_rate > 5% OR InErrs > 0 |
| 권고 (예) | "retrans 3.2% — 네트워크 손실 의심. cilium policy / NetworkPolicy / MTU 확인" |

### C3. CoreDNS Latency

| 항목 | 값 |
|---|---|
| 1차 시도 | CoreDNS metrics endpoint (`http://coredns.kube-system.svc:9153/metrics`) 의 `coredns_dns_request_duration_seconds_bucket` |
| 2차 fallback | source pod 에서 `nslookup {dest_service}` 3회 평균 |
| Threshold (warning) | p95 > 50ms |
| Threshold (critical) | p95 > 500ms OR NXDOMAIN/SERVFAIL > 0 |
| 권고 (예) | "DNS p95 120ms — CoreDNS replica 부족 의심. `kubectl scale -n kube-system deploy/coredns --replicas=3`" |

### C4. Service Endpoints + Ready Ratio

| 항목 | 값 |
|---|---|
| 명령 | K8s SDK `discovery_v1.list_namespaced_endpoint_slice(ns, label_selector=f"kubernetes.io/service-name={svc}")` |
| 파싱 | endpoints 수, ready 수, ports, addresses |
| Threshold (warning) | ready_ratio < 100% (예: 3/5) |
| Threshold (critical) | ready_count == 0 OR endpoint_count == 0 |
| 권고 (예) | "backend 2/5 ready — pod restart 또는 readinessProbe 실패. `kubectl describe pod ...`" |

## 7. Out-of-Scope Capability vs Plan

PRD §4 의 8 capability 중 ✅ 4 IN / ⚠️ 4 carry — Plan 변경 없음.

## 8. Phase 계획

| Phase | 산출물 | 예상 |
|---|---|---|
| **1. PM (PRD-lite)** | ✅ 완료 | `docs/00-pm/pod-bottleneck-analyzer.prd.md` |
| **2. Plan** (현재) | ✅ 본 문서 | — |
| **3. Design** (다음) | 3 architecture 비교 + Module Map M1-M9 | ~5분 |
| **4. Do** | backend (모델+라우터+Probe registry+마이그레이션) + frontend (페이지+훅+컴포넌트) | ~1300-1600 라인 |
| **5. Check** | 4-axis self-check | ~5분 |
| **6. Iterate** (필요 시) | lint/tsc 픽스 | ~5분 |
| **7. Report + QA + Archive + Commit + Push** | 직전 사이클 패턴 | ~15분 |

총: 직전 lake-service-monitoring 사이클(95%, ~1700줄)과 유사 규모.

## 9. Carry-Over (사전 명시)

- CO-1: `pod-bottleneck-iperf3` — active throughput
- CO-2: `pod-bottleneck-node-layer` — conntrack/iptables
- CO-3: `pod-bottleneck-l7-trace` — Hubble L7
- CO-4: `pod-bottleneck-node-resource` — Prometheus 노드 메트릭
- CO-5: `pod-bottleneck-scheduled-check` — 주기적 진단 (Celery Beat)
- CO-6: `pod-bottleneck-ai-advisor` — Ollama 기반 권고 자동 생성 (현재는 hardcoded threshold + 정적 메시지)
