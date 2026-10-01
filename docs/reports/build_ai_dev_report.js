// PEP AI 개발 리포트 생성기 — `npm install pptxgenjs` 후 `node build_ai_dev_report.js out.pptx`
// 수치는 2026-10-01 기준 git log origin/main 집계값을 하드코딩했다.
const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
pres.title = "AI 페어 개발 리포트 — PEP";

// Umber light (umber-light) 테마 토큰 → hex — 크림 바탕 + 움버 패널 + 오커 단일 강조
const C = {
  bg: "F6F3EF", card: "FDFDFC", sec: "ECE7DF", border: "D8D1CA",
  fg: "281C1A", muted: "6E5D53", dim: "A49284",
  peri: "DA950B", periT: "885407", periBg: "FCF1CF", maroon: "231B1A",
  onDark: "EDE8DE", onDarkMuted: "B7ADA4", onDarkAcc: "FABF0F",
};
const KO = "Malgun Gothic";
const NUM = "Arial";
const W = 13.333;

function base(s) { s.background = { color: C.bg }; }
function title(s, kicker, text) {
  s.addText(kicker, { x: 0.6, y: 0.35, w: 9, h: 0.35, fontFace: KO, fontSize: 13, color: C.periT, bold: true, margin: 0, isTextBox: true });
  s.addText(text, { x: 0.6, y: 0.7, w: 12.1, h: 0.75, fontFace: KO, fontSize: 30, color: C.fg, bold: true, margin: 0, isTextBox: true });
}
function card(s, x, y, w, h, fill) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.08, fill: { color: fill || C.card }, line: { color: C.border, width: 0.75 } });
}
function foot(s, n, src) {
  s.addText(src || "출처: git log origin/main (2026-02-05 ~ 2026-10-01), 저장소 스냅샷", { x: 0.6, y: 7.0, w: 10.5, h: 0.3, fontFace: KO, fontSize: 10, color: C.dim, margin: 0, isTextBox: true });
  s.addText(String(n), { x: 12.2, y: 7.0, w: 0.55, h: 0.3, fontFace: NUM, fontSize: 10, color: C.dim, align: "right", margin: 0, isTextBox: true });
}
const axis = () => ({
  catAxisLabelColor: C.muted, valAxisLabelColor: C.muted, catAxisLabelFontFace: KO, valAxisLabelFontFace: NUM,
  catAxisLabelFontSize: 12, valAxisLabelFontSize: 11,
  valGridLine: { color: C.border, size: 0.5 }, catGridLine: { style: "none" },
  catAxisLineShow: false, valAxisLineShow: false,
  titleColor: C.fg, titleFontFace: KO, titleFontSize: 14,
  legendColor: C.muted, legendFontFace: KO, legendFontSize: 12,
  dataLabelColor: C.fg, dataLabelFontFace: NUM, dataLabelFontSize: 11,
});
const MONTHS = ["2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월"];

// ── 1. 표지 ─────────────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  s.addShape(pres.shapes.RECTANGLE, { x: 8.6, y: 0, w: W - 8.6, h: 7.5, fill: { color: C.maroon }, line: { color: C.maroon } });
  s.addText("팀 보고 · 2026-10", { x: 0.7, y: 0.8, w: 7, h: 0.4, fontFace: KO, fontSize: 14, color: C.periT, bold: true, margin: 0, isTextBox: true });
  s.addText("AI 와 함께 만든 8개월", { x: 0.7, y: 1.9, w: 7.8, h: 0.9, fontFace: KO, fontSize: 40, bold: true, color: C.fg, margin: 0, isTextBox: true });
  s.addText("PEP(Platform Engineering Portal) 개발 과정·결과 리포트", { x: 0.7, y: 2.85, w: 7.8, h: 0.6, fontFace: KO, fontSize: 20, color: C.muted, margin: 0, isTextBox: true });
  s.addText([
    { text: "개발 방식이 어떻게 바뀌었나", options: { bullet: true, breakLine: true } },
    { text: "어떻게 발전해 왔나 — 수치로", options: { bullet: true, breakLine: true } },
    { text: "상용화까지 얼마나 왔고, 무엇이 남았나", options: { bullet: true } },
  ], { x: 0.7, y: 3.9, w: 7.6, h: 1.5, fontFace: KO, fontSize: 17, color: C.fg, paraSpaceAfter: 8, margin: 0, isTextBox: true });
  s.addText("기간 2026-02-05 ~ 2026-10-01 · 데이터 기준 riverjin839/devops_management main", { x: 0.7, y: 6.6, w: 7.8, h: 0.35, fontFace: KO, fontSize: 11, color: C.dim, margin: 0, isTextBox: true });
  const st = [["1,988", "커밋"], ["750", "병합 PR"], ["82", "자동 릴리스"], ["96%", "AI 작성 커밋 비중"]];
  st.forEach(([v, l], i) => {
    const y = 0.9 + i * 1.5;
    s.addText(v, { x: 9.2, y, w: 3.6, h: 0.8, fontFace: NUM, fontSize: 44, bold: true, color: i === 3 ? C.onDarkAcc : C.onDark, margin: 0, isTextBox: true });
    s.addText(l, { x: 9.2, y: y + 0.8, w: 3.6, h: 0.4, fontFace: KO, fontSize: 14, color: C.onDarkMuted, margin: 0, isTextBox: true });
  });
  s.addNotes("표지. 8개월간 1인 + AI(Claude Code) 페어로 PEP 를 개발한 과정과 결과를 수치로 정리했다.");
}

