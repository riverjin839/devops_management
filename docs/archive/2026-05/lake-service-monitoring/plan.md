# Plan — LAKE Service Monitoring + Troubleshooting + History

> 작성일: 2026-05-21
> 모드: Fresh PDCA (신규 개발 — 이전 두 사이클의 리버스 audit 와 다름)
> 직전 사이클: cluster-detail-monitoring (94%, archived), work-mgmt-enterprise-audit (82%, archived)
> 다음: `docs/02-design/features/lake-service-monitoring.design.md`

---

## Executive Summary

| Perspective | Statement |
|---|---|
| **Problem** | K8s 클러스터 위의 LAKE 도메인 오픈소스 서비스(airflow/spark/iceberg/trino/starrocks/jupyterlab/superset/polaris) 가 폐쇄망 커스텀 빌드라 표준 모니터링 도구 없이 운영 중. DevOps engineer 가 매번 kubectl exec / port-forward / 로그 grep 으로 점검하고, 트러블슈팅 노하우/이력이 개인 머신/메모/팀 채팅에 흩어져 전파 안 됨. |
| **Solution** | devops_management 안에 **LAKE 도메인 전용 monitoring 페이지** 신설 (`/lake-services`). 서비스 인스턴스를 cluster + 서비스 type 으로 등록하고, 표준 헬스체크 + ServiceEntry 기반 트러블슈팅 가이드/히스토리 통합 표시. Strategy + Registry 패턴으로 신규 서비스 추가가 코드 1 클래스 + DB row 1건으로 가능. |
| **Function UX Effect** | 운영자가 한 화면(`/lake-services`)에서 ① 모든 LAKE 서비스의 현재 상태 ② 클릭 시 서비스별 상세 (헬스 + 메트릭 요약 + 트러블슈팅 가이드 + 최근 히스토리) ③ 가이드 직접 열람 + 히스토리 작성. 매번 kubectl 안 쳐도 됨. |
| **Core Value** | "**LAKE 서비스 운영 노하우의 조직 자산화**" — 한 사람이 트러블슈팅한 경험이 다음 사람에게 1-click 으로 전파. 폐쇄망/커스텀 빌드 환경에서도 표준 monitoring 베이스라인 확보. |

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | 폐쇄망 + 커스텀 빌드 + 8개 OSS 의 조합은 SaaS Datadog/Grafana Cloud 같은 표준 도구가 통하지 않음. devops_management 가 이미 cluster 점검/업무관리 통합 hub 이므로 이 안에 LAKE 도메인 가시성 추가가 가장 빠른 가치. |
| **WHO** | DevOps/SRE — 평일 09:00 출근 후 클러스터 + LAKE 서비스 + 업무 3 도메인 순회 점검. 트러블슈팅 노하우는 머릿속/Confluence 흩어짐. |
| **RISK** | 8개 OSS 각각 헬스 endpoint/메트릭/로그 패턴이 달라 한 사이클로 깊이 못 다룸. 잘못 짜면 "또 하나의 비어있는 카탈로그 페이지" 가 됨. **MVP = framework + stub + 1-2개 실측** 으로 가치 검증, 나머지는 carry. |
| **SUCCESS** | (1) 8 서비스 인스턴스를 등록 가능 + 메인보드에 상태 표시. (2) 1개 서비스 (airflow) 는 진짜 healthz probe 동작. (3) ServiceEntry 가이드/히스토리가 상세 페이지에 자연스럽게 통합. (4) 새 서비스 추가는 신규 Checker 클래스 1개 + registry 등록 1줄. |
| **SCOPE** | (in) `LakeService` 모델 + `LakeChecker` registry + 8 서비스 stub + 메인보드 + 상세 + ServiceEntry 통합 view. (out) 트러블슈팅 액션 자동 실행 (read-only 가이드만), AI 추천, 알림, 그래프 메트릭 시계열, 권한 RBAC 강화 (operator 만 등록/검사 기본 — admin/viewer 차이는 carry) |

## 1. 점검 대상 서비스 (8개, 확장 가능)

