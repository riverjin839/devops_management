/**
 * 붙여넣기/삽입 이미지 경량화 — 본문(HTML)에 base64 로 박히는 이미지가 DB 를
 * 비대하게 만들지 않도록 캔버스로 다운스케일 + 재인코딩한다.
 *
 * 서버 업로드가 없는 현재 구조에서 이미지는 data URL 로 본문에 저장되므로,
 * 큰 스크린샷 한 장이 수 MB 가 되어 문서/업무 row 를 무겁게 만든다.
 * 이 헬퍼는 최대 변(maxDim)으로 축소하고 webp/jpeg 로 압축해 용량을 크게 줄인다.
 * (압축 결과가 원본보다 크면 원본 유지 — 작은 아이콘/투명 PNG 손해 방지)
 */

export interface CompressOptions {
  /** 가로/세로 중 긴 변의 최대 픽셀 (기본 1600) */
  maxDim?: number;
  /** 0~1 인코딩 품질 (기본 0.82) */
  quality?: number;
  /** 이 크기(byte) 이하의 작은 이미지는 손대지 않음 (기본 200KB) */
  skipUnderBytes?: number;
}

function readFileAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

/**
 * 이미지 파일을 경량화한 data URL 로 반환. 실패 시 원본 data URL 로 폴백.
 */
export async function compressImageFile(file: File | Blob, opts: CompressOptions = {}): Promise<string> {
  const maxDim = opts.maxDim ?? 1600;
  const quality = opts.quality ?? 0.82;
  const skipUnderBytes = opts.skipUnderBytes ?? 200 * 1024;

  let originalDataUrl: string;
  try {
    originalDataUrl = await readFileAsDataUrl(file);
  } catch {
    throw new Error('이미지를 읽을 수 없습니다.');
  }

  // 이미 충분히 작으면 그대로
  if (typeof file.size === 'number' && file.size > 0 && file.size <= skipUnderBytes) {
    return originalDataUrl;
  }

  try {
    const img = await loadImage(originalDataUrl);
    const longest = Math.max(img.width, img.height);
    const scale = longest > maxDim ? maxDim / longest : 1;
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return originalDataUrl;
    ctx.drawImage(img, 0, 0, w, h);

    // webp 우선(알파 지원), 미지원 브라우저는 jpeg 폴백
    let out = canvas.toDataURL('image/webp', quality);
    if (!out.startsWith('data:image/webp')) {
      out = canvas.toDataURL('image/jpeg', quality);
    }
    // 압축이 오히려 커졌으면 원본 유지
    return out.length > 0 && out.length < originalDataUrl.length ? out : originalDataUrl;
  } catch {
    return originalDataUrl;
  }
}
