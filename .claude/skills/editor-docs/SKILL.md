---
name: editor-docs
description: 리치텍스트 에디터·문서 기능 작업 시 사용. TipTap 기반 RichTextEditor 사용/확장, 문서 템플릿 추가, 붙여넣기 이미지 경량화, 안전한 HTML 렌더(RichContent)를 다룬다.
---

# 에디터 · 문서 기능

문서 본문은 TipTap 기반 `RichTextEditor` 로 작성하고 **HTML 문자열로 DB 저장**, 읽기는
`RichContent`(DOMPurify sanitize)로 렌더한다.

## 핵심 파일
- `src/components/editor/RichTextEditor.tsx` — TipTap 에디터 + 툴바. props: `value`/`onChange`/
  `placeholder`/`minHeight`/`whiteBg`/`onImagePaste`.
- `src/components/editor/RichContent.tsx` — 저장된 HTML 안전 렌더(허용 태그/속성 화이트리스트).
- `src/components/editor/docTemplates.ts` — 실무 템플릿 카탈로그(툴바 "템플릿" 메뉴).
- `src/lib/imageCompress.ts` — 붙여넣기 이미지 경량화.

## 배경색 / "흰 배경"
- `whiteBg` 가 true 면 wrapper·**툴바·본문 전부 흰색**(+ 검정 글씨). 기본 테마는 "warm paper"(크림)라
  whiteBg 없이는 누리끼리하게 보인다. 사용자별 토글은 `useEditorWhiteBg`/`users.editor_white_bg`.

## 새 문서 템플릿 추가
- `docTemplates.ts` 의 `DOC_TEMPLATES` 에 `{ id, label, description, html }` 추가.
- **현재 TipTap 확장만으로 렌더되는 HTML 만** 사용(heading/p/ul/ol/taskList/table/blockquote/hr/code).
  taskList 형식: `<ul data-type="taskList"><li data-type="taskItem" data-checked="false">…</li></ul>`.
- **원칙(사용자 요청)**: 실무에 쓰는 것만, 이미지 없이 경량. 새 블록 타입이 필요하면 먼저 TipTap 확장 추가.

## 이미지 용량 관리 (중요)
- 서버 업로드가 없어 이미지는 base64 data URL 로 본문에 박힌다 → DB 비대화 위험.
- 붙여넣기는 `compressImageFile`(캔버스 다운스케일 maxDim=1600 + webp/jpeg 재인코딩)을 거친다.
- 새 이미지 삽입 경로를 추가하면 **반드시 동일 압축을 거치게** 할 것. 대용량 원본 저장 지양.
- 후속 옵션: 서버 업로드 + URL 참조(가장 근본적 경량화), draw.io 도식은 PNG 가 아닌 .drawio XML/SVG(벡터)로.

## 검증
```
cd frontend && npm run lint && npx tsc --noEmit && npm run build
```