| 서비스 | 카테고리 | 주요 컴포넌트 | 기본 헬스체크 패턴 |
|---|---|---|---|
| **airflow** | 런타임 (워크플로우 오케스트레이션) | webserver / scheduler / triggerer / worker | `GET /health` (200 + JSON `{metadatabase, scheduler, triggerer}`) |
| **spark** | 런타임 (분산 컴퓨팅) | master / worker / history server | master `/api/v1/applications` |
| **iceberg** | 카탈로그 (테이블 포맷) | REST catalog (or embedded in trino/spark) | catalog `/v1/config` |
| **trino** | 분석 (분산 SQL) | coordinator / worker | `/v1/info` (200 + uptime/version) |
| **starrocks** | 분석 (OLAP MPP) | FE (Frontend) / BE (Backend) | FE `/api/health` |
| **jupyterlab** | 분석 (notebook) | jupyterhub + user pods | hub `/hub/health` |
| **superset** ("hyberset" 추정) | 분석 (BI 대시보드) | web / worker / beat | `/health` |
| **polaris** | 카탈로그 (Apache Polaris) | catalog REST | `/api/management/v1/health` |

→ 8 서비스 + 카테고리 3종 (카탈로그/런타임/분석). 신규 서비스 추가는 DB row + Checker 클래스로.

## 2. Requirements

### FR — Functional
- FR-1. LAKE 서비스 인스턴스 등록 (cluster_id + service_type + name + endpoint URL + optional namespace/labels)
- FR-2. 메인보드 `/lake-services` — 모든 등록 서비스의 카드 view (상태 색상 + 마지막 점검 시각 + 핵심 메트릭 1-2개)
- FR-3. 카테고리/클러스터 필터 (분석/런타임/카탈로그, cluster 별 sidebar)
- FR-4. "지금 체크" 버튼 — 수동 헬스체크 실행 → 결과 즉시 표시
- FR-5. 상세 페이지 `/lake-services/:id` — 헬스 결과 detail + 메트릭 요약 + 트러블슈팅 가이드 list + 히스토리 timeline
- FR-6. 트러블슈팅 가이드 — `ServiceEntry kind='guide'` 의 같은 service 슬러그 항목 inline 표시. 우상단 "+ 가이드 작성" 으로 신규 추가.
- FR-7. 히스토리 — `ServiceEntry kind='history'` + LakeServiceCheck 두 source 를 시간순 timeline.
- FR-8. Strategy 패턴 — 신규 서비스 추가 시 `LakeChecker` 서브클래스 1개 + `LAKE_CHECKER_REGISTRY` 1줄.
- FR-9. 8 서비스 stub seed — service_type 별 기본 healthz endpoint 정의. airflow 는 진짜 동작 (deep stub), 나머지 7개는 endpoint probe 만 (shallow stub).

### NFR — Non-Functional
- NFR-1. **인증**: 직전 사이클 교훈 — GET 도 `get_current_user`, 등록/검사는 `require_operator`
- NFR-2. **페이지네이션**: list 엔드포인트는 offset/limit + 진짜 count
- NFR-3. **Audit log**: 서비스 등록/삭제/수동 체크 모두 audit_logger
- NFR-4. **Fail-safe**: 헬스체크 실패가 다른 서비스 점검 막지 않음 (각 checker safe_run)
- NFR-5. **UX 표준**: ClusterSidebar iconOnly, MacCard, ConfirmDialog, dark mode, error state
- NFR-6. **마이그레이션 안전**: `_safe_add_column` / `_safe_create_index` 패턴
- NFR-7. **확장성**: 8개에 묶이지 않고 9-10개로 늘어나도 코드 변경 최소 (registry 등록 only)

## 3. Success Criteria

| # | Criterion | 측정 |
|---|---|---|
| SC-1 | `/lake-services` 진입 후 3초 내 8 서비스 카드 렌더 | browser timing |
| SC-2 | airflow 인스턴스 실제 운영 클러스터 대상 healthz probe 성공 | manual test |
| SC-3 | ServiceEntry `kind='guide'` 가 상세 페이지에 service 슬러그 매칭으로 자동 표시 | manual test |
| SC-4 | 신규 서비스 추가 (예: kafka) 가 Checker 1 클래스 + registry 1줄 + service_type seed 1줄로 가능 | code review |
| SC-5 | 8 서비스 + 4 인스턴스 = 32 인스턴스 환경에서 메인보드 응답 < 500ms | manual benchmark |
| SC-6 | 직전 사이클의 모든 Enterprise baseline (인증, 페이지네이션, audit, error code, ownership) 충족 | gap analysis |

