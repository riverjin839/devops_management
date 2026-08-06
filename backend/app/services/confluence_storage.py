"""Confluence storage-format ↔ PEP 에디터(TipTap) HTML 변환기 — 순수 함수, 네트워크 없음.

storage-format 은 XHTML + `ac:`/`ri:` 네임스페이스 확장이다. 네임스페이스 선언이 없어
표준 XML 파서(xml.etree)로는 읽을 수 없으므로 정규식 기반 관용 파서로 처리하고,
변환 불가능한 요소는 내부 텍스트를 보존(unwrap)한 뒤 warnings 로 알린다 — 절대 raise 하지 않는다.

매핑 (v1 범위 — 에디터 블록 직렬화 형식은 frontend/src/components/editor/blocks.ts 참조):

| Confluence                         | PEP 에디터 HTML                                        |
|------------------------------------|--------------------------------------------------------|
| code 매크로 (+language)            | `<pre><code>…</code></pre>`                            |
| info / tip / note / warning 매크로 | `<div data-callout="info|success|note|warning">…</div>`|
| expand 매크로 (+title)             | `<details open><summary>…</summary><div class="toggle-body">…</div></details>` |
| ac:link + ri:page                  | `<a href="{base}/display/{space}/{title}">…</a>`       |
| ac:image + ri:attachment           | `<img src="{base}/download/attachments/{page_id}/{file}">` |
| ac:image + ri:url                  | `<img src="{url}">`                                    |
| ac:task-list                       | `<ul>` + ☑/☐ 텍스트 (경고 기록)                        |
| 기타 ac:*/ri:*                     | unwrap(텍스트 보존) + 경고                             |

역방향(editor_html_to_storage)은 위 표의 오른쪽 → 왼쪽. `data:` 이미지 URI 는
`data_images[]` 로 추출해 호출부(라우터)가 첨부 업로드 후 `<ri:attachment>` 참조가
유효해지도록 한다.
"""
from __future__ import annotations

import base64
import html as html_mod
import re
from urllib.parse import quote

# Callout variant 매핑 — Confluence 매크로명 → 에디터 data-callout 값
_MACRO_TO_CALLOUT = {"info": "info", "tip": "success", "note": "note", "warning": "warning"}
_CALLOUT_TO_MACRO = {v: k for k, v in _MACRO_TO_CALLOUT.items()}

# 본문 없이 통째로 제거해도 안전한 매크로 (목차/자식목록 등 — PEP 쪽 대응물이 없음)
_DROP_MACROS = {"toc", "children", "pagetree", "recently-updated", "livesearch", "contentbylabel"}

_MAX_MACRO_PASSES = 30  # 중첩 매크로 bottom-up 처리 상한 (무한루프 방지)


def _extract_param(body: str, name: str) -> str:
    m = re.search(
        rf'<ac:parameter\s+ac:name="{re.escape(name)}"\s*>(.*?)</ac:parameter>',
        body, re.DOTALL,
    )
    return (m.group(1) or "").strip() if m else ""


def _extract_rich_body(body: str) -> str:
    m = re.search(r"<ac:rich-text-body\s*>(.*?)</ac:rich-text-body>", body, re.DOTALL)
    return m.group(1) if m else ""


def _extract_plain_body(body: str) -> str:
    m = re.search(
        r"<ac:plain-text-body\s*>\s*(?:<!\[CDATA\[(.*?)\]\]>|(.*?))\s*</ac:plain-text-body>",
        body, re.DOTALL,
    )
    if not m:
        return ""
    return m.group(1) if m.group(1) is not None else (m.group(2) or "")