// ── 2. 한 장 요약 ───────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "SUMMARY", "한 장 요약 — 구현은 AI, 사람은 의도·검증·하네스");
  const k = [
    ["222K", "코드 라인", "Python 102K + TS 121K\n2월 대비 16배"],
    ["1,097", "백엔드 테스트", "5월 31개 → 9월 1,097개\n35배"],
    ["5.4", "PR / 작업일", "750 PR ÷ 139 작업일\n하루 5건 병합"],
    ["67%", "상용화 진척도", "9개 영역 자체 평가\n근거는 11장"],
  ];
  k.forEach(([v, l, d], i) => {
    const x = 0.6 + i * 3.08;
    card(s, x, 1.75, 2.85, 2.55, i === 3 ? C.periBg : C.card);
    s.addText(v, { x: x + 0.3, y: 1.95, w: 2.4, h: 0.85, fontFace: NUM, fontSize: 40, bold: true, color: i === 3 ? C.periT : C.fg, margin: 0, isTextBox: true });
    s.addText(l, { x: x + 0.3, y: 2.85, w: 2.4, h: 0.4, fontFace: KO, fontSize: 16, bold: true, color: C.fg, margin: 0, isTextBox: true });
    s.addText(d, { x: x + 0.3, y: 3.3, w: 2.45, h: 0.85, fontFace: KO, fontSize: 13, color: C.muted, margin: 0, isTextBox: true });
  });
  card(s, 0.6, 4.6, 12.1, 2.2);
  s.addText([
    { text: "방식 변화  ", options: { bold: true, color: C.periT } }, { text: "커밋의 96%, PR 의 78% 를 AI 가 작성. 사람의 일은 코딩 → 요구사항·리뷰·규칙(하네스) 설계로 이동했다.", options: { breakLine: true } },
    { text: "발전 경로  ", options: { bold: true, color: C.periT } }, { text: "프롬프트 코딩 → 컨텍스트 문서화 → 스킬·자동 게이트 → 에이전트 운영의 4단계로 진화했다.", options: { breakLine: true } },
    { text: "상용화  ", options: { bold: true, color: C.periT } }, { text: "기능·배포·CI 는 상용 수준. SSO·프론트 테스트·관측성·i18n 이 남은 핵심 공백이다.", options: {} },
  ], { x: 0.9, y: 4.8, w: 11.5, h: 1.85, fontFace: KO, fontSize: 15, color: C.fg, paraSpaceAfter: 10, margin: 0, isTextBox: true, valign: "middle" });
  foot(s, 2);
}

// ── 3. 개발 방식 변화 (Before / After) ───────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "HOW WE WORK", "개발 방식은 어떻게 바뀌었나");
  const rows = [
    ["코드 작성", "사람이 직접 타이핑", "AI 가 구현, 사람은 의도·수용 기준 제시"],
    ["컨텍스트 전달", "매번 설명 (휘발)", "CLAUDE.md·CODE_MAP·SCREENS 로 저장소에 고정"],
    ["반복 작업", "사람의 기억·체크리스트", "스킬 8종 (페이지·체커·릴리스·문서 동기화)"],
    ["품질 확인", "수동 확인", "lint 0경고·tsc·build·pytest·docs-sync 게이트"],
    ["릴리스", "수동 버전·태그", "PR 병합 → SemVer·CHANGELOG·태그 자동"],
    ["디자인 검토", "화면 보며 감(感)", "UX 에이전트 감사 → DESIGN.md 백로그 101건"],
  ];
  const hy = 1.75;
  s.addText("영역", { x: 0.6, y: hy, w: 2.4, h: 0.45, fontFace: KO, fontSize: 14, bold: true, color: C.muted, margin: 0, isTextBox: true });
  s.addText("BEFORE", { x: 3.1, y: hy, w: 3.9, h: 0.45, fontFace: NUM, fontSize: 14, bold: true, color: C.muted, margin: 0, isTextBox: true });
  s.addText("AFTER (AI 페어)", { x: 7.5, y: hy, w: 5.2, h: 0.45, fontFace: KO, fontSize: 14, bold: true, color: C.periT, margin: 0, isTextBox: true });
  rows.forEach(([a, b, c], i) => {
    const y = 2.3 + i * 0.75;
    card(s, 0.6, y, 12.1, 0.62);
    s.addText(a, { x: 0.85, y, w: 2.2, h: 0.62, fontFace: KO, fontSize: 15, bold: true, color: C.fg, valign: "middle", margin: 0, isTextBox: true });
    s.addText(b, { x: 3.1, y, w: 3.9, h: 0.62, fontFace: KO, fontSize: 14, color: C.muted, valign: "middle", margin: 0, isTextBox: true });
    s.addShape(pres.shapes.RIGHT_ARROW, { x: 6.85, y: y + 0.19, w: 0.45, h: 0.24, fill: { color: C.peri }, line: { color: C.peri } });
    s.addText(c, { x: 7.5, y, w: 5.1, h: 0.62, fontFace: KO, fontSize: 14, color: C.fg, valign: "middle", margin: 0, isTextBox: true });
  });
  foot(s, 3, "출처: 저장소 내 CLAUDE.md · .claude/skills · .github/workflows · DESIGN.md");
}

