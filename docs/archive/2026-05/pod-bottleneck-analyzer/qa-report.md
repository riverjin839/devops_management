# QA Report — Pod-to-Pod Bottleneck Analyzer

> 작성일: 2026-05-21
> Match Rate (정적): 95%
> 최종 Verdict: **QA_SKIP** (환경 미충족, 직전 사이클들과 동일)

## 1. Pre-flight

| 항목 | 상태 |
|---|---|
| Backend (localhost:8000) | ❌ unreachable |
| Frontend (localhost:5173) | ❌ unreachable |
| Docker CLI | ❌ not in PATH |
| Frontend 신규 dependency | ✅ **없음** (직전 lake 와 동일) |

## 2. 자동 정적 검증

| 항목 | 결과 |
|---|---|
| Backend AST parse — 13 파일 | ✅ OK |
| Backend bottleneck router 5 endpoint deps | ✅ OK (GET 3 → get_current_user, mutating 2 → require_operator) |
| Backend BOTTLENECK_PROBE_REGISTRY — 4/4 매핑 | ✅ OK |
| Frontend `npm run lint` (max-warnings 0) | ✅ PASS |
| Frontend `npx tsc --noEmit` | ✅ PASS |

→ **lint + tsc 작성 직후 PASS** (직전 lake 와 동일).

## 3. L1 — API Smoke Tests (수동, 사용자 환경)

```powershell
$BASE = "http://localhost:8000/api/v1"
$H = @{ Authorization = "Bearer $TOKEN" }

# L1.1 인증 누락 확인
curl -s -o /dev/null -w "%{http_code}`n" $BASE/pod-bottleneck/runs
# 기대: 401

# L1.2 probe catalog
curl -s $BASE/pod-bottleneck/probes -H "Authorization: Bearer $TOKEN" | python -m json.tool
# 기대: 4 항목 (tcp_state/tcp_perf/dns_latency/endpoints) + axis + needs_exec

# L1.3 진단 실행
curl -s -X POST $BASE/pod-bottleneck/run -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "clusterId": "<cluster-uuid>",
  "namespace": "workbench",
  "sourcePod": "frontend-7f...-xyz",
  "destPod": "backend-5d...-abc",
  "destService": "backend"
}' | python -m json.tool
# 기대: overallStatus + probes (4 키) + durationMs < 7000

# L1.4 list runs (페이지네이션)
curl -s "$BASE/pod-bottleneck/runs?limit=10" -H "Authorization: Bearer $TOKEN" | python -m json.tool
# 기대: data/total/offset/limit/hasMore

# L1.5 audit log
docker-compose exec postgres psql -U postgres -d k8s_monitor \
  -c "SELECT action, target_id, created_at FROM audit_logs WHERE action LIKE 'bottleneck.%' ORDER BY created_at DESC LIMIT 5"
# 기대: bottleneck.run / bottleneck.delete 액션
```

## 4. L2 — UI Tests (브라우저)

| # | 시나리오 | 합격 기준 |
|---|---|---|
| L2.1 | Sidebar "모니터링" flyout → "Pod 병목 진단" | 메뉴 항목 표시 + 클릭 시 `/pod-bottleneck` 진입 |
| L2.2 | 빈 상태 | "진단 결과가 없습니다" + 진단 폼 표시 |
| L2.3 | 진단 폼 제출 (cluster + ns + src + dst) | 10초 내 → /pod-bottleneck/{id} 이동 |
| L2.4 | 상세 페이지 — 4 Probe Card | 각각 status icon + axis badge + message + recommendation |
| L2.5 | manual_fallback (distroless pod 대상) | amber 박스 + command copy 버튼 + reason 표시 |
| L2.6 | raw details expand | ChevronRight 회전 + JSON pre 표시 |
| L2.7 | 삭제 → ConfirmDialog | window.confirm 아님. 빨강 버튼 |
| L2.8 | PacketFlowPage east-west + ns/pod 입력 | 우상단 "병목 진단" CTA 버튼 표시 |
| L2.9 | CTA 클릭 | `/pod-bottleneck?cluster=...&ns=...&src=...&dst=...` 이동 + 폼 prefill |
| L2.10 | 최근 진단 list | RunRow 에 status 색상 + ns/src→dst font-mono + 시각 + duration |

## 5. Verdict

```
L1-L5:           SKIP (환경 미가용)
─────────────────────────────────────────
정적:             PASS (AST + lint + tsc + endpoint deps + registry)
─────────────────────────────────────────
최종:            QA_SKIP
```

## 6. 사용자 즉시 실행

```powershell
cd C:\dev_env\devops_management\frontend; npm install   # 신규 dep 0 - 빠름
cd ..; docker-compose up -d
docker-compose logs backend | Select-String "bottleneck_runs|CREATE TABLE"

# 브라우저 spot check (15분):
# §3 L1 (API) + §4 L2 (UI) 차례로
```

## 7. 다음 단계

- `/pdca archive pod-bottleneck-analyzer --summary`
