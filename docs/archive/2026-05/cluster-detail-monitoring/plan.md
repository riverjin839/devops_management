# Plan — Cluster Detail Monitoring (Reverse-Engineered)

> 작성일: 2026-05-21
> 모드: 리버스 PDCA — 이미 구현된 기능에 대한 사후 plan 문서
> 대상: **k8s cluster 별 상세 상태 점검** 기능
> 다음 단계: `docs/02-design/features/cluster-detail-monitoring.design.md` → `docs/03-analysis/cluster-detail-monitoring.analysis.md`

---

## Executive Summary

| Perspective | Statement |
|---|---|
| **Problem** | 운영자가 다수 k8s 클러스터의 상태를 매일 3회(09/13/18시) 일관된 기준으로 점검하고, 이전 점검 대비 무엇이 바뀌었는지 즉시 파악할 수 있어야 한다. |
| **Solution** | 스케줄러(Celery Beat)가 cluster 단위 daily check + deep check 를 자동 수행하고, AI 자동 리뷰 + diff + 7일 trend 를 클러스터별 리뷰 페이지(`/daily-check/review/:clusterId`) 에서 한 화면에 보여준다. |
| **Function / UX Effect** | 운영자가 메뉴에서 클러스터 1개를 선택해서 ① 최근 회차 ② AI 요약 + 조치권고 ③ 깊은 점검 결과(definition 단위) ④ 어제 대비 변동 ⑤ 7일 추이 ⑥ 알림 설정을 한 페이지에서 본다. 수동 "Deep Check 지금 실행" 버튼으로 즉시 재점검 가능. |
| **Core Value** | "어제 잘 돌던 클러스터가 오늘 무슨 이유로 무엇이 달라졌는가" 를 사람이 매번 kubectl 로 비교하지 않고 자동으로 확인. |

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | 다수 클러스터 → 사람의 수동 점검은 빈도/정확성/일관성 모두 한계. AI 가 점검 결과를 요약·diff·추이로 재가공해야 인지 부하가 낮아진다. |
| **WHO** | DevOps/SRE 운영자 — 영문 메시지에 익숙하지만 한국어 요약 선호. 일일 운영 루틴이 09:00 출근 직후 클러스터 상태 확인. |
| **RISK** | 점검 시스템 자체가 신뢰를 잃으면(false positive/negative, 누락, 일관성 깨짐) 운영자가 다시 kubectl 직접 사용 → 도구 가치 zero. |
| **SUCCESS** | (1) 매일 3회 스케줄 누락 0건. (2) 점검 결과와 실제 상태 일치율 95%+. (3) 클러스터 1개 점검 페이지 진입 후 3초 내 핵심 상태 파악. (4) Ollama/Prometheus offline 이어도 점검 자체는 동작. |
| **SCOPE** | (in) backend daily/deep checker engine + Celery Beat 스케줄러 + DailyCheckLog/DeepCheckResult 스토리지 + `/daily-check/review/:clusterId` 페이지. (out) PromQL 메트릭 카드, 글로벌 Dashboard 위젯, Playbook 실행. |

## 1. Requirements

### FR — Functional
- FR-1. 매일 09/13/18시 KST 에 모든 등록된 클러스터에 대해 daily check 자동 수행.
- FR-2. Daily check 15분 뒤 동일 클러스터 deep check 자동 수행 (centralized 모드: 관리 backend 직접 실행, 또는 in-cluster super pod 가 결과 push).
- FR-3. 점검 결과 commit 직후 AI 자동 리뷰(Ollama) 비동기 큐잉. 실패해도 점검 자체는 영향 없음.
- FR-4. 사용자는 `/daily-check/review/:clusterId` 에서 최신 회차 자동 표시 + 과거 20회 picker.
- FR-5. 리뷰 페이지에서 ① AI 요약/조치권고 ② Deep Check 결과 grid ③ 이전 점검 대비 변동 ④ 7일 trend ⑤ 알림 설정 표시.
- FR-6. "Deep Check 지금 실행" 버튼으로 수동 즉시 실행.
- FR-7. AI 리뷰 "재생성" 버튼으로 강제 재호출.
- FR-8. 점검 결과 CSV/Markdown export (cluster 단위 또는 전체).
- FR-9. 클러스터별 스케줄 활성화 토글 (아침/점심/저녁 각각 on/off).

### NFR — Non-Functional
- NFR-1. **Fail-safe**: Ollama, Prometheus, Notifier 가 죽어도 점검 자체는 동작해야 한다.
- NFR-2. **Idempotent**: 동일 시간대에 같은 schedule_type 으로 두 번 돌아도 DB 가 망가지지 않아야 한다 (현재는 append-only 라 OK).
- NFR-3. **Performance**: 단일 클러스터 daily check 30초 이내. 노드 200대 환경에서도 OK (NodeChecker 가 list_node 1회만 호출).
- NFR-4. **Air-gap**: 외부 네트워크 없이도 점검 자체는 동작.
- NFR-5. **다중 클러스터 환경**: 한 회차에 5개 이상 클러스터를 직렬로 처리해도 Celery task_time_limit(300s) 안에 끝나야 한다.

## 2. Success Criteria

| # | Criterion | 측정 방법 |
|---|---|---|
| SC-1 | 스케줄 누락 0건/주 | Celery 로그 vs DailyCheckLog 카운트 |
| SC-2 | 한 클러스터의 status 가 시간에 따라 일관됨 (race condition 없음) | 동일 timestamp +- 1분 내 status 가 여러 번 바뀌지 않음 |
| SC-3 | 점검 페이지 진입 후 3초 내 첫 렌더 | brower timing API |
| SC-4 | Ollama down 시에도 페이지 정상 표시 + 안내 문구 | manual test |
| SC-5 | Modern K8s (1.27+) 클러스터에서도 components 체크가 의미 있는 결과 반환 | manual test |

## 3. Constraints

- C-1. 기존 코드 베이스의 `BaseChecker` (services/checkers/*) + `DeepCheckBase` (services/deep_checkers/*) 두 family 를 유지해야 한다.
- C-2. 시간 스케줄러는 Celery Beat 로 통일 (Airflow/k8s CronJob 도입 X).
- C-3. AI 모델은 Ollama 로컬, 외부 모델 콜 금지.

## 4. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 다수 클러스터 직렬 처리 → 5분 Celery timeout 초과 | 일부 클러스터 누락 | 클러스터별 sub-task 분할 |
| 3개 파이프라인(Health/Daily/Deep) 이 cluster.status 동시 갱신 | last-write-wins, 사용자 혼동 | "authoritative status" 단일 소스 정의 |
| kubectl componentstatuses K8s 1.27 제거 | DailyChecker 가 영구 빈 결과 | K8s SDK 로 마이그레이션 |
| Ollama 응답 지연으로 페이지 로딩 차단 | UX 저하 | AI 리뷰는 fire-and-forget (이미 적용됨 ✅) |

## 5. Out of Scope

- PromQL 메트릭 카드 (`/promql/cards`) — 보조 지표
- 글로벌 Dashboard 페이지의 전체 클러스터 그리드 (별도 plan 필요)
- Playbook 실행, Ansible 자동화
- 사용자 인증 / 권한 (별도 feature)
