"""Confluence storage-format ↔ 에디터 HTML 변환기 단위 테스트 — 순수 함수, 네트워크/DB 불필요."""
from app.services.confluence_storage import editor_html_to_storage, storage_to_editor_html

BASE = "https://confluence.example.com"


# ── Import (storage → editor HTML) ─────────────────────────────────────────────
def test_code_macro_becomes_pre_code():
    xml = (
        '<ac:structured-macro ac:name="code" ac:schema-version="1">'
        '<ac:parameter ac:name="language">bash</ac:parameter>'
        "<ac:plain-text-body><![CDATA[echo <hi> & bye]]></ac:plain-text-body>"
        "</ac:structured-macro>"
    )
    out = storage_to_editor_html(xml, base_url=BASE, page_id="1")
    assert out["html"] == "<pre><code>echo &lt;hi&gt; &amp; bye</code></pre>"
    assert out["warnings"] == []


def test_info_and_warning_macros_become_callouts():
    xml = (
        '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>안내</p></ac:rich-text-body></ac:structured-macro>'
        '<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>주의</p></ac:rich-text-body></ac:structured-macro>'
        '<ac:structured-macro ac:name="tip"><ac:rich-text-body><p>팁</p></ac:rich-text-body></ac:structured-macro>'
    )
    html = storage_to_editor_html(xml, base_url=BASE, page_id="1")["html"]
    assert '<div data-callout="info" class="callout"><p>안내</p></div>' in html
    assert '<div data-callout="warning" class="callout"><p>주의</p></div>' in html
    # tip → success (에디터 Callout variant)
    assert '<div data-callout="success" class="callout"><p>팁</p></div>' in html


def test_expand_macro_becomes_toggle_details():
    xml = (
        '<ac:structured-macro ac:name="expand">'
        '<ac:parameter ac:name="title">상세 보기</ac:parameter>'
        "<ac:rich-text-body><p>본문</p></ac:rich-text-body></ac:structured-macro>"
    )
    html = storage_to_editor_html(xml, base_url=BASE, page_id="1")["html"]
    assert html.startswith("<details open><summary>상세 보기</summary>")
    assert '<div class="toggle-body"><p>본문</p></div></details>' in html


def test_nested_macros_processed_bottom_up():
    xml = (
        '<ac:structured-macro ac:name="expand">'
        '<ac:parameter ac:name="title">t</ac:parameter>'
        "<ac:rich-text-body>"
        '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>'
        "</ac:rich-text-body></ac:structured-macro>"
    )
    html = storage_to_editor_html(xml, base_url=BASE, page_id="1")["html"]
    assert '<div data-callout="info"' in html
    assert "<details open>" in html
    assert "ac:" not in html


def test_page_link_becomes_display_anchor():
    xml = (
        "<ac:link>"
        '<ri:page ri:space-key="OPS" ri:content-title="운영 가이드"/>'
        "<ac:plain-text-link-body><![CDATA[가이드 문서]]></ac:plain-text-link-body>"
        "</ac:link>"
    )
    html = storage_to_editor_html(xml, base_url=BASE, page_id="1")["html"]
    assert 'href="https://confluence.example.com/display/OPS/' in html
    assert ">가이드 문서</a>" in html


def test_attachment_image_uses_absolute_download_url():
    xml = '<ac:image ac:width="500"><ri:attachment ri:filename="diagram.png"/></ac:image>'
    out = storage_to_editor_html(xml, base_url=BASE, page_id="777")
    assert '<img src="https://confluence.example.com/download/attachments/777/diagram.png"' in out["html"]
    assert out["attachments"] == ["diagram.png"]


def test_external_url_image_kept():
    xml = '<ac:image><ri:url ri:value="https://img.example.com/a.png"/></ac:image>'
    html = storage_to_editor_html(xml, base_url=BASE, page_id="1")["html"]
    assert '<img src="https://img.example.com/a.png">' in html


def test_task_list_becomes_plain_list_with_warning():
    xml = (
        "<ac:task-list>"
        "<ac:task><ac:task-status>complete</ac:task-status><ac:task-body>끝난 일</ac:task-body></ac:task>"
        "<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>남은 일</ac:task-body></ac:task>"
        "</ac:task-list>"
    )
    out = storage_to_editor_html(xml, base_url=BASE, page_id="1")
    assert "<li>☑ 끝난 일</li>" in out["html"]
    assert "<li>☐ 남은 일</li>" in out["html"]
    assert any("작업 목록" in w for w in out["warnings"])