def _transform_macro(name: str, inner: str, warnings: list[str]) -> str:
    """단일(자식 매크로가 이미 처리된) structured-macro 를 에디터 HTML 로 변환."""
    name = (name or "").lower()
    if name == "code":
        code = _extract_plain_body(inner)
        return f"<pre><code>{html_mod.escape(code)}</code></pre>"
    if name in _MACRO_TO_CALLOUT:
        body = _extract_rich_body(inner) or f"<p>{html_mod.escape(_extract_plain_body(inner))}</p>"
        variant = _MACRO_TO_CALLOUT[name]
        return f'<div data-callout="{variant}" class="callout">{body}</div>'
    if name == "expand":
        title = _extract_param(inner, "title") or "펼치기"
        body = _extract_rich_body(inner) or ""
        return (
            f"<details open><summary>{html_mod.escape(title)}</summary>"
            f'<div class="toggle-body">{body}</div></details>'
        )
    if name == "status":
        title = _extract_param(inner, "title")
        return f"<strong>[{html_mod.escape(title)}]</strong>" if title else ""
    if name in _DROP_MACROS:
        warnings.append(f"'{name}' 매크로는 지원되지 않아 제거했습니다.")
        return ""
    # 알 수 없는 매크로 — 본문 텍스트를 보존하고 경고
    body = _extract_rich_body(inner)
    plain = _extract_plain_body(inner)
    warnings.append(f"'{name}' 매크로는 지원되지 않아 본문 텍스트만 유지했습니다.")
    if body:
        return body
    if plain:
        return f"<pre><code>{html_mod.escape(plain)}</code></pre>"
    return ""


