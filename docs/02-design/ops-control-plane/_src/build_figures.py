#!/usr/bin/env python3
"""운영 관리 평면 고도화 제안서 그림 생성기.

같은 도형 정의(좌표 · 글자 크기)에서 draw.io XML 과 SVG 를 동시에 만든다.
  - drawio/figN-M.drawio       그림별 원본
  - drawio/all-figures.drawio  통합본(페이지 = 그림)
  - drawio/gliffy/all-figures-gliffy.drawio  Gliffy 가져오기용(cube → 사각형)
  - figures/figN-M.svg         문서 삽입용(배경 투명)
그 뒤 검증한다: XML 파싱, 글자 폭(1.2배 여유 · 상자 폭 80%), 한 줄 15자, 2줄 상자 높이,
연결선과 도형 · 구역 제목 교차, 연결선 라벨과 도형 겹침.

사용: python3 build_figures.py   (이 파일 기준 상위 폴더에 산출)
PNG 목업은 rsvg-convert 로 만든다(build_previews 참고).
"""
from __future__ import annotations

import html
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent

FONT = "Noto Sans KR,Noto Sans CJK KR,Malgun Gothic,Apple SD Gothic Neo,sans-serif"
# 2색 + 무채색
C_MAIN = "#2F4A6D"      # 주색: 신규 · 핵심 도형 테두리
C_ACCENT = "#C2410C"    # 강조: 그림당 1곳
C_ACCENT_FILL = "#FFF4EC"
C_TEXT = "#1F2937"
C_SUB = "#4B5563"
C_GRAY = "#8A94A6"      # 기존(유지) 도형 테두리
C_ZONE = "#9AA3B2"
C_EDGE = "#5B6B82"
C_CUBE_FILL = "#EEF2F7"
C_BOX_FILL = "#FFFFFF"

HEAD_FS = 18
BODY_FS = 14
LABEL_FS = 12
ZONE_FS = 14
CUBE_D = 10             # cube 깊이


@dataclass
class Node:
    id: str
    x: float
    y: float
    w: float
    h: float
    head: str
    body: list[str] = field(default_factory=list)
    kind: str = "box"       # box | cube
    tone: str = "main"      # main | gray | accent

    @property
    def face(self) -> tuple[float, float, float, float]:
        if self.kind == "cube":
            return (self.x + CUBE_D, self.y + CUBE_D, self.w - CUBE_D, self.h - CUBE_D)
        return (self.x, self.y, self.w, self.h)


@dataclass
class Zone:
    id: str
    x: float
    y: float
    w: float
    h: float
    title: str
    tone: str = "gray"      # gray | accent

    @property
    def title_rect(self) -> tuple[float, float, float, float]:
        tw = text_width(self.title, ZONE_FS)
        return (self.x + 6, self.y + 4, tw + 12, ZONE_FS + 12)


@dataclass
class Edge:
    x1: float
    y1: float
    x2: float
    y2: float
    label: str = ""
    dashed: bool = False


@dataclass
class Figure:
    key: str
    name: str
    width: int
    height: int
    zones: list[Zone]
    nodes: list[Node]
    edges: list[Edge]


# ---------------------------------------------------------------- 글자 폭 추정
def char_w(ch: str, fs: float) -> float:
    o = ord(ch)
    if o >= 0x1100 and (0x1100 <= o <= 0x11FF or 0x2E80 <= o <= 0xD7AF or 0xF900 <= o <= 0xFAFF):
        return fs * 1.0
    if ch == " ":
        return fs * 0.3
    if ch in "·":
        return fs * 0.5
    if ch.isupper():
        return fs * 0.68
    return fs * 0.58


def text_width(s: str, fs: float) -> float:
    return sum(char_w(c, fs) for c in s)


