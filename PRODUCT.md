# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
사내 DevOps/플랫폼 엔지니어링 팀. 다중 Kubernetes 클러스터를 일상적으로 점검·운영·딥 트러블슈팅하는
운영자(operator/admin)와, 같은 화면 안에서 팀 업무·문서 협업을 처리하는 팀 구성원(viewer 포함)이
함께 쓴다. 권한은 RBAC 3단계(`admin`/`operator`/`viewer`)로 구분된다.

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
- Secret 값은 화면에 마스킹되어 노출되며, 주요 조작은 감사 로그(`audit_logs`)에 기록된다.
- 폐쇄망(air-gap) 배포를 반드시 지원해야 하며, Ollama·ansible-runner 등은 optional dependency로
  이들이 없어도 앱이 떠야 한다(CLAUDE.md Tech Stack 원칙).
- 외부 의존 서비스(Prometheus/Alertmanager/Ollama 등) 장애 시에도 대시보드 자체는 계속 동작해야
  한다(fail-safe 패턴, CLAUDE.md).
- 규정 준수(컴플라이언스) 요건이 있다고 확인됐으나 **구체적인 표준(ISMS 등)은 아직 미확정** — 후속
  확인이 필요하며, 지금은 임의로 특정 표준을 상정하지 않는다.

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

## Accessibility & Inclusion
WCAG AA 기준을 목표로 상시 감사·개선 중이다(`ux-ui-designer` 스킬이 `DESIGN.md`에서 정량 추적 —
아이콘 버튼 aria-label, 키보드 포커스 가시성, 색상 단독 정보 전달 금지 등). 별도의 법적·표준 준수
의무는 확인되지 않았다.
