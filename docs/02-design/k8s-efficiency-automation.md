## K8S 자원 효율화 자동화 — 설계

- **화면**: `/k8s-allocation` → **효율화** 탭 (`docs/SCREENS.md` §K8S 자원 관리)
- **코드**: `backend/app/services/k8s_efficiency/`, `backend/app/routers/k8s_efficiency.py`,
  `backend/app/models/k8s_efficiency.py`, `frontend/src/components/k8s-allocation/Efficiency*.tsx`
- **작성**: 2026-09 (Phase B/C — 502·흔들림 안정화(Phase A)와 같은 브랜치)

### 무엇을 해결하나

1. 점유 자원(request) 대비 실제 사용률이 낮은 워크로드를 찾아 request 축소를 **추천**하고, 설정에
   따라 **자동으로 줄인다**.
2. 네임스페이스 기준 저효율 자원 사용률을 **추적·가시화**해 추이를 분석한다.
3. 특정 네임스페이스가 자원 부족이면 **자동으로 늘리고**, 미사용이 지속되면 **자동으로 회수**한다.

### 데이터 흐름

```
Celery beat(매분) ─ dispatch_k8s_efficiency_collect ─ 클러스터별 cron due? ─▶ collect_k8s_efficiency_one
                                                                                   │
   ┌───────────────────────────────────────────────────────────────────────────────┘
   ▼
 collector.collect_cluster
   1 kubeconfig  2 _build_overview(on_pod 훅 → 워크로드/컨테이너 집계, Redis 스냅샷 워밍)
   3 ResourceQuota LIST  4 워크로드 메타(오퍼레이터 CR 소유/opt-out)  5 사용률(metrics-server → Prometheus)
   6 k8s_ns_samples / k8s_workload_samples 저장
   ▼
 engine.generate  → k8s_rightsize_recommendations (open; 이전 open 은 superseded)
   ▼
 automation.dispatch_auto → (opt-in NS 만) K8sEfficiencyRun(auto) 생성 → run_k8s_efficiency_run
```

수동 실행(지금 수집 / 추천 재생성 / 적용 / 롤백 / Quota 조정 / CR 스케일)도 전부 같은 run 테이블에
단계(steps)·로그(log_lines)를 남기고 프론트가 1.5초 폴링으로 실시간 표시한다.

### 사용률 소스 (정책 `usage_source`)

| 값 | 순간 사용량(샘플) | 추천용 p95 |
|---|---|---|
| `auto`(기본) | metrics-server → 비어 있으면 Prometheus 순간 조회 → none | Prometheus `quantile_over_time` → DB 샘플 `percentile_cont` → 데이터 부족(추천 없음) |
| `prometheus` | Prometheus 만 | Prometheus 만 |
| `metrics` | metrics-server 만 | DB 샘플 만 |

- Prometheus 는 클러스터의 `prometheus_enabled`/`prometheus_url` 로 해석한다(`service_for_cluster`).
- Prometheus p95 는 파드별 값을 워크로드/컨테이너로 귀속할 때 **파드 중 최댓값**을 쓴다(보수적).
- DB 샘플 경로는 `min_samples`(기본 12)·`min_coverage_hours`(기본 24) 를 넘어야 추천한다 — 설치 직후
  하루 동안은 "데이터 부족"이 정상이다.

### 추천 규칙 (engine.py)

```
target  = max( p95 × (1 + headroom_pct/100), floor )
추천    = current > target × threshold_ratio  AND  (current − target) ≥ min_savings
savings = (current − target) × pod_count
```

제외: `system_namespaces` · opt-out annotation(NS/워크로드/템플릿, 값 off/false) · DaemonSet(옵션) ·
Deployment/StatefulSet/DaemonSet 외 kind · request 미설정 컨테이너(축소 대상 아님).
`keep_guaranteed` 면 req==lim(Guaranteed) 컨테이너는 limit 도 같이 내려 QoS 를 유지한다.

**오퍼레이터(CR) 관리 워크로드** — 워크로드의 ownerReferences group 이 `""/apps/batch` 밖이면
(예: StarRocks CN StatefulSet ← `StarRocksCluster`) `recommend_only=true` 로 표시만 하고, 적용 API 는
422 로 거부한다. STS 를 직접 패치하면 오퍼레이터가 되돌리기 때문이다. 이런 서비스의 확장/회수는
아래 CR 어댑터로 한다.

