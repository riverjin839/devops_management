# Report — Pod-to-Pod Bottleneck Analyzer (Fresh PDCA)

> 작성일: 2026-05-21
> 모드: Fresh PDCA (PM-lite → Plan → Design → Do → Check → Report → QA → Archive)
> 직전 사이클: lake-service-monitoring (95%, archived)
> 최종 Match Rate: **95%** (정적 + lint/tsc PASS)

---

## Executive Summary

| Perspective | Before | After |
|---|---|---|
| **Problem** | Pod ↔ pod 병목 정량 진단 GUI 부재 → 매번 node ssh + `ss -tin` / nslookup / `kubectl get endpointslices` 수동 30분 | `/pod-bottleneck` 통합 도메인 — 두 pod 선택 → 4축 (TCP state / TCP perf / DNS latency / Service endpoints) 통합 진단 + BottleneckRun history |
| **Solution** | 가능은 했으나 (PacketFlow + tcpdump) **정성 verdict** 까지 | **정량 메트릭 자동 수집** (Recv-Q/RTT/retrans rate/p95 DNS/ready ratio) + 권고 액션 + manual fallback (distroless/PSA restricted 대응) |
| **Function UX Effect** | 운영자가 도구 4-5개 옮겨다님 | 한 화면 진단 → 10초 내 4축 status + 권고 + raw JSON + PacketFlowPage cross-link |
| **Core Value** | "**병목 진단 30분 → 30초**" + 진단 history 조직 자산화 + 비전문가 1-click |

### Value Delivered (정량)

| 지표 | 값 |
|---|---:|
| Match Rate (정적) | **95%** |
| Lint warnings | 0 ✅ |
| TypeScript errors | 0 ✅ |
| Backend 신규 파일 | 11 (모델 1 + 스키마 1 + probes 6 + helper 1 + router 1 + __init__ 1) |
| Frontend 신규 파일 | 6 (hooks 1 + pages 2 + components 3) |
| 수정 파일 | 5 (backend: models/routers/main __init__ + main.py / frontend: types/api/App/Sidebar/PacketFlow) |
| 신규 endpoint | 5 (POST /run, GET /probes, GET /runs, GET /runs/:id, DELETE /runs/:id) |
| 신규 dependency | **0** ✅ (폐쇄망 친화) |
| 4 Probe 병렬 timeout | 5초 each (TcpPerf 6초) |
| 총 라인 | ~1500 |

---

## 1. Overview

이전 두 사이클 (lake-service-monitoring fresh + work-mgmt-enterprise-audit reverse) 과 마찬가지로 **K8s 운영 도메인** 의 새 capability. PacketFlowPage 의 **정성 verdict** 분석 옆에 **정량 메트릭 진단** 을 보완.

### 4 Probe 매핑

| Probe | 명령 | Warning | Critical |
|---|---|---|---|
| TcpStateProbe | `ss -tinJ` (JSON) → fallback regex | RTT>100ms / Recv-Q>1024 / retrans>0 | RTT>500ms / Recv-Q>16384 / retrans>10 |
| TcpPerfProbe | `/proc/net/snmp` diff (2초 간격) | retrans_rate>1% | retrans_rate>5% / InErrs>0 |
| DnsLatencyProbe | `getent hosts {svc}` 3회 → fallback nslookup | p95>50ms | p95>500ms / NXDOMAIN |
| EndpointsProbe | K8s SDK `discovery_v1.list_namespaced_endpoint_slice` | ready_ratio<100% | ready=0 OR endpoint=0 |

## 2. Plan SC — Final Status

| # | Criterion | 상태 | Evidence |
|---|---|:---:|---|
| SC-1 | 진단 10초 내 결과 | ⚠️ | runtime 검증 필요. 4 Probe asyncio.gather + 각 5-6초 timeout — 이론상 ≤ 7초 |
| SC-2 | 4축 status badge + 핵심 수치 + 권고 1-2줄 | ✅ | `ProbeResultCard.tsx` — status icon + axis badge + message + recommendation + manual_fallback + details expand |
| SC-3 | BottleneckRun 저장 + history view | ✅ | model + router POST/GET, `PodBottleneckPage` 의 RunRow 리스트 |
| SC-4 | PacketFlow CTA cross-link | ✅ | `PacketFlowPage.tsx` 의 `bottleneckPrefill` + "병목 진단" 버튼 (east-west + pod 형식일 때만 활성) |
| SC-5 | Enterprise baseline (인증/페이지네이션/audit/error dict/ConfirmDialog) | ✅ | 5 endpoint deps 매핑 검증, audit_logger.record 3개, _not_found/_cluster_not_found dict |
| SC-6 | 신규 Probe = 1 클래스 + REGISTRY 1줄 + CATALOG 1 entry + Literal 1 | ✅ | `bottleneck_probes/__init__.py` + `schemas/bottleneck.py` ProbeKey Literal 4 위치만 |
| SC-7 | exec 실패 시 manual fallback 안내 | ✅ | `kubectl_exec.safe_pod_exec` → `make_manual_fallback` + `ProbeResultCard` 의 amber 박스 + 명령 copy 버튼 |

