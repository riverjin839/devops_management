# Plan — LAKE Service Knowledge Seed (Mini PDCA)

> 작성일: 2026-05-21
> 직전 사이클: pod-bottleneck-analyzer (95%, archived)
> 모드: Mini PDCA — Design/Check 생략 (작은 데이터 seed)

## Executive Summary

| Perspective | Statement |
|---|---|
| **Problem** | LAKE 8 OSS 서비스의 기능/동작/특징이 운영자 머릿속/외부 위키에 흩어져 있음. 신규 입사자 또는 트러블슈팅 시 즉시 참고할 baseline 가이드 부재 |
| **Solution** | `_seed_default_lake_service_entries()` 마이그레이션 함수로 8 ServiceEntry (kind=guide, cluster_id=NULL=전역, pinned=true) 자동 생성. 기존 ServiceHub/KnowledgeHub 페이지가 그대로 표시 |
| **Function UX Effect** | 운영자가 `/services/{airflow|spark|...}` 진입 시 "기능 동작 특징" 가이드가 pinned 상단에. LakeServiceDetailPage 의 "트러블슈팅 가이드" 섹션에도 자동 노출 (service 슬러그 매칭) |
| **Core Value** | **LAKE 도메인 baseline 지식의 코드화** — 신규 환경/팀에 backend 재시작만으로 표준 가이드 보급. 추후 운영자가 직접 ServiceHub 에서 추가/수정 가능 |

## 1. Scope

### 8 ServiceEntry (kind=guide, pinned, 전역)

| service | title | category |
|---|---|---|
| airflow | Apache Airflow — 기능 동작 특징 | runtime |
| spark | Apache Spark — 기능 동작 특징 | runtime |
| iceberg | Apache Iceberg — 기능 동작 특징 | catalog |
| trino | Trino — 기능 동작 특징 | analytics |
| starrocks | StarRocks — 기능 동작 특징 | analytics |
| jupyterlab | JupyterHub — 기능 동작 특징 | analytics |
| superset | Apache Superset — 기능 동작 특징 | analytics |
| polaris | Apache Polaris — 기능 동작 특징 | catalog |

### content (각 800-1500자, Markdown)

표준 구조:
1. **정의** — 한 줄 + 카테고리
2. **핵심 기능** (5개)
3. **아키텍처 요지** (컴포넌트 + 흐름)
4. **LAKE 도메인 내 역할** (다른 서비스와 어떻게 연결되는가)
5. **주요 의존성/통합** (storage / catalog / 다른 OSS)
6. **운영 시 주의점** (3-5)

## 2. Idempotent 정책

- service+title 매칭으로 기존 row 있으면 skip
- pinned=true → ServiceHub 카드 상단 고정
- tags=["lake", "feature", "overview"] → 검색 가능
- cluster_id=NULL → 전역 (모든 클러스터에서 표시)
- author="system" → 운영자가 수정 시 author 갱신됨

## 3. 영향 범위

- backend `main.py` 의 seed 리스트에 1개 함수 추가 (~~5 + 1 = 6)
- 신규 함수 1개 (~150 라인 + 8 content × 1000자 = ~10000자)
- 모델/스키마 변경 X
- 마이그레이션 신규 컬럼 X
- frontend 변경 X — 기존 ServiceHub/LakeServiceDetailPage 가 자동 표시

## 4. Success Criteria

| # | Criterion |
|---|---|
| SC-1 | backend 재시작 시 `_seed_default_lake_service_entries()` 가 실행되고 부팅 로그에 8 entry 생성 라인 |
| SC-2 | `GET /api/v1/services/airflow/entries` 호출 → kind=guide pinned=true 항목 1개 |
| SC-3 | 두 번째 부팅 시 idempotent — 8 entry 중복 생성 안 됨 |
| SC-4 | LakeServiceDetailPage 의 "트러블슈팅 가이드" 섹션에 같은 entry 자동 표시 (service 슬러그 매칭) |
| SC-5 | Content Markdown 이 RichContent (DOMPurify) 통과 — XSS 안전 |

## 5. Carry-Over

- 운영자가 직접 ServiceHub 에서 추가 가이드 작성 (`kind='troubleshoot'`, `kind='history'`)
- 다른 도메인 seed (`bottleneck-knowledge-seed` 등) — 같은 패턴
- 외부 위키 → ServiceEntry 일괄 import (별도 PDCA)