# ---------------------------------------------------------------- 그림 정의
def fig1_1() -> Figure:
    z = [
        Zone("zA", 20, 40, 270, 450, "관리 대상 클러스터"),
        Zone("zB", 340, 40, 860, 450, "PEP 관리 평면"),
    ]
    n = [
        Node("c1", 40, 90, 230, 90, "클러스터 1", ["API · 지표"], "cube", "gray"),
        Node("c2", 40, 230, 230, 90, "클러스터 N", ["API · 지표"], "cube", "gray"),
        Node("col", 40, 370, 230, 90, "클러스터 수집기", ["점검 · 이벤트"], "box", "gray"),
        Node("ing", 370, 90, 170, 370, "수집", ["pull · push", "생존 신호"]),
        Node("cfg", 620, 90, 260, 90, "기준 설정 · 편차", ["계층 상속", "스냅샷 비교"], "box", "accent"),
        Node("hl", 620, 230, 260, 90, "상태 판정", ["컴포넌트 Health", "클러스터 롤업"]),
        Node("ev", 620, 370, 260, 90, "통합 이벤트", ["유지보수 모드", "알림 규칙"]),
        Node("api", 960, 90, 210, 370, "관리 API · 화면", ["인박스", "실행 로그"], "box", "gray"),
        Node("ch", 1260, 170, 190, 90, "알림 채널", ["Slack · Webhook", "Email"], "box", "gray"),
        Node("op", 1260, 330, 190, 90, "운영자", ["명시적 실행"], "box", "gray"),
    ]
    e = [
        Edge(270, 140, 370, 140, "pull"),
        Edge(270, 280, 370, 280, "pull"),
        Edge(270, 415, 370, 415, "push"),
        Edge(540, 135, 620, 135, "스냅샷"),
        Edge(540, 275, 620, 275, "지표 · 점검"),
        Edge(540, 415, 620, 415, "이벤트"),
        Edge(750, 180, 750, 230, "편차"),
        Edge(750, 320, 750, 370, "상태 변화"),
        Edge(880, 135, 960, 135),
        Edge(880, 275, 960, 275),
        Edge(880, 415, 960, 415),
        Edge(1170, 215, 1260, 215, "재전파"),
        Edge(1170, 375, 1260, 375, "확인 · 실행"),
    ]
    return Figure("fig3-1", "그림 3-1 전체 구조", 1470, 510, z, n, e)


def fig3_1() -> Figure:
    z = [Zone("zS", 20, 40, 1080, 160, "기준 설정 저장소")]
    xs = [40, 320, 600, 880, 1180]
    n = [
        Node("l1", xs[0], 90, 200, 90, "공통 기준", ["전 클러스터", "기본값"]),
        Node("l2", xs[1], 90, 200, 90, "클러스터 그룹", ["환경 · 테넌트"]),
        Node("l3", xs[2], 90, 200, 90, "클러스터", ["클러스터별 값"]),
        Node("l4", xs[3], 90, 200, 90, "노드 · 컴포넌트", ["예외 값"]),
        Node("eff", xs[4], 90, 190, 90, "유효 기준값", ["차이만 저장", "키 스키마 검증"], "box", "accent"),
    ]
    e = [
        Edge(240, 135, 320, 135, "덮어쓰기"),
        Edge(520, 135, 600, 135, "덮어쓰기"),
        Edge(800, 135, 880, 135, "덮어쓰기"),
        Edge(1080, 135, 1180, 135, "병합"),
    ]
    return Figure("fig4-1", "그림 4-1 기준 설정 계층", 1390, 220, z, n, e)


def fig3_2() -> Figure:
    xs = [40, 340, 640, 940]
    n = [
        Node("base", xs[0], 60, 200, 90, "유효 기준값", ["계층 병합 결과"]),
        Node("cmp", xs[1], 60, 200, 90, "비교", ["키 단위 대조"]),
        Node("st", xs[2], 60, 200, 90, "편차 상태", ["일치 · 편차", "재시작 필요"], "box", "accent"),
        Node("run", xs[3], 60, 200, 90, "운영자 실행", ["명시적 트리거", "실시간 로그"]),
        Node("snap", xs[1], 260, 200, 90, "최신 스냅샷", ["해시 변경 시 저장"], "box", "gray"),
        Node("ing", xs[2], 260, 200, 90, "수집", ["pull · push"], "box", "gray"),
        Node("k8s", xs[3], 260, 200, 90, "대상 클러스터", ["노드 · 컴포넌트"], "cube", "gray"),
    ]
    e = [
        Edge(240, 105, 340, 105, "기준"),
        Edge(540, 105, 640, 105, "판정"),
        Edge(840, 105, 940, 105, "알림 · 화면"),
        Edge(1040, 150, 1040, 260, "Ansible · 배치잡"),
        Edge(940, 310, 840, 310, "수집"),
        Edge(640, 305, 540, 305, "저장"),
        Edge(440, 260, 440, 150, "실제값"),
    ]
    return Figure("fig4-2", "그림 4-2 편차 판정과 조치", 1180, 370, [], n, e)


