# editor-white-bg Design Document

> **Summary**: 작성 영역(OpsNote/WorkItem) 흰 배경 토글 — User DB 저장, Option A Minimal 아키텍처
>
> **Project**: PEP (Platform Engineering Portal)
> **Version**: feature/home-v2
> **Author**: riverjin839
> **Date**: 2026-06-01
> **Status**: Draft
> **Planning Doc**: [editor-white-bg.plan.md](../01-plan/features/editor-white-bg.plan.md)

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

### 1.1 Design Goals

- 최소한의 파일 변경으로 기능 완성 (Option A Minimal)
- 기존 `authStore` + `authApi` 패턴을 그대로 확장
- 낙관적 업데이트(토글 즉시 반영) + API 실패 시 자동 롤백
- `_safe_add_column` 패턴으로 기존 DB 호환

### 1.2 Design Principles

- 기존 패턴 재사용 — 새 hook·store 없음, `useAuthStore` + `authApi` 직접 사용
- 단일 진실 공급원 — `AuthUser.editorWhiteBg`가 유일한 상태 소스
- 실패 안전성 — API 실패 시 즉시 이전 값으로 롤백

---

## 2. Architecture Options

### 2.0 Architecture Comparison

| Criteria | Option A: Minimal | Option B/C: Hook 분리 |
|----------|:-:|:-:|
| **Approach** | 페이지 직접 useAuthStore + authApi | useEditorPreferences 훅 신규 |
| **New Files** | 0 | 1 |
| **Modified Files** | 7 | 7 |
| **Complexity** | Low | Low-Medium |
| **Maintainability** | Medium (로직 분산) | High (중앙화) |
| **Effort** | Low | Low |
| **Recommendation** | 현 규모에 적합 | 설정 항목 증가 시 |

**Selected**: **Option A — Minimal**  
**Rationale**: 설정 항목이 1개이므로 새 hook 추가 대비 이득이 없음. 기존 4개 페이지 패턴 통일.

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend                                                   │
│                                                             │
│  OpsNoteFormPage   OpsNoteDetailPage                        │
│  WorkItemFormPage  WorkItemDetailPage                       │
│         │                                                   │
│         ├── read: useAuthStore((s) => s.user?.editorWhiteBg)│
│         └── write: authApi.patchPreferences() → setUser()  │
│                                                             │
│  authStore.ts ← AuthUser.editorWhiteBg (boolean)           │
│  api.ts       ← authApi.patchPreferences()                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ PATCH /auth/me/preferences
┌──────────────────────▼──────────────────────────────────────┐
│  Backend                                                    │
│                                                             │
│  auth.py router ← PATCH /auth/me/preferences (신규)        │
│  schemas/auth.py ← UserOut + UpdatePreferencesRequest      │
│  models/user.py ← editor_white_bg Boolean column           │
│  main.py ← _safe_add_column 마이그레이션                    │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

```
[페이지 진입]
1. useAuthStore((s) => s.user) 읽기
   - user.editorWhiteBg ?? false → 토글 초기값 결정
   - user가 null이면 토글 미표시

[토글 클릭]
2. const next = !editorWhiteBg
3. setUser({ ...user!, editorWhiteBg: next })  // 낙관적 업데이트 즉시 반영
4. try { await authApi.patchPreferences({ editorWhiteBg: next }) }
   catch { setUser(prevUser) }                  // 실패 시 롤백

[다음 방문/재로그인]
5. GET /auth/me → UserOut.editor_white_bg → normalizeUser() → editorWhiteBg
   → localStorage 'k8s:auth:user' 갱신 → 토글 자동 복원
```

---

## 3. Data Model

### 3.1 Backend: User 모델 변경

```python
# backend/app/models/user.py
class User(Base):
    __tablename__ = "users"
    # ... 기존 필드들 ...
    editor_white_bg = Column(Boolean, nullable=True, default=False)
    #   ↑ nullable=True: 기존 rows null 허용 (마이그레이션 후 프론트에서 ?? false)
```

### 3.2 Backend: 마이그레이션 (`main.py`)

```python
# _run_migrations() 함수 내
_safe_add_column('users', 'editor_white_bg', 'BOOLEAN DEFAULT FALSE')
```

### 3.3 Frontend: AuthUser 타입 변경

