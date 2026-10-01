// PEP AI 개발 리포트 생성기 — `npm install pptxgenjs` 후 `node build_ai_dev_report.js out.pptx`
// 수치는 2026-10-01 기준 git log origin/main 집계값을 하드코딩했다.
const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
pres.title = "AI 페어 개발 리포트 — PEP";

// Picasso 〈소녀의 초상〉 (picasso-portrait) 테마 토큰 → hex
const C = {
  bg: "15231D", card: "1E2F28", sec: "2A3C35", border: "364A41",
  fg: "EDEAE3", muted: "ABBAB2", dim: "6E7F77",
  peri: "94A2DB", periT: "ADBAEB", periBg: "323853", maroon: "30171B",
};
const KO = "Malgun Gothic";
const NUM = "Arial";
const W = 13.333;

function base(s) { s.background = { color: C.bg }; }
function title(s, kicker, text) {
  s.addText(kicker, { x: 0.6, y: 0.35, w: 9, h: 0.35, fontFace: KO, fontSize: 13, color: C.peri, bold: true, margin: 0, isTextBox: true });
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
  s.addText("팀 보고 · 2026-10", { x: 0.7, y: 0.8, w: 7, h: 0.4, fontFace: KO, fontSize: 14, color: C.peri, bold: true, margin: 0, isTextBox: true });
  s.addText("AI 와 함께 만든 8개월", { x: 0.7, y: 1.9, w: 7.8, h: 0.9, fontFace: KO, fontSize: 40, bold: true, color: C.fg, margin: 0, isTextBox: true });
  s.addText("PEP(Platform Engineering Portal) 개발 과정·결과 리포트", { x: 0.7, y: 2.85, w: 7.8, h: 0.6, fontFace: KO, fontSize: 20, color: C.muted, margin: 0, isTextBox: true });
  s.addText([
    { text: "개발 방식이 어떻게 바뀌었나", options: { bullet: true, breakLine: true } },
    { text: "어떻게 발전해 왔나 — 수치로", options: { bullet: true, breakLine: true } },
    { text: "상용화까지 얼마나 왔고, 무엇이 남았나", options: { bullet: true } },
  ], { x: 0.7, y: 3.9, w: 7.6, h: 1.5, fontFace: KO, fontSize: 17, color: C.fg, paraSpaceAfter: 8, margin: 0, isTextBox: true });
  s.addText("기간 2026-02-05 ~ 2026-10-01 · 데이터 기준 riverjin839/devops_management main", { x: 0.7, y: 6.6, w: 7.8, h: 0.35, fontFace: KO, fontSize: 11, color: C.dim, margin: 0, isTextBox: true });
  const st = [["1,988", "커밋"], ["845", "병합 PR"], ["82", "자동 릴리스"], ["86%", "AI 작성 커밋 비중"]];
  st.forEach(([v, l], i) => {
    const y = 0.9 + i * 1.5;
    s.addText(v, { x: 9.2, y, w: 3.6, h: 0.8, fontFace: NUM, fontSize: 44, bold: true, color: i === 3 ? C.periT : C.fg, margin: 0, isTextBox: true });
    s.addText(l, { x: 9.2, y: y + 0.8, w: 3.6, h: 0.4, fontFace: KO, fontSize: 14, color: C.muted, margin: 0, isTextBox: true });
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
    ["6.1", "PR / 작업일", "845 PR ÷ 139 작업일\n하루 6건 병합"],
    ["67%", "상용화 진척도", "9개 영역 자체 평가\n근거는 10장"],
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
    { text: "방식 변화  ", options: { bold: true, color: C.peri } }, { text: "커밋의 86%, PR 의 77% 를 AI 가 작성. 사람의 일은 코딩 → 요구사항·리뷰·규칙(하네스) 설계로 이동했다.", options: { breakLine: true } },
    { text: "발전 경로  ", options: { bold: true, color: C.peri } }, { text: "프롬프트 코딩 → 컨텍스트 문서화 → 스킬·자동 게이트 → 에이전트 운영의 4단계로 진화했다.", options: { breakLine: true } },
    { text: "상용화  ", options: { bold: true, color: C.peri } }, { text: "기능·배포·CI 는 상용 수준. SSO·프론트 테스트·관측성·i18n 이 남은 핵심 공백이다.", options: {} },
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
  s.addText("AFTER (AI 페어)", { x: 7.5, y: hy, w: 5.2, h: 0.45, fontFace: KO, fontSize: 14, bold: true, color: C.peri, margin: 0, isTextBox: true });
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
    { text: "모델이 아니라 '저장소에 남긴 규칙'이 생산성을 바꿨다. CLAUDE.md 이후 같은 지시를 반복할 필요가 사라졌고, 스킬·게이트 도입(6~7월)과 함께 월 PR 이 110 → 220 건으로 2배가 됐다.", options: {} },
  ], { x: 0.9, y: 5.55, w: 11.5, h: 1.1, fontFace: KO, fontSize: 15, color: C.fg, valign: "middle", margin: 0, isTextBox: true });
  foot(s, 4, "출처: 각 파일의 최초 추가 커밋 일자 (git log --diff-filter=A)");
}

