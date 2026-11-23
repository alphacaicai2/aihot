import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { sha256, stableJson } from '@aihot/backend/lib/ids';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { collectSource } from '@aihot/backend/sources/collect';
import { previewSource } from '@aihot/backend/admin/sources';

const T = tag();
let version = 1;
let broken = false;
let redirectNew = false;
const requests: Array<{ path: string; etag?: string; modified?: string }> = [];
let burstBarrier: (() => Promise<void>) | undefined;
const burstDate = new Date().toUTCString();
const modified = 'Mon, 28 Sep 2026 10:00:00 GMT';
const server = http.createServer(async (req, res) => {
  const path = req.url ?? '/';
  requests.push({ path, etag: req.headers['if-none-match'], modified: req.headers['if-modified-since'] });
  if (path === '/redirect') { res.writeHead(302, { location: redirectNew ? '/new.xml' : '/old.xml' }); res.end(); return; }
  if (path === '/burst.xml' && burstBarrier) await burstBarrier();
  const etag = path === '/modified.xml' ? undefined : path === '/feed.xml' ? `"v${version}"` : '"shared"';
  if ((etag && req.headers['if-none-match'] === etag) || (!etag && req.headers['if-modified-since'] === modified)) {
    res.writeHead(304, { ...(etag ? { etag } : {}), 'last-modified': modified }); res.end(); return;
  }
  const entries = Array.from({ length: path === '/feed.xml' ? 40 : path === '/burst.xml' ? 122 : path === '/retry.xml' ? 61 : 1 }, (_, i) =>
    `<item><title>Entry ${i} ${path === '/feed.xml' && i === 0 ? version : path} ${T}</title><link>https://example.org/rss-conditional-${T}/${path.replaceAll('/', '')}/${i}</link><pubDate>${path === '/burst.xml' ? burstDate : new Date(Date.now() - 1000 * i).toUTCString()}</pubDate></item>`).join('');
  res.writeHead(200, { 'content-type': 'application/rss+xml', ...(etag ? { etag } : {}), 'last-modified': modified });
  res.end(broken ? '<not-feed/>' : `<rss version="2.0"><channel><title>Feed</title>${entries}</channel></rss>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });
async function source(id: string, path: string, initialized = true) {
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'RSS conditional test','rss',${sql.json({ feedUrl: base + path })},'T1','editorial',${initialized ? sql.json({ initializedAt: new Date().toISOString() }) : null},'2100-01-01')`;
}
const cursor = async (id: string) => (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor;

test('RSS first backfill, ordinary window, 304, revision and config edits preserve collection behavior', async () => {
  const id = `rss-conditional-${T}`;
  await source(id, '/feed.xml', false);
  assert.equal((await collectSource(id)).created, 30);
  assert.equal((await cursor(id)).rss, undefined, 'the first backfill cap must not freeze the ordinary window');
  assert.equal((await collectSource(id)).created, 10);
  assert.equal((await cursor(id)).rss.etag, '"v1"');
  const third = await collectSource(id);
  assert.deepEqual([third.status, third.found, third.created, third.revised], ['ok', 0, 0, 0]);
  assert.equal(requests.at(-1)!.etag, '"v1"');
  const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(run!.detail, { notModified: true, httpStatus: 304 });
  const [healthy] = await sql`SELECT health,fail_count FROM sources WHERE id=${id}`;
  assert.deepEqual({ ...healthy }, { health: 'ok', fail_count: 0 });
  version = 2;
  assert.equal((await collectSource(id)).revised, 1, 'a changed feed is parsed and stored normally');
  await sql`UPDATE sources SET config=config || '{"summaryIsBody":true}'::jsonb WHERE id=${id}`;
  assert.equal((await collectSource(id)).status, 'ok');
  assert.equal(requests.at(-1)!.etag, undefined, 'config edits must reprocess unchanged bytes');
  await collectSource(id, { force: true });
  assert.equal(requests.at(-1)!.etag, undefined, 'manual recollection bypasses validation');
  const [saved] = await sql`SELECT id,kind,config,cursor FROM sources WHERE id=${id}`;
  assert.equal((await previewSource(saved as never)).count, 40, 'preview still returns items for an unchanged feed');
  assert.equal(requests.at(-1)!.etag, undefined);
  const beforeFailure = await cursor(id);
  version = 3; broken = true;
  assert.equal((await collectSource(id)).status, 'failed');
  assert.deepEqual(await cursor(id), beforeFailure, 'failed parsing never advances the success validator');
  broken = false;
  assert.equal((await collectSource(id)).revised, 1);
  assert.equal(requests.at(-1)!.etag, '"v2"');
});

test('Last-Modified works without ETag and changing redirect targets cannot accept an unrelated 304', async () => {
  const lm = `rss-modified-${T}`;
  await source(lm, '/modified.xml');
  assert.equal((await collectSource(lm)).created, 1);
  assert.equal((await collectSource(lm)).found, 0);
  assert.equal(requests.at(-1)!.modified, modified);
  const redirect = `rss-redirect-${T}`;
  await source(redirect, '/redirect');
  assert.equal((await collectSource(redirect)).created, 1);
  redirectNew = true;
  assert.equal((await collectSource(redirect)).created, 1, 'new destination is fetched without old destination validators');
  assert.equal(requests.at(-1)!.path, '/new.xml');
  assert.equal(requests.at(-1)!.etag, undefined);
});

test('a native RSS burst drains durable pages in order before conditional polling resumes', async () => {
  const id = `rss-burst-${T}`;
  const hits = () => requests.filter(r => r.path === '/burst.xml').length;
  await source(id, '/burst.xml');
  // Simulate an old collector which had already acknowledged the full response.
  const legacy = { configHash: sha256(stableJson({ feedUrl: base + '/burst.xml' })),
    etag: '"shared"', lastModified: null, responseUrl: base + '/burst.xml' };
  await sql`UPDATE sources SET cursor=cursor || ${sql.json({ rss: legacy })} WHERE id=${id}`;
  // Make both jobs fetch from the same cursor before either can commit its snapshot.
  let received = 0;
  const both = Promise.withResolvers<void>();
  burstBarrier = () => { if (++received === 2) both.resolve(); return both.promise; };
  const concurrent = await Promise.all([collectSource(id), collectSource(id)]).finally(() => { burstBarrier = undefined; });
  assert.equal(concurrent.reduce((n, r) => n + r.created, 0), 60);
  const afterFirst = await cursor(id);
  assert.deepEqual(afterFirst.rss, legacy);
  assert.ok(requests.filter(r => r.path === '/burst.xml').every(r => !r.etag), 're-read the legacy window once');
  assert.equal(afterFirst.rssBacklog.nextPage, 1);
  const pages = async () => (await sql`SELECT jsonb_array_length(entries) AS n FROM source_rss_pages
    WHERE source_id=${id} ORDER BY page`).map(r => r.n);
  assert.deepEqual(await pages(), [60, 2]);
  const initialReads = hits();
  // Even if the feed disappears, workers restart from the captured material.
  broken = true;
  try {
    assert.equal((await collectSource(id)).created, 60);
    assert.deepEqual((await cursor(id)).rss, legacy);
    assert.deepEqual(await pages(), [2]);
    assert.equal((await collectSource(id)).created, 2);
    assert.equal(hits(), initialReads);
  } finally { broken = false; }
  assert.deepEqual(await pages(), []);
  const final = await cursor(id);
  assert.equal(final.rssBacklog, undefined);
  assert.equal(final.rss.etag, '"shared"');
  assert.equal((await collectSource(id)).found, 0);
  assert.equal(requests.at(-1)!.etag, '"shared"');
  const [last] = await sql`SELECT published_at FROM articles WHERE source_id=${id} AND url LIKE '%/121'`;
  assert.equal(last!.published_at.toUTCString(), burstDate);
});

test('a failed first page is retried from the stored feed after the publisher drops it', async () => {
  const id = `rss-retry-${T}`;
  await source(id, '/retry.xml');
  await sql`ALTER TABLE articles ADD CONSTRAINT rss_test_page_write CHECK (url NOT LIKE '%/retry.xml/30') NOT VALID`;
  try {
    assert.equal((await collectSource(id)).status, 'failed');
    assert.equal((await cursor(id)).rssBacklog.nextPage, 0);
    assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${id}`)[0]!.n, 0);
  } finally {
    await sql`ALTER TABLE articles DROP CONSTRAINT rss_test_page_write`;
  }
  const before = requests.filter(r => r.path === '/retry.xml').length;
  broken = true;
  try {
    assert.equal((await collectSource(id)).created, 60);
    assert.equal((await collectSource(id)).created, 1);
  } finally { broken = false; }
  assert.equal(requests.filter(r => r.path === '/retry.xml').length, before);
  assert.equal((await cursor(id)).rssBacklog, undefined);
});
