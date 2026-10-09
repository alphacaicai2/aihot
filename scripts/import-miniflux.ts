// Imports source identities only; credentials, feed URLs and private upstream fields stay out of SQL.
// node --env-file=.env scripts/import-miniflux.ts [--dry-run]
import { sql, closeDb } from "@aihot/backend/db";
import { listMinifluxFeeds } from "@aihot/backend/sources/miniflux";

try {
  const feeds = await listMinifluxFeeds();
  const active = feeds.filter((f) => !f.disabled);
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({ sources: active.length, disabled: feeds.length - active.length, upstreamErrors: active.filter((f) => f.parsing_error_count).length }));
  } else {
    let added = 0;
    for (const f of active) {
      const rows = await sql`
        INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, tags,
                             site_fulltext, syndicate_fulltext, imported_from, next_fetch_at)
        VALUES (${`miniflux-${f.id}`}, ${f.title.slice(0, 200)}, 'rss',
                ${sql.json({ minifluxFeedId: f.id, minifluxLookbackDays: 2, _aihot: { initialBackfillLimit: 60 } })},
                'T2', 'editorial', 30, ${["miniflux", ...(f.category?.title ? [f.category.title] : [])]},
                false, false, 'miniflux', now())
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      added += rows.length;
    }
    console.log(JSON.stringify({ sources: active.length, added, existing: active.length - added }));
  }
} finally {
  await closeDb();
}