// ── 5. AI 기여도 ────────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "AI SHARE", "작성 주체 — 커밋의 86% 를 AI 가 작성");
  const ai = [67, 50, 79, 74, 211, 249, 85, 91];
  const hu = [6, 5, 18, 114, 3, 2, 1, 1];
  card(s, 0.6, 1.7, 8.3, 5.1);
  s.addChart(pres.charts.BAR, [
    { name: "AI (Claude)", labels: MONTHS, values: ai },
    { name: "사람", labels: MONTHS, values: hu },
  ], { x: 0.8, y: 1.85, w: 7.9, h: 4.85, barDir: "col", barGrouping: "stacked", chartColors: [C.peri, C.dim],
    showTitle: true, title: "월별 커밋 수 (병합·봇 커밋 제외)", showLegend: true, legendPos: "t",
    showValue: false, barGapWidthPct: 45, ...axis() });
  const side = [["906 / 1,056", "AI 작성 커밋 (86%)"], ["653 / 845", "AI 브랜치 PR (77%)"], ["5월", "유일하게 사람 커밋 114건 —\n구조 개편을 직접 수행"]];
  side.forEach(([v, l], i) => {
    const y = 1.7 + i * 1.75;
    card(s, 9.2, y, 3.5, 1.55, i === 0 ? C.periBg : C.card);
    s.addText(v, { x: 9.45, y: y + 0.15, w: 3.1, h: 0.6, fontFace: NUM, fontSize: 26, bold: true, color: i === 0 ? C.periT : C.fg, margin: 0, isTextBox: true });
    s.addText(l, { x: 9.45, y: y + 0.75, w: 3.1, h: 0.7, fontFace: KO, fontSize: 13, color: C.muted, margin: 0, isTextBox: true });
  });
  foot(s, 5, "출처: git log --no-merges 작성자 기준 (github-actions 봇 171건 제외)");
}

// ── 6. 처리량 ──────────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "THROUGHPUT", "처리량 — 7월 정점 220 PR, 이후 안정화 구간");
  const prs = [56, 54, 74, 110, 129, 220, 97, 105];
  const days = [13, 13, 14, 20, 22, 24, 13, 22];
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
    { text: "4.3 → 9.2", options: { bold: true, color: C.periT, fontSize: 22, breakLine: true } },
    { text: "2월 대비 7월 작업일당 PR 2.1배. 8월은 신규 기능 대신 버그·품질 정비에 집중한 구간이다.", options: { fontSize: 13, color: C.muted } },
  ], { x: 8.8, y: 5.1, w: 3.7, h: 1.6, fontFace: KO, margin: 0, isTextBox: true, valign: "top" });
  foot(s, 6, "출처: git log --merges (월별), 작업일 = 커밋이 1건 이상인 날");
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

// ── 8. 품질 체계 ───────────────────────────────────────
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
  foot(s, 8, "출처: backend/tests 의 def test_ 집계, Conventional Commits prefix 집계");
}

