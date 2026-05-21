# QA Report — LAKE Service Monitoring

> 작성일: 2026-05-21
> Match Rate (정적): 95%
> 최종 Verdict: **QA_SKIP** (환경 미충족 — 수동 체크리스트로 대체)

---

## 1. Pre-flight 결과

| 항목 | 상태 |
|---|---|
| Backend (localhost:8000) | ❌ unreachable (이전 사이클과 동일) |
| Frontend (localhost:5173) | ❌ unreachable |
| Docker / Playwright | ❌ 미설치 |
| Frontend 신규 dependency | ✅ **없음** (직전 사이클과 차별점) |

## 2. 자동 정적 검증 결과

| 항목 | 결과 |
|---|---|
| Backend AST parse — 14 파일 | ✅ OK |
| Backend lake_services router import + 8 endpoint deps | ✅ OK (GET 4 → get_current_user, mutating 4 → require_operator) |
| Backend LAKE_CHECKER_REGISTRY — 8/8 매핑 | ✅ OK |
| Frontend `npm run lint` (max-warnings 0) | ✅ PASS |
| Frontend `npx tsc --noEmit` | ✅ PASS |

→ **이번 사이클은 lint + tsc 까지 PASS 확정** (직전 사이클들은 lint 위반/lockfile 누락 후속 commit 필요). spot check 의 §5 단계 (lint/tsc) skip 가능.

## 3. L1 — API Smoke Tests (수동)

```powershell
$BASE = "http://localhost:8000/api/v1"
$H = @{ Authorization = "Bearer $TOKEN" }

# L1.1 인증 누락 확인
curl -s -o /dev/null -w "%{http_code}`n" $BASE/lake-services
# 기대: 401

# L1.2 service types catalog
curl -s $BASE/lake-services/types -H "Authorization: Bearer $TOKEN" | python -m json.tool
# 기대: 8 항목 (airflow/spark/iceberg/trino/starrocks/jupyterlab/superset/polaris)

# L1.3 등록
curl -s -X POST $BASE/lake-services -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "clusterId": "<cluster-uuid>",
  "serviceType": "airflow",
  "name": "Prod Airflow",
  "endpointUrl": "http://airflow.lake-prod.svc.cluster.local:8080",
  "namespace": "lake-prod",
  "tlsVerify": false
}' | python -m json.tool

# L1.4 list + pagination
curl -s "$BASE/lake-services?limit=10" -H "Authorization: Bearer $TOKEN" | python -m json.tool
# 기대: total/offset/limit/hasMore 필드 포함

# L1.5 수동 점검 실행
curl -s -X POST $BASE/lake-services/<id>/check -H "Authorization: Bearer $TOKEN" | python -m json.tool
# 기대: status + responseTimeMs + message + details

# L1.6 audit log
docker-compose exec postgres psql -U postgres -d k8s_monitor \
  -c "SELECT action, target_id, created_at FROM audit_logs WHERE action LIKE 'lake_service.%' ORDER BY created_at DESC LIMIT 10"
# 기대: lake_service.create / check_run 등 5 액션
```

## 4. L2 — UI Tests (브라우저)

| # | 시나리오 | 합격 기준 |
|---|---|---|
| L2.1 | `/lake-services` 진입 | Sidebar "모니터링" 그룹 flyout 에 "LAKE 서비스" 메뉴 표시 + 클릭 시 진입 |
| L2.2 | 빈 상태 | "등록된 LAKE 서비스가 없습니다" + "서비스 등록" CTA 표시 |
| L2.3 | "서비스 등록" 모달 | cluster select + service type select (8 옵션) + 폼 검증 (URL prefix 등) |
| L2.4 | 등록 후 카드 등장 | LakeServiceCard 에 service icon + name + endpoint + 상태 |
| L2.5 | "지금 점검" 카드 inline 클릭 | spinner 표시 + 완료 후 status 갱신 (이벤트 propagation 차단 — 상세 페이지 안 감) |
| L2.6 | 카드 클릭 | 상세 페이지 navigate |
| L2.7 | 상세 페이지 헤더 | 서비스 icon + name + label + HealthBadge + 3 버튼 (지금점검/삭제/목록) |
| L2.8 | 트러블슈팅 가이드 섹션 | ServiceEntry kind=guide 매칭 — 같은 service 슬러그 항목 list. 클릭 시 RichContent expand |
| L2.9 | 히스토리 timeline | LakeServiceCheck + ServiceEntry kind=history merge sort. "점검" / "히스토리" 색상 구분 |
| L2.10 | 삭제 → ConfirmDialog | window.confirm 아님. "삭제" 버튼 빨강 |
| L2.11 | 카테고리 chip 필터 | catalog/runtime/analytics 클릭 시 list 변경 + 카운트 표시 |
| L2.12 | ClusterSidebar 클러스터 전환 | URL/state 변경 + list 갱신, 페이지 깜빡임 없음 |

## 5. L3-L5 — Optional

| Layer | 상태 |
|---|---|
| L3 E2E (Playwright) | SKIP — 미설치 |
| L4 Perf (32 인스턴스 < 500ms) | SKIP — manual benchmark 필요 |
| L5 Security (XSS — ServiceEntry guide RichContent) | 직전 사이클 G-I7 (DOMPurify) 자동 적용됨 — passive |

## 6. Verdict

```
L1 (API):        SKIP (backend down) → §3 수동
L2 (UI):         SKIP (frontend down) → §4 수동
L3-L5:           SKIP
─────────────────────────────────────────
정적:             PASS (AST + lint + tsc + router deps + registry)
─────────────────────────────────────────
최종:            QA_SKIP
```

## 7. 사용자 즉시 실행 가이드

```powershell
# (1) 환경
cd C:\dev_env\devops_management\frontend; npm install   # 신규 dep 없음 - 빠름
cd ..; docker-compose up -d

# (2) backend 마이그레이션 확인 (Base.metadata.create_all 자동)
docker-compose logs backend | Select-String "lake_services|lake_service_checks|CREATE TABLE"

# (3) L1 §3 + L2 §4 차례로 (15분)
# (4) verdict 갱신
```

## 8. 다음 단계

- `/pdca archive lake-service-monitoring --summary` — 사이클 종료
