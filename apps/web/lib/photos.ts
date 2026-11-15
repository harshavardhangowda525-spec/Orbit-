'use client';

/**
 * Get photos ready to send: shrink on the phone (max 1600 px, JPEG) so uploads are
 * fast and well under 10 MB; turn PDFs into page images (up to 5 pages) because
 * not every reading model accepts PDFs.
 */
const MAX_SIDE = 1600;
const MAX_FILES = 5;

async function shrink(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // e.g. HEIC on some browsers: send as-is (the server checks the size)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.82));
}

async function pdfPages(file: Blob, limit: number): Promise<Blob[]> {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs' as any);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out: Blob[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, limit); i++) {
    const page = await doc.getPage(i);
    const v = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, MAX_SIDE / Math.max(v.width, v.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    out.push(await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('page'))), 'image/jpeg', 0.85)));
  }
  return out;
}

export async function preparePhotos(files: File[]): Promise<Blob[]> {
  const out: Blob[] = [];
  for (const f of files) {
    if (out.length >= MAX_FILES) break;
    if (f.type === 'application/pdf') out.push(...(await pdfPages(f, MAX_FILES - out.length)));
    else if (f.type.startsWith('image/')) out.push(await shrink(f));
  }
  return out.slice(0, MAX_FILES);
}
