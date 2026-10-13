import { Worker } from "node:worker_threads";
import { stripTags } from "../lib/text.ts";
import type { ExtractedBody } from "./extract.ts";

/** Explicit PDF responses only; no OCR, viewer HTML or parser fallback is implied. */
export async function pdfDocument(bytes: Uint8Array, contentType: string): Promise<ExtractedBody | null> {
  if (!/^application\/pdf\b/i.test(contentType) || bytes.length > 16 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") return null;
  const data = Uint8Array.from(bytes).buffer;
  const pages = await new Promise<string[] | null>((resolve) => {
    const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), {
      workerData: data, transferList: [data], execArgv: [],
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
  const html = pages.map(p => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`).join("\n");
  const text = stripTags(html);
  return text.length >= 200 ? { html, text, images: [], via: "pdf-text" } : null;
}
