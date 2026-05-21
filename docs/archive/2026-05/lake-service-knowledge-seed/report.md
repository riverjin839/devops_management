# Report — LAKE Service Knowledge Seed (Mini PDCA)

> 작성일: 2026-05-21
> 직전 사이클: pod-bottleneck-analyzer (95%, archived)
> 모드: Mini PDCA (Plan → Do → Report → Archive)

## Executive Summary

| Perspective | Before | After |
|---|---|---|
| Problem | LAKE 8 OSS 기능/동작/특징이 흩어져 있음, 신규 입사자/트러블슈팅 시 baseline 없음 | `_seed_default_lake_service_entries()` 가 8 ServiceEntry (kind=guide, pinned, 전역) 자동 등록 |
| Solution | 운영자가 ServiceHub UI 에 직접 작성해야 | backend 재시작만으로 8 가이드 즉시 사용 가능 |
| Function UX | `/services/airflow` 등 진입 시 빈 페이지 | "Apache Airflow — 기능 동작 특징" pinned 상단 + LakeServiceDetailPage 의 트러블슈팅 가이드 섹션 자동 노출 |
| Core Value | **LAKE 도메인 baseline 지식 코드화** — 신규 환경/팀에 backend 재시작만으로 표준 가이드 보급 |

### Value Delivered

| 지표 | 값 |
|---|---:|
| 신규 ServiceEntry | 8 (kind=guide, cluster_id=NULL, pinned=true, tags=["lake","feature","overview"]) |
| Content 총 라인 | ~10688 chars (각 1212-1442) |
| 신규 파일 | 2 (`backend/app/data/__init__.py`, `lake_service_knowledge.py`) |
| 수정 파일 | 1 (`backend/app/main.py` — seed 함수 + 리스트 등록) |
| 신규 모델/마이그레이션 | 0 (기존 ServiceEntry 재활용) |
| Frontend 변경 | 0 (기존 ServiceHub/LakeServiceDetailPage 가 자동 표시) |

## Plan SC — Final Status

| # | Criterion | 상태 |
|---|---|:---:|
| SC-1 | backend 재시작 시 8 entry 생성 로그 | ⚠️ runtime 검증 필요 — 정적 import test 8 entries 로드 확인 |
| SC-2 | `GET /api/v1/services/airflow/entries` → kind=guide pinned 1개 | ⚠️ runtime 필요 |
| SC-3 | 두 번째 부팅 idempotent — 중복 X | ✅ `existing_keys` (service+title 매칭) skip 로직 |
| SC-4 | LakeServiceDetailPage 트러블슈팅 가이드 섹션 자동 표시 | ✅ 기존 `useQuery({queryKey: ['serviceEntries', 'lake', serviceSlug]})` 가 service 슬러그 매칭 |
| SC-5 | Markdown XSS 안전 | ✅ RichContent → DOMPurify (직전 cluster-detail PDCA 도입) |

## Key Decisions

| Decision | 선택 | Rationale |
|---|---|---|
| Content 분리 | `app/data/lake_service_knowledge.py` 별도 모듈 | main.py 비대화 회피, 신규 서비스 추가 시 1 dict entry |
| pinned=true | ServiceHub 카드 상단 고정 | "표준 가이드" 가시성 ↑ |
| cluster_id=NULL | 전역 | 모든 클러스터에서 같은 가이드 — LAKE OSS 는 클러스터 무관 baseline |
| author="system" | 운영자 수정 시 author 갱신 | seed vs human 구분 가능 |
| tags=["lake","feature","overview"] | ServiceHub 검색 가능 | 차기 다른 도메인 (예: bottleneck) seed 와 구분 |

## Changes Summary

```
신규 (2):
  backend/app/data/__init__.py                          ~3 lines (모듈 패키지)
  backend/app/data/lake_service_knowledge.py            ~190 lines (8 content × ~1300 chars)

수정 (1):
  backend/app/main.py    +50 lines (_seed_default_lake_service_entries() + 리스트 등록 1줄)
```

## 사용자 직접 실행

```powershell
cd C:\dev_env\devops_management
docker-compose restart backend
docker-compose logs backend | Select-String "seeded.*lake service"
# 기대: "seeded 8 lake service knowledge entries"

# DB 검증
docker-compose exec postgres psql -U postgres -d k8s_monitor \
  -c "SELECT service, kind, pinned, title FROM service_entries WHERE 'lake' = ANY(SELECT jsonb_array_elements_text(tags)) ORDER BY service"

# 브라우저
# 1) http://localhost:5173/services/airflow → pinned 상단에 "Apache Airflow — 기능 동작 특징"
# 2) http://localhost:5173/lake-services/{any-airflow-instance-id} → 트러블슈팅 가이드 섹션에 같은 entry 표시
```

## Carry-Over

- `pod-bottleneck-knowledge-seed` — 같은 패턴으로 4 Probe 의 해석 가이드 seed
- `cluster-knowledge-seed` — K8s/cilium/coredns 등 cluster-detail 도메인의 가이드 seed
- 외부 위키 → ServiceEntry 일괄 import (별도 PDCA)
- 운영자 수정 시 system author 표시 차별화 (UI minor)
