# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
사내 DevOps/플랫폼 엔지니어링 팀. 다중 Kubernetes 클러스터를 일상적으로 점검·운영·딥 트러블슈팅하는
운영자(operator/admin)와, 같은 화면 안에서 팀 업무·문서 협업을 처리하는 팀 구성원(viewer 포함)이
함께 쓴다. 권한은 RBAC 3단계(`admin`/`operator`/`viewer`)로 구분된다.

주 사용자는 운영자다 — 테이블·상태·로그를 한 화면에서 훑고 판단하는 정보 밀도 높은 작업이 기본이다.

보조 청중: 로그인 없이 공개 화면(`/daily-report` 일일 리포트, `/external-services` 외부 도메인·IP:Port)을
읽기 전용으로 보는 사내 이해관계자. 공개 방식이 `link` 면 만료 기한 있는 공유 링크(`?t=`)로만 접근하며,
테넌트에 바인딩되지 않은 클러스터만 노출된다(`services/public_pages.py`).

## Product Purpose
여러 K8s 클러스터의 상태를 상시 점검하고, 장애를 딥 트러블슈팅하며, 그 과정에서 발생하는 팀 업무·
지식을 같은 곳에서 관리하기 위해 존재한다. 성공 기준은 "운영자가 파편화된 개별 도구(모니터링
대시보드·kubectl·Ansible·Jira·Confluence 등)를 오가지 않고 이 포털 하나에서 점검부터 조치, 업무
기록까지 끝낼 수 있는가"이다.

## Positioning
다른 K8s 대시보드와 구별되는 핵심은 세 가지를 동시에 만족한다는 점이다:
1. **통합 포털** — 모니터링·운영 콘솔·딥 트러블슈팅·업무/문서 협업이 개별 도구가 아니라 하나의
   포털 안에 있다.
2. **UI-First 환경 대응** — 설치 현장마다 다른 환경 차이(네임스페이스, 라벨 셀렉터, 엔드포인트 등)를
   코드 수정·재배포 없이 화면에서 직접 조정한다(CLAUDE.md UI-First 원칙).
3. **폐쇄망(air-gap) 완전 대응** — 인터넷이 차단된 환경에서도 로컬 LLM(Ollama) 기반 AI 장애 분석을
   포함한 전체 스택이 그대로 동작한다.

## Operating Context
- 다중 K8s 클러스터(여러 환경·팀) 환경에서 상시 사용.
- 배포 형태 3가지: 로컬 kind, 폐쇄망(air-gap), 프로덕션(Helm + ArgoCD + Jenkins) — `docs/DEPLOY_GUIDE.md`.
- 운영 리듬: check-matrix cron 기반 자동 점검(구 아침/점심/저녁 고정 스케줄을 대체) + 운영자가 직접
  트리거하는 수동 점검·실행.
- AI 장애 분석은 분석 전용이며 클러스터에 조치를 직접 실행하지 않는다(안전 설계 — 분석과 조치의 분리).

## Capabilities and Constraints
- RBAC 3단계: `viewer` / `operator` / `admin` (백엔드 `User.role`).
- 로그인: 로컬 계정 + OIDC SSO + LDAP. SSO·LDAP 설정은 admin 전용(`auth_oidc`, `auth_ldap`).
- 테넌트 격리(opt-in): 클러스터를 테넌트에 바인딩하면 그 테넌트 멤버에게만 보이고, 실행·변경은 operate
  멤버만 할 수 있다(`services/cluster_access.py`). 업무·지식 데이터(`projects`/`work_items`/`work_guides`/
  `ops_notes`/`mindmaps`)와 `metric_cards` 는 nullable `tenant_id` 로 공유 범위를 정한다 — NULL = 전체 공유
  (`services/tenant_scope.py`). 테넌트별 LLM 라우팅 오버라이드와 백그라운드 실행 동시성 상한을 가진다.
- 실행 로그: 모든 "실행" 버튼은 상세·실시간 로그 출력을 함께 제공하고, 사용자가 "로그 보기" 여부를
  선택할 수 있어야 한다.
- 폐쇄망 자산 제약: 외부 CDN·Google Fonts·외부 이미지를 쓸 수 없다. 폰트·아이콘·에셋은 전부 셀프 호스팅
  또는 번들링한다.
- 언어: UI 텍스트는 한국어 중심. 한글 가독성이 좋은 글꼴이 필요하다(후보: Pretendard 번들링 — 현재
  `DESIGN_SYSTEM.md` D-131 은 시스템 폰트 스택을 채택하고 있어, 번들 글꼴 도입 여부는 미결정).
- Secret 값은 화면에 마스킹되어 노출되며, 주요 조작은 감사 로그(`audit_logs`)에 기록된다.
- 폐쇄망(air-gap) 배포를 반드시 지원해야 하며, Ollama·ansible-runner 등은 optional dependency로
  이들이 없어도 앱이 떠야 한다(CLAUDE.md Tech Stack 원칙).
- 외부 의존 서비스(Prometheus/Alertmanager/Ollama 등) 장애 시에도 대시보드 자체는 계속 동작해야
  한다(fail-safe 패턴, CLAUDE.md).
- 규정 준수: **ISMS / ISMS-P** 를 따라야 한다 — 접근 통제(RBAC·테넌트), 감사 로그, 민감 정보 마스킹이
  이 요건의 근거다.

## Brand Commitments
- 제품명: **PEP — Platform Engineering Portal** (원래 이름 "K8s Daily Monitor"에서 2026년 5월 리브랜딩).
- 파비콘: `frontend/public/favicon.svg`.

## Evidence on Hand
- 외부 공개용 데모·스크린샷·고객 사례 등은 없음 — 사내 전용 도구. 향후 작업에서 가상의 고객·사례·
  수치를 지어내지 않는다.

## Product Principles
1. UI-First — 환경 차이는 코드가 아니라 화면 설정으로 흡수한다.
2. Fail-safe by default — 외부 의존이 죽어도 대시보드는 죽지 않는다.
3. 분석과 조치의 분리 — AI는 분석만 하고, 실행은 항상 운영자의 명시적 트리거를 거친다.
4. 파편화 제거 — 점검·트러블슈팅·업무·지식을 별도 도구로 흩어놓지 않는다.
5. 폐쇄망 우선 시민권 — 신규 기능은 인터넷 연결을 전제하지 않는다.
6. 실행은 보이게 — 실행한 일은 상세·실시간 로그로 확인할 수 있어야 하며, 볼지 말지는 사용자가 정한다.
7. 밀도 우선 — 운영자의 작업 화면이 기본이다. 여백 위주의 마케팅·랜딩 스타일은 지양한다.

## Accessibility & Inclusion
WCAG AA 기준을 목표로 상시 감사·개선 중이다(`ux-ui-designer` 스킬이 `DESIGN.md`에서 정량 추적 —
아이콘 버튼 aria-label, 키보드 포커스 가시성, 색상 단독 정보 전달 금지 등). 접근성에 대한 별도의 법적
준수 의무는 확인되지 않았다.