```typescript
// frontend/src/stores/authStore.ts
export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  displayName?: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  editorWhiteBg: boolean;   // ← 추가
}

function normalizeUser(raw: Partial<AuthUser> & { role?: string }): AuthUser {
  return {
    // ... 기존 필드들 ...
    editorWhiteBg: Boolean(raw.editorWhiteBg ?? false),  // ← 추가
  };
}
```

---

## 4. API Specification

### 4.1 Endpoint List

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/auth/me` | 현재 유저 정보 (기존, `editor_white_bg` 포함으로 확장) | Bearer |
| PATCH | `/auth/me/preferences` | 사용자 설정 업데이트 (신규) | Bearer |

### 4.2 GET /auth/me 응답 변경

기존 `UserOut` 스키마에 필드 추가:

```python
# backend/app/schemas/auth.py
class UserOut(BaseModel):
    id: str
    username: str
    role: str
    display_name: str | None = None
    is_active: bool
    must_change_password: bool = False
    created_at: datetime
    editor_white_bg: bool = False   # ← 추가 (기본값 False로 하위 호환)

    class Config:
        from_attributes = True
```

**Response (200 OK) — 변경된 형태:**
```json
{
  "id": "uuid",
  "username": "riverjin839",
  "role": "admin",
  "display_name": null,
  "is_active": true,
  "must_change_password": false,
  "created_at": "2026-01-01T00:00:00Z",
  "editor_white_bg": false
}
```

### 4.3 PATCH /auth/me/preferences (신규)

**Request Schema:**
```python
# backend/app/schemas/auth.py
class UpdatePreferencesRequest(BaseModel):
    editor_white_bg: bool
