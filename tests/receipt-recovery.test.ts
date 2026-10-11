import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { paidRequest } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts, runsOverview } from "@aihot/backend/admin/runs";
import { recoverReceiptWork, recoverFallbackWork } from "@aihot/backend/jobs/receipt-recovery";
import { ensureQueue, enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { sha256, stableJson } from "@aihot/backend/lib/ids";

const source = `receipt-recovery-${tag()}`;
let sends = 0;
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${source},'Recovery tests','rss','T1','editorial','2100-01-01')`;
  for (const q of [QUEUES.analyze, QUEUES.group, QUEUES.digest]) await ensureQueue(q);
});
after(async () => { await stopBoss(); await closeDb(); });

async function article() {
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/recovery/${tag()}`,
    title: 'Recovery test', bodyText: 'A source report.', bodyStatus: 'ok', via: 'fetch', publishedAt: new Date() });
  await sql`UPDATE articles SET processing_state='failed' WHERE id=${articleId}`;
  return articleId;
}

async function lost(purpose: string, subject: string, attemptTag = "0") {
  const req = { service: 'receipt-recovery-test', model: 'primary', purpose, subject, identity: { test: tag() }, attemptTag };
  await assert.rejects(paidRequest(req, async () => {
    sends++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('private detail'), { code: 'ECONNRESET', syscall: 'read' }) });
  }));
  const [r] = await sql<{ id: number; logical_key: string }[]>`SELECT id,logical_key FROM receipts WHERE subject=${subject} AND service=${req.service} ORDER BY id DESC LIMIT 1`;
  return r!;
}

async function fallback(r: { id: number; logical_key: string }, status: string | null = 'received', primaryId: number | null = r.id) {
  let id: number | null = null;
  if (status) {
    const [original] = await sql`SELECT purpose,subject FROM receipts WHERE id=${r.id}`;
    const saved = await paidRequest({ service: 'receipt-recovery-test', model: 'fallback', purpose: original!.purpose,
      subject: original!.subject, identity: { test: tag() }, attemptTag: /:[a-f0-9]{64}:(.+)$/.exec(r.logical_key)![1] }, async () => {
      sends++; return { response: { ok: true } };
    });
    id = saved.receiptId;
    await sql`UPDATE receipts SET status=${status} WHERE id=${id}`;
  }
  await sql`INSERT INTO model_fallback_routes(primary_key,fallback_model,primary_receipt_id,fallback_receipt_id,reason)
    VALUES (${r.logical_key},'deepseek-flash',${primaryId},${id},'test route')`;
  return id;
}

const jobs = (id: string, queue: string = QUEUES.analyze) => sql`SELECT * FROM pgboss.job WHERE name=${queue} AND data->>'articleId'=${id}`;

test('automatic release preserves the failed attempt and resumes a split analysis step exactly once', async () => {
  const id = await article();
  const r = await lost('score_article', `article:${id}@1`, 'score-1');
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${r.id}`;
  const sent = sends;
  await autoReleaseUnknownReceipts();
  assert.equal((await jobs(id)).length, 1);
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${id}`)[0]!.processing_state, 'new');
  const [attempt] = await sql`SELECT status,error,release_note,released_at FROM receipt_attempts WHERE receipt_id=${r.id}`;
  assert.equal(attempt!.status, 'unknown');
  assert.match(attempt!.error, /ECONNRESET/);
  assert.doesNotMatch(attempt!.error, /private detail/);
  assert.match(attempt!.release_note, /自动放行/);
  assert.ok(attempt!.released_at);
  assert.equal((await recoverReceiptWork(r.id)).state, 'in-flight');
  assert.equal(sends, sent);
});

