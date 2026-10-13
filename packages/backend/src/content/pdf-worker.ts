// Read only searchable PDF text. A separate worker bounds parser time and memory.
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
const task = getDocument({
  data: new Uint8Array(workerData as ArrayBuffer),
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  stopAtErrors: true,
  cMapUrl: path.join(root, "cmaps") + path.sep,
  cMapPacked: true,
  standardFontDataUrl: path.join(root, "standard_fonts") + path.sep,
});
try {
  const doc = await task.promise;
  if (doc.numPages > 150) throw new Error("PDF page limit");
  const pages: string[] = [];
  let size = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    const parts: string[] = [];
    let previous: { transform: number[]; width: number; str: string } | null = null;
    for (const item of items) {
      if (!("str" in item)) continue;
      if (previous && previous.str && item.str && !/\s$/.test(previous.str) && !/^\s/.test(item.str)) {
        const gap = item.transform[4]! - previous.transform[4]! - previous.width;
        if (gap > Math.abs(item.transform[3]!) * 0.1) parts.push(" ");
      }
      parts.push(item.str);
      if (item.hasEOL) { parts.push("\n"); previous = null; }
      else previous = item;
    }
    const text = parts.join("").replace(/[ \t]+\n/g, "\n").trim();
    // Image-only interior pages can contain missing writing; do not confirm a partial report.
    if (text.replace(/[\s\d]/g, "").length < 20) throw new Error("PDF page has no searchable writing");
    if (text.includes("\uFFFD")) throw new Error("PDF character decoding failed");
    size += text.length;
    if (size > 500_000) throw new Error("PDF text limit");
    pages.push(text);
    page.cleanup();
  }
  parentPort!.postMessage({ pages });
} catch {
  parentPort!.postMessage(null);
} finally {
  await task.destroy();
}
