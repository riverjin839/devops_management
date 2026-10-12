"""data.json + 서술 데이터 + PEP 테마 토큰 → 단일 HTML 리포트.

사용: python3 -I scripts/report/build_ai_dev_report_html.py <repo_dir> <data_json> <out_html>
  - data_json: collect_ai_dev_metrics.py 의 출력 (git 집계, 자동)
  - ai_dev_report_narrative.json: 문구·진척도·세대 구간 (사람이 편집하는 판단 값)
  - ai_dev_report_template.html: 화면 템플릿
"""
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO, DATA, OUT = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
LABELS = {
    "umber-light": "움버 라이트", "light": "라이트 (슬레이트)", "dark": "다크", "comfort": "컴포트",
    "high-contrast": "고대비", "umber": "움버", "plaster": "플라스터", "journal": "저널 〈아침 식사〉",
    "relief": "릴리프", "harlequin": "할리퀸", "ozenfant": "오장팡", "whanki": "김환기 〈창〉",
    "picasso-girl": "피카소 〈소녀의 머리〉", "picasso-portrait": "피카소 〈소녀의 초상〉",
    "picasso-violin": "피카소 〈바이올린〉", "gris-guitar": "후안 그리스 〈기타〉",
}

css = (REPO / "frontend/src/index.css").read_text(encoding="utf-8")


def block(start):
    i = css.index("{", start) + 1
    depth, j = 1, i
    while depth:
        depth += {"{": 1, "}": -1}.get(css[j], 0)
        j += 1
    return css[i:j - 1]


root = re.search(r"^\s*:root\s*\{", css, re.M)
out = [":root {" + block(root.start()) + "}"]
themes, seen = [], set()
for m in re.finditer(r"^\s*html\.([a-z-]+)\s*\{", css, re.M):
    key = m.group(1)
    if key in seen:
        continue  # 두 번째 이후 정의(레이어 밖 부분 오버라이드)는 건너뛴다
    seen.add(key)
    body = block(m.start())
    if "--background" not in body:
        continue
    out.append(f'html[data-theme="{key}"] {{{body}}}')
    themes.append({"key": key, "label": LABELS.get(key, key)})
themes.sort(key=lambda t: (t["key"] != "umber-light", t["label"]))

def safe_json(path):
    return pathlib.Path(path).read_text(encoding="utf-8").strip().replace("</", "<\\/")

html = (HERE / "ai_dev_report_template.html").read_text(encoding="utf-8")
html = (html.replace("/*__THEMES__*/", "\n".join(out))
            .replace("/*__DATA__*/", safe_json(DATA))
            .replace("/*__NARRATIVE__*/", safe_json(HERE / "ai_dev_report_narrative.json"))
            .replace("/*__THEME_LIST__*/", json.dumps(themes, ensure_ascii=False)))
OUT.write_text(html, encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB, themes={len(themes)})")
