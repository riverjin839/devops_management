/** 화면(DOM 요소) 디자인 그대로 PNG / PDF / PPT 로 추출하는 공용 모듈.
 *
 * 방식: 요소를 이미지(PNG)로 캡처 → PDF(jsPDF) / PPT(pptxgenjs) 에 삽입. 차트·표·테마가 보이는 그대로.
 * 무거운 라이브러리는 **동적 import** 로 클릭 시에만 로드(메인 번들 영향 최소화).
 *
 * 캡처에서 제외하려면 요소에 `data-export-ignore` 속성을 둔다(버튼/드롭다운 등 상호작용 UI).
 */

/** 현재 테마 배경색(투명/검정 캡처 방지). */
function pageBg(): string {
  try {
    const c = getComputedStyle(document.body).backgroundColor;
    return c && c !== 'rgba(0, 0, 0, 0)' ? c : '#ffffff';
  } catch {
    return '#ffffff';
  }
}

/** 요소를 PNG dataURL 로 캡처. */
export async function capturePng(el: HTMLElement): Promise<string> {
  const { toPng } = await import('html-to-image');
  return toPng(el, {
    pixelRatio: 2,
    cacheBust: true,
    backgroundColor: pageBg(),
    // data-export-ignore 노드(버튼/메뉴 등) 제외
    filter: (node: HTMLElement) => !(node?.dataset && node.dataset.exportIgnore !== undefined),
  });
}

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
}

function loadImageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** PNG 다운로드. */
export async function exportPng(el: HTMLElement, filename: string): Promise<void> {
  const png = await capturePng(el);
  triggerDownload(png, `${filename}.png`);
}

/** PDF 다운로드 — fit-width 후 페이지 높이만큼 음수 오프셋으로 그려 긴 화면을 다중 페이지로 분할. */
export async function exportPdf(el: HTMLElement, filename: string): Promise<void> {
  const png = await capturePng(el);
  const { w, h } = await loadImageSize(png);
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: w >= h ? 'l' : 'p', unit: 'pt', format: 'a4' });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const scaledH = (h * pw) / w;           // 폭을 페이지에 맞췄을 때 전체 높이
  let pos = 0;
  while (pos < scaledH - 1) {
    if (pos > 0) pdf.addPage();
    pdf.addImage(png, 'PNG', 0, -pos, pw, scaledH);   // 음수 y → 페이지 밖은 클리핑
    pos += ph;
  }
  pdf.save(`${filename}.pdf`);
}

/** PPT(.pptx) 다운로드 — WIDE 슬라이드에 캡처 이미지, 길면 다중 슬라이드로 분할. */
export async function exportPptx(el: HTMLElement, filename: string): Promise<void> {
  const png = await capturePng(el);
  const { w, h } = await loadImageSize(png);
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';
  const sw = 13.33;
  const sh = 7.5;
  const scaledH = (h * sw) / w;           // 폭을 슬라이드에 맞췄을 때 전체 높이(in)
  let pos = 0;
  let guard = 0;
  while (pos < scaledH - 0.01 && guard < 200) {
    const slide = pptx.addSlide();
    slide.addImage({ data: png, x: 0, y: -pos, w: sw, h: scaledH });  // 슬라이드 밖은 클리핑
    pos += sh;
    guard += 1;
  }
  await pptx.writeFile({ fileName: `${filename}.pptx` });
}

export type ExportFormat = 'pdf' | 'pptx' | 'png';

export async function exportElement(el: HTMLElement, format: ExportFormat, filename: string): Promise<void> {
  if (format === 'pdf') return exportPdf(el, filename);
  if (format === 'pptx') return exportPptx(el, filename);
  return exportPng(el, filename);
}
