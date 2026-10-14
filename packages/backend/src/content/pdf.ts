import { Worker } from "node:worker_threads";
import { stripTags } from "../lib/text.ts";
import type { ExtractedBody } from "./extract.ts";

export interface PdfOptions { maxBytes?: number; timeoutMs?: number; shortCoverTexts?: string[] }

/** Source-level exceptions remain bounded and cannot silently alter the default reader. */
export function validatedPdfOptions(value?: unknown): { maxBytes: number; timeoutMs: number; shortCoverTexts: string[] } | null {
  if (value === undefined) return { maxBytes: 16 * 1024 * 1024, timeoutMs: 20_000, shortCoverTexts: [] };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(key => !["maxBytes", "timeoutMs", "shortCoverTexts"].includes(key))) return null;
  if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || Number(options.maxBytes) < 1 || Number(options.maxBytes) > 64 * 1024 * 1024)) return null;
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || Number(options.timeoutMs) < 1000 || Number(options.timeoutMs) > 120_000)) return null;
  if (options.shortCoverTexts !== undefined && (!Array.isArray(options.shortCoverTexts) || options.shortCoverTexts.length > 8 ||
      options.shortCoverTexts.some(text => typeof text !== "string" || text.length > 256 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFD]/.test(text) ||
        text.replace(/[\s\d]/g, "").length < 1 || text.replace(/[\s\d]/g, "").length >= 20))) return null;
  return { maxBytes: options.maxBytes === undefined ? 16 * 1024 * 1024 : Number(options.maxBytes),
    timeoutMs: options.timeoutMs === undefined ? 20_000 : Number(options.timeoutMs),
    shortCoverTexts: (options.shortCoverTexts as string[] | undefined) ?? [] };
}

/** Explicit PDF responses only; no OCR, viewer HTML or parser fallback is implied. */
export async function pdfDocument(bytes: Uint8Array, contentType: string, options?: PdfOptions): Promise<ExtractedBody | null> {
  const limits = validatedPdfOptions(options);
  if (!limits || !/^application\/pdf\b/i.test(contentType) || bytes.length > limits.maxBytes || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") return null;
  const data = Uint8Array.from(bytes).buffer;
  const pages = await new Promise<string[] | null>((resolve) => {
    const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), {
      workerData: { data, options: limits }, transferList: [data], execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    let done = false;
    const finish = (value: string[] | null) => {
      if (done) return;
      done = true; clearTimeout(timer); void worker.terminate(); resolve(value);
    };
    const timer = setTimeout(() => finish(null), 30_000);
    worker.once("message", (result: unknown) => {
      const p = result && typeof result === "object" && "pages" in result ? result.pages : null;
      finish(Array.isArray(p) && p.every(x => typeof x === "string") ? p : null);
    });
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
  if (!pages) return null;
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Unmapped font glyphs can become control codes, including NUL (invalid PostgreSQL text).
  // Refuse the document instead of guessing/removing writing or aborting its database write.
  if (pages.some(p => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(p))) return null;
  const html = pages.map(p => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`).join("\n");
  const text = stripTags(html);
  return text.length >= 200 ? { html, text, images: [], via: "pdf-text" } : null;
}
