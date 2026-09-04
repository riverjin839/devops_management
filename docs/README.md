# 문서 색인 (docs)

PEP 문서 모음. 루트의 [README](../README.md) · [CHANGELOG](../CHANGELOG.md) ·
[CONTRIBUTING](../CONTRIBUTING.md) · [SECURITY](../SECURITY.md) 도 함께 참고.

## 운영 / 사용
- [MAC_LOCAL_TEST_GUIDE.md](MAC_LOCAL_TEST_GUIDE.md) — Apple Silicon Mac 로컬 테스트(kind+Vagrant 클러스터 2대 + PEP 기동)
- [WIN_LOCAL_TEST_GUIDE.md](WIN_LOCAL_TEST_GUIDE.md) — Windows 로컬 테스트(VirtualBox + AlmaLinux kubeadm VM **2 클러스터** = 폐쇄망 동일 SSH/서버정보 + 멀티클러스터)
- [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md) — 로컬(Docker Compose)·3단계 배포(kind / 폐쇄망 / 프로덕션)
- [ENVIRONMENT.md](ENVIRONMENT.md) — **환경변수 전수 레퍼런스**(`config.py` Settings 기준, 기본값·설명)
- [AIRGAP_LLM_NEXUS.md](AIRGAP_LLM_NEXUS.md) — 폐쇄망 LLM(Ollama) 모델 수급(Nexus/오프라인)
- [AIRGAP_LLM_ARCHITECTURE.md](AIRGAP_LLM_ARCHITECTURE.md) — 폐쇄망 LLM 아키텍처 상세(내부 모델 서빙, K8s 로그 자동 분석·조치 가이드, PEP 지식 RAG)
- [ADMIN_MANUAL.md](ADMIN_MANUAL.md) — 관리자 매뉴얼
- [BACKUP_RESTORE_GUIDE.md](BACKUP_RESTORE_GUIDE.md) — 데이터 백업·복구(JSON export/import, merge/replace)
- [DEEP_CHECKER_GUIDE.md](DEEP_CHECKER_GUIDE.md) — Deep Check 점검 프레임워크(체커 16종, in-cluster CronJob) 가이드
- [CHECK_MATRIX_GUIDE.md](CHECK_MATRIX_GUIDE.md) — **점검 매트릭스 운영 매뉴얼**(홈 ▸ 플랫폼 현황): deep check/addon/수동입력 구현 방식, 셀·클러스터·항목 단위 실행, 수행 로그·런북
- [K8S_ALLOCATION_GUIDE.md](K8S_ALLOCATION_GUIDE.md) — **K8S 자원 관리 운영 매뉴얼**(`/k8s-allocation`): 노드/NS 용량 계획 화면 + 효율화 탭 사용법(추천 적용/롤백, NS 정책 opt-in, ResourceQuota 탄력, 오퍼레이터 CR 어댑터), 트러블슈팅
- [OBSERVABILITY_GUIDE.md](OBSERVABILITY_GUIDE.md) — **관측 스택 대시보드 · 인시던트 알람 수신**(Alertmanager receiver 설정, pull/push 수집 모드, 알림 라우팅·중복 억제, 모듈 확장법)
- [K8S_OPS_CHECKLIST.md](K8S_OPS_CHECKLIST.md) — K8s 운영 점검 체크리스트
- [PROJECT_FLOW_GUIDE.md](PROJECT_FLOW_GUIDE.md) — 요청/작업 흐름
- [SERVICE_TOPOLOGY_GUIDE.md](SERVICE_TOPOLOGY_GUIDE.md) — 서비스 토폴로지(서비스 디스커버리) 사용 가이드
- [JIRA_기능정리.md](JIRA_기능정리.md) — Jira 연동 기능 정리(Excel 가져오기, 양방향 반영)
- [PROJECT_PLAN.md](PROJECT_PLAN.md) — 최초 기획서(보관용, 현재 상태 아님 — README/CLAUDE.md 신뢰)

## 화면 / 설계 레퍼런스
- [SCREENS.md](SCREENS.md) — **화면 단위 명세서**(전 라우트의 UX/UI/Frontend/Backend/핵심 기능; 화면별 개선 요청 기록용)
- [KNOWLEDGE_BASE_DESIGN.md](KNOWLEDGE_BASE_DESIGN.md) — 지식 베이스 설계

## 릴리스 / 프로세스
- [branch-tag-strategy.md](branch-tag-strategy.md) — 브랜치·태그·릴리스(SemVer, trunk)

## 아키텍처 / 로드맵
- [openlens-architecture-roadmap.md](openlens-architecture-roadmap.md) — 범용 K8s 관리 + 300노드 실시간 로드맵(P0~P5)
- [collab-tooling-borrow-report.md](collab-tooling-borrow-report.md) — AFFiNE/AppFlowy 차용 분석
- [architecture.drawio](architecture.drawio) — 아키텍처 다이어그램 소스
- [observability-agentic-architecture.drawio](observability-agentic-architecture.drawio) — 관측/에이전틱 아키텍처 다이어그램 소스

## 설계/기획 (내부)
- `01-plan/`, `02-design/`, `03-analysis/` — 기능별 계획/설계/분석
  - [02-design/k8s-efficiency-automation.md](02-design/k8s-efficiency-automation.md) — K8S 자원 효율화 자동화(request 축소 추천·적용/롤백·NS 정책·Quota 탄력·CR 어댑터) 설계와 안전장치
- `superpowers/` — 기획 스펙/플랜
- `archive/` — 완료된 기능의 분석/설계/리포트 보관

> 참고: AI 어시스턴트 컨텍스트는 루트 [CLAUDE.md](../CLAUDE.md), 재사용 작업 절차는
> [`.claude/skills/`](../.claude/skills/) 에 있다.
