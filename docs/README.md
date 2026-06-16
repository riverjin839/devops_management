# 문서 색인 (docs)

PEP 문서 모음. 루트의 [README](../README.md) · [CHANGELOG](../CHANGELOG.md) ·
[CONTRIBUTING](../CONTRIBUTING.md) · [SECURITY](../SECURITY.md) 도 함께 참고.

## 운영 / 사용
- [MAC_LOCAL_TEST_GUIDE.md](MAC_LOCAL_TEST_GUIDE.md) — Apple Silicon Mac 로컬 테스트(kind+Vagrant 클러스터 2대 + PEP 기동)
- [WIN_LOCAL_TEST_GUIDE.md](WIN_LOCAL_TEST_GUIDE.md) — Windows 로컬 테스트(VirtualBox + AlmaLinux kubeadm VM **2 클러스터** = 폐쇄망 동일 SSH/서버정보 + 멀티클러스터)
- [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md) — 3단계 배포(kind / 폐쇄망 / 프로덕션)
- [ADMIN_MANUAL.md](ADMIN_MANUAL.md) — 관리자 매뉴얼
- [PROJECT_FLOW_GUIDE.md](PROJECT_FLOW_GUIDE.md) — 요청/작업 흐름
- [SERVICE_TOPOLOGY_GUIDE.md](SERVICE_TOPOLOGY_GUIDE.md) — 서비스 토폴로지(서비스 디스커버리) 사용 가이드
- [PROJECT_PLAN.md](PROJECT_PLAN.md) — 프로젝트 계획

## 릴리스 / 프로세스
- [branch-tag-strategy.md](branch-tag-strategy.md) — 브랜치·태그·릴리스(SemVer, trunk)

## 아키텍처 / 로드맵
- [openlens-architecture-roadmap.md](openlens-architecture-roadmap.md) — 범용 K8s 관리 + 300노드 실시간 로드맵(P0~P5)
- [collab-tooling-borrow-report.md](collab-tooling-borrow-report.md) — AFFiNE/AppFlowy 차용 분석
- [architecture.drawio](architecture.drawio) — 아키텍처 다이어그램 소스

## 설계/기획 (내부)
- `01-plan/`, `02-design/`, `03-analysis/` — 기능별 계획/설계/분석
- `superpowers/` — 기획 스펙/플랜
- `archive/` — 완료된 기능의 분석/설계/리포트 보관

> 참고: AI 어시스턴트 컨텍스트는 루트 [CLAUDE.md](../CLAUDE.md), 재사용 작업 절차는
> [`.claude/skills/`](../.claude/skills/) 에 있다.