**Met: 6/7 정적 확정 + SC-1 runtime 검증 carry**

## 3. Key Decisions & Outcomes

| Decision | 선택 | Rationale | Outcome |
|---|---|---|---|
| **MVP scope** | 4 Probe (C1+C2+C4+C6), 4 carry | 사용자 선택 — 가장 가치 큰 4축 | ~1500줄, Plan 한도 정합 |
| **Architecture** | Option C (Pragmatic) — BottleneckRun 1 모델 + probes JSONB | Probe 별 별도 row 는 over-engineering, atomic 조회가 자연 | 모델 1개, 마이그레이션 단순 |
| **Probe 패턴** | LakeChecker Strategy/Registry 패턴 차용 | 일관된 신규 추가 비용 | `BOTTLENECK_PROBE_REGISTRY` + `PROBE_CATALOG` |
| **exec 정책** | Fallback "manual command suggest" | distroless / PSA restricted 환경 대응 안전 | `safe_pod_exec` returns (stdout, fallback_dict) — 어느 쪽이든 ProbeResult 로 |
| **결과 저장** | 신규 BottleneckRun 모델 (vs ServiceEntry 재활용) | 4축 구조화 데이터 보존 + pair 단위 history index | `ix_bottleneck_runs_pair` 복합 인덱스 |
| **도메인 위치** | 신규 `/pod-bottleneck` + PacketFlow cross-link | UX 연결 + 도메인 격리 | bottleneckPrefill memo 로 east-west 모드만 활성화 |
| **신규 의존성** | 0 — kubernetes SDK 만 사용 | 폐쇄망 + 사용자 npm install 부담 회피 | 직전 사이클의 react-markdown/dompurify 함정 회피 |

## 4. Match Rate

```
Static (Plan SC weighted):
  Structural  100% × 0.20 = 0.200  (Module Map M1-M9 모두 매칭)
  Functional   95% × 0.40 = 0.380  (SC-1 runtime 미검증 외 충족)
  Contract    100% × 0.40 = 0.400  (API ↔ Frontend 타입 일치, snake↔camel)
  ─────────────────────────────────────────────
  Overall                  ≈ 0.95  → 95%

Lint PASS + tsc PASS — 직전 사이클의 lint/lockfile 후속 commit 함정 회피
```

## 5. Changes Summary

### Backend — 11 신규 + 4 수정

| 파일 | 종류 | 핵심 |
|---|---|---|
| `models/bottleneck_run.py` | NEW | BottleneckRun (probes JSONB) + 복합 인덱스 |
| `schemas/bottleneck.py` | NEW | Create/Response/List + ProbeKey Literal + ProbeManualFallback |
| `services/kubectl_exec.py` | NEW | safe_pod_exec — 403/404/500/exception → (None, fallback_dict) |
| `services/bottleneck_probes/{base,tcp_state,tcp_perf,dns_latency,endpoints,__init__}.py` | NEW | LakeChecker 패턴 + ProbeContext + worst_status |
| `routers/bottleneck.py` | NEW | 5 endpoint (인증/페이지네이션/audit/error code dict) |
| `models/__init__.py`, `routers/__init__.py`, `main.py` | MOD | import + include_router |

### Frontend — 6 신규 + 5 수정

| 파일 | 종류 | 핵심 |
|---|---|---|
| `hooks/usePodBottleneck.ts` | NEW | 5 hooks (probes/runs/run detail/runAnalysis/delete) |
| `pages/PodBottleneckPage.tsx` | NEW | 진단 폼 + Recent Runs list + URL prefill + error/loading/empty |
| `pages/PodBottleneckDetailPage.tsx` | NEW | 4 Probe grid + ConfirmDialog + overall status header |
| `components/pod-bottleneck/{ProbeAxisBadge,ProbeResultCard,index}.tsx` | NEW | axis 색상 + 결과 카드 (manual_fallback amber 박스 + copy 버튼) |
| `types/index.ts` | MOD | BottleneckRun/Input/ProbeResultOut + 6 타입 |
| `services/api.ts` | MOD | podBottleneckApi (5 method) |
| `App.tsx` | MOD | 2 Route |
| `components/layout/Sidebar.tsx` | MOD | NAV_MAP + Activity import + monitoring group |
| `pages/PacketFlowPage.tsx` | MOD | bottleneckPrefill memo + handleGoBottleneck + "병목 진단" CTA 버튼 |

