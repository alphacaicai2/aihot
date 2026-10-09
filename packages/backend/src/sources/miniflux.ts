// Read the user's existing Miniflux subscriptions, without changing entries or subscriptions.
// This is an RSS reader adapter: normal collection owns storage, revisions, queues and health.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { stripTags } from "../lib/text.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import type { RssRead } from "./rss.ts";

export interface MinifluxFeed {
  id: number;
  title: string;
  feed_url?: string;
  disabled?: boolean;
  parsing_error_count?: number;
  category?: { title: string };
}

interface Entry {
  id: number;
  title: string;
  url: string;
  content?: string;
  author?: string;
  published_at?: string;
  changed_at?: string;
}

interface Scan {
  since: number;
  until: number;
  afterId: number;
  baseline: boolean;
}

const PAGE_SIZE = 60; // collectSource stores at most 60: never advance past unstored material.

function connection() {
  const file = credential("collectors", "MINIFLUX_ENV_FILE");
  const saved = file ? parseEnv(readFileSync(file, "utf8")) : {};
  const value = (key: string) => credential("collectors", key) ?? saved[key];
  const address = value("MINIFLUX_BASE_URL");
  if (!address) throw new FetchError("MINIFLUX_BASE_URL missing: set it directly or in MINIFLUX_ENV_FILE");
  const base = new URL(address);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new FetchError("MINIFLUX_BASE_URL must be an HTTP(S) address without credentials or query parameters");
  }
  const token = value("MINIFLUX_TOKEN");
  const username = value("MINIFLUX_USERNAME");
  const password = value("MINIFLUX_PASSWORD");
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers["X-Auth-Token"] = token;
  else if (username && password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  else throw new FetchError("Miniflux credentials missing: set MINIFLUX_TOKEN or MINIFLUX_ENV_FILE");
  return { base: base.toString().replace(/\/+$/, ""), headers };
}

async function read<T>(path: string, params: Record<string, number | string> = {}): Promise<T> {
  const { base, headers } = connection();
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  // Removed entries are deliberately not ingested; read/unread state has no influence on coverage.
  if (path.endsWith("/entries")) {
    url.searchParams.append("status", "read");
    url.searchParams.append("status", "unread");
  }
  try {
    const res = await guardedFetch(url.toString(), { headers, route: "direct", timeoutMs: 30_000, maxRedirects: 0 });
    if (res.status !== 200) throw new FetchError(`Miniflux HTTP ${res.status}`, res.status);
    return JSON.parse(res.text()) as T;
  } catch (error) {
    if (error instanceof FetchError) throw error;
    // Upstream errors can contain URLs or credentials. Never persist the raw error message.
    throw new FetchError(`Miniflux request failed (${error instanceof Error ? error.name : "unknown"})`);
  }
}

export async function listMinifluxFeeds(): Promise<MinifluxFeed[]> {
  const feeds = await read<MinifluxFeed[]>("/v1/feeds");
  if (!Array.isArray(feeds) || feeds.some((f) => !Number.isSafeInteger(f.id) || f.id <= 0 || typeof f.title !== "string")) {
    throw new FetchError("Miniflux returned invalid subscriptions");
  }
  return feeds;
}

export async function fetchMiniflux(source: SourceRow): Promise<RssRead> {
  const id = Number(source.config.minifluxFeedId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new FetchError("minifluxFeedId must be a positive integer");
  const feed = await read<MinifluxFeed>(`/v1/feeds/${id}`);
  if (feed.id !== id) throw new FetchError("Miniflux returned the wrong subscription");
  if (feed.disabled) throw new FetchError("This subscription is paused in Miniflux");
  const configHash = sha256(stableJson(source.config));
  const previous = source.cursor?.rss?.configHash === configHash ? source.cursor.rss.miniflux : null;
  const now = Math.floor(Date.now() / 1000);
  const days = Number(source.config.minifluxLookbackDays ?? 2);
  if (!Number.isFinite(days) || days < 1 || days > 30) throw new FetchError("minifluxLookbackDays must be between 1 and 30");
  const scan: Scan = previous?.pending ?? {
    since: previous?.completedUntil ? previous.completedUntil - 60 : now - days * 86400,
    until: now + 1,
    afterId: 0,
    baseline: !previous?.completedUntil,
  };
  const pageSize = source.cursor?.initializedAt ? PAGE_SIZE : Math.max(1, Math.min(PAGE_SIZE, Number(source.config._aihot?.initialBackfillLimit ?? 30)));
  const page = await read<{ entries: Entry[] }>(`/v1/feeds/${id}/entries`, {
    order: "id", direction: "asc", limit: pageSize, after_entry_id: scan.afterId,
    ...(scan.baseline ? { published_after: scan.since } : { changed_after: scan.since }),
    changed_before: scan.until,
  });
  if (!Array.isArray(page.entries) || page.entries.length > pageSize) throw new FetchError("Miniflux returned invalid entries");
  const candidates: Candidate[] = [];
  let lastId = scan.afterId;
  for (const e of page.entries) {
    if (!Number.isSafeInteger(e.id) || e.id <= lastId || typeof e.url !== "string" || typeof e.title !== "string") {
      throw new FetchError("Miniflux returned unordered or invalid entries");
    }
    lastId = e.id;
    const url = new URL(e.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !e.title.trim()) continue;
    const html = sanitizeBody(e.content ?? "", e.url);
    const text = stripTags(html);
    // RSS content is not automatically a full article, even when Miniflux's crawler was enabled.
    const full = source.config.summaryIsBody === true && text.length > 280;
    const date = new Date(e.published_at ?? "");
    const updated = new Date(e.changed_at ?? "");
    candidates.push({
      url: e.url, title: e.title, author: e.author ?? null,
      publishedAt: Number.isFinite(date.getTime()) ? date : null,
      sourceUpdatedAt: Number.isFinite(updated.getTime()) ? updated : null,
      excerpt: full ? null : text || null,
      bodyHtml: full ? html : null, bodyText: full ? text : null,
      bodyStatus: full ? "ok" : "unconfirmed",
      backfill: scan.baseline ? "miniflux-baseline" : null,
      raw: { miniflux: { feedId: id, entryId: e.id, contentKind: full ? "body" : "feed-content" } },
    });
  }
  const pending = page.entries.length === pageSize ? { ...scan, afterId: lastId } : null;
  const errors = Number(feed.parsing_error_count ?? 0);
  return {
    candidates, notModified: false,
    warning: errors > 0 ? `Miniflux upstream feed has ${errors} fetch errors; cached entries remain readable` : null,
    validator: {
      configHash, responseUrl: `miniflux:feed:${id}`, etag: null, lastModified: null,
      miniflux: { pending, completedUntil: pending ? previous?.completedUntil ?? null : scan.until },
    },
  };
}
