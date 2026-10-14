// JSON sources: plain JSON APIs, JSON embedded in HTML (script tags, window variables).
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { htmlScriptArray, htmlJsonDocument, javascriptArray, JAVASCRIPT_MAX_BYTES, textBlocks } from "./javascript-array.ts";
import { framerHandover } from "./framer-handover.ts";

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

function firstString(obj: unknown, paths: string[] | undefined): string | null {
  for (const p of paths ?? []) {
    const v = getPath(obj, p);
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** A publisher's separate public page index can resolve internal CMS IDs to actual reader URLs. */
async function publicUrlLookup(config: Record<string, any>, listingUrl: string): Promise<Map<string, string> | null> {
  const rule = config.urlLookup;
  if (!rule) return null;
  const target = new URL(rule.url, listingUrl), origin = new URL(listingUrl).origin;
  if (target.origin !== origin || target.username || target.password || target.hash || !target.pathname.endsWith(".json")) throw new FetchError("URL lookup must be a same-origin public JSON file");
  const response = await guardedFetch(target.href, { timeoutMs: 25_000, maxBytes: 4 * 1024 * 1024, maxRedirects: 0, headers: { accept: "application/json" } });
  if (response.status !== 200 || !/\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) throw new FetchError("URL lookup returned redirects or non-JSON content", response.status);
  let data: unknown;
  try { data = JSON.parse(response.text()); } catch { throw new FetchError("URL lookup response is not JSON"); }
  const rows = getPath(data, rule.itemsPath);
  if (!Array.isArray(rows) || !rows.length || rows.length > 10_000) throw new FetchError("URL lookup items must be a bounded nonempty array");
  const urls = new Map<string, string>();
  for (const row of rows) {
    const key = getPath(row, rule.keyPath), path = getPath(row, rule.valuePath);
    if (key === undefined || key === null) continue; // Framework utility pages have no CMS article ID.
    if (!(typeof key === "string" && key.length > 0 && key.length <= 256) && !(typeof key === "number" && Number.isSafeInteger(key))) throw new FetchError("URL lookup requires a stable string or integer key");
    if (typeof path !== "string" || !path.trim()) throw new FetchError("URL lookup is missing a reader path");
    const url = new URL(path, listingUrl);
    if (url.origin !== origin || url.username || url.password || url.hash) throw new FetchError("URL lookup reader paths must stay on the publisher origin");
    const previous = urls.get(String(key));
    if (previous && previous !== url.href) throw new FetchError("URL lookup key has ambiguous reader paths");
    urls.set(String(key), url.href);
  }
  if (!urls.size) throw new FetchError("URL lookup contains no public reader mappings");
  return urls;
}

/** "{path}" → encoded value, "{raw:path}" → raw value. Returns null when a referenced value is missing. */
export function renderTemplate(template: string, item: unknown): string | null {
  let missing = false;
  const out = template.replace(/\{(raw:)?([^}]+)\}/g, (_m, raw: string | undefined, path: string) => {
    const v = getPath(item, path);
    if (v === undefined || v === null || v === "") {
      missing = true;
      return "";
    }
    return raw ? String(v) : encodeURIComponent(String(v)).replace(/%2F/g, "/");
  });
  return missing ? null : out;
}

function toDate(v: unknown, unit: string | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (unit === "epoch_ms") return new Date(Number(v));
  if (unit === "epoch_s") return new Date(Number(v) * 1000);
  // 20260922: a calendar day at UTC midnight (some list APIs give dates as yyyymmdd).
  if (unit === "yyyymmdd") {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v).trim());
    const d = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) : null;
    return d && Number.isFinite(d.getTime()) && d.toISOString().startsWith(`${m![1]}-${m![2]}-${m![3]}`) ? d : null;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t) : null;
}

