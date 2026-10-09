import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { feedIdentity, importOpml, parseOpml } from "@aihot/backend/sources/opml";

after(closeDb);

test("OPML preserves nested folders, decodes names and rejects invalid subscription addresses", () => {
  const result = parseOpml(`<opml version="2.0"><body><outline text="AI"><outline text="Tools">
    <outline title="A &amp; B" xmlUrl="https://example.com/feed/?b=2&amp;a=1" />
    <outline text="Duplicate" xmlUrl="https://example.com/feed?a=1&amp;b=2#rss" />
    <outline text="Local file" xmlUrl="file:///tmp/rss" />
    <outline text="Credentials" xmlUrl="https://user:secret@example.com/rss" />
    <outline text="Other query" xmlUrl="https://example.com/feed?source=other" />
  </outline></outline></body></opml>`);
  assert.equal(result.invalid, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.feeds.length, 2);
  assert.equal(result.feeds[0]!.name, "A & B");
  assert.deepEqual(result.feeds[0]!.folders, ["AI", "Tools"]);
  assert.notEqual(feedIdentity("https://example.com/rss?source=a"), feedIdentity("https://example.com/rss?source=b"));
  assert.throws(() => parseOpml("<opml><body>"));
  assert.throws(() => parseOpml('<!DOCTYPE opml [<!ENTITY a SYSTEM "file:///etc/passwd">]><opml><body/></opml>'));
});

test("repeated OPML imports and Miniflux overlaps preserve existing admin choices", async () => {
  const label = `opml-${tag()}`;
  const mfId = 987654321;
  const mfSource = `${label}-existing`;
  await sql`INSERT INTO sources (id, name, kind, config, enabled) VALUES
    (${mfSource}, 'Keep this name', 'rss', ${sql.json({ minifluxFeedId: mfId })}, false)`;
  const feeds = [
    { name: "Shared", url: `https://example.com/${label}/shared`, folders: [] },
    { name: "New", url: `https://example.com/${label}/new`, folders: ["AI"] },
  ];
  const opts = { label, minifluxFeeds: [{ id: mfId, feed_url: feeds[0]!.url }] };
  const preview = await importOpml(feeds, { ...opts, dryRun: true });
  assert.deepEqual([preview.added, preview.skipped], [1, 1]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM sources WHERE imported_from = ${`opml:${label}`}`)[0]!.n, 0);
  const result = await importOpml(feeds, opts);
  assert.deepEqual([result.added, result.skipped], [1, 1]);
  const id = result.ids[0]!;
  await sql`UPDATE sources SET name = 'My edit', enabled = false, interval_minutes = 120 WHERE id = ${id}`;
  const again = await importOpml(feeds, opts);
  assert.deepEqual([again.added, again.skipped], [0, 2]);
  const [source] = await sql`SELECT name, enabled, interval_minutes, site_fulltext, syndicate_fulltext FROM sources WHERE id = ${id}`;
  assert.deepEqual(source, { name: "My edit", enabled: false, interval_minutes: 120, site_fulltext: false, syndicate_fulltext: false });
  assert.equal((await sql`SELECT name FROM sources WHERE id = ${mfSource}`)[0]!.name, "Keep this name");
});
