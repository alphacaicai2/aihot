import { Worker } from "node:worker_threads";
import { load } from "cheerio";
import { guardedFetch } from "../lib/http-fetch.ts";
import { FetchError } from "./types.ts";

export const JAVASCRIPT_MAX_BYTES = 4 * 1024 * 1024;
const unsafe = new Set(["__proto__", "prototype", "constructor"]);

export function staticKeys(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > 20 || input.some(k => typeof k !== "string" || !/^[a-zA-Z_$][\w$]*$/.test(k) || unsafe.has(k)) || new Set(input).size !== input.length) throw new FetchError(`invalid ${label}`);
  return input;
}

async function parseInWorker(source: string, options: Record<string, unknown>, timeoutMs = 5_000): Promise<any> {
  if (Buffer.byteLength(source) > JAVASCRIPT_MAX_BYTES) throw new FetchError("JavaScript byte limit");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./javascript-array-worker.ts", import.meta.url), {
      workerData: { source, ...options }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });
    let done = false;
    const finish = (error: Error | null, result?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(new FetchError(error.message)); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("JavaScript parse timeout")), timeoutMs);
    worker.once("message", result => finish(result?.error ? new Error(String(result.error)) : null, result));
    worker.once("error", error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", () => finish(new Error("JavaScript parser exited without data")));
  });
}

export async function javascriptArray(source: string, matchKeys: unknown, projectionKeys?: unknown, timeoutMs?: number, collectionKind = "array"): Promise<unknown[] | Record<string, unknown>> {
  const keys = staticKeys(matchKeys, "arrayMatchKeys");
  const projection = projectionKeys === undefined ? undefined : staticKeys(projectionKeys, "arrayProjectionKeys");
  if (projection && keys.some(k => !projection.includes(k))) throw new FetchError("arrayProjectionKeys must include arrayMatchKeys");
  if (!["array", "object"].includes(collectionKind)) throw new FetchError("invalid collectionKind");
  const result = await parseInWorker(source, { matchKeys: keys, projectionKeys: projection, collectionKind }, timeoutMs);
  if (!result?.items || (collectionKind === "array" ? !Array.isArray(result.items) : typeof result.items !== "object" || Array.isArray(result.items))) throw new FetchError("JavaScript parser returned no items");
  return result.items;
}

function assetUrl(path: string, base: string): string {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin || !/^https?:$/.test(url.protocol) || !url.pathname.endsWith(".js") || url.username || url.password) throw new FetchError("JavaScript asset must be a same-origin public .js URL");
  return url.toString();
}

export function scriptAsset(html: string, base: string, selector: unknown): string {
  if (typeof selector !== "string" || !selector || selector.length > 300) throw new FetchError("scriptSelector required");
  const $ = load(html);
  const targets = $(selector);
  if (targets.length !== 1 || !targets.is("script")) throw new FetchError("scriptSelector must match exactly one script");
  const src = targets.attr("src");
  if (!src) throw new FetchError("selected script has no public src");
  return assetUrl(src, base);
}

export async function htmlScriptArray(html: string, base: string, config: Record<string, any>, headers: Record<string, string>): Promise<unknown[] | Record<string, unknown>> {
  let url = scriptAsset(html, base, config.scriptSelector);
  const read = async () => {
    const response = await guardedFetch(url, { headers, timeoutMs: 25_000, maxBytes: JAVASCRIPT_MAX_BYTES, maxRedirects: 0 });
    if (response.status !== 200) throw new FetchError(`JavaScript asset HTTP ${response.status}`, response.status);
    if (new URL(response.url).origin !== new URL(base).origin) throw new FetchError("JavaScript asset redirected off origin");
    return response;
  };
  let response = await read();
  if (config.assetNameIncludes !== undefined) {
    const name = config.assetNameIncludes;
    if (typeof name !== "string" || !/^[\w-]{3,100}$/.test(name)) throw new FetchError("invalid assetNameIncludes");
    const declared = await parseInWorker(response.text(), { assetNameIncludes: name });
    if (typeof declared?.asset !== "string" || !["module", "absolute"].includes(declared.assetBase)) throw new FetchError("no declared JavaScript asset");
    if (declared.assetBase === "absolute" && !declared.asset.startsWith("/") && !/^https?:\/\//.test(declared.asset)) throw new FetchError("JavaScript asset URL base is unknown");
    url = assetUrl(declared.asset, declared.assetBase === "module" ? response.url : base);
    response = await read();
  }
  return javascriptArray(response.text(), config.arrayMatchKeys, config.arrayProjectionKeys, undefined, config.collectionKind);
}

/** These published block types are plain text; unknown blocks must not yield a partial body. */
export function textBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 2_000) throw new FetchError("invalid summary blocks");
  return blocks.map(block => {
    if (!block || typeof block !== "object" || Object.keys(block).some(k => !["type", "text"].includes(k)) || !["heading", "paragraph", "quote"].includes(block.type) || typeof block.text !== "string") throw new FetchError("unsupported summary block");
    return block.text;
  }).join("\n\n");
}
