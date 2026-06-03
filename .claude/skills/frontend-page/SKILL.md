---
name: frontend-page
description: 새 React 페이지(특히 클러스터 선택형 운영 페이지)를 추가할 때 사용. 표준 레이아웃(ClusterSidebar iconOnly + MacCard), api.ts/hooks 패턴, 라우팅·사이드바 메뉴 등록, lint/tsc/build 게이트까지 컨벤션대로 만든다.
---

# 새 프론트엔드 페이지

스택: React 18 + TS + Vite + Tailwind + shadcn/Radix + Zustand(클라 상태) + TanStack Query(서버 상태).
**ESLint max-warnings 0** — 경고 0 이어야 CI 통과.

## 레이아웃 표준 (클러스터 선택형)
```
min-h-screen bg-background p-5
  flex gap-4 max-w-[1600px] mx-auto
    <div className="sticky top-4 self-start">
      <ClusterSidebar clusters={clusters} selectedId={...} onSelect={...} iconOnly />
    </div>
    <div className="flex-1 min-w-0 space-y-4"> ...본문(MacCard)... </div>
```
- `ClusterSidebar` 는 **항상 `iconOnly`**(폭 56px 아이콘 레일). 다중 선택은 `multiSelect`+`selectedIds`+`onMultiSelectChange`.
- 섹션은 `MacCard`(variant 기본 'flat'). 카드 제목을 본문에서 `<h2>` 로 중복 금지.
- 상태 표시는 `StatusBadge`/`StatusDot`(+ `statusToVariant`). 필터칩은 LakeServicesPage 의 FilterChip 패턴.
- 둥근모서리 `rounded-2xl`(카드)/`rounded-xl`(버튼), 그림자 `.mac-shadow`, 인라인 스타일 금지.
- 참고 스켈레톤: `pages/DailyCheckReview.tsx`, `pages/OpsCheckConsolePage.tsx`.

## 데이터 (api + hooks)
- `src/services/api.ts` 에 `export const xApi = { ... }` 추가. axios 인터셉터가 **camel↔snake 자동 변환**하므로
  프론트는 camelCase, 백엔드는 snake_case 그대로 둔다.
- `src/hooks/useX.ts` 에 TanStack Query 훅(`useQuery`/`useMutation`, `queryKey` 상수, `invalidateQueries`).
  진행률 폴링은 `refetchInterval`(완료 시 false 반환)로.
- 공유 타입은 `src/types/index.ts` 에.

## 라우팅·메뉴
- `src/App.tsx` 에 `<Route path="/x(/:id)" element={<XPage />} />`. 레거시 경로는 redirect 로 호환 유지.
- `src/components/layout/Sidebar.tsx`: `NAV_MAP` 에 라벨/아이콘, `GROUPS` 의 적절한 그룹 `paths` 에 경로 추가.
  메뉴 라벨은 `uiSettings.navLabels` 로 사용자 커스터마이즈 가능.

## 검증 (커밋 전 필수)
```
cd frontend && npm run lint && npx tsc --noEmit && npm run build
```
