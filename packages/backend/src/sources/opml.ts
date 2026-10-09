// OPML is a subscription list, not an article feed. Turn its leaves into ordinary RSS sources.
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

export interface OpmlFeed { name: string; url: string; folders: string[] }

/** Keep feed query parameters: they can identify different subscriptions on the same service. */
export function feedIdentity(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
    u.hash = "";
    u.searchParams.sort();
    if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch { return null; }
}

export function parseOpml(xml: string): { feeds: OpmlFeed[]; invalid: number; duplicates: number } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid OPML XML");
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseAttributeValue: false }).parse(xml);
  if (!doc.opml?.body) throw new Error("OPML body missing");
  const feeds: OpmlFeed[] = [];
  const seen = new Set<string>();
  let invalid = 0, duplicates = 0;
  const walk = (nodes: any, folders: string[]) => {
    for (const node of Array.isArray(nodes) ? nodes : nodes ? [nodes] : []) {
      const name = String(node["@title"] || node["@text"] || "").trim();
      if (node["@xmlUrl"] !== undefined) {
        const url = feedIdentity(String(node["@xmlUrl"]));
        if (!url) invalid++;
        else if (seen.has(url)) duplicates++;
        else {
          seen.add(url);
          feeds.push({ name: (name || new URL(url).hostname).slice(0, 200), url, folders });
        }
      }
      if (node.outline) walk(node.outline, node["@xmlUrl"] === undefined && name ? [...folders, name] : folders);
    }
  };
  walk(doc.opml.body.outline, []);
  return { feeds, invalid, duplicates };
}

export async function importOpml(feeds: OpmlFeed[], opts: {
  label: string; dryRun?: boolean; minifluxFeeds?: Array<{ id: number; feed_url?: string }>;
}) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(opts.label)) throw new Error("Use a short lowercase import label");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('opml-source-import'))`;
    const existing = await tx<{ id: string; config: Record<string, any> }[]>`SELECT id, config FROM sources WHERE kind = 'rss'`;
    const upstream = new Map((opts.minifluxFeeds ?? []).map((f) => [f.id, f.feed_url]));
    const known = new Map<string, string>();
    for (const s of existing) {
      const url = feedIdentity(String(s.config.feedUrl ?? upstream.get(Number(s.config.minifluxFeedId)) ?? ""));
      if (url) known.set(url, s.id);
    }
    let added = 0, skipped = 0;
    const ids: string[] = [];
    for (const feed of feeds) {
      const url = feedIdentity(feed.url);
      if (!url) throw new Error("Invalid feed in OPML import");
      if (known.has(url)) { skipped++; continue; }
      const id = `${opts.label}-${sha256(url).slice(0, 20)}`;
      if (existing.some((s) => s.id === id)) { skipped++; continue; }
      if (!opts.dryRun) {
        const inserted = await tx`
          INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, tags,
                               site_fulltext, syndicate_fulltext, imported_from, next_fetch_at)
          VALUES (${id}, ${feed.name}, 'rss',
                  ${tx.json({ feedUrl: feed.url, sortByPublishedAt: true, _aihot: { initialBackfillLimit: 5, initialBackfillMonths: 1 } })},
                  'T2', 'editorial', 60, ${[opts.label, ...feed.folders].map((t) => t.slice(0, 60)).slice(0, 30)},
                  false, false, ${`opml:${opts.label}`}, now() + interval '10 minutes')
          ON CONFLICT (id) DO NOTHING RETURNING id`;
        if (!inserted.length) { skipped++; continue; }
      }
      known.set(url, id);
      ids.push(id);
      added++;
    }
    return { added, skipped, ids };
  });
}
