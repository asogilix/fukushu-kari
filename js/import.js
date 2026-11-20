const EDGE = 2000;
const THUMB_EDGE = 420;
const pdfAssets = new URL('../vendor/pdfjs/', import.meta.url);
const pdfFile = path => new URL(path, pdfAssets).href;

function resizedCanvas(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

function jpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('写真を保存できる形にできませんでした。'));
    }, 'image/jpeg', quality);
  });
}

function drawResized(image, maxEdge) {
  const canvas = resizedCanvas(image.width, image.height, maxEdge);
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function encodePhoto(canvas) {
  const preview = drawResized(canvas, THUMB_EDGE);
  try {
    const full = await jpeg(canvas, 0.85);
    const thumb = await jpeg(preview, 0.75);
    return { full, thumb };
  } finally {
    preview.width = 0;
  }
}

export async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let canvas;
  try {
    canvas = drawResized(bitmap, EDGE);
  } finally {
    bitmap.close();
  }
  try {
    return await encodePhoto(canvas);
  } finally {
    canvas.width = 0;
  }
}

export function parsePageRange(value, total) {
  const text = value.normalize('NFKC').trim();
  if (!text) return [1, total];
  const match = /^(\d+)(?:\s*[-–~〜]\s*(\d+))?$/.exec(text);
  if (!match) throw new RangeError('ページの範囲は「3-10」のように入れてください。');
  const first = Number(match[1]);
  const last = Number(match[2] ?? match[1]);
  if (first < 1 || first > last || last > total) {
    throw new RangeError(`ページは1から${total}までの範囲で選んでください。`);
  }
  return [first, last];
}

export async function readPdf(file, range, receive, onProgress) {
  let pdf;
  try {
    pdf = await import('../vendor/pdfjs/build/pdf.min.mjs');
  } catch {
    throw new Error('PDF を読むためのファイルが見つかりません。写真は取りこめます。');
  }
  pdf.GlobalWorkerOptions.workerSrc = pdfFile('build/pdf.worker.min.mjs');
  const task = pdf.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: pdfFile('cmaps/'),
    cMapPacked: true,
    iccUrl: pdfFile('iccs/'),
    standardFontDataUrl: pdfFile('standard_fonts/'),
    wasmUrl: pdfFile('wasm/'),
    disableWorkerRendering: true,
    enableXfa: false
  });
  try {
    const document = await task.promise;
    const [first, last] = parsePageRange(range, document.numPages);
    const total = last - first + 1;
    onProgress(0, total);
    for (let number = first; number <= last; number++) {
      const page = await document.getPage(number);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: EDGE / Math.max(original.width, original.height) });
      const canvas = resizedCanvas(viewport.width, viewport.height, EDGE);
      try {
        await page.render({ canvas, viewport }).promise;
        await receive(await encodePhoto(canvas), { name: file.name, page: number });
      } finally {
        page.cleanup();
        canvas.width = 0;
      }
      onProgress(number - first + 1, total);
    }
  } finally {
    await task.destroy();
  }
}