def fig4_1() -> Figure:
    bx = [40, 280, 520, 760]
    off = 150  # 연결선은 상자 왼쪽에서 150px 지점 — 구역 제목 회피
    z = [Zone("zC", 20, 170, 960, 140, "컴포넌트 Health", "accent")]
    n = [
        Node("cl", 40, 40, 920, 80, "클러스터 종합 상태", ["위험 > 경고 > 정상"]),
        Node("k1", bx[0], 215, 200, 80, "컨트롤 플레인", ["API · etcd"]),
        Node("k2", bx[1], 215, 200, 80, "네트워크", ["CNI · DNS"]),
        Node("k3", bx[2], 215, 200, 80, "스토리지", ["CSI · PV"]),
        Node("k4", bx[3], 215, 200, 80, "애드온", ["관측 · 수집기"]),
        Node("rule", 40, 360, 920, 80, "Health 규칙", ["임계값 · 지속 시간", "미확인 처리"]),
        Node("i1", bx[0], 490, 200, 80, "점검 매트릭스", ["심층 · 핵심 점검"], "box", "gray"),
        Node("i2", bx[1], 490, 200, 80, "애드온 점검", ["응답 · 상태"], "box", "gray"),
        Node("i3", bx[2], 490, 200, 80, "지표 임계값", ["지표 카탈로그"]),
        Node("i4", bx[3], 490, 200, 80, "수집 신선도", ["생존 신호"]),
    ]
    e = []
    for x in bx:
        e.append(Edge(x + off, 490, x + off, 440))
        e.append(Edge(x + off, 360, x + off, 295))
        e.append(Edge(x + off, 215, x + off, 120))
    return Figure("fig5-1", "그림 5-1 상태 판정 계층", 1000, 590, z, n, e)


def fig5_1() -> Figure:
    z = [Zone("zE", 20, 30, 250, 550, "이벤트 소스")]
    srcs = [
        ("외부 알람", "Alertmanager", "gray"),
        ("K8s 이벤트", "kubewatch", "gray"),
        ("설정 변경", "감사 로그", "gray"),
        ("상태 변화", "Health 판정", "main"),
        ("설정 편차", "기준 대비", "main"),
        ("수집 중단", "생존 신호", "main"),
    ]
    n = []
    e = []
    for i, (h, b, tone) in enumerate(srcs):
        y = 80 + i * 82
        n.append(Node(f"s{i}", 40, y, 200, 62, h, [b], "box", tone))
        e.append(Edge(240, y + 31, 340, y + 31))
    n += [
        Node("ev", 340, 80, 180, 472, "통합 이벤트", ["출처 · 심각도", "대상 · 시각"], "box", "accent"),
        Node("mm", 600, 271, 190, 90, "유지보수 모드", ["억제 시간창"]),
        Node("rule", 870, 271, 200, 90, "알림 규칙", ["우선순위 · 매처", "중복 억제"], "box", "gray"),
        Node("o1", 1150, 130, 190, 80, "인박스", ["이력 · 확인"], "box", "gray"),
        Node("o2", 1150, 276, 190, 80, "개인 알림", ["전체 · 담당자"], "box", "gray"),
        Node("o3", 1150, 422, 190, 80, "재전파 채널", ["Slack · Webhook"], "box", "gray"),
    ]
    e += [
        Edge(520, 316, 600, 316, "통과"),
        Edge(790, 316, 870, 316, "평가"),
        Edge(1070, 300, 1150, 185),
        Edge(1070, 316, 1150, 316),
        Edge(1070, 332, 1150, 447),
    ]
    return Figure("fig6-1", "그림 6-1 이벤트 · 알림 흐름", 1370, 600, z, n, e)