// ── 4. 하네스 진화 타임라인 ─────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "TIMELINE", "AI 를 잘 쓰기 위한 '하네스'가 쌓여 온 과정");
  const ev = [
    ["02-05", "첫 AI 커밋·PR #1", false],
    ["02-24", "CLAUDE.md 도입", true],
    ["04-21", "CODE_MAP.md", false],
    ["05-04", "DESIGN_SYSTEM.md", false],
    ["06-03", "스킬 + CHANGELOG", true],
    ["07-09", "자동 릴리스", true],
    ["07-17", "docs-sync CI·shadcn MCP", false],
    ["07-19", "UX 에이전트·DESIGN.md", true],
  ];
  const y0 = 3.55, x0 = 1.5, x1 = 11.8;
  s.addShape(pres.shapes.LINE, { x: x0, y: y0, w: x1 - x0, h: 0, line: { color: C.border, width: 4 } });
  const step = (x1 - x0) / (ev.length - 1);
  ev.forEach(([d, t, key], i) => {
    const x = x0 + i * step;
    s.addShape(pres.shapes.OVAL, { x: x - 0.14, y: y0 - 0.14, w: 0.28, h: 0.28, fill: { color: key ? C.peri : C.muted }, line: { color: C.bg, width: 2 } });
    const up = i % 2 === 0;
    s.addText(d, { x: x - 0.8, y: up ? 2.0 : 3.95, w: 1.6, h: 0.4, fontFace: NUM, fontSize: 15, bold: true, color: key ? C.periT : C.fg, align: "center", margin: 0, isTextBox: true });
    s.addText(t, { x: x - 0.85, y: up ? 2.4 : 4.35, w: 1.7, h: 0.8, fontFace: KO, fontSize: 13, color: C.muted, align: "center", valign: "top", margin: 0, isTextBox: true });
  });
  card(s, 0.6, 5.45, 12.1, 1.3, C.periBg);
  s.addText([
    { text: "핵심 관찰  ", options: { bold: true, color: C.periT } },
    { text: "모델이 아니라 '저장소에 남긴 규칙'이 생산성을 바꿨다. CLAUDE.md 이후 같은 지시를 반복할 필요가 사라졌고, 스킬·게이트 도입(6~7월)과 함께 월 PR 이 99 → 183 건으로 1.8배가 됐다.", options: {} },
  ], { x: 0.9, y: 5.55, w: 11.5, h: 1.1, fontFace: KO, fontSize: 15, color: C.fg, valign: "middle", margin: 0, isTextBox: true });
  foot(s, 4, "출처: 각 파일의 최초 추가 커밋 일자 (git log --diff-filter=A)");
}

// ── 5. AI 기여도 ────────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "AI SHARE", "작성 주체 — 커밋의 96% 를 AI 가 작성");
  const ai = [67, 49, 80, 173, 216, 250, 85, 92];
  const hu = [6, 4, 19, 11, 2, 1, 1, 0];
  card(s, 0.6, 1.7, 8.3, 5.1);
  s.addChart(pres.charts.BAR, [
    { name: "AI (Claude)", labels: MONTHS, values: ai },
    { name: "사람", labels: MONTHS, values: hu },
  ], { x: 0.8, y: 1.85, w: 7.9, h: 4.85, barDir: "col", barGrouping: "stacked", chartColors: [C.peri, C.dim],
    showTitle: true, title: "월별 커밋 수 (병합·봇 커밋 제외)", showLegend: true, legendPos: "t",
    showValue: false, barGapWidthPct: 45, ...axis() });
  const side = [["1,012 / 1,056", "AI 작성 커밋 (96%)"], ["586 / 750", "AI 브랜치 PR (78%)"], ["5월", "로컬 Claude Code CLI 전환\n개인 계정 커밋도 91% AI 작성"]];
  side.forEach(([v, l], i) => {
    const y = 1.7 + i * 1.75;
    card(s, 9.2, y, 3.5, 1.55, i === 0 ? C.periBg : C.card);
    s.addText(v, { x: 9.45, y: y + 0.15, w: 3.1, h: 0.6, fontFace: NUM, fontSize: 26, bold: true, color: i === 0 ? C.periT : C.fg, margin: 0, isTextBox: true });
    s.addText(l, { x: 9.45, y: y + 0.75, w: 3.1, h: 0.7, fontFace: KO, fontSize: 13, color: C.muted, margin: 0, isTextBox: true });
  });
  foot(s, 5, "AI = 작성자 Claude 또는 Co-Authored-By: Claude 트레일러 · github-actions 봇 171건 제외");
}