// ── 9. 성숙도 4단계 ────────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  title(s, "MATURITY", "AI 활용 성숙도 — 4단계로 진화");
  const st = [
    ["1", "프롬프트 코딩", "2~3월", "대화로 기능 단위 구현\nCLAUDE.md 첫 도입", "PR 55건/월"],
    ["2", "컨텍스트 문서화", "4~5월", "CODE_MAP·디자인 시스템\n문서로 저장소 지도 제공", "PR 92건/월"],
    ["3", "스킬·자동 게이트", "6~7월", "스킬 8종, docs-sync CI,\n자동 릴리스·CHANGELOG", "PR 175건/월"],
    ["4", "에이전트 운영", "8~9월", "UX 감사 에이전트, 테스트\n1,097개, 안정화 우선", "테스트 2배"],
  ];
  st.forEach(([n, t, p, d, m], i) => {
    const x = 0.6 + i * 3.1, cur = i === 3;
    card(s, x, 1.8, 2.8, 4.3, cur ? C.periBg : C.card);
    s.addShape(pres.shapes.OVAL, { x: x + 0.3, y: 2.05, w: 0.7, h: 0.7, fill: { color: cur ? C.peri : C.sec }, line: { color: cur ? C.peri : C.border } });
    s.addText(n, { x: x + 0.3, y: 2.05, w: 0.7, h: 0.7, fontFace: NUM, fontSize: 22, bold: true, color: cur ? C.bg : C.fg, align: "center", valign: "middle", margin: 0, isTextBox: true });
    s.addText(t, { x: x + 0.3, y: 3.0, w: 2.35, h: 0.5, fontFace: KO, fontSize: 18, bold: true, color: C.fg, margin: 0, isTextBox: true });
    s.addText(p, { x: x + 0.3, y: 3.5, w: 2.35, h: 0.35, fontFace: KO, fontSize: 13, color: cur ? C.periT : C.muted, margin: 0, isTextBox: true });
    s.addText(d, { x: x + 0.3, y: 4.0, w: 2.4, h: 1.2, fontFace: KO, fontSize: 13, color: C.muted, margin: 0, isTextBox: true, valign: "top" });
    s.addText(m, { x: x + 0.3, y: 5.25, w: 2.35, h: 0.6, fontFace: KO, fontSize: 17, bold: true, color: cur ? C.periT : C.fg, margin: 0, isTextBox: true });
    if (i < 3) s.addShape(pres.shapes.RIGHT_ARROW, { x: x + 2.83, y: 4.05, w: 0.24, h: 0.3, fill: { color: C.peri }, line: { color: C.peri } });
  });
  foot(s, 9, "PR/월 = 해당 구간 월평균 병합 PR · 현재 위치 = 4단계");
}

// ── 10. 상용화 진척도 ──────────────────────────────────
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
  foot(s, 10, "자체 평가: 9개 영역 동일 가중 평균 · 70% 이상 = 상용 기준 충족(강조색)");
}

// ── 11. 남은 과제 ──────────────────────────────────────
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
  foot(s, 11, "출처: DESIGN.md 로드맵 R-6·R-7, 백로그 D-069~D-085, 저장소 grep 결과");
}

// ── 12. 교훈 / 마무리 ──────────────────────────────────
{
  const s = pres.addSlide(); base(s);
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 4.6, h: 7.5, fill: { color: C.maroon }, line: { color: C.maroon } });
  s.addText("LESSONS", { x: 0.6, y: 0.8, w: 3.6, h: 0.4, fontFace: NUM, fontSize: 14, bold: true, color: C.peri, margin: 0, isTextBox: true });
  s.addText("8개월에서\n얻은 3가지", { x: 0.6, y: 1.4, w: 3.7, h: 1.6, fontFace: KO, fontSize: 32, bold: true, color: C.fg, margin: 0, isTextBox: true });
  s.addText("AI 는 속도를 주고,\n하네스는 방향을 준다.", { x: 0.6, y: 5.4, w: 3.7, h: 1.0, fontFace: KO, fontSize: 16, italic: true, color: C.muted, margin: 0, isTextBox: true });
  const L = [
    ["컨텍스트가 곧 생산성", "CLAUDE.md·CODE_MAP·스킬로 규칙을 저장소에 남기자 같은 설명의 반복이 사라졌다. 월 PR 2배의 실제 원인이다."],
    ["속도는 게이트와 함께 키운다", "7월 fix 비율 50% 는 게이트 없이 속도만 낸 대가였다. 테스트·docs-sync·자동 릴리스가 이를 40% 로 되돌렸다."],
    ["사람의 역할은 '판단'으로 이동", "무엇을 만들지, 무엇이 충분히 좋은지, 어디서 멈출지. 남은 과제(SSO·테스트·관측)도 같은 판단의 문제다."],
  ];
  L.forEach(([h, d], i) => {
    const y = 0.9 + i * 2.1;
    s.addShape(pres.shapes.OVAL, { x: 5.2, y: y + 0.05, w: 0.6, h: 0.6, fill: { color: C.peri }, line: { color: C.peri } });
    s.addText(String(i + 1), { x: 5.2, y: y + 0.05, w: 0.6, h: 0.6, fontFace: NUM, fontSize: 18, bold: true, color: C.bg, align: "center", valign: "middle", margin: 0, isTextBox: true });
    s.addText(h, { x: 6.1, y, w: 6.6, h: 0.55, fontFace: KO, fontSize: 21, bold: true, color: C.fg, margin: 0, isTextBox: true });
    s.addText(d, { x: 6.1, y: y + 0.6, w: 6.6, h: 1.1, fontFace: KO, fontSize: 14, color: C.muted, margin: 0, isTextBox: true, valign: "top" });
  });
}

pres.writeFile({ fileName: process.argv[2] || "PEP_AI_Dev_Report.pptx" }).then(f => console.log("wrote", f));