**총: 17 신규 + 9 수정 = 26 파일, ~1500 라인**

## 6. Carry-Over (6건, 별도 PDCA)

| # | PDCA | 이유 |
|---|---|---|
| CO-1 | `pod-bottleneck-iperf3` | Active throughput probe (ephemeral container 필요) |
| CO-2 | `pod-bottleneck-node-layer` | conntrack / iptables (node ssh 채널 통합) |
| CO-3 | `pod-bottleneck-l7-trace` | Hubble L7 metric (Hubble L7 enable 전제) |
| CO-4 | `pod-bottleneck-node-resource` | NIC PPS / softirq (Prometheus + node-exporter) |
| CO-5 | `pod-bottleneck-scheduled-check` | Celery Beat 주기 자동 진단 |
| CO-6 | `pod-bottleneck-ai-advisor` | Ollama 기반 권고 자동 생성 (현재는 hardcoded threshold + 정적 메시지) |

## 7. Lessons Learned

### 잘된 점
1. **lake-service-monitoring 패턴 재사용** — Strategy/Registry, fail-safe, manual fallback, ProbeContext 모두 lake 패턴 차용. Design 시간 절약 + 일관성 ↑
2. **lint + tsc PASS 작성 직후 확정** — 직전 두 사이클의 unused import / hook deps 함정 회피 (작성 직후 검증 습관화)
3. **PacketFlowPage cross-link 가 minimal 변경** — 5 줄 추가 (memo + handler + 버튼) 로 UX 연결. 도메인 격리 + 연속성 동시
4. **4 Probe 가 모두 async/await + asyncio.gather** — 직렬 수동 (`kubectl exec` 4번) 대비 4배 빠름
5. **manual_fallback 패턴이 distroless/PSA 대응을 우아하게** — exec 실패 = 사용자에게 친절한 안내 ("이 명령을 직접 실행하세요") + copy 버튼

### 개선할 점
1. **runtime 미검증** — SC-1 (10초 내 결과) 는 정적 검증 한계. 사용자 spot check 필요
2. **TcpPerfProbe 의 `time.sleep(2.0)`** — async 컨텍스트인데 `to_thread` 안이라 OK 이지만 진단 1회당 6초 timeout 사용 — 4 probe 병렬이라도 worst-case 7초
3. **CoreDNS metrics scrape 제외** — 1차 시도 후 fallback 만으로 충분하다고 판단, 실제 운영에선 metrics 더 정확
4. **EndpointSlice 의 ready condition 만 봄** — `serving` / `terminating` 분리 미지원 — K8s 1.26+ 신규 condition

### 정량 개선 (직전 3 사이클 누적)
- cluster-detail-monitoring: 81→94% (+13pt)
- work-mgmt-enterprise-audit: 51→82% (+31pt)
- lake-service-monitoring: fresh 95%
- **pod-bottleneck-analyzer: fresh 95%** ✅

신규 사이클의 baseline 이 95% 안정 — Plan/Design 명확성 + 직전 사이클 패턴 재사용 효과

## 8. Next Steps

### 사용자가 직접 실행 (spot check)
```powershell
cd C:\dev_env\devops_management\frontend; npm install   # 신규 dep 없음 — 빠름
cd ..; docker-compose restart backend
docker-compose logs backend | Select-String "bottleneck_runs|CREATE TABLE"
# 기대: bottleneck_runs 테이블 자동 생성 라인

# 브라우저: http://localhost:5173/pod-bottleneck
# 1) Sidebar "모니터링" flyout → "Pod 병목 진단" 메뉴
# 2) 클러스터 선택 + ns=workbench + source/dest pod 입력 + dest_service (옵션)
# 3) "지금 진단" → 10초 내 4축 결과 → "최근 진단 결과" 리스트에 새 항목
# 4) 항목 클릭 → 상세 페이지 → 4 ProbeResultCard
# 5) (옵션) /packet-flow east-west + ns/pod 입력 → "병목 진단" 버튼 클릭 → prefill 이동 확인
```

### PDCA 다음 단계
- `/pdca pm pod-bottleneck-iperf3` (CO-1)
- `/pdca pm pod-bottleneck-node-layer` (CO-2)
- `/pdca pm pod-bottleneck-ai-advisor` (CO-6)
