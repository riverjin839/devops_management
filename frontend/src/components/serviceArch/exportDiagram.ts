/** SVG 다이어그램 → SVG/PNG 다운로드 (MindMap exportMindMap 패턴 추출본).
 *
 * 캔버스는 테마 토큰(`hsl(var(--card))` 등)을 쓰므로 standalone SVG 로 떼어내면
 * 색이 사라진다 — 직렬화 전에 computed 토큰 값으로 인라인 치환한다.
 */

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const VAR_RE = /var\((--[a-z0-9-]+)\)/gi;

function resolveCssVars(el: Element, rootStyle: CSSStyleDeclaration) {
  for (const attr of ['fill', 'stroke', 'stop-color'] as const) {
    const val = el.getAttribute(attr);
    if (val && val.includes('var(')) {
      el.setAttribute(attr, val.replace(VAR_RE, (_, name: string) =>
        rootStyle.getPropertyValue(name).trim() || '0 0% 50%'));
    }
  }
  for (const child of Array.from(el.children)) resolveCssVars(child, rootStyle);
}

export async function exportSvgDiagram(
  svg: SVGSVGElement,
  baseName: string,
  format: 'svg' | 'png',
): Promise<void> {
  const innerG = svg.querySelector('g') as SVGGraphicsElement | null;
  if (!innerG) return;
  let bbox: DOMRect;
  try {
    bbox = innerG.getBBox();
  } catch {
    return;
  }
  const pad = 40;
  const vbX = bbox.x - pad;
  const vbY = bbox.y - pad;
  const vbW = Math.max(1, bbox.width + pad * 2);
  const vbH = Math.max(1, bbox.height + pad * 2);

  const clone = svg.cloneNode(true) as SVGSVGElement;
  const cg = clone.querySelector('g');
  if (cg) cg.removeAttribute('transform'); // pan/zoom 제거 → 전체 1:1
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  clone.setAttribute('width', String(vbW));
  clone.setAttribute('height', String(vbH));
  clone.removeAttribute('class');
  clone.removeAttribute('style');
  resolveCssVars(clone, getComputedStyle(document.documentElement));

  // 흰 배경
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', String(vbX));
  bg.setAttribute('y', String(vbY));
  bg.setAttribute('width', String(vbW));
  bg.setAttribute('height', String(vbH));
  bg.setAttribute('fill', '#ffffff');
  clone.insertBefore(bg, clone.firstChild);

  const svgStr = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob(
    [`<?xml version="1.0" encoding="UTF-8"?>\n${svgStr}`],
    { type: 'image/svg+xml;charset=utf-8' },
  );
  const ts = new Date().toISOString().slice(0, 10);

  if (format === 'svg') {
    const url = URL.createObjectURL(svgBlob);
    triggerDownload(url, `${baseName}-${ts}.svg`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  // PNG — SVG 를 이미지로 그려 canvas 래스터화 (2x)
  const url = URL.createObjectURL(svgBlob);
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vbW * scale);
      canvas.height = Math.ceil(vbH * scale);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob) {
            const purl = URL.createObjectURL(blob);
            triggerDownload(purl, `${baseName}-${ts}.png`);
            setTimeout(() => URL.revokeObjectURL(purl), 1000);
          }
          resolve();
        }, 'image/png');
      } else {
        resolve();
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    img.src = url;
  });
}