FIGURES = [fig1_1(), fig3_1(), fig3_2(), fig4_1(), fig5_1()]


# ---------------------------------------------------------------- 스타일
def tone_colors(tone: str, kind: str) -> tuple[str, str, float]:
    if tone == "accent":
        return C_ACCENT, C_ACCENT_FILL, 2.5
    if tone == "gray":
        return C_GRAY, C_CUBE_FILL if kind == "cube" else C_BOX_FILL, 1.2
    return C_MAIN, C_CUBE_FILL if kind == "cube" else C_BOX_FILL, 2.0


def node_value_html(nd: Node) -> str:
    """draw.io 값: 글자는 HTML 이스케이프, 속성 기록 시 XML 이스케이프(ElementTree) → 이중."""
    parts = [f'<b style="font-size:{HEAD_FS}px">{html.escape(nd.head)}</b>']
    if nd.body:
        body = "<br>".join(html.escape(b) for b in nd.body)
        parts.append(f'<span style="font-size:{BODY_FS}px">{body}</span>')
    return "<br>".join(parts)


# ---------------------------------------------------------------- draw.io
def drawio_diagram(fig: Figure, gliffy: bool = False) -> ET.Element:
    diagram = ET.Element("diagram", name=fig.name, id=fig.key)
    model = ET.SubElement(diagram, "mxGraphModel", dx="1200", dy="800", grid="1", gridSize="10",
                          guides="1", tooltips="1", connect="0", arrows="1", fold="1", page="1",
                          pageScale="1", pageWidth=str(fig.width), pageHeight=str(fig.height),
                          math="0", shadow="0", background="none")
    root = ET.SubElement(model, "root")
    ET.SubElement(root, "mxCell", id="0")
    ET.SubElement(root, "mxCell", id="1", parent="0")

    for zn in fig.zones:
        stroke = C_ACCENT if zn.tone == "accent" else C_ZONE
        style = (f"rounded=1;arcSize=3;dashed=1;dashPattern=6 4;fillColor=none;strokeColor={stroke};"
                 f"strokeWidth={2 if zn.tone == 'accent' else 1.2};html=1;whiteSpace=wrap;verticalAlign=top;"
                 f"align=left;spacingLeft=10;spacingTop=4;fontStyle=1;fontSize={ZONE_FS};"
                 f"fontColor={C_SUB};fontFamily={FONT};")
        c = ET.SubElement(root, "mxCell", id=f"{fig.key}-{zn.id}", value=html.escape(zn.title),
                          style=style, vertex="1", parent="1")
        ET.SubElement(c, "mxGeometry", x=str(zn.x), y=str(zn.y), width=str(zn.w), height=str(zn.h),
                      **{"as": "geometry"})

    for nd in fig.nodes:
        stroke, fill, sw = tone_colors(nd.tone, nd.kind)
        common = (f"html=1;whiteSpace=wrap;fillColor={fill};strokeColor={stroke};strokeWidth={sw};"
                  f"fontColor={C_TEXT};fontFamily={FONT};fontSize={BODY_FS};align=center;verticalAlign=middle;")
        if nd.kind == "cube" and not gliffy:
            style = f"shape=cube;size={CUBE_D};boundedLbl=1;backgroundOutline=1;darkOpacity=0.05;darkOpacity2=0.1;" + common
        elif nd.kind == "cube":
            style = "rounded=0;" + common   # Gliffy: cube 미지원 → 사각형
        else:
            style = "rounded=1;arcSize=10;" + common
        c = ET.SubElement(root, "mxCell", id=f"{fig.key}-{nd.id}", value=node_value_html(nd),
                          style=style, vertex="1", parent="1")
        ET.SubElement(c, "mxGeometry", x=str(nd.x), y=str(nd.y), width=str(nd.w), height=str(nd.h),
                      **{"as": "geometry"})

    for i, ed in enumerate(fig.edges):
        style = (f"endArrow=block;endFill=1;endSize=7;html=1;rounded=0;strokeColor={C_EDGE};strokeWidth=1.5;"
                 f"fontSize={LABEL_FS};fontColor={C_SUB};labelBackgroundColor=#FFFFFF;fontFamily={FONT};"
                 + ("dashed=1;" if ed.dashed else ""))
        # 도형에 붙이지 않음(source/target 없음) — 좌표 고정
        c = ET.SubElement(root, "mxCell", id=f"{fig.key}-e{i}", value=html.escape(ed.label),
                          style=style, edge="1", parent="1")
        g = ET.SubElement(c, "mxGeometry", relative="1", **{"as": "geometry"})
        ET.SubElement(g, "mxPoint", x=str(ed.x1), y=str(ed.y1), **{"as": "sourcePoint"})
        ET.SubElement(g, "mxPoint", x=str(ed.x2), y=str(ed.y2), **{"as": "targetPoint"})
    return diagram