// ── 6. 처리량 ──────────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "THROUGHPUT", "처리량 — 7월 정점 183 PR, 이후 안정화 구간");
  const prs = [53, 54, 68, 99, 116, 183, 87, 90];
  const days = [13, 13, 13, 20, 21, 24, 13, 22];
  card(s, 0.6, 1.7, 7.6, 5.1);
  s.addChart(pres.charts.BAR, [{ name: "병합 PR", labels: MONTHS, values: prs }], {
    x: 0.8, y: 1.85, w: 7.2, h: 4.85, barDir: "col", chartColors: [C.dim, C.dim, C.dim, C.dim, C.dim, C.peri, C.dim, C.dim],
    showTitle: true, title: "월별 병합 PR", showLegend: false, showValue: true, dataLabelPosition: "outEnd", barGapWidthPct: 45, ...axis() });
  card(s, 8.5, 1.7, 4.2, 5.1);
  const ppd = prs.map((p, i) => +(p / days[i]).toFixed(1));
  s.addChart(pres.charts.LINE, [{ name: "PR / 작업일", labels: MONTHS, values: ppd }], {
    x: 8.65, y: 1.85, w: 3.9, h: 3.2, chartColors: [C.peri], lineSize: 3, lineDataSymbol: "circle", lineDataSymbolSize: 7,
    showTitle: true, title: "작업일당 PR", showLegend: false, showValue: true, dataLabelPosition: "t", dataLabelFormatCode: "0.0", ...axis(), catAxisLabelFontSize: 10 });
  s.addText([
    { text: "4.1 → 7.6", options: { bold: true, color: C.periT, fontSize: 22, breakLine: true } },
    { text: "2월 대비 7월 작업일당 PR 1.9배. 8월은 신규 기능 대신 버그·품질 정비에 집중한 구간이다.", options: { fontSize: 13, color: C.muted } },
  ], { x: 8.8, y: 5.1, w: 3.7, h: 1.6, fontFace: KO, margin: 0, isTextBox: true, valign: "top" });
  foot(s, 6, "출처: 'Merge pull request' 병합만 집계(브랜치 동기화 병합 95건 제외), 작업일 = 커밋 1건 이상인 날");
}

// ── 7. 코드베이스 성장 ──────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "GROWTH", "결과물 — 코드 16배, 화면 9배, API 6배");
  const py = [5.6, 7.9, 20.2, 31.0, 44.0, 75.8, 82.4, 101.7];
  const ts = [8.3, 18.9, 40.9, 59.4, 77.0, 104.5, 110.1, 121.0];
  card(s, 0.6, 1.7, 7.6, 5.1);
  s.addChart(pres.charts.LINE, [
    { name: "Frontend TS/TSX", labels: MONTHS, values: ts },
    { name: "Backend Python", labels: MONTHS, values: py },
  ], { x: 0.8, y: 1.85, w: 7.2, h: 4.85, chartColors: [C.peri, C.muted], lineSize: 3, lineDataSymbol: "circle", lineDataSymbolSize: 6,
    showTitle: true, title: "월말 코드 라인 (천 줄)", showLegend: true, legendPos: "t", ...axis() });
  const g = [["라우터 (API)", "12", "76"], ["화면 (pages)", "8", "72"], ["DB 모델", "9", "60"], ["문서 (.md)", "5", "160"]];
  card(s, 8.5, 1.7, 4.2, 5.1);
  s.addText("2월 말 → 9월 말", { x: 8.8, y: 1.9, w: 3.7, h: 0.4, fontFace: KO, fontSize: 14, bold: true, color: C.muted, margin: 0, isTextBox: true });
  g.forEach(([l, a, b], i) => {
    const y = 2.5 + i * 1.05;
    s.addText(l, { x: 8.8, y, w: 3.7, h: 0.35, fontFace: KO, fontSize: 14, color: C.fg, margin: 0, isTextBox: true });
    s.addText([
      { text: a, options: { color: C.muted } }, { text: "  →  ", options: { color: C.dim } }, { text: b, options: { color: C.periT, bold: true } },
    ], { x: 8.8, y: y + 0.35, w: 3.7, h: 0.55, fontFace: NUM, fontSize: 24, margin: 0, isTextBox: true });
  });
  foot(s, 7, "출처: 월말 커밋 스냅샷 기준 파일·라인 집계 (git ls-tree / cat-file)");
}