def storage_to_editor_html(
    storage_xml: str, *, base_url: str = "", page_id: str = "",
) -> dict:
    """storage-format XML → 에디터 HTML. 반환 {"html", "warnings", "attachments"}.

    attachments 는 본문이 참조하는 첨부 파일명 목록 — 호출부가 inline 변환(다운로드 후
    base64 치환) 여부를 결정할 때 쓴다.
    """
    warnings: list[str] = []
    attachments: list[str] = []
    if not (storage_xml or "").strip():
        return {"html": "", "warnings": warnings, "attachments": attachments}
    out = storage_xml
    base = (base_url or "").rstrip("/")

    try:
        # 1) structured-macro — 중첩 대비 bottom-up (자식 매크로가 없는 것부터) 반복 처리
        macro_re = re.compile(
            r'<ac:structured-macro[^>]*?ac:name="([^"]+)"[^>]*?>'
            r"((?:(?!<ac:structured-macro).)*?)"
            r"</ac:structured-macro>",
            re.DOTALL,
        )
        for _ in range(_MAX_MACRO_PASSES):
            out, n = macro_re.subn(
                lambda m: _transform_macro(m.group(1), m.group(2), warnings), out
            )
            if n == 0:
                break
        # self-closing 매크로 (<ac:structured-macro ac:name="toc" ... />)
        out = re.sub(
            r'<ac:structured-macro[^>]*?ac:name="([^"]+)"[^>]*?/>',
            lambda m: _transform_macro(m.group(1), "", warnings), out,
        )

        # 2) 링크 — ri:page / ri:attachment / 기타
        def _link_repl(m: re.Match) -> str:
            inner = m.group(1)
            body_m = re.search(
                r"<ac:(?:plain-text-)?link-body\s*>\s*(?:<!\[CDATA\[(.*?)\]\]>|(.*?))\s*"
                r"</ac:(?:plain-text-)?link-body>",
                inner, re.DOTALL,
            )
            text = ""
            if body_m:
                text = body_m.group(1) if body_m.group(1) is not None else (body_m.group(2) or "")
                text = re.sub(r"<[^>]+>", "", text).strip()
            page_m = re.search(
                r'<ri:page[^>]*?ri:content-title="([^"]*)"[^>]*?/?>', inner)
            if page_m:
                title = html_mod.unescape(page_m.group(1))
                space_m = re.search(r'ri:space-key="([^"]*)"', page_m.group(0))
                label = html_mod.escape(text or title)
                if base:
                    space = space_m.group(1) if space_m else ""
                    href = (
                        f"{base}/display/{quote(space)}/{quote(title)}" if space
                        else f"{base}/dosearchsite.action?queryString={quote(title)}"
                    )
                    return f'<a href="{html_mod.escape(href)}">{label}</a>'
                return label
            att_m = re.search(r'<ri:attachment[^>]*?ri:filename="([^"]*)"[^>]*?/?>', inner)
            if att_m and base and page_id:
                fn = html_mod.unescape(att_m.group(1))
                href = f"{base}/download/attachments/{page_id}/{quote(fn)}"
                return f'<a href="{html_mod.escape(href)}">{html_mod.escape(text or fn)}</a>'
            return html_mod.escape(text) if text else ""

        out = re.sub(r"<ac:link[^>]*>(.*?)</ac:link>", _link_repl, out, flags=re.DOTALL)

        # 3) 이미지 — 첨부는 Confluence 절대 URL 로 (사내망 브라우저는 SSO 세션으로 렌더됨)
        def _img_repl(m: re.Match) -> str:
            inner = m.group(1)
            att_m = re.search(r'<ri:attachment[^>]*?ri:filename="([^"]*)"[^>]*?/?>', inner)
            if att_m:
                fn = html_mod.unescape(att_m.group(1))
                attachments.append(fn)
                if base and page_id:
                    src = f"{base}/download/attachments/{page_id}/{quote(fn)}"
                    return f'<img src="{html_mod.escape(src)}" alt="{html_mod.escape(fn)}">'
                warnings.append(f"첨부 이미지 '{fn}' 는 원본 페이지 정보가 없어 제거했습니다.")
                return ""
            url_m = re.search(r'<ri:url[^>]*?ri:value="([^"]*)"[^>]*?/?>', inner)
            if url_m:
                return f'<img src="{html_mod.escape(html_mod.unescape(url_m.group(1)))}">'
            return ""

        out = re.sub(r"<ac:image[^>]*>(.*?)</ac:image>", _img_repl, out, flags=re.DOTALL)
        out = re.sub(r"<ac:image[^>]*/>", "", out)

        # 4) 작업 목록 → 일반 목록 + 체크 문자 (TipTap taskList 왕복은 v1 비목표)
        if "<ac:task-list" in out:
            warnings.append("작업 목록(task list)은 일반 목록으로 변환했습니다.")

            def _task_repl(m: re.Match) -> str:
                body = m.group(1)
                items = []
                for t in re.finditer(r"<ac:task>(.*?)</ac:task>", body, re.DOTALL):
                    status_m = re.search(r"<ac:task-status>(.*?)</ac:task-status>", t.group(1))
                    done = bool(status_m and status_m.group(1).strip() == "complete")
                    body_m = re.search(r"<ac:task-body>(.*?)</ac:task-body>", t.group(1), re.DOTALL)
                    txt = body_m.group(1) if body_m else ""
                    items.append(f"<li>{'☑' if done else '☐'} {txt}</li>")
                return f"<ul>{''.join(items)}</ul>"

            out = re.sub(r"<ac:task-list\s*>(.*?)</ac:task-list>", _task_repl, out, flags=re.DOTALL)

        # 5) 레이아웃/기타 잔여 ac:*, ri:* 태그 unwrap (내부 콘텐츠 보존)
        leftover = sorted(set(re.findall(r"</?(?:ac|ri):([a-z-]+)", out)))
        if leftover:
            warnings.append(
                "지원되지 않는 요소를 본문만 남기고 정리했습니다: " + ", ".join(leftover)
            )
        out = re.sub(r"</?(?:ac|ri):[a-z-]+[^>]*>", "", out)
        # CDATA 잔여물 정리
        out = out.replace("<![CDATA[", "").replace("]]>", "")
        return {"html": out.strip(), "warnings": warnings, "attachments": attachments}
    except Exception as exc:  # noqa: BLE001 — 변환 실패 시 원문 텍스트 보존 (fail-safe)
        text = re.sub(r"<[^>]+>", " ", storage_xml)
        text = html_mod.escape(re.sub(r"\s+", " ", text).strip())
        return {
            "html": f"<p>{text}</p>" if text else "",
            "warnings": warnings + [f"변환 실패 — 텍스트만 보존했습니다 ({str(exc)[:120]})"],
            "attachments": attachments,
        }


# ── Export: 에디터 HTML → storage-format ─────────────────────────────────────

_DATA_IMG_RE = re.compile(
    r'<img[^>]*?src="data:(image/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)"[^>]*?>', re.IGNORECASE
)
_MIME_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}


