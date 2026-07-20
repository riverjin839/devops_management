---
name: editor-docs
description: 리치텍스트 에디터·문서 기능 작업 시 사용. TipTap 기반 RichTextEditor 사용/확장, 문서 템플릿 추가, 붙여넣기 이미지 경량화, 안전한 HTML 렌더(RichContent)를 다룬다.
---

# 에디터 · 문서 기능

문서 본문은 TipTap 기반 `RichTextEditor` 로 작성하고 **HTML 문자열로 DB 저장**, 읽기는
`RichContent`(DOMPurify sanitize)로 렌더한다.

## 핵심 파일
- `src/components/editor/RichTextEditor.tsx` — TipTap 에디터 + 툴바. props: `value`/`onChange`/
  `placeholder`/`minHeight`/`onImagePaste`/`linkSearch`(`[[` 백링크 검색)/`defaultBg`/
  `extraTemplates`(동적 템플릿 주입, 예: `WorkItemForm.tsx`).
- `src/components/editor/RichContent.tsx` — 저장된 HTML 안전 렌더(허용 태그/속성 화이트리스트,
  `blocks.ts` 의 콜아웃/토글 커스텀 노드용 `div`/`details`/`summary`/`data-callout`/`open` 포함).
- `src/components/editor/docTemplates.ts` — 실무 템플릿 카탈로그(툴바 "템플릿" 메뉴).
- `src/components/editor/blocks.ts` — 커스텀 TipTap 노드: 콜아웃(`Callout`), 토글(`ToggleBlock`).
- `src/lib/imageCompress.ts` — 붙여넣기 이미지 경량화.

## 배경색
- `defaultBg`(hex, 예: `'#ffffff'`) prop 으로 초기 배경을 지정한다. 사용자가 툴바에서
  `BG_PRESETS`(흰/크림/그레이/인디고톤/그린톤/다크) 중 골라 바꾸면 `localStorage['k8s:editor-bg']`
  에 저장돼 다음에도 유지된다.
- ⚠️ **`whiteBg` prop / `useEditorWhiteBg` 훅은 더 이상 존재하지 않는다** (과거 boolean 토글 →
  컬러 피커 방식으로 교체됨). 백엔드의 `users.editor_white_bg` 컬럼은 프론트에서 더 이상
  참조되지 않는 죽은 필드로 남아 있다 — 새 코드에서 참조하지 말 것.

## 새 문서 템플릿 추가
- `docTemplates.ts` 의 `DOC_TEMPLATES` 에 `{ id, label, description, html }` 추가.
- 기본 TipTap 확장(heading/p/ul/ol/taskList/table/blockquote/hr/code) 외에도 `blocks.ts` 의
  **콜아웃/토글 블록이 이미 있으니 재사용 가능** — 완전히 새로운 블록 타입이 필요할 때만
  TipTap 확장을 새로 추가한다.
  taskList 형식: `<ul data-type="taskList"><li data-type="taskItem" data-checked="false">…</li></ul>`.
- **원칙(사용자 요청)**: 실무에 쓰는 것만, 이미지 없이 경량.

## 이미지 용량 관리 (중요)
- 서버 업로드가 없어 이미지는 base64 data URL 로 본문에 박힌다 → DB 비대화 위험.
- 붙여넣기는 `compressImageFile`(캔버스 다운스케일 maxDim=1600 + webp/jpeg 재인코딩)을 거친다.
- 새 이미지 삽입 경로를 추가하면 **반드시 동일 압축을 거치게** 할 것. 대용량 원본 저장 지양.
- 후속 옵션: 서버 업로드 + URL 참조(가장 근본적 경량화), draw.io 도식은 PNG 가 아닌 .drawio XML/SVG(벡터)로.

## 검증
```
cd frontend && npm run lint && npx tsc --noEmit && npm run build
```