// ── 8. 모델 세대별 기능 구현 성장 ──────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "MODEL EVOLUTION", "모델 세대가 바뀔 때마다 기능 구현 규모가 커졌다");
  // 세대 구분 = 병합 PR 안 커밋의 Co-Authored-By 모델 다수결. 2~4월은 모델 표기 없음(초기).
  const gens = ["초기 (2~4월)", "4.x (5~6월)", "5 (7~8월)", "5.x (9월)"];
  card(s, 0.6, 1.7, 7.6, 5.1);
  s.addChart(pres.charts.BAR, [
    { name: "월 기능 PR", labels: gens, values: [100, 204, 150, 93] },
    { name: "월 코드 증가량", labels: gens, values: [100, 148, 176, 148] },
    { name: "PR당 변경 파일", labels: gens, values: [100, 140, 140, 200] },
  ], { x: 0.8, y: 1.85, w: 7.2, h: 4.85, barDir: "col", barGrouping: "clustered", chartColors: [C.dim, C.muted, C.peri],
    showTitle: true, title: "세대별 성장 지수 (초기 = 100)", showLegend: true, legendPos: "t",
    showValue: true, dataLabelPosition: "outEnd", dataLabelFontSize: 10, barGapWidthPct: 35, valAxisMinVal: 0, valAxisMaxVal: 250, ...axis() });
  const rows = [
    ["4.x", "Opus 4.7 (1M) · Opus 4.8", "월 기능 PR 35 → 72건 (2.0배)"],
    ["5", "Sonnet 5 · Opus 5 · Fable 5", "월 코드 +20K → +36K줄 (1.8배)"],
    ["5.x", "Opus 5.5 · Fable 5.1 · Sonnet 5.5", "PR당 변경 파일 5 → 10개 (2.0배)"],
  ];
  card(s, 8.5, 1.7, 4.2, 5.1);
  s.addText("세대별 주력 모델과 대표 성장", { x: 8.75, y: 1.85, w: 3.8, h: 0.4, fontFace: KO, fontSize: 15, bold: true, color: C.fg, margin: 0, isTextBox: true });
  rows.forEach(([g, m, v], i) => {
    const y = 2.4 + i * 1.12;
    s.addText(g, { x: 8.75, y, w: 0.75, h: 0.4, fontFace: NUM, fontSize: 18, bold: true, color: C.periT, margin: 0, isTextBox: true });
    s.addText(m, { x: 9.5, y: y + 0.03, w: 3.1, h: 0.4, fontFace: NUM, fontSize: 11.5, color: C.muted, margin: 0, isTextBox: true });
    s.addText(v, { x: 8.75, y: y + 0.45, w: 3.85, h: 0.45, fontFace: KO, fontSize: 14, bold: true, color: C.fg, margin: 0, isTextBox: true });
  });
  s.addText("8~9월 기능 PR 감소는 성능 저하가 아니라 안정화 집중(테스트 540 → 1,097)의 결과다.", { x: 8.75, y: 5.75, w: 3.85, h: 0.9, fontFace: KO, fontSize: 12, color: C.muted, margin: 0, isTextBox: true, valign: "top" });
  foot(s, 8, "기준: main 병합 PR 745건 중 모델 표기(Co-Authored-By) PR 295건 + 초기 173건 · 세대 구간은 일부 겹침 · 파일 = 중앙값");
}

// ── 9. 품질 체계 ───────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "QUALITY", "품질 — 7월 버그 급증을 테스트·게이트로 되잡았다");
  card(s, 0.6, 1.7, 6.0, 5.1);
  s.addChart(pres.charts.BAR, [{ name: "테스트 함수", labels: ["5월", "6월", "7월", "8월", "9월"], values: [31, 57, 540, 730, 1097] }], {
    x: 0.8, y: 1.85, w: 5.6, h: 4.85, barDir: "col", chartColors: [C.peri], showTitle: true, title: "백엔드 테스트 함수 수 (월말)",
    showLegend: false, showValue: true, dataLabelPosition: "outEnd", barGapWidthPct: 45, ...axis() });
  card(s, 6.9, 1.7, 5.8, 5.1);
  const feat = [34, 33, 61, 105, 119, 105, 26, 44];
  const fix = [36, 17, 22, 43, 55, 104, 41, 29];
  s.addChart(pres.charts.BAR, [
    { name: "feat", labels: MONTHS, values: feat },
    { name: "fix", labels: MONTHS, values: fix },
  ], { x: 7.05, y: 1.85, w: 5.5, h: 3.5, barDir: "col", barGrouping: "clustered", chartColors: [C.peri, C.dim],
    showTitle: true, title: "월별 feat vs fix 커밋", showLegend: true, legendPos: "t", barGapWidthPct: 40, ...axis(), catAxisLabelFontSize: 10 });
  s.addText([
    { text: "7월 fix 비율 50%", options: { bold: true, color: C.periT, breakLine: true } },
    { text: "→ 테스트 10배·docs-sync CI·자동 릴리스 도입 → 9월 40% 로 회복, 릴리스 82회 중 revert·hotfix 4건", options: { color: C.muted, fontSize: 13 } },
  ], { x: 7.2, y: 5.4, w: 5.3, h: 1.3, fontFace: KO, fontSize: 16, margin: 0, isTextBox: true, valign: "top" });
  foot(s, 9, "출처: backend/tests 의 def test_ 집계, Conventional Commits prefix 집계");
}

// ── 10. 성숙도 4단계 ────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "MATURITY", "AI 활용 성숙도 — 4단계로 진화");
  const st = [
    ["1", "프롬프트 코딩", "2~3월", "대화로 기능 단위 구현\nCLAUDE.md 첫 도입", "PR 54건/월"],
    ["2", "컨텍스트 문서화", "4~5월", "CODE_MAP·디자인 시스템\n문서로 저장소 지도 제공", "PR 84건/월"],
    ["3", "스킬·자동 게이트", "6~7월", "스킬 8종, docs-sync CI,\n자동 릴리스·CHANGELOG", "PR 150건/월"],
    ["4", "에이전트 운영", "8~9월", "UX 감사 에이전트, 테스트\n1,097개, 안정화 우선", "테스트 2배"],
  ];
  st.forEach(([n, t, p, d, m], i) => {
    const x = 0.6 + i * 3.1, cur = i === 3;
    card(s, x, 1.8, 2.8, 4.3, cur ? C.periBg : C.card);
    s.addShape(pres.shapes.OVAL, { x: x + 0.3, y: 2.05, w: 0.7, h: 0.7, fill: { color: cur ? C.peri : C.sec }, line: { color: cur ? C.peri : C.border } });
    s.addText(n, { x: x + 0.3, y: 2.05, w: 0.7, h: 0.7, fontFace: NUM, fontSize: 22, bold: true, color: C.fg, align: "center", valign: "middle", margin: 0, isTextBox: true });
    s.addText(t, { x: x + 0.3, y: 3.0, w: 2.35, h: 0.5, fontFace: KO, fontSize: 18, bold: true, color: C.fg, margin: 0, isTextBox: true });
    s.addText(p, { x: x + 0.3, y: 3.5, w: 2.35, h: 0.35, fontFace: KO, fontSize: 13, color: cur ? C.periT : C.muted, margin: 0, isTextBox: true });
    s.addText(d, { x: x + 0.3, y: 4.0, w: 2.4, h: 1.2, fontFace: KO, fontSize: 13, color: C.muted, margin: 0, isTextBox: true, valign: "top" });
    s.addText(m, { x: x + 0.3, y: 5.25, w: 2.35, h: 0.6, fontFace: KO, fontSize: 17, bold: true, color: cur ? C.periT : C.fg, margin: 0, isTextBox: true });
    if (i < 3) s.addShape(pres.shapes.RIGHT_ARROW, { x: x + 2.83, y: 4.05, w: 0.24, h: 0.3, fill: { color: C.peri }, line: { color: C.peri } });
  });
  foot(s, 10, "PR/월 = 해당 구간 월평균 병합 PR · 현재 위치 = 4단계");
}