### 적용 / 롤백 (apply.py)

- target 종류: `workload`(컨테이너 requests[/limits] strategic-merge patch) ·
  `resourcequota`(spec.hard) · `custom_resource`(jsonpath merge-patch).
- 적용 전 현재 값을 `before` 에 기록 → 롤백 run 은 `before` 로 target 을 재구성한다.
- `dry_run` 이면 apiserver 에 `dryRun=All` 로 보내 검증만 한다(기본 on).
- 한 대상이 실패해도 계속 진행하고 `partial` 로 끝낸다. 성공한 추천은 `applied` 로 바뀐다.
- 모든 run 은 감사 로그(`k8s.efficiency.*`)에 남는다.

### 자동화 안전장치 (automation.py)

| 장치 | 위치 | 기본값 |
|---|---|---|
| 마스터 스위치 `automation_enabled` | 전역 기본값 | **off** |
| NS opt-in `auto_rightsize` / `quota_elastic` | NS 정책 | off |
| 허용 시간대 `maintenance_cron` | 전역 | 없음(항상) |
| 쿨다운 `cooldown_minutes` | 전역/NS | 1440 |
| 1회 최대 감소폭 `max_step_pct` | 전역/NS | 20% |
| run 당 최대 대상 `max_targets_per_run` | 전역 | 20 |
| `recommend_only`(오퍼레이터 관리) 제외 | 엔진/서버 | 항상 |

### ResourceQuota 탄력 (quota.py)

- `used/hard ≥ up_threshold`(0.85) → `hard × (1 + step_pct)` 로 확장, `max` 를 넘지 않음.
- `sustain_hours`(24h) 내내 `used/hard ≤ low_threshold`(0.5) → `max(used_max × lower_factor, min)` 로 회수.
- 새 hard 가 현재 used 보다 작아지는 조정은 하지 않는다(파드 생성 즉시 거부 사고 방지).
- min/max 는 NS 정책에서 지정(정책 다이얼로그 "라이브 Quota 불러오기"로 프리필).

### 오퍼레이터 CR 어댑터 (custom_targets)

NS 정책에 `{group, version, plural, name, jsonpath, min, max}` 를 등록하면 NS 사용률이 임계 이상일 때
+1, sustain 창 내내 낮을 때 −1 로 replicas 를 조정한다(현재 값은 적용 run 이 갱신). 예:

```json
{"label":"StarRocks CN","group":"starrocks.com","version":"v1","plural":"starrocksclusters",
 "name":"sr","jsonpath":"spec.starRocksCnSpec.replicas","min":2,"max":6}
```

수동 조정은 `POST /k8s/{id}/efficiency/custom-targets/scale` (범위 밖 값은 422).

### 보존/백업

| 테이블 | 성격 | 보존 | 비고 |
|---|---|---|---|
| `k8s_ns_samples` | NS 시계열 | 400일 | 추이 차트 |
| `k8s_workload_samples` | 워크로드/컨테이너 JSONB 시계열 | 8일 | 추천 윈도(7일)+여유, 대용량 |
| `k8s_efficiency_runs` | 실행 로그 | 365일 | 감사 추적 |

세 테이블은 `backup_service.LOG_TABLES`(`include_logs=false` 시 제외)와 `log_retention_service`
(`log-tables-purge` 03:20) 에 등록돼 있다. `k8s_rightsize_recommendations`/`k8s_namespace_policies` 는
설정/상태 테이블이라 백업에 항상 포함된다.

### 운영 체크리스트

1. 정책 설정 → 수집 스케줄에서 클러스터 수집이 켜져 있는지, 마지막 수집 시각이 갱신되는지.
2. 하루 뒤 추천이 뜨면 **드라이런**으로 검증 → 소수 워크로드에 실제 적용 → 롤백까지 확인.
3. NS 정책에서 대상 NS 만 opt-in → 전역 마스터 스위치 ON → 실행 이력의 `auto` run 감시.
4. Quota 탄력은 min/max 를 반드시 지정하고 시작한다.