def test_unknown_macro_unwraps_body_and_warns():
    xml = (
        '<ac:structured-macro ac:name="fancy-chart">'
        "<ac:rich-text-body><p>데이터</p></ac:rich-text-body></ac:structured-macro>"
    )
    out = storage_to_editor_html(xml, base_url=BASE, page_id="1")
    assert out["html"] == "<p>데이터</p>"
    assert any("fancy-chart" in w for w in out["warnings"])


def test_toc_macro_dropped():
    xml = '<ac:structured-macro ac:name="toc"/><p>본문</p>'
    out = storage_to_editor_html(xml, base_url=BASE, page_id="1")
    assert out["html"] == "<p>본문</p>"
    assert any("toc" in w for w in out["warnings"])


def test_plain_xhtml_passes_through():
    xml = "<h2>제목</h2><p>본문 <strong>강조</strong></p><table><tr><td>a</td></tr></table>"
    out = storage_to_editor_html(xml, base_url=BASE, page_id="1")
    assert out["html"] == xml
    assert out["warnings"] == []


def test_empty_input():
    assert storage_to_editor_html("", base_url=BASE, page_id="1")["html"] == ""


# ── Export (editor HTML → storage) ─────────────────────────────────────────────
def test_callout_becomes_info_macro():
    html = '<div data-callout="warning" class="callout"><p>주의</p></div>'
    out = editor_html_to_storage(html)
    assert out["storage"] == (
        '<ac:structured-macro ac:name="warning">'
        "<ac:rich-text-body><p>주의</p></ac:rich-text-body></ac:structured-macro>"
    )


def test_success_callout_maps_to_tip_macro():
    html = '<div data-callout="success" class="callout"><p>ok</p></div>'
    assert 'ac:name="tip"' in editor_html_to_storage(html)["storage"]


def test_toggle_becomes_expand_macro():
    html = (
        '<details open><summary contenteditable="false">더 보기</summary>'
        '<div class="toggle-body"><p>본문</p></div></details>'
    )
    out = editor_html_to_storage(html)["storage"]
    assert 'ac:name="expand"' in out
    assert '<ac:parameter ac:name="title">더 보기</ac:parameter>' in out
    assert "<ac:rich-text-body><p>본문</p></ac:rich-text-body>" in out


def test_pre_code_becomes_code_macro_with_cdata():
    html = "<pre><code>echo &lt;hi&gt;</code></pre>"
    out = editor_html_to_storage(html)["storage"]
    assert 'ac:name="code"' in out
    assert "<![CDATA[echo <hi>]]>" in out


def test_cdata_terminator_escaped():
    html = "<pre><code>a]]&gt;b</code></pre>"
    out = editor_html_to_storage(html)["storage"]
    # CDATA 종료 시퀀스가 본문에 있으면 분할 이스케이프돼야 XML 이 깨지지 않는다
    assert "]]]]><![CDATA[>" in out


def test_data_image_extracted_as_attachment():
    # 1x1 png (base64)
    b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    html = f'<p>x</p><img src="data:image/png;base64,{b64}" alt="pasted">'
    out = editor_html_to_storage(html)
    assert len(out["data_images"]) == 1
    img = out["data_images"][0]
    assert img["filename"] == "pep-image-1.png"
    assert img["mime"] == "image/png"
    assert isinstance(img["data"], bytes) and len(img["data"]) > 0
    assert '<ac:image><ri:attachment ri:filename="pep-image-1.png"/></ac:image>' in out["storage"]


def test_void_tags_self_closed_for_xhtml():
    out = editor_html_to_storage("<p>a<br>b</p><hr><img src=\"https://x/y.png\">")["storage"]
    assert "<br/>" in out
    assert "<hr/>" in out
    assert '<img src="https://x/y.png"/>' in out


def test_roundtrip_callout_and_toggle():
    """import → export 왕복 시 매크로 구조가 보존된다."""
    xml = (
        '<ac:structured-macro ac:name="note"><ac:rich-text-body><p>메모</p></ac:rich-text-body></ac:structured-macro>'
        '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">t</ac:parameter>'
        "<ac:rich-text-body><p>b</p></ac:rich-text-body></ac:structured-macro>"
    )
    html = storage_to_editor_html(xml, base_url=BASE, page_id="1")["html"]
    back = editor_html_to_storage(html)["storage"]
    assert 'ac:name="note"' in back
    assert 'ac:name="expand"' in back
    assert "<p>메모</p>" in back and "<p>b</p>" in back
