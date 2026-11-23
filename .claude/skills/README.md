# Agent Skills (`.claude/skills/`)

이 폴더는 **Claude Code Agent Skills** 규칙을 따른다. 요즘 권장되는 정리 방식이며,
프로젝트의 재사용 가능한 작업 절차(playbook)를 **구조화·모듈화**해 담는다.

## 규칙 (맞는 형식)
- 한 스킬 = 한 폴더: `.claude/skills/<skill-name>/SKILL.md`
- `SKILL.md` 상단에 **YAML frontmatter**:
  ```yaml
  ---
  name: skill-name              # 소문자-하이픈
  description: 언제 이 스킬을 써야 하는지 (트리거 포함). 모델이 이걸 보고 자동 선택.
  ---
  ```
- 본문은 마크다운 절차/체크리스트. 같은 폴더에 보조 파일(스크립트·템플릿)을 둘 수 있고
  SKILL.md 에서 상대경로로 참조한다.
- 개인용은 `~/.claude/skills/`, 프로젝트 공유용은 이 저장소의 `.claude/skills/` (← 이쪽).
- 전역 컨벤션·아키텍처 설명은 `CLAUDE.md` 에, **"X 하는 법" 작업 절차**는 여기 스킬에.

## 수록 스킬
| 스킬 | 언제 쓰나 |
|---|---|
| `add-deep-checker` | 새 점검 항목(인증서·OS·스토리지·네트워크 등)을 추가할 때 |
| `backend-feature` | 새 모델/라우터/마이그레이션(FastAPI)을 추가할 때 |
| `frontend-page` | 새 React 페이지(클러스터 선택형 포함)를 만들 때 |
| `editor-docs` | 리치텍스트 에디터·문서 템플릿·이미지/렌더 관련 작업을 할 때 |
| `release` | 새 버전 릴리스(마이너/패치) — SemVer 버전업·CHANGELOG·태그 절차 |
| `docs-sync` | 기능 추가/변경 후 문서(README·CLAUDE.md·CODE_MAP·SCREENS·CHANGELOG) 동기화. CI `docs-sync` 검사 실패 시 |
| `ux-ui-designer` | 디자인 감사·UX 점검·`DESIGN.md` 현행화/백로그 운영 (전담 에이전트: `.claude/agents/ux-ui-designer.md`) |
| `impeccable` | 프론트엔드 화면(웹/랜딩/대시보드/컴포넌트) 디자인 품질 개선 — 3rd-party 스킬([impeccable.style](https://impeccable.style)). `/impeccable init` 으로 시작, `polish`/`audit`/`critique` 등 23개 서브커맨드 + 60개 결정론적 안티패턴 감지 규칙 제공 (전담 에이전트 4종: `.claude/agents/impeccable-*.md`) |

### K8s 운영 패턴 모듈 (`k8s-ops-*`, Cloudera cm_api 차용)

일반 K8s 관리 앱에 옮겨 쓸 수 있는 운영 원시 동작. 각 폴더 = `SKILL.md`(규칙·매핑·PEP 적용 지점·체크리스트)
+ `reference.py`(표준 라이브러리만 쓰는 레퍼런스 구현). 분석 배경은 `docs/03-analysis/cm-api-borrow-analysis.md`.

| 스킬 | 언제 쓰나 |
|---|---|
| `k8s-ops-command-tracking` | 오래 걸리는 실행 — 명령 핸들·실시간 로그·abort/retry·하위 명령·명령 카탈로그(인자 스키마) |
| `k8s-ops-rolling-ops` | 노드/워크로드 롤링 재시작·드레인·업그레이드 — 배치·실패 허용치·stale 대상만·decommission 절차 |
| `k8s-ops-config-model` | 컴포넌트 설정 보기/편집/반영 — summary·full view, 계층(서비스·그룹·인스턴스), staleness |
| `k8s-ops-health-rollup` | 계층 건강 상태 롤업·유지보수 억제·외부 모니터링(Nagios/3색) 매핑 |
| `k8s-ops-templates` | 노드 프로파일 적용, 클러스터 청사진 export/import(변수·cardinality) |
| `k8s-ops-staged-rollout` | 애드온/이미지 버전 받기 → 노드 사전 배포 → 전환(폐쇄망) |
| `k8s-ops-diagnostics-bundle` | 지원 번들(시간창·크기 예산·마스킹) + 파드 진단 명령 카탈로그 |
| `k8s-ops-api-client` | 클라이언트 계층 — 조회만 재시도, 오류 정규화, RO 필드 보호, 버전 게이트, 보상 배치 |

> 참고: 운영 점검(Ops Checks) 콘솔 아키텍처와 점검 소스 추가는 `add-deep-checker` 에 정리.