// ── 11. 상용화 진척도 ──────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "READINESS", "상용화까지 얼마나 왔나 — 종합 67%");
  const items = [
    ["기능 커버리지", 90], ["CI/CD·릴리스", 90], ["배포 형태", 85], ["운영 문서", 85],
    ["백엔드 테스트", 70], ["UX 완성도", 70], ["보안·인증", 55], ["관측·성능", 30], ["프론트 테스트", 20],
  ];
  card(s, 0.6, 1.7, 6.7, 5.1);
  s.addChart(pres.charts.BAR, [{ name: "진척도", labels: items.map(i => i[0]).reverse(), values: items.map(i => i[1]).reverse() }], {
    x: 0.75, y: 1.8, w: 6.4, h: 4.9, barDir: "bar", chartColors: items.map(i => (i[1] >= 70 ? C.peri : C.dim)).reverse(),
    showTitle: true, title: "영역별 진척도 (%)", showLegend: false, showValue: true, dataLabelPosition: "outEnd",
    valAxisMaxVal: 100, valAxisMinVal: 0, valAxisMajorUnit: 25, barGapWidthPct: 35, ...axis(), catAxisLabelFontSize: 12 });
  const ev = [
    ["기능·CI·배포", "라우터 76 · 화면 72 · 모델 60, CI 게이트 3종, Helm/Kustomize 4 overlay + 폐쇄망"],
    ["테스트", "백엔드 1,097개 (커버리지 미측정), 프론트 단위·E2E 0건"],
    ["보안", "JWT + viewer/operator/admin + 테넌트 격리 + 감사 로그 / SSO·refresh 토큰 없음"],
    ["UX", "UX 백로그 101건 중 83건 완료(82%) / i18n·반응형 미대응"],
    ["관측", "앱 자체 메트릭 exporter 0, 부하 테스트 0"],
  ];
  card(s, 7.6, 1.7, 5.1, 5.1);
  s.addText("평가 근거", { x: 7.85, y: 1.85, w: 4.6, h: 0.4, fontFace: KO, fontSize: 15, bold: true, color: C.fg, margin: 0, isTextBox: true });
  s.addText(ev.flatMap(([h, d], i) => [
    { text: h, options: { bold: true, color: C.periT, breakLine: true } },
    { text: d, options: { color: C.muted, breakLine: i < ev.length - 1 } },
  ]), { x: 7.85, y: 2.3, w: 4.65, h: 4.35, fontFace: KO, fontSize: 12.5, paraSpaceAfter: 5, margin: 0, isTextBox: true, valign: "top" });
  foot(s, 11, "자체 평가: 9개 영역 동일 가중 평균 · 70% 이상 = 상용 기준 충족(강조색)");
}