test('a saved fallback response resumes unfinished work without releasing or resending the primary', async () => {
  const id = await article();
  const r = await lost('structure_article', `article:${id}@1`, 'structure');
  await fallback(r);
  const sent = sends;
  const results = await Promise.all([recoverReceiptWork(r.id), recoverReceiptWork(r.id)]);
  assert.equal(results.filter(x => x.requeued).length, 1);
  assert.equal((await jobs(id)).length, 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${r.id}`)[0]!.status, 'unknown');
  assert.equal(sends, sent);
});

test('the fallback sweep also finds a saved response when the circuit skipped the primary entirely', async () => {
  const id = await article();
  const r = await lost('structure_article', `article:${id}@1`, 'structure');
  await fallback(r, 'received', null);
  const sent = sends;
  assert.ok((await recoverFallbackWork()).requeued >= 1);
  assert.equal((await jobs(id)).length, 1);
  assert.equal(sends, sent);
});

test('an un-routed default-model unknown is preserved and resumed through an independent fallback', async () => {
  const keys = ['LLM_MODEL','LLM_BASE_URL','LLM_API_KEY','LLM_FALLBACK_MODEL','DEEPSEEK_BASE_URL','DEEPSEEK_API_KEY'];
  const saved = Object.fromEntries(keys.map(k => [k,process.env[k]]));
  Object.assign(process.env, { LLM_MODEL:'recovery-primary',LLM_BASE_URL:'http://127.0.0.1:9',LLM_API_KEY:'test-key',
    LLM_FALLBACK_MODEL:'deepseek-flash',DEEPSEEK_BASE_URL:'http://127.0.0.1:9',DEEPSEEK_API_KEY:'test-key' });
  try {
    const id = await article();
    const subject = `article:${id}@1`;
    await assert.rejects(paidRequest({ service:'llm',model:'recovery-primary',purpose:'prefilter_article',subject,identity:{ test:tag() } },
      async () => { sends++; throw new Error('lost original response'); }));
    const [r] = await sql<{ id:number }[]>`SELECT id FROM receipts WHERE subject=${subject} AND service='llm'`;
    await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${r!.id}`;
    const sent = sends;
    await autoReleaseUnknownReceipts();
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${r!.id}`)[0]!.status,'unknown');
    await recoverFallbackWork();
    assert.equal((await jobs(id)).length,1);
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${r!.id}`)[0]!.status,'unknown');
    const [route] = await sql`SELECT fallback_model,fallback_receipt_id FROM model_fallback_routes WHERE primary_receipt_id=${r!.id}`;
    assert.equal(route!.fallback_model,'deepseek-flash');
    assert.equal(route!.fallback_receipt_id,null);
    assert.equal(sends,sent,'recovery itself must not call either provider');
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k]=saved[k];
  }
});

test('completed and newer article inputs do not replay an old uncertain step', async () => {
  for (const state of ['analyzed', 'blocked']) {
    const id = await article();
    const r = await lost('summarize_article', `article:${id}@1`, 'summarize');
    await fallback(r, 'completed');
    await sql`UPDATE articles SET processing_state=${state} WHERE id=${id}`;
    assert.equal((await recoverReceiptWork(r.id)).state, 'settled');
    assert.equal((await jobs(id)).length, 0);
  }
  const id = await article();
  const r = await lost('structure_article', `article:${id}@1`, 'structure');
  await fallback(r);
  await sql`UPDATE articles SET revision=2 WHERE id=${id}`;
  assert.equal((await recoverReceiptWork(r.id)).state, 'stale');
  assert.equal((await jobs(id)).length, 0);
});

