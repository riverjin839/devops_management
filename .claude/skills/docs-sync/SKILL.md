---
name: docs-sync
description: 기능 추가/변경 후 저장소 문서(README, CLAUDE.md, CODE_MAP.md, docs/SCREENS.md, docs/README.md, CHANGELOG.md)를 코드와 동기화할 때 사용. 새 라우터/페이지/모델/환경변수를 추가했거나, CI 의 docs-sync 검사가 실패했거나, "문서 업데이트해줘"라는 요청이 오면 이 스킬을 따른다. 모든 feat/fix PR 은 머지 전에 이 체크리스트를 통과해야 한다.
---

# docs-sync — 문서-코드 동기화 절차

코드가 바뀌면 어떤 문서를 어떻게 고쳐야 하는지의 단일 기준. CI(`.github/workflows/ci.yml` 의
`docs-sync` job)가 `scripts/docs/check_docs_sync.py` 로 기계 검사를 하므로, 여기 매핑대로
갱신하지 않으면 PR 이 실패한다.

## 0. 검사 먼저 실행

```bash
python3 scripts/docs/check_docs_sync.py
```

실패 항목이 곧 할 일 목록이다. 통과해도 아래 "내용 동기화" 항목(기계 검사 불가)을 점검한다.

## 1. 변경 유형 → 갱신 문서 매핑

| 코드 변경 | 반드시 갱신 | 조건부 갱신 |
|---|---|---|
| 새 프론트 페이지 / App.tsx 라우트 | `docs/SCREENS.md` 화면 섹션, `CODE_MAP.md` | 사이드바 메뉴 신설이면 `README.md` 핵심 기능표 |
| 새 백엔드 라우터 (`backend/app/routers/*.py`) | `CODE_MAP.md` | 주요 API 그룹이면 `CLAUDE.md` API Reference |
| 새 모델/테이블 | `CODE_MAP.md` | 핵심 도메인이면 `CLAUDE.md` Database Schema |
| `config.py` Settings 에 환경변수 추가 | `CLAUDE.md` 환경변수 표, `.env.example` | 배포 관련이면 `docs/DEPLOY_GUIDE.md` |
| 기능 추가(`feat:`) / 버그 수정(`fix:`) | `CHANGELOG.md` `[Unreleased]` | 사용자 노출 기능이면 `README.md` 핵심 기능표 |
| `docs/` 에 새 문서 추가 | `docs/README.md` 인덱스 | — |
| UI 컨벤션/디자인 토큰 변경 | `DESIGN_SYSTEM.md` | `CLAUDE.md` UI Design System 절 |
| 새 스킬 추가 (`.claude/skills/`) | `.claude/skills/README.md` 수록표 | — |
| 화면 구조가 크게 바뀐 기존 페이지 | `docs/SCREENS.md` 해당 섹션 | — |
| 릴리스(버전업) | `scripts/release/bump_version.py` 가 자동 처리 | `/release` 스킬 참고 |

## 2. 갱신 요령

- **SCREENS.md**: 헤딩에 라우트를 백틱으로 포함해야 검사기가 인식한다 —
  `### 화면명 (\`/route\`)`. 기존 섹션 형식(UX/UI/Frontend/Backend/핵심 기능)을 따른다.
- **CODE_MAP.md**: 파일명이 본문에 존재하기만 하면 검사 통과. 도메인 그룹 표에 한 줄
  (파일명 + 한 줄 설명) 추가한다. 장문 설명 금지 — 지도이지 명세서가 아니다.
- **CLAUDE.md**: 전역 컨벤션·아키텍처만. 개별 기능 상세는 docs/ 로. 60여 개 라우터를
  개별 나열하지 말고 도메인 그룹 요약을 유지한다.
- **CHANGELOG.md**: `[Unreleased]` 아래 `### Added`/`### Fixed`/`### Changed` 에 굵은
  기능명 + 사용자 관점 요약 1~2줄 (+ `Backend:`/`Frontend:` 구현 포인트).
- **의도된 예외**: 문서화가 불필요한 라우트/파일이면
  `scripts/docs/check_docs_sync.py` 의 `EXEMPT_*` 목록에 **사유 주석과 함께** 추가한다.
  예외 남발 금지 — 리다이렉트 alias, 내부 전용 유틸 정도만.

## 3. 마무리 체크리스트

- [ ] `python3 scripts/docs/check_docs_sync.py` 통과
- [ ] `CHANGELOG.md` `[Unreleased]` 에 항목 추가 (feat/fix 인 경우)
- [ ] 위 매핑표의 "조건부 갱신" 해당 여부 판단·반영
- [ ] PR 본문 Changes 절에 문서 변경도 명시