// ── 12. 남은 과제 ──────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "NEXT", "남은 과제 — 상용 전환을 막는 5가지");
  const t = [
    ["P0", "SSO·세션", "OIDC/LDAP 로그인, refresh 토큰, 만료 안내·returnTo (R-7)", "보안 55 → 80"],
    ["P0", "프론트 테스트", "Vitest 핵심 훅·컴포넌트 + Playwright 주요 동선 E2E", "20 → 60"],
    ["P1", "관측·성능", "/metrics exporter, SLO 정의, 대형 클러스터 부하 테스트", "30 → 70"],
    ["P1", "국제화·반응형", "react-i18next ko/en (R-6), 태블릿 최소 폭 대응", "UX 70 → 85"],
    ["P2", "UX 백로그", "미처리 13건 + 부분완료 3건 소진, 토큰 정합(raw hex 104건)", "82% → 100%"],
  ];
  const hy = 1.75;
  [["우선", 0.6, 0.9], ["과제", 1.6, 2.3], ["내용", 4.0, 6.0], ["목표 지표", 10.2, 2.5]].forEach(([h, x, w]) =>
    s.addText(h, { x: x + 0.2, y: hy, w, h: 0.4, fontFace: KO, fontSize: 13, bold: true, color: C.muted, margin: 0, isTextBox: true }));
  t.forEach(([p, a, b, c], i) => {
    const y = 2.2 + i * 0.84, top = p === "P0";
    card(s, 0.6, y, 12.1, 0.7, top ? C.periBg : C.card);
    s.addText(p, { x: 0.8, y, w: 0.8, h: 0.7, fontFace: NUM, fontSize: 16, bold: true, color: top ? C.periT : C.muted, valign: "middle", margin: 0, isTextBox: true });
    s.addText(a, { x: 1.8, y, w: 2.2, h: 0.7, fontFace: KO, fontSize: 16, bold: true, color: C.fg, valign: "middle", margin: 0, isTextBox: true });
    s.addText(b, { x: 4.2, y, w: 5.9, h: 0.7, fontFace: KO, fontSize: 13.5, color: C.muted, valign: "middle", margin: 0, isTextBox: true });
    s.addText(c, { x: 10.4, y, w: 2.2, h: 0.7, fontFace: KO, fontSize: 15, bold: true, color: top ? C.periT : C.fg, valign: "middle", margin: 0, isTextBox: true });
  });
  s.addText("목표 지표를 모두 달성하면 종합 진척도 67% → 약 80% (상용 베타 수준)", { x: 0.6, y: 6.45, w: 12.1, h: 0.35, fontFace: KO, fontSize: 13, color: C.periT, margin: 0, isTextBox: true });
  foot(s, 12, "출처: DESIGN.md 로드맵 R-6·R-7, 백로그 D-069~D-085, 저장소 grep 결과");
}

// ── 13. 복기 — 실제 vs 다시 한다면 ───────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "RETROSPECTIVE", "과거로 돌아간다면 — 무엇을 다르게 했어야 했나");
  const rows = [
    ["하네스", "CLAUDE.md 19일 차, CODE_MAP 75일 차, 스킬 118일 차에 도입", "스킬 전 4개월은 같은 설명을 반복", "1주 차에 하네스 골격(CLAUDE.md·스킬)"],
    ["테스트", "5월 말 코드 9만 줄에 테스트 31개", "7월 fix 104건, fix 비율 50%", "PR 마다 테스트 동반을 CI 게이트로 강제"],
    ["디자인 시스템", "화면 34개를 만든 뒤 5월에 도입", "UX 백로그 101건, raw hex 104건 잔존", "화면 5개 시점에 토큰·카드 규격 확정"],
    ["비기능 요건", "SSO·i18n·관측·프론트 테스트를 후순위로", "상용화 67%, 남은 공백이 전부 비기능", "1개월 차에 인증·관측·i18n 뼈대 선행"],
    ["측정 규칙", "모델 표기 PR 40%, 동기화 병합 95건", "모델·하네스 효과를 정밀 비교 불가", "커밋 트레일러·세션 링크·병합 규칙 첫날 고정"],
  ];
  const hy = 1.7;
  [["영역", 0.6, 1.9], ["실제로 한 것", 2.55, 3.6], ["치른 대가 (지표)", 6.25, 3.0], ["다시 한다면", 9.35, 3.3]].forEach(([h, x, w], i) =>
    s.addText(h, { x: x + 0.2, y: hy, w, h: 0.4, fontFace: KO, fontSize: 13, bold: true, color: i === 3 ? C.periT : C.muted, margin: 0, isTextBox: true }));
  rows.forEach(([a, b, c, d], i) => {
    const y = 2.15 + i * 0.92;
    card(s, 0.6, y, 12.1, 0.8);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 9.45, y: y + 0.08, w: 3.15, h: 0.64, rectRadius: 0.06, fill: { color: C.periBg }, line: { color: C.periBg } });
    s.addText(a, { x: 0.8, y, w: 1.75, h: 0.8, fontFace: KO, fontSize: 15, bold: true, color: C.fg, valign: "middle", margin: 0, isTextBox: true });
    s.addText(b, { x: 2.75, y, w: 3.45, h: 0.8, fontFace: KO, fontSize: 12.5, color: C.muted, valign: "middle", margin: 0, isTextBox: true });
    s.addText(c, { x: 6.45, y, w: 2.85, h: 0.8, fontFace: KO, fontSize: 12.5, bold: true, color: C.fg, valign: "middle", margin: 0, isTextBox: true });
    s.addText(d, { x: 9.6, y, w: 2.95, h: 0.8, fontFace: KO, fontSize: 12.5, bold: true, color: C.periT, valign: "middle", margin: 0, isTextBox: true });
  });
  foot(s, 13, "일차 = 첫 커밋(2026-02-05) 기준 · 지표 출처는 각 장(5·6·8·9·11장)과 동일");
}