def write_drawio(path: Path, figs: list[Figure], gliffy: bool = False) -> None:
    mx = ET.Element("mxfile", host="app.diagrams.net", agent="build_figures.py", version="24.0.0")
    for f in figs:
        mx.append(drawio_diagram(f, gliffy))
    ET.indent(mx)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(ET.tostring(mx, encoding="unicode"), encoding="utf-8")


# ---------------------------------------------------------------- SVG
def esc(s: str) -> str:
    return html.escape(s, quote=True)


def svg_figure(fig: Figure) -> str:
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{fig.width}" height="{fig.height}" '
         f'viewBox="0 0 {fig.width} {fig.height}" font-family="{esc(FONT)}">',
         '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
         f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{C_EDGE}"/></marker></defs>']
    for zn in fig.zones:
        stroke = C_ACCENT if zn.tone == "accent" else C_ZONE
        sw = 2 if zn.tone == "accent" else 1.2
        o.append(f'<rect x="{zn.x}" y="{zn.y}" width="{zn.w}" height="{zn.h}" rx="6" fill="none" '
                 f'stroke="{stroke}" stroke-width="{sw}" stroke-dasharray="6 4"/>')
        o.append(f'<text x="{zn.x + 10}" y="{zn.y + 4 + ZONE_FS + 2}" font-size="{ZONE_FS}" font-weight="700" '
                 f'fill="{C_SUB}">{esc(zn.title)}</text>')
    for nd in fig.nodes:
        stroke, fill, sw = tone_colors(nd.tone, nd.kind)
        if nd.kind == "cube":
            d = CUBE_D
            x, y, w, h = nd.x, nd.y, nd.w, nd.h
            o.append(f'<polygon points="{x},{y} {x + w - d},{y} {x + w},{y + d} {x + d},{y + d}" '
                     f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round"/>')
            o.append(f'<polygon points="{x},{y} {x + d},{y + d} {x + d},{y + h} {x},{y + h - d}" '
                     f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round"/>')
            o.append(f'<rect x="{x + d}" y="{y + d}" width="{w - d}" height="{h - d}" fill="{fill}" '
                     f'stroke="{stroke}" stroke-width="{sw}"/>')
        else:
            o.append(f'<rect x="{nd.x}" y="{nd.y}" width="{nd.w}" height="{nd.h}" rx="8" fill="{fill}" '
                     f'stroke="{stroke}" stroke-width="{sw}"/>')
        fx, fy, fw, fh = nd.face
        lines = [(nd.head, HEAD_FS, 700)] + [(b, BODY_FS, 400) for b in nd.body]
        lh = {HEAD_FS: 24, BODY_FS: 19}
        total = sum(lh[fs] for _, fs, _ in lines)
        cy = fy + (fh - total) / 2
        for txt, fs, wt in lines:
            base = cy + lh[fs] * 0.75
            o.append(f'<text x="{fx + fw / 2}" y="{base:.1f}" font-size="{fs}" font-weight="{wt}" '
                     f'text-anchor="middle" fill="{C_TEXT}">{esc(txt)}</text>')
            cy += lh[fs]
    for ed in fig.edges:
        dash = ' stroke-dasharray="6 4"' if ed.dashed else ""
        o.append(f'<line x1="{ed.x1}" y1="{ed.y1}" x2="{ed.x2}" y2="{ed.y2}" stroke="{C_EDGE}" '
                 f'stroke-width="1.5" marker-end="url(#arr)"{dash}/>')
        if ed.label:
            lx, ly, lw, lh2 = label_rect(ed)
            o.append(f'<rect x="{lx}" y="{ly}" width="{lw}" height="{lh2}" fill="#FFFFFF"/>')
            o.append(f'<text x="{lx + lw / 2}" y="{ly + lh2 / 2 + LABEL_FS * 0.36:.1f}" font-size="{LABEL_FS}" '
                     f'text-anchor="middle" fill="{C_SUB}">{esc(ed.label)}</text>')
    o.append("</svg>")
    return "\n".join(o)


def label_rect(ed: Edge) -> tuple[float, float, float, float]:
    mx, my = (ed.x1 + ed.x2) / 2, (ed.y1 + ed.y2) / 2
    w = text_width(ed.label, LABEL_FS) + 8
    h = LABEL_FS + 6
    return (mx - w / 2, my - h / 2, w, h)


# ---------------------------------------------------------------- 검증
def seg_hits_rect(x1, y1, x2, y2, r, pad=0.0) -> bool:
    rx, ry, rw, rh = r[0] - pad, r[1] - pad, r[2] + 2 * pad, r[3] + 2 * pad
    # Liang–Barsky
    dx, dy = x2 - x1, y2 - y1
    p = [-dx, dx, -dy, dy]
    q = [x1 - rx, rx + rw - x1, y1 - ry, ry + rh - y1]
    u1, u2 = 0.0, 1.0
    for pi, qi in zip(p, q):
        if pi == 0:
            if qi < 0:
                return False
        else:
            t = qi / pi
            if pi < 0:
                u1 = max(u1, t)
            else:
                u2 = min(u2, t)
    return u1 < u2 - 1e-6


def on_border(px, py, r, tol=1.5) -> bool:
    x, y, w, h = r
    inside = x - tol <= px <= x + w + tol and y - tol <= py <= y + h + tol
    near = (abs(px - x) <= tol or abs(px - x - w) <= tol or abs(py - y) <= tol or abs(py - y - h) <= tol)
    return inside and near


def rects_overlap(a, b) -> bool:
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def validate(fig: Figure) -> list[str]:
    errs: list[str] = []
    for nd in fig.nodes:
        fx, fy, fw, fh = nd.face
        for txt, fs in [(nd.head, HEAD_FS)] + [(b, BODY_FS) for b in nd.body]:
            if len(txt) > 15:
                errs.append(f"{fig.key}/{nd.id}: 한 줄 15자 초과 '{txt}'")
            est = text_width(txt, fs) * 1.2
            if est > fw * 0.8:
                errs.append(f"{fig.key}/{nd.id}: 글자 폭 {est:.0f} > 상자 80% {fw * 0.8:.0f} '{txt}'")
            if text_width(txt, fs) * 1.1 > fw:
                errs.append(f"{fig.key}/{nd.id}: 자간 10% 확대 시 넘침 '{txt}'")
        if 1 + len(nd.body) >= 2 and nd.h < 50:
            errs.append(f"{fig.key}/{nd.id}: 2줄 이상 상자 높이 {nd.h} < 50")
        if len(nd.body) > 2:
            errs.append(f"{fig.key}/{nd.id}: 본문 3줄 이상")
        need = 24 + 19 * len(nd.body) + 8
        if fh < need:
            errs.append(f"{fig.key}/{nd.id}: 높이 부족 {fh} < {need}")
    rects = {nd.id: (nd.x, nd.y, nd.w, nd.h) for nd in fig.nodes}
    for i, ed in enumerate(fig.edges):
        if ed.x1 != ed.x2 and ed.y1 != ed.y2:
            pass  # 사선 허용(꺾임 없는 직선)
        for nid, r in rects.items():
            if on_border(ed.x1, ed.y1, r) or on_border(ed.x2, ed.y2, r):
                continue
            if seg_hits_rect(ed.x1, ed.y1, ed.x2, ed.y2, r):
                errs.append(f"{fig.key}/e{i}: 연결선이 도형 {nid} 통과")
        for zn in fig.zones:
            if seg_hits_rect(ed.x1, ed.y1, ed.x2, ed.y2, zn.title_rect, pad=2):
                errs.append(f"{fig.key}/e{i}: 연결선이 구역 제목 '{zn.title}' 교차")
        if ed.label:
            lr = label_rect(ed)
            for nid, r in rects.items():
                if rects_overlap(lr, r):
                    errs.append(f"{fig.key}/e{i}: 라벨 '{ed.label}' 이 도형 {nid} 와 겹침")
        # 끝점이 도형 경계에 붙어 있는지(떠 있는 선 방지)
        for px, py, tag in [(ed.x1, ed.y1, "시작"), (ed.x2, ed.y2, "끝")]:
            if not any(on_border(px, py, r) for r in rects.values()):
                errs.append(f"{fig.key}/e{i}: {tag}점 ({px},{py}) 이 도형 경계에 없음")
    for zn in fig.zones:
        for nd in fig.nodes:
            if rects_overlap(zn.title_rect, (nd.x, nd.y, nd.w, nd.h)):
                errs.append(f"{fig.key}: 구역 제목 '{zn.title}' 이 도형 {nd.id} 와 겹침")
    accents = sum(1 for nd in fig.nodes if nd.tone == "accent") + sum(1 for zn in fig.zones if zn.tone == "accent")
    if accents != 1:
        errs.append(f"{fig.key}: 강조 {accents}곳 (1곳이어야 함)")
    return errs


# ---------------------------------------------------------------- 실행
def build_previews() -> None:
    prev = OUT / "preview"
    prev.mkdir(exist_ok=True)
    if not shutil.which("rsvg-convert"):
        print("rsvg-convert 없음 — PNG 목업 생략", file=sys.stderr)
        return
    for f in FIGURES:
        subprocess.run(["rsvg-convert", "-z", "1.5", "-b", "#FFFFFF", "-o", str(prev / f"{f.key}.png"),
                        str(OUT / "figures" / f"{f.key}.svg")], check=True)
    # 전체 목업 한 장
    try:
        from PIL import Image
    except ImportError:
        return
    imgs = [Image.open(prev / f"{f.key}.png") for f in FIGURES]
    gap = 40
    W = max(i.width for i in imgs) + 2 * gap
    H = sum(i.height for i in imgs) + gap * (len(imgs) + 1)
    sheet = Image.new("RGB", (W, H), "white")
    y = gap
    for im in imgs:
        sheet.paste(im, (gap, y))
        y += im.height + gap
    sheet.save(prev / "all-figures.png")


def main() -> int:
    errs: list[str] = []
    for f in FIGURES:
        errs += validate(f)
    (OUT / "figures").mkdir(exist_ok=True)
    for f in FIGURES:
        (OUT / "figures" / f"{f.key}.svg").write_text(svg_figure(f), encoding="utf-8")
        write_drawio(OUT / "drawio" / f"{f.key}.drawio", [f])
    write_drawio(OUT / "drawio" / "all-figures.drawio", FIGURES)
    write_drawio(OUT / "drawio" / "gliffy" / "all-figures-gliffy.drawio", FIGURES, gliffy=True)
    # XML 파싱 검증 + 값 이중 이스케이프 왕복 확인
    for p in sorted((OUT / "drawio").rglob("*.drawio")) + sorted((OUT / "figures").glob("*.svg")):
        try:
            tree = ET.parse(p)
        except ET.ParseError as ex:
            errs.append(f"{p.name}: XML 파싱 실패 {ex}")
            continue
    build_previews()
    if errs:
        print("검증 실패:")
        for e in errs:
            print("  -", e)
        return 1
    print(f"OK — 그림 {len(FIGURES)}개, 검증 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