function staticDate(v: unknown, unit: string | undefined): Date | null {
  if (unit) return toDate(v, unit);
  const text = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}(?:$|T|\s)/.test(text)) {
    const day = toDate(`${text.slice(0, 10)}T00:00:00Z`, undefined);
    return day?.toISOString().startsWith(text.slice(0, 10)) ? toDate(text, undefined) : null;
  }
  // Human-readable calendar days have no publisher timezone; use a stable UTC day anchor.
  const human = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (human) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(human[1]!.slice(0, 3).toLowerCase());
    const day = toDate(`${text} UTC`, undefined);
    return day && day.getUTCMonth() === month && day.getUTCDate() === Number(human[2]) && day.getUTCFullYear() === Number(human[3]) ? day : null;
  }
  return null;
}

function findKey(obj: unknown, key: string, depth = 0): unknown {
  if (depth > 12 || obj === null || typeof obj !== "object") return undefined;
  if (!Array.isArray(obj) && key in (obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Flight arrays can contain nested arrays and brackets inside JSON strings. */
function flightArray(decoded: string, key: string): unknown[] | null {
  const property = `${JSON.stringify(key)}:`;
  let at = decoded.indexOf(property);
  while (at >= 0) {
    const start = at + property.length;
    const match = /^\s*\[/.exec(decoded.slice(start));
    if (match) {
      const arrayStart = start + match[0].length - 1;
      let depth = 0, inString = false, escaped = false;
      for (let i = arrayStart; i < decoded.length; i++) {
        const ch = decoded[i]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') inString = true;
        else if (ch === "[") depth++;
        else if (ch === "]" && --depth === 0) return JSON.parse(decoded.slice(arrayStart, i + 1));
      }
    }
    at = decoded.indexOf(property, at + property.length);
  }
  return null;
}

function embeddedJson(html: string, source: SourceRow): unknown {
  const mode = source.config.mode;
  if (mode === "html_window_var") {
    const name = String(source.config.windowVar);
    const re = new RegExp(`(?:window\\.)?${name.replace(/[$]/g, "\\$")}\\s*=\\s*`);
    const m = re.exec(html);
    if (!m) throw new FetchError(`window.${name} not found`);
    const start = m.index + m[0].length;
    // Balanced-brace scan to find the object literal's end.
    let depth = 0, inStr: string | null = null, esc = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return JSON.parse(html.slice(start, i + 1));
      }
    }
    throw new FetchError(`window.${name} not terminated`);
  }
  // html_json_key: scan JSON script blocks (e.g. __NEXT_DATA__) for the key.
  const key = String(source.config.jsonKey);
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1]!.trim();
    // Flight payloads carry the key escaped inside a string (\"items\").
    if (!body.includes(`"${key}"`) && !body.includes(`\\"${key}\\"`)) continue;
    const candidates = [body, body.replace(/^[^{[]*/, "").replace(/;?\s*$/, "")];
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c);
        const found = findKey(parsed, key);
        if (found) return { [key]: found };
      } catch {
        // Next.js flight payloads: self.__next_f.push([1,"..."])
      }
    }
    const flight = /"((?:[^"\\]|\\.)*)"\]\)\s*$/.exec(body);
    if (flight) {
      try {
        const decoded = JSON.parse(`"${flight[1]}"`) as string;
        const found = flightArray(decoded, key);
        if (found) return { [key]: found };
      } catch {
        // keep scanning
      }
    }
  }
  throw new FetchError(`embedded key ${key} not found`);
}

