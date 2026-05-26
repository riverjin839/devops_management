# QA Report — LAKE Service Type Management

> Match Rate (정적): 95%
> Verdict: **QA_SKIP** (환경 미충족)

## 1. Pre-flight
| 항목 | 상태 |
|---|---|
| Backend/Frontend | ❌ unreachable |
| 신규 dependency | ✅ 없음 |

## 2. 정적 검증
| 항목 | 결과 |
|---|---|
| Backend AST — 9 파일 | ✅ OK |
| Backend lake_service_types router 6 endpoint deps | ✅ OK (GET 2 get_current_user, mutating 4 require_operator) |
| Frontend lint (max-warnings 0) | ✅ PASS |
| Frontend tsc | ✅ PASS |

## 3. L1 — API Smoke (수동)

```powershell
$BASE = "http://localhost:8000/api/v1"

# L1.1 list (builtin 8 seed 확인)
curl -s "$BASE/lake-service-types" -H "Authorization: Bearer $TOKEN" | python -m json.tool
# 기대: data 8개, 모두 isBuiltin=true, enabled=true

# L1.2 toggle builtin
$AID = "<airflow id>"
curl -s -X PATCH "$BASE/lake-service-types/$AID/enabled" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"enabled":false}' | python -m json.tool
# 기대: enabled=false 갱신

# L1.3 builtin 삭제 (차단)
curl -s -X DELETE "$BASE/lake-service-types/$AID" -H "Authorization: Bearer $TOKEN" -w "%{http_code}"
# 기대: 409 + LAKE_SERVICE_TYPE_BUILTIN_LOCKED

# L1.4 custom create
curl -s -X POST "$BASE/lake-service-types" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{
    "serviceType": "kafka",
    "label": "Apache Kafka",
    "category": "runtime",
    "defaultPath": "/health"
  }' | python -m json.tool

# L1.5 LakeService 등록 (custom type)
curl -s -X POST "$BASE/lake-services" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{
    "clusterId": "<cluster id>",
    "serviceType": "kafka",
    "name": "Lake Kafka",
    "endpointUrl": "http://kafka-rest.kafka.svc:8082"
  }' | python -m json.tool

# L1.6 점검 → GenericHealthzChecker
$SID = "<lake service id from L1.5>"
curl -s -X POST "$BASE/lake-services/$SID/check" -H "Authorization: Bearer $TOKEN" | python -m json.tool

# L1.7 사용 중 custom 삭제 (차단)
$KID = "<kafka type id>"
curl -s -X DELETE "$BASE/lake-service-types/$KID" -H "Authorization: Bearer $TOKEN" -w "%{http_code}"
# 기대: 409 + LAKE_SERVICE_TYPE_IN_USE + in_use_count
```

## 4. L2 — UI Tests

| # | 시나리오 | 합격 |
|---|---|---|
| L2.1 | /settings → "LAKE 타입" 탭 진입 | 8 builtin row, builtin badge, delete 비활성 |
| L2.2 | builtin 의 enabled 토글 | 즉시 갱신, LakeServicesPage 등록 모달 반영 |
| L2.3 | "+ 커스텀 추가" → kafka | 저장 후 list 즉시 표시 (cache invalidate) |
| L2.4 | builtin 의 edit 모달 | service_type/label/category/default_path readonly 표시 (disabled style) |
| L2.5 | custom 삭제 → ConfirmDialog | 차단 시 amber 박스에 in_use_count 표시 |
| L2.6 | LakeServicesPage 등록 모달 | enabled type 만 select. 신규 custom 도 표시 |

## 5. Verdict

```
L1-L5: SKIP (환경 미가용)
정적:  PASS
최종:  QA_SKIP
```

## 6. 사용자 실행
```powershell
cd frontend; npm install   # 신규 dep 0
cd ..; docker-compose restart backend
# /settings → LAKE 타입 탭
```