// ── 14. 복기 — 다시 짠다면의 순서 ───────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "IF WE STARTED OVER", "다시 짠다면 — 기능보다 '틀'을 먼저 깐다");
  const ph = [
    ["1주 차", "하네스", "CLAUDE.md · CODE_MAP\n스킬 템플릿\n커밋·병합 규칙"],
    ["1개월", "품질 게이트", "PR 테스트 동반 강제\ndocs-sync · 자동 릴리스\n디자인 토큰 확정"],
    ["2~3개월", "상용 뼈대", "SSO·세션 · i18n 키\n/metrics · E2E 스모크\n권한 UX 규칙"],
    ["4개월~", "기능 확장", "도메인 기능 병렬 개발\nUX·보안 감사 에이전트\n모델별 작업 라우팅"],
  ];
  ph.forEach(([w, t, d], i) => {
    const x = 0.6 + i * 3.1, last = i === 3;
    card(s, x, 1.75, 2.8, 3.0, i === 0 ? C.periBg : C.card);
    s.addText(w, { x: x + 0.3, y: 1.95, w: 2.3, h: 0.4, fontFace: KO, fontSize: 14, bold: true, color: C.periT, margin: 0, isTextBox: true });
    s.addText(t, { x: x + 0.3, y: 2.4, w: 2.3, h: 0.5, fontFace: KO, fontSize: 20, bold: true, color: C.fg, margin: 0, isTextBox: true });
    s.addText(d, { x: x + 0.3, y: 3.05, w: 2.4, h: 1.5, fontFace: KO, fontSize: 13, color: C.muted, margin: 0, isTextBox: true, valign: "top", paraSpaceAfter: 4 });
    if (!last) s.addShape(pres.shapes.RIGHT_ARROW, { x: x + 2.83, y: 3.07, w: 0.24, h: 0.3, fill: { color: C.peri }, line: { color: C.peri } });
  });
  card(s, 0.6, 5.0, 5.95, 1.75);
  s.addText([
    { text: "실제 순서", options: { bold: true, color: C.muted, breakLine: true } },
    { text: "기능 → 컨텍스트 → 게이트 → 안정화 → 비기능(미완)", options: { color: C.fg, fontSize: 15 } },
  ], { x: 0.85, y: 5.15, w: 5.5, h: 1.45, fontFace: KO, fontSize: 13, margin: 0, isTextBox: true, valign: "middle", paraSpaceAfter: 6 });
  card(s, 6.75, 5.0, 5.95, 1.75, C.periBg);
  s.addText([
    { text: "기대 효과 (추정)", options: { bold: true, color: C.periT, breakLine: true } },
    { text: "남은 과제 5개 중 4개(SSO·프론트 테스트·관측·i18n)를 깔고 기능을 얹었을 것. 7월 fix 급증과 UX 재작업이 가장 크게 줄었을 구간이다.", options: { color: C.fg, fontSize: 13.5 } },
  ], { x: 7.0, y: 5.15, w: 5.5, h: 1.45, fontFace: KO, fontSize: 13, margin: 0, isTextBox: true, valign: "middle", paraSpaceAfter: 6 });
  foot(s, 14, "추정은 실제 수치(9·11·12장)에 근거한 해석이며 검증된 결과가 아니다");
}

// ── 15. 교훈 / 마무리 ──────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 4.6, h: 7.5, fill: { color: C.maroon }, line: { color: C.maroon } });
  s.addText("LESSONS", { x: 0.6, y: 0.8, w: 3.6, h: 0.4, fontFace: NUM, fontSize: 14, bold: true, color: C.onDarkAcc, margin: 0, isTextBox: true });
  s.addText("8개월에서\n얻은 3가지", { x: 0.6, y: 1.4, w: 3.7, h: 1.6, fontFace: KO, fontSize: 32, bold: true, color: C.onDark, margin: 0, isTextBox: true });
  s.addText("AI 는 속도를 주고,\n하네스는 방향을 준다.", { x: 0.6, y: 5.4, w: 3.7, h: 1.0, fontFace: KO, fontSize: 16, italic: true, color: C.onDarkMuted, margin: 0, isTextBox: true });
  const L = [
    ["컨텍스트가 곧 생산성", "CLAUDE.md·CODE_MAP·스킬로 규칙을 저장소에 남기자 같은 설명의 반복이 사라졌다. 월 PR 1.8배의 실제 원인이다."],
    ["속도는 게이트와 함께 키운다", "7월 fix 비율 50% 는 게이트 없이 속도만 낸 대가였다. 테스트·docs-sync·자동 릴리스가 이를 40% 로 되돌렸다."],
    ["사람의 역할은 '판단'으로 이동", "무엇을 만들지, 무엇이 충분히 좋은지, 어디서 멈출지. 남은 과제(SSO·테스트·관측)도 같은 판단의 문제다."],
  ];
  L.forEach(([h, d], i) => {
    const y = 0.9 + i * 2.1;
    s.addShape(pres.shapes.OVAL, { x: 5.2, y: y + 0.05, w: 0.6, h: 0.6, fill: { color: C.peri }, line: { color: C.peri } });
    s.addText(String(i + 1), { x: 5.2, y: y + 0.05, w: 0.6, h: 0.6, fontFace: NUM, fontSize: 18, bold: true, color: C.fg, align: "center", valign: "middle", margin: 0, isTextBox: true });
    s.addText(h, { x: 6.1, y, w: 6.6, h: 0.55, fontFace: KO, fontSize: 21, bold: true, color: C.fg, margin: 0, isTextBox: true });
    s.addText(d, { x: 6.1, y: y + 0.6, w: 6.6, h: 1.1, fontFace: KO, fontSize: 14, color: C.muted, margin: 0, isTextBox: true, valign: "top" });
  });
}

pres.writeFile({ fileName: process.argv[2] || "PEP_AI_Dev_Report.pptx" }).then(f => console.log("wrote", f));