export async function fetchJsonList(source: SourceRow): Promise<Candidate[]> {
  const c = source.config;
  const url = String(c.url ?? "");
  const headers: Record<string, string> = { accept: "application/json, text/html;q=0.9",
    ...(c.userAgent ? { "user-agent": String(c.userAgent) } : {}), ...(c.headers ?? {}) };
  if (/^https:\/\/api\.github\.com\//.test(url)) {
    const token = credential("collectors", "GITHUB_TOKEN");
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await guardedFetch(url, {
    method: c.method ?? "GET",
    headers: c.bodyJson ? { ...headers, "content-type": "application/json" } : headers,
    body: c.bodyJson ? JSON.stringify(c.bodyJson) : undefined,
    timeoutMs: 25_000,
    ...(c.mode === "javascript_array" || c.mode === "html_script_array" || c.mode === "html_json_document" || c.mode === "framer_handover" ? { maxBytes: JAVASCRIPT_MAX_BYTES } : {}),
  });
  if (res.status !== 200) throw new FetchError(`HTTP ${res.status}`, res.status);
  let data: unknown;
  if (c.mode === "javascript_array") data = await javascriptArray(res.text(), c.arrayMatchKeys, c.arrayProjectionKeys, undefined, c.collectionKind, c.allowJoinedMarkdown === true);
  else if (c.mode === "html_script_array") data = await htmlScriptArray(res.text(), res.url, c, headers);
  else if (c.mode === "html_json_document") data = await htmlJsonDocument(res.text(), res.url, c);
  else if (c.mode === "framer_handover") data = framerHandover(res.text(), c.framerHandover);
  else if (c.mode === "html_json_key" || c.mode === "html_window_var") data = embeddedJson(res.text(), source);
  else {
    try {
      data = JSON.parse(res.text());
    } catch {
      throw new FetchError("response is not JSON");
    }
  }
  let items = c.itemsPath ? getPath(data, c.itemsPath) : c.jsonKey ? getPath(data, c.jsonKey) : data;
  if (c.itemsObjectValues && items && typeof items === "object" && !Array.isArray(items)) items = Object.values(items);
  if (!Array.isArray(items)) throw new FetchError("items path did not resolve to an array");
  const urlLookup = await publicUrlLookup(c, res.url);

  const out: Candidate[] = [];
  for (const item of items) {
    if (c.requireBoolean && getPath(item, c.requireBoolean.path) !== c.requireBoolean.equals) continue;
    if (c.minNumeric && !(Number(getPath(item, c.minNumeric.path)) >= Number(c.minNumeric.min))) continue;
    const title = firstString(item, c.titlePaths);
    const url = (urlLookup && urlLookup.get(String(getPath(item, c.urlLookup.itemKeyPath)))) ||
      (c.urlTemplate && renderTemplate(c.urlTemplate, item)) || (c.urlTemplateFallback && renderTemplate(c.urlTemplateFallback, item));
    if (!title || !url) continue;
    const externalId = c.externalIdPath ? getPath(item, c.externalIdPath) : null;
    const summary = c.summaryBlocksPath ? textBlocks(getPath(item, c.summaryBlocksPath), c.summaryBlocksFormat) : firstString(item, c.summaryPaths);
    const raw = item && typeof item === "object" ? { ...(item as Record<string, unknown>) } : { value: item };
    for (const k of c.rawDropKeys ?? []) delete (raw as Record<string, unknown>)[k];
    const summaryIsBody = c.summaryIsBody === true && !!summary;
    out.push({
      url,
      ...(c.preserveUrlFragment === true ? { identityKey: identityKeyForUrl(url, { keepFragment: true }) ?? undefined } : {}),
      title: collapseWhitespace(stripTags(title)),
      author: firstString(item, c.authorPaths),
      // A month-only static newsletter label is not a publication day. Never substitute fetch time.
      publishedAt: !c.publishedAtPath ? null : (c.mode === "javascript_array" || c.mode === "html_script_array" || c.mode === "html_json_document" || c.mode === "framer_handover")
        ? staticDate(getPath(item, c.publishedAtPath), c.publishedAtUnit)
        : toDate(getPath(item, c.publishedAtPath), c.publishedAtUnit),
      excerpt: summary ? collapseWhitespace(c.summaryBlocksPath ? summary : stripTags(summary)).slice(0, 2000) : null,
      bodyText: summaryIsBody ? (c.summaryBlocksPath ? summary! : stripTags(summary!)) : null,
      bodyStatus: summaryIsBody ? "ok" : "pending",
      raw: { externalId: externalId ?? null },
    });
  }
  if (items.length > 0 && out.length === 0 && !c.requireBoolean && !c.minNumeric) throw new FetchError("no items mapped (check title/url paths)");
  return out;
}