```

**Request:**
```json
{ "editor_white_bg": true }
```

**Response (200 OK):** `UserOut` (업데이트된 user 전체 반환)

**Error Responses:**
- `401 Unauthorized` — 미인증

**구현 위치:** `backend/app/routers/auth.py`
```python
@router.patch("/me/preferences", response_model=UserOut)
def update_my_preferences(
    payload: UpdatePreferencesRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    user.editor_white_bg = payload.editor_white_bg
    db.commit()
    db.refresh(user)
    return UserOut.model_validate(user)
```

### 4.4 Frontend: authApi 확장

```typescript
// frontend/src/services/api.ts
export const authApi = {
  // ... 기존 메서드들 ...
  patchPreferences: (payload: { editorWhiteBg: boolean }) =>
    api.patch<AuthUser>('/auth/me/preferences', payload),
};
```

---

## 5. UI/UX Design

### 5.1 토글 버튼 위치

각 페이지의 기존 sticky 헤더 바 우측에 배치.

```
┌──────────────────────────────────────────────────────────┐
│  ← (뒤로)  🔔 (아이콘)  페이지 제목     [ ☀ 흰배경 ] ... │  ← 헤더
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ bg-white rounded-2xl p-8                          │  │  ← 에디터 컨테이너
│  │  (editorWhiteBg=true 시 bg-white 클래스 적용)      │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 5.2 토글 버튼 스펙

```tsx
// 토글 버튼 — 헤더 우측 ml-auto 위치
<button
  onClick={handleToggle}
  className={cn(
    'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
    editorWhiteBg
      ? 'bg-primary/10 text-primary'          // 활성: 파란 틴트
      : 'text-muted-foreground hover:bg-secondary'  // 비활성: 회색
  )}
  title={editorWhiteBg ? '흰 배경 끄기' : '흰 배경 켜기'}
>
  <Sun className="w-3.5 h-3.5" />
  <span className="hidden sm:inline">흰 배경</span>
</button>
```

### 5.3 에디터 컨테이너 배경 적용

각 페이지의 에디터를 감싸는 `div`에 조건부 클래스 적용:

```tsx
// 변경 전
<div className="bg-card border border-border rounded-2xl p-8 mac-shadow">

// 변경 후
<div className={cn(
  'border border-border rounded-2xl p-8 mac-shadow',
  editorWhiteBg ? 'bg-white' : 'bg-card'
)}>
```

### 5.4 Page UI Checklist

#### OpsNoteFormPage (새 Q&A 작성)

- [ ] Button: 흰 배경 토글 — 헤더 우측, Sun 아이콘 + "흰 배경" 텍스트 (sm 이상)
- [ ] Container: 에디터 컨테이너 `bg-white` / `bg-card` 조건부 클래스
- [ ] State: 토글 클릭 시 즉시 배경 전환 (낙관적)
- [ ] Persistence: 새로고침 후 동일 설정 유지

#### OpsNoteDetailPage (Q&A 상세/편집)

- [ ] Button: 흰 배경 토글 — 헤더 우측, Sun 아이콘 + "흰 배경" 텍스트 (sm 이상)
- [ ] Container: 본문 표시 영역 `bg-white` / `bg-card` 조건부 클래스
- [ ] State: 토글 클릭 시 즉시 배경 전환

#### WorkItemFormPage (업무 등록/수정)

- [ ] Button: 흰 배경 토글 — 헤더 우측, Sun 아이콘 + "흰 배경" 텍스트 (sm 이상)
- [ ] Container: 폼 컨테이너 `bg-white` / `bg-card` 조건부 클래스
- [ ] State: 토글 클릭 시 즉시 배경 전환

#### WorkItemDetailPage (업무 상세/편집)

- [ ] Button: 흰 배경 토글 — 헤더 우측, Sun 아이콘 + "흰 배경" 텍스트 (sm 이상)
- [ ] Container: 본문/설명 영역 `bg-white` / `bg-card` 조건부 클래스
- [ ] State: 토글 클릭 시 즉시 배경 전환

---

## 6. Error Handling

| 상황 | 처리 |
|------|------|
| `patchPreferences` API 실패 (네트워크 오류 등) | `setUser(prevUser)` 로 즉시 롤백, toast 없음 (silent rollback) |
| `user`가 null (미로그인) | 토글 버튼 미표시 (`user &&` 조건부 렌더) |
| `editorWhiteBg` 필드 없는 구형 user 객체 | `user?.editorWhiteBg ?? false` fallback |

---

## 7. Security Considerations

- [ ] PATCH `/auth/me/preferences`는 `get_current_user` 의존성으로 인증 필수
- [ ] `payload.editor_white_bg`는 Pydantic `bool` 타입 — 타입 강제 적용됨
- [ ] 다른 사용자의 preferences 수정 불가 — 항상 `current_user` 기준

---

## 8. Test Plan

### 8.1 L1: API Test Scenarios

| # | Endpoint | Method | Test Description | Expected Status |
|---|----------|--------|-----------------|:--------------:|
| 1 | `/auth/me` | GET | `editor_white_bg` 필드 포함 확인 | 200 |
| 2 | `/auth/me/preferences` | PATCH | `{"editor_white_bg": true}` → 저장 후 GET /me 확인 | 200 |
| 3 | `/auth/me/preferences` | PATCH | 미인증 요청 거부 | 401 |
| 4 | `/auth/me/preferences` | PATCH | 재토글 `{"editor_white_bg": false}` | 200 |

### 8.2 L2: UI Action Test Scenarios

| # | Page | Action | Expected Result |
|---|------|--------|----------------|
| 1 | OpsNoteFormPage | 페이지 로드 | 헤더에 Sun 아이콘 + "흰 배경" 버튼 표시 |
| 2 | OpsNoteFormPage | 토글 클릭 | 에디터 컨테이너 배경 즉시 흰색 전환 |
| 3 | OpsNoteFormPage | 토글 켠 후 새로고침 | 흰 배경 유지 |
| 4 | WorkItemDetailPage | 토글 클릭 | 본문 영역 배경 즉시 전환 |
| 5 | 임의 페이지 → OpsNoteFormPage | 재진입 | 이전 설정 복원 |

### 8.3 L3: E2E Scenario Test Scenarios

| # | Scenario | Steps | Success Criteria |
|---|----------|-------|-----------------|
| 1 | 기기 간 동기화 | 로그인 → 흰 배경 켜기 → 로그아웃 → 재로그인 | 흰 배경 설정 유지 |
| 2 | 낙관적 업데이트 | 토글 클릭 | 즉시 배경 전환, API 완료 대기 없음 |

---

## 9. Clean Architecture — Layer Assignment

| Component | Layer | Location |
|-----------|-------|----------|
| `AuthUser.editorWhiteBg` | Domain | `frontend/src/stores/authStore.ts` |
| `authApi.patchPreferences` | Infrastructure | `frontend/src/services/api.ts` |
| 토글 버튼 + 조건부 클래스 | Presentation | 각 Page 파일 |
| `User.editor_white_bg` | Infrastructure (DB) | `backend/app/models/user.py` |
| `UpdatePreferencesRequest` | Domain (Schema) | `backend/app/schemas/auth.py` |
| `PATCH /auth/me/preferences` | Application | `backend/app/routers/auth.py` |

---

## 10. Coding Conventions

| Item | Convention |
|------|-----------|
| 백엔드 컬럼명 | `editor_white_bg` (snake_case) |
| 프론트 필드명 | `editorWhiteBg` (camelCase — axios 인터셉터 자동 변환) |
| 조건부 클래스 | `cn()` 헬퍼 사용 (`clsx` 기반) |
| 마이그레이션 | `_safe_add_column` — raw ALTER 금지 |
| 에러 처리 | silent rollback (toast 없음, console.error 없음) |

---

## 11. Implementation Guide

### 11.1 File Structure

```
backend/
  app/
    models/user.py              ← editor_white_bg 컬럼 추가
    schemas/auth.py             ← UserOut + UpdatePreferencesRequest
    routers/auth.py             ← PATCH /auth/me/preferences
    main.py                     ← _run_migrations() _safe_add_column

frontend/src/
  stores/authStore.ts           ← AuthUser.editorWhiteBg + normalizeUser()
  services/api.ts               ← authApi.patchPreferences()
  pages/
    OpsNoteFormPage.tsx         ← 토글 버튼 + 조건부 bg 클래스
    OpsNoteDetailPage.tsx       ← 토글 버튼 + 조건부 bg 클래스
    WorkItemFormPage.tsx        ← 토글 버튼 + 조건부 bg 클래스
    WorkItemDetailPage.tsx      ← 토글 버튼 + 조건부 bg 클래스
```

**신규 파일: 0개 / 수정 파일: 8개**

### 11.2 Implementation Order

**Phase 1 — 백엔드 (선행 필수)**

1. [ ] `backend/app/models/user.py` — `editor_white_bg` 컬럼 추가
2. [ ] `backend/app/schemas/auth.py` — `UserOut`에 `editor_white_bg: bool = False` + `UpdatePreferencesRequest` 추가
3. [ ] `backend/app/main.py` — `_run_migrations()`에 `_safe_add_column` 추가
4. [ ] `backend/app/routers/auth.py` — `PATCH /auth/me/preferences` 엔드포인트 추가

**Phase 2 — 프론트엔드**

5. [ ] `frontend/src/stores/authStore.ts` — `AuthUser.editorWhiteBg` + `normalizeUser()` 업데이트
6. [ ] `frontend/src/services/api.ts` — `authApi.patchPreferences()` 추가
7. [ ] `frontend/src/pages/OpsNoteFormPage.tsx` — 토글 UI + 조건부 bg
8. [ ] `frontend/src/pages/OpsNoteDetailPage.tsx` — 토글 UI + 조건부 bg
9. [ ] `frontend/src/pages/WorkItemFormPage.tsx` — 토글 UI + 조건부 bg
10. [ ] `frontend/src/pages/WorkItemDetailPage.tsx` — 토글 UI + 조건부 bg

### 11.3 Session Guide

#### Module Map

| Module | Scope Key | Description | 예상 파일 수 |
|--------|-----------|-------------|:----------:|
| 백엔드 API | `module-1` | User 모델 + 스키마 + 마이그레이션 + 라우터 | 4개 |
| 프론트엔드 기반 | `module-2` | authStore + api.ts 타입/메서드 추가 | 2개 |
| 프론트엔드 UI | `module-3` | 4개 페이지 토글 UI + 조건부 bg 적용 | 4개 |

#### Recommended Session Plan

| Session | Phase | Scope | 예상 소요 |
|---------|-------|-------|:--------:|
| Session 1 (현재) | Plan + Design | 전체 | 완료 |
| Session 2 | Do | `--scope module-1,module-2` | 20-30 turns |
| Session 3 | Do | `--scope module-3` | 20-30 turns |
| Session 4 | Check + Report | 전체 | 20-25 turns |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-01 | Initial draft — Option A Minimal 선택 | riverjin839 |
