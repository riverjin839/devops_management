# KM(K8s Manager) 운영 패턴 분석 — 일반 K8s 관리 앱용 스킬 모듈

- KM = **K8s Manager**: 여러 클러스터의 서비스·인스턴스·노드를 한 화면에서 운영하는 관리 플랫폼 모델.
- 결과물: `.claude/skills/k8s-ops-*` 8개 스킬(각 `SKILL.md` + 표준 라이브러리만 쓰는 `reference.py`)

## 왜 KM 모델인가

관리 플랫폼의 운영 동작을 API 로 고정하면 제품 고유 명령을 빼고도 **관리 앱이라면 어디서나 필요한
운영 원시 동작(primitive)** 이 남는다. 이 원시 동작을 K8s 관리 앱에 그대로 적용한다.

| KM 개념 | K8s 대응 |
|---|---|
| Cluster | Cluster |
| Service | 컴포넌트·애드온·워크로드 묶음(kubelet, cilium, ingress, 앱) |
| Instance / Role type | 인스턴스(파드·노드 데몬) / 노드 역할(control-plane, worker, gpu…) |
| Config group | 노드 그룹(라벨·glob) 단위 설정 |
| Node | Node |
| Command | 실행 이력(run) 1건 |
| Package | 오프라인 번들(이미지·차트) 버전 |

## 패턴 → 스킬

| # | 스킬 | KM 개념 | 핵심 아이디어 |
|---|---|---|---|
| 1 | `k8s-ops-command-tracking` | Command, 일괄 명령, 명령 메타데이터 | 변경 API 는 명령 핸들 반환. fetch/wait(타임아웃 시 마지막 상태)/abort/retry, 부모-자식, 인자 스키마 카탈로그 |
| 2 | `k8s-ops-rolling-ops` | 롤링 재시작, 노드 빼기/넣기, 유지보수 모드 | 마스터 1대씩 → 워커 배치, 실패 배치 허용치, sleep, stale/미업그레이드만 |
| 3 | `k8s-ops-config-model` | 설정 view, 설정 그룹, 반영 상태(staleness) | summary/full view, 기본←서비스←그룹←인스턴스, None=재정의 삭제, FRESH/STALE_REFRESHABLE/STALE |
| 4 | `k8s-ops-health-rollup` | healthSummary/healthChecks/maintenanceMode/entityStatus, 외부 모니터링 연동 | 6단계(모름≠정상), 이름 붙은 체크, 계층 롤업, 유지보수 상속, 외부 매핑 단일화 |
| 5 | `k8s-ops-templates` | 노드 템플릿, 클러스터 템플릿 export/import | 노드 프로파일, 변수화된 클러스터 청사진, hostNameRange·cardinality 검증 |
| 6 | `k8s-ops-staged-rollout` | 패키지 stage·state | 받기 → 뿌리기 → 전환 상태 기계, 단계별 취소·진행률, 원자 전환 |
| 7 | `k8s-ops-diagnostics-bundle` | 진단 데이터 수집, 대상 진단 명령 | 기간 모드 vs 최근부터 예산 모드, 우선순위 절단·dropped 기록, 진단 명령 카탈로그 |
| 8 | `k8s-ops-api-client` | 리소스 경로 객체, 읽기/쓰기 속성, 오류 정규화, 버전 게이트, 일괄 실행 | GET 만 재시도, 오류 정규화, RO 필드 보호, 버전 게이트, 보상 배치 |

## 제외한 것과 이유

- **특정 제품 전용 명령**(분산 파일시스템 HA·포맷, 메타스토어 DB 생성 등): K8s 에서는 오퍼레이터/Helm 의 책임.
- **전용 시계열 쿼리 언어**: PEP 는 이미 PromQL 카드(`metric_cards`, UI 편집)와 관측 모듈이 있다.
  다만 "메트릭 스키마/엔티티 타입 목록을 API 로 노출해 쿼리 빌더를 돕는다"는 아이디어는
  PromQL 자동완성(라벨·메트릭 이름 조회)으로 따로 검토할 만하다.
- **Basic auth 고정, 동기 HTTP 클라이언트, 고정 간격 폴링**: 오래된 구현 방식. 레퍼런스는 백오프 폴링으로 바꿨다.
- **대화형 셸**: PEP 는 콘솔 패턴 화면(`/bulk-exec` 등)이 같은 역할.

## PEP 에서 이미 있는 것 / 보강 후보

| 영역 | 이미 있음 | 보강 후보(스킬) |
|---|---|---|
| 실행 이력 | `K8sEfficiencyRun`·`ServiceConfigApplyRun`·`NsMigrationRun`·`BatchJobRun`·`PlaybookRun`(steps·log_lines) | 공통 `abort_requested`/`parent_run_id`/`can_retry`, 명령 카탈로그(arg schema) — #1 |
| 롤링 | 단건 rollout restart(`routers/k8s_resources.py`), 노드 적용(`service_config/apply_nodes.py`) | 배치 크기·실패 허용치·stale_only 옵션, 계획 미리보기 — #2 |
| 설정 | `service_config`(항목·규칙·그룹·버전·적용) + `config_snapshot` | summary/full view, None=삭제, 3단계 staleness — #3 |
| 상태 | `core_bundle_checker`, `cluster_status_service.recompute` | 모름≠정상 규칙, 이름 붙은 체크 문자열, 유지보수 상속 — #4 |
| 템플릿 | 노드 라벨, `ServiceConfigGroup`, `ns_migration` 치환 프리셋 | 노드 프로파일, 클러스터 청사진 export/import — #5 |
| 배포 | 노드 이미지 사전 배포(`node_images /distribute`), 폐쇄망 스크립트 | stage/progress 상태 기계 화면 — #6 |
| 진단 | `system_diagnostics`(앱 자체), `incident_context_builder`, `k8s_diagnose` | 대상 클러스터 지원 번들, 진단 명령 카탈로그 — #7 |
| 클라이언트 | `k8s_client_pool`·`k8s_concurrency`·`k8s_list_cache`·`k8s_paging` | 재시도 정책 일원화, 오류 정규화, 보상 배치 — #8 |

## 공통 원칙 (모든 스킬)

1. **실행 버튼 = 명령 1건**: 상세·실시간 로그 + 사용자가 켜고 끄는 "로그 보기"(CLAUDE.md custom 요청).
2. **UI-First**: 배치 크기·임계치·변수·우선순위 등 환경에 따라 다른 값은 화면 파라미터.
3. **계획 → 확인 → 실행**: dry-run diff 를 먼저 보여 준다. 조회형은 확인 없이, 변경형만 danger 확인.
4. **fail-safe**: 한 대상/소스 실패는 구조화된 결과로 남기고 나머지는 계속(허용치·예산 안에서).

## 검증

각 `reference.py` 는 표준 라이브러리만 쓰며, 8개 모듈 전부를 스모크 테스트(상태 전이·롤업·
배치 계획·예산 절단·보상 롤백 등)로 확인했다. 앱 코드가 아니므로 `backend/tests` 에는 포함하지 않는다.