def editor_html_to_storage(editor_html: str) -> dict:
    """에디터 HTML → storage-format. 반환 {"storage", "warnings", "data_images"}.

    data_images 는 [{"filename", "mime", "data"(bytes)}] — 호출부가 페이지 첨부로
    업로드해야 본문의 `<ri:attachment>` 참조가 유효해진다. 업로드 실패 시 해당
    이미지는 호출부가 제거/경고 처리한다.
    """
    warnings: list[str] = []
    data_images: list[dict] = []
    if not (editor_html or "").strip():
        return {"storage": "", "warnings": warnings, "data_images": data_images}
    out = editor_html

    try:
        # 1) base64 인라인 이미지 → 첨부 참조 (파일명은 순번 기반 결정적 이름)
        def _data_img_repl(m: re.Match) -> str:
            mime = m.group(1).lower()
            try:
                raw = base64.b64decode(re.sub(r"\s+", "", m.group(2)))
            except Exception:  # noqa: BLE001
                warnings.append("본문 이미지 1건을 해석할 수 없어 제거했습니다.")
                return ""
            ext = _MIME_EXT.get(mime, "png")
            filename = f"pep-image-{len(data_images) + 1}.{ext}"
            data_images.append({"filename": filename, "mime": mime, "data": raw})
            return (
                f'<ac:image><ri:attachment ri:filename="{html_mod.escape(filename)}"/></ac:image>'
            )

        out = _DATA_IMG_RE.sub(_data_img_repl, out)

        # 2) Callout → info/tip/note/warning 매크로
        def _callout_repl(m: re.Match) -> str:
            variant = m.group(1)
            macro = _CALLOUT_TO_MACRO.get(variant, "info")
            return (
                f'<ac:structured-macro ac:name="{macro}">'
                f"<ac:rich-text-body>{m.group(2)}</ac:rich-text-body></ac:structured-macro>"
            )

        out = re.sub(
            r'<div[^>]*?data-callout="([^"]+)"[^>]*>(.*?)</div>',
            _callout_repl, out, flags=re.DOTALL,
        )

        # 3) Toggle(details) → expand 매크로
        def _toggle_repl(m: re.Match) -> str:
            summary = re.sub(r"<[^>]+>", "", m.group(1) or "").strip() or "펼치기"
            return (
                '<ac:structured-macro ac:name="expand">'
                f'<ac:parameter ac:name="title">{html_mod.escape(summary)}</ac:parameter>'
                f"<ac:rich-text-body>{m.group(2)}</ac:rich-text-body></ac:structured-macro>"
            )

        out = re.sub(
            r'<details[^>]*>\s*<summary[^>]*>(.*?)</summary>\s*'
            r'<div class="toggle-body"[^>]*>(.*?)</div>\s*</details>',
            _toggle_repl, out, flags=re.DOTALL,
        )

        # 4) 코드 블록 → code 매크로 (CDATA 종료 시퀀스 이스케이프)
        def _code_repl(m: re.Match) -> str:
            code = html_mod.unescape(re.sub(r"</?code[^>]*>", "", m.group(1)))
            code = code.replace("]]>", "]]]]><![CDATA[>")
            return (
                '<ac:structured-macro ac:name="code">'
                f"<ac:plain-text-body><![CDATA[{code}]]></ac:plain-text-body>"
                "</ac:structured-macro>"
            )

        out = re.sub(r"<pre[^>]*>(.*?)</pre>", _code_repl, out, flags=re.DOTALL)

        # 5) TipTap taskList → 일반 목록 (Confluence 작업 목록 왕복은 v1 비목표)
        if 'data-type="taskList"' in out:
            warnings.append("체크리스트는 일반 목록으로 게시했습니다.")
            out = re.sub(r'<(ul|li)([^>]*?)\sdata-[a-z-]+="[^"]*"([^>]*)>', r"<\1\2\3>", out)
            out = re.sub(r"</?(?:label|input)[^>]*>", "", out)

        # 6) storage 는 XHTML — void 태그를 self-closing 으로 정규화
        out = re.sub(r"<(br|hr)(\s[^>]*?)?(?<!/)>", r"<\1\2/>", out)
        out = re.sub(r"<img((?:[^>]*?))(?<!/)>", r"<img\1/>", out)
        return {"storage": out.strip(), "warnings": warnings, "data_images": data_images}
    except Exception as exc:  # noqa: BLE001
        text = re.sub(r"<[^>]+>", " ", editor_html)
        text = html_mod.escape(re.sub(r"\s+", " ", text).strip())
        return {
            "storage": f"<p>{text}</p>" if text else "",
            "warnings": warnings + [f"변환 실패 — 텍스트만 게시합니다 ({str(exc)[:120]})"],
            "data_images": [],
        }