## 4. Constraints

- C-1. 폐쇄망 → 외부 의존성 추가 금지 (이미 있는 패키지만 활용)
- C-2. 정적 분석 only (이전 사이클들과 동일, 환경 미가용)
- C-3. ServiceEntry 모델 변경 X — 그대로 활용 (service 슬러그 매칭만)
- C-4. Cluster 모델은 cluster-detail-monitoring 사이클 의 `tls_verify` 컬럼까지 도입된 상태. 영향 없음.
- C-5. 신규 dependency 추가 시 직전 사이클 교훈 적용: package.json + package-lock.json **반드시 같이 commit**

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 8 서비스 헬스체크가 다 달라 한 사이클로 못 끝남 | High | MVP = airflow 1개만 deep, 7개는 shallow stub. carry-over 명시 |
| 폐쇄망 endpoint 가 신뢰 인증서 없음 | Med | Cluster.tls_verify (직전 도입) 재활용 — LakeService 도 같은 패턴 |
| 같은 service_type 인스턴스 여러 개 (multi-cluster) 충돌 | Med | (cluster_id, service_type, name) unique constraint |
| ServiceEntry 페이지(/docs, /services) 와 UX 중복 | Med | LakeService 페이지는 "운영 모니터링" 강조 (ServiceEntry 는 카탈로그/지식). 두 도메인 명확 구분 + cross-link |
| 폐쇄망에서 신규 서비스 추가 시 운영자가 코드 못 만짐 | High | service_type 자체는 정적 enum 이지만 인스턴스 등록은 DB row — 8개 type 으로 시작, 신규 type 은 dev 가 추가 |

## 6. Out of Scope

- **트러블슈팅 액션 자동 실행** (read-only 가이드만) → `lake-troubleshoot-actions` 별도 PDCA
- **AI 추천 (Ollama)** → `lake-ai-advisor` 별도 PDCA
- **메트릭 시계열 그래프** → `lake-metrics-timeseries` 별도 PDCA
- **알림 채널 연동** → cluster-detail-monitoring 의 NotificationChannel 재활용 가능, 별도 PDCA
- **RBAC 세분화** (운영자/뷰어 차이) → 이번엔 operator 만 mutating, 차기
- **백업/복구** (LakeService 자체)
- **외부 서비스 (Kubernetes-native 아닌)** — 우리는 cluster 내부 서비스만

## 7. 산출물 / Phase 계획

| Phase | 산출물 | 메인 vs subagent | 예상 라인 |
|---|---|---|---|
| 1. **Plan** (현재) | 본 문서 | 메인 | ✅ 완료 |
| 2. **Design** (다음) | As-To-Be 구조 + 3 architecture 비교 + Module Map | 메인 | ~5분 |
| 3. **Do** | backend (모델+라우터+체커+마이그레이션) + frontend (페이지+훅+컴포넌트) | 메인 (큰 작업) | ~1200-1500 라인 |
| 4. **Check (Analyze)** | gap-detector 정적 + 4-axis 평가 | 메인 또는 subagent | ~10분 |
| 5. **Iterate-1** (필요시) | finding 픽스 | 메인 | ~5-10건 |
| 6. **Report** | 완료 보고서 + carry | 메인 | ~5분 |
| 7. **QA** | 환경 미가용 SKIP + 수동 체크리스트 | 메인 | ~3분 |
| 8. **Archive + Commit + Push** | docs/archive/ + 2 commit + push | 메인 | ~5분 |

총: 약 1.5-2시간 작업. 직전 work-mgmt 사이클의 ~1.5배 (신규 개발이라 모델/라우터/페이지 신설).

## 8. Carry-Over (사전 명시)

이번 사이클 종료 시 다음 carry 예상:
- `lake-troubleshoot-actions` — 가이드 실행 자동화 (kubectl 등 read-only 명령)
- `lake-ai-advisor` — Ollama 기반 next-action 추천
- `lake-metrics-timeseries` — Prometheus 통합 시계열
- `lake-service-rbac` — viewer 권한 분리
- `lake-{서비스명}-deep-check` — 8개 서비스 각각의 깊은 헬스체크 로직 (airflow 외 7개)
- `ci-node24-migration` (직전 사이클 carry 유지)
