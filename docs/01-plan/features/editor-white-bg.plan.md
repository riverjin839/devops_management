# editor-white-bg Planning Document

> **Summary**: 작성 영역(OpsNote, Work Item)에 흰 배경 옵션을 추가하고 사용자별 DB에 저장
>
> **Project**: PEP (Platform Engineering Portal)
> **Version**: feature/home-v2
> **Author**: riverjin839
> **Date**: 2026-06-01
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | default·light 테마에서 작성 영역 배경이 카드 색상(warm paper / slate-50)에 묻혀 집중도가 떨어지고, 사용자마다 선호하는 편집 배경이 다름 |
| **Solution** | OpsNote 작성/편집·Work Item 상세/편집 페이지의 에디터 영역에 "흰 배경 모드" 토글을 추가하고, 선택값을 서버 User 모델에 저장 |
| **Function/UX Effect** | 토글 한 번으로 에디터 배경이 순수 흰색(#FFFFFF)으로 전환되어 가독성·집중도 향상. 재로그인 후·다른 기기에서도 설정 유지 |
| **Core Value** | 사용자가 선호하는 작성 환경을 선택할 수 있어 플랫폼의 개인화 품질 향상 |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 작성 영역 배경 색상이 테마에 종속되어 개인 선호를 반영할 수 없음 |
| **WHO** | PEP를 사용하는 모든 로그인 사용자 (OpsNote·Work Item 작성자) |
| **RISK** | User 모델 스키마 변경 시 기존 users 테이블 호환성, 배포 중 null 값 처리 |
| **SUCCESS** | 토글 UI 노출 → 저장 → 페이지 재진입 시 설정 복원 → 다른 기기 로그인 후에도 동일 설정 유지 |
| **SCOPE** | Phase 1: 백엔드 User 모델 + API. Phase 2: 프론트엔드 토글 UI + 적용 |

---

## 1. Overview

### 1.1 Purpose

OpsNote 작성/편집 페이지(`OpsNoteFormPage`, `OpsNoteDetailPage`)와 Work Item 상세/편집 페이지(`WorkItemDetailPage`, `WorkItemFormPage`)의 에디터·본문 영역에 **"흰 배경 모드"** 를 옵션으로 추가한다.

사용자가 토글을 켜면 해당 영역의 배경이 `#FFFFFF`(순수 흰색)로 전환되며, 이 설정은 사용자 계정에 연동되어 재로그인 후에도 유지된다.

### 1.2 Background

현재 PEP는 `default`(warm paper), `light`(slate-50), `dark`, `system` 4개의 전역 테마를 제공한다. 그러나 작성 작업 시 전역 테마의 배경색이 편집 집중도를 저하시킨다는 피드백이 있었다. 전역 테마를 바꾸지 않고 **작성 영역만 흰 배경**으로 전환하는 옵션이 필요하다.

### 1.3 Related Documents

- CLAUDE.md — 백엔드 아키텍처 / DB 마이그레이션 규칙
- `backend/app/models/user.py` — User 모델
- `backend/app/schemas/auth.py` — UserOut 스키마

---

## 2. Scope

### 2.1 In Scope

- [ ] `User` 모델에 `editor_white_bg: Boolean` 컬럼 추가 (`_safe_add_column`)
- [ ] `UserOut` 스키마에 `editor_white_bg` 필드 추가
- [ ] `PATCH /auth/me/preferences` 엔드포인트 추가 (editor_white_bg 업데이트)
- [ ] `GET /auth/me` 응답에 `editor_white_bg` 포함
- [ ] `OpsNoteFormPage` — 에디터 컨테이너 흰 배경 토글 UI
- [ ] `OpsNoteDetailPage` (읽기 뷰) — 본문 영역 흰 배경 토글 UI
- [ ] `WorkItemFormPage` — 본문/설명 에디터 영역 흰 배경 토글 UI
- [ ] `WorkItemDetailPage` — 본문 표시 영역 흰 배경 토글 UI
- [ ] 프론트엔드 `useUserPreferences` 훅 or `userStore` 연동 (API 저장 + 로컬 상태)
- [ ] 설정이 페이지 진입 시 자동 복원

### 2.2 Out of Scope

- 전역 테마 변경 (themeStore 수정 없음)
- OpsNote·Work Item 외의 다른 페이지 (Knowledge Hub, Dashboard 등)
- 어두운 배경 옵션 (흰 배경만 추가)
- Settings 페이지 UI 변경 (토글은 각 작성 페이지에 인라인 배치)

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | User 모델에 `editor_white_bg` Boolean 컬럼 추가 (기본값 `false`) | High | Pending |
| FR-02 | `PATCH /auth/me/preferences` API로 `editor_white_bg` 저장 | High | Pending |
| FR-03 | `GET /auth/me` 응답에 `editor_white_bg` 포함 | High | Pending |
| FR-04 | OpsNoteFormPage 헤더에 흰 배경 토글 버튼 표시 | High | Pending |
| FR-05 | WorkItemFormPage 헤더에 흰 배경 토글 버튼 표시 | High | Pending |
| FR-06 | WorkItemDetailPage 헤더에 흰 배경 토글 버튼 표시 | High | Pending |
| FR-07 | OpsNoteDetailPage 헤더에 흰 배경 토글 버튼 표시 | Medium | Pending |
| FR-08 | 토글 변경 시 즉시 UI 반영 + 백그라운드 API 저장 (낙관적 업데이트) | High | Pending |
| FR-09 | 페이지 진입 시 사용자 설정(`editor_white_bg`) 자동 로드 | High | Pending |
| FR-10 | 미로그인 상태에서는 토글 미표시 (비로그인 시 기본 배경 유지) | Medium | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Performance | 토글 API 응답 < 300ms | 브라우저 Network 탭 |
| Compatibility | 기존 users 테이블 컬럼 없을 시 NULL → false fallback | `_safe_add_column` 마이그레이션 확인 |
| UX | 토글 → UI 적용까지 지연 없음 (낙관적 업데이트) | 시각적 확인 |
| Zero ESLint | `eslint --max-warnings 0` 통과 | CI |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-01~FR-10 전체 구현
- [ ] 백엔드 `_safe_add_column`으로 마이그레이션 작성 (기존 DB 호환)
- [ ] ESLint zero warnings + TypeScript strict 통과
- [ ] OpsNote 작성 페이지에서 토글 켜고 → 새로고침 → 설정 유지 확인
- [ ] Work Item 상세 페이지에서 토글 켜고 → 새로고침 → 설정 유지 확인

### 4.2 Quality Criteria

- [ ] TypeScript `any` 미사용
- [ ] `eslint . --max-warnings 0` 통과
- [ ] `npm run build` 성공

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 기존 users 테이블 NULL 이슈 | Medium | Medium | `_safe_add_column` + `default=False` + `nullable=True` → 프론트에서 `?? false` fallback |
| UserOut 스키마 변경으로 `/auth/me` 소비자 영향 | Low | Low | `editor_white_bg: bool = False` 기본값 지정으로 하위 호환 |
| 토글 API 실패 시 UI 불일치 | Low | Low | 낙관적 업데이트 후 실패 시 롤백 처리 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `User` (SQLAlchemy model) | DB Model | `editor_white_bg: Boolean` 컬럼 추가 |
| `UserOut` (Pydantic schema) | Schema | `editor_white_bg: bool = False` 필드 추가 |
| `/auth/me` GET | API | 응답에 `editor_white_bg` 포함 |
| `/auth/me/preferences` PATCH | API | 신규 엔드포인트 |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|----------|-----------|-----------|--------|
| `GET /auth/me` | READ | `frontend/src/services/api.ts` `getMe()` | Needs verification — 새 필드 추가, 기존 소비자 무영향 |
| `UserOut` | READ | `frontend/src/types/index.ts` `User` 타입 | `editor_white_bg` 필드 추가 필요 |
| `User` model | READ | `backend/app/routers/auth.py` `me()` | 변경 없음 (model_validate 자동 반영) |

### 6.3 Verification

- [ ] `/auth/me` 기존 소비자(`useCurrentUser` hook 등) 동작 확인
- [ ] `UserOut` 변경 후 `TokenResponse` 정상 작동 확인
- [ ] DB 마이그레이션 후 기존 users 레코드 NULL → 기본값 처리 확인

---

## 7. Architecture Considerations

### 7.1 Project Level

**Dynamic** — 기존 FastAPI + React 스택 내 추가 기능. 새 서비스/레이어 불필요.

### 7.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| 설정 저장 위치 | localStorage / DB | DB (User 모델) | 사용자 요청: 기기 간 동기화 |
| API 패턴 | 별도 preferences 테이블 / User 컬럼 직접 추가 | User 컬럼 직접 추가 | 설정 수가 적고 기존 패턴과 일치 |
| 프론트 상태 | useQuery 캐시 / 별도 store | useQuery 캐시 invalidate | 기존 TanStack Query 패턴 준수 |
| 토글 위치 | 페이지 헤더 인라인 / Settings 페이지 | 각 작성 페이지 헤더 인라인 | 사용자 요청: 작성 시 바로 접근 가능 |

### 7.3 Implementation Flow

```
사용자 로그인
  └─ GET /auth/me → editor_white_bg 로드
       └─ useCurrentUser 훅에서 캐시
            └─ OpsNoteFormPage / WorkItemDetailPage 진입 시 값 읽기
                 └─ 토글 UI 렌더링 (초기값 = editor_white_bg)
                      └─ 토글 변경 → 낙관적 UI 업데이트
                           └─ PATCH /auth/me/preferences { editor_white_bg }
                                └─ useCurrentUser 캐시 invalidate
```

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] `CLAUDE.md` coding conventions 존재
- [x] ESLint configuration (`eslint.config.js`)
- [x] TypeScript strict (`tsconfig.json`)
- [x] `_safe_add_column` 마이그레이션 패턴 (`main.py`)

### 8.2 Conventions to Follow

| Category | Rule |
|----------|------|
| DB 마이그레이션 | `_safe_add_column` 필수. raw `ALTER TABLE` 금지 |
| API 스키마 | `UserOut`에 `= False` 기본값으로 하위 호환 유지 |
| 프론트 상태 | Server state는 TanStack Query. Client UI state는 useState |
| 스타일 | Tailwind CSS only. inline style 금지 |

---

## 9. Next Steps

1. [ ] `/pdca design editor-white-bg` — 설계 문서 작성
2. [ ] 구현 (백엔드 → 프론트엔드 순)
3. [ ] `/pdca analyze editor-white-bg` — Gap 분석

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-01 | Initial draft | riverjin839 |