test('unknown and pending fallbacks, and manually tagged evaluations, are not automatically retried', async () => {
  for (const status of ['unknown', 'pending']) {
    const id = await article();
    const r = await lost('score_article', `article:${id}@1`, 'score-1');
    await fallback(r, status);
    assert.equal((await recoverReceiptWork(r.id)).state, 'blocked');
    assert.equal((await jobs(id)).length, 0);
  }
  const id = await article();
  const r = await lost('score_article', `article:${id}@1`, 'manual-eval:score-1');
  await fallback(r);
  assert.equal((await recoverReceiptWork(r.id)).state, 'unsupported');
  assert.equal((await jobs(id)).length, 0);
  const rejected = await article();
  const original = await lost('structure_article', `article:${rejected}@1`, 'structure');
  const fid = await fallback(original, 'failed');
  await sql`UPDATE receipts SET error='HTTP 401: invalid key' WHERE id=${fid}`;
  assert.equal((await recoverReceiptWork(original.id)).state, 'blocked');
  assert.equal((await jobs(rejected)).length, 0);
});

test('event recovery queues grouping only when the article is not already grouped', async () => {
  const id = await article();
  const r = await lost('group_article', `article:${id}`);
  await fallback(r, 'completed');
  assert.ok((await recoverReceiptWork(r.id)).requeued);
  assert.equal((await jobs(id, QUEUES.group)).length, 1);
  assert.equal((await jobs(id)).length, 0);
  const done = await article();
  const old = await lost('group_article', `article:${done}`);
  await fallback(old, 'completed');
  await sql`UPDATE articles SET grouped_at=now() WHERE id=${done}`;
  assert.equal((await recoverReceiptWork(old.id)).state, 'settled');
  assert.equal((await jobs(done, QUEUES.group)).length, 0);
});

test('digest recovery checks current public inputs before queuing any work', async () => {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title) VALUES (${randomUUID()},'Recovery story') RETURNING id`;
  const sid = story!.id;
  const r = await lost('story_digest', `story:${sid}@1`);
  await fallback(r, 'completed');
  assert.equal((await recoverReceiptWork(r.id)).state, 'settled', 'no eligible reports');
  const id = await article();
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES (${id},1,'rule','pass','ai-models','Test title','Test summary',80,true)`;
  await publishArticle(id);
  await sql`UPDATE publications SET visibility='public',eligible=true WHERE article_id=${id}`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES (${tag()},${sid},'Test fact') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${fact!.id},${id},'report')`;
  const [p] = await sql`SELECT title,summary FROM publications WHERE article_id=${id}`;
  const hash = sha256(stableJson([[id,p!.title,p!.summary ?? '']]));
  await sql`INSERT INTO story_digests(story_id,version,digest,article_ids,inputs_hash) VALUES (${sid},1,'Saved digest',${[id]},${hash})`;
  assert.equal((await recoverReceiptWork(r.id)).state, 'settled', 'unchanged saved inputs');
  await sql`UPDATE publications SET summary='Changed summary' WHERE article_id=${id}`;
  assert.ok((await recoverReceiptWork(r.id)).requeued);
  const queued = await sql`SELECT * FROM pgboss.job WHERE name=${QUEUES.digest} AND data->>'storyId'=${String(sid)}`;
  assert.equal(queued.length, 1);
});

test('runs overview counts all unknown receipts and separates recovered history from current failures', async () => {
  const baseline = await runsOverview();
  for (let i = 0; i < 45; i++) await lost('overview_test', `overview:${tag()}`);
  const id = await article();
  const job = await enqueue(QUEUES.group, { articleId: id }, { singletonKey: `failure:${id}` });
  await sql`UPDATE pgboss.job SET state='failed',completed_on=now()-interval '1 minute',output=${sql.json({ message: 'original failure' })} WHERE id=${job}`;
  const success = await enqueue(QUEUES.group, { articleId: id }, { singletonKey: `success:${id}` });
  await sql`UPDATE pgboss.job SET state='completed',completed_on=now() WHERE id=${success}`;
  const view = await runsOverview();
  assert.equal(view.receipts.recovery.unknown, baseline.receipts.recovery.unknown + 45);
  assert.equal(view.receipts.issues.length, 40);
  const group = view.failedJobs.find(x => x.name === QUEUES.group)!;
  assert.ok(group.recovered >= 1);
  assert.equal(group.recovered + group.unresolved, group.failed);
});
