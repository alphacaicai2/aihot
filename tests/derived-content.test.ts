// Editorial changes must stop showing obsolete generated claims before another paid answer arrives.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle, publishArticleTx, republishSource } from "@aihot/backend/publication/publish";
import { overrideFields, setVisibility, detachFromFact } from "@aihot/backend/admin/content";
import { composeStoryDigest, storyDigestNeedsUpdate } from "@aihot/backend/events/digest";
import { mergeStoryInto } from "@aihot/backend/events/merge";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { buildApp } from "../apps/api/src/app.ts";

const source = `derived-${tag()}`;
const oldClaim = `OBSOLETE_CLAIM_${tag()}`;
const newClaim = `CORRECTED_CLAIM_${tag()}`;
const provider = await stub(() => ({ id: 'derived-stub', choices: [{ message: { content: JSON.stringify({ title: newClaim, digest: newClaim, latest: newClaim }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = 'test-key';
const app = await buildApp();
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${source},'Derived tests','rss','T1','editorial','2100-01-01')`;
});
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

async function report() {
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/derived/${tag()}`,
    title: 'Source report', bodyText: 'A source report.', bodyStatus: 'ok', via: 'fetch', publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','ai-models','公开报道标题','公开报道摘要',80,false)`;
  await publishArticle(articleId);
  return articleId;
}
async function fixture(origin = 'model') {
  const ids = [await report(), await report()];
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title,origin) VALUES (${publicId},${origin==='manual'?'编辑指定的标题':oldClaim},${origin}) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title,subject,occurred_at) VALUES (${tag()},${story!.id},${oldClaim},${oldClaim},'2026-01-01') RETURNING id`;
  for (const id of ids) {
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${fact!.id},${id},'report')`;
    await publishArticle(id);
  }
  const input = await sql`SELECT article_id,title,summary FROM publications WHERE article_id=ANY(${ids}) ORDER BY article_id`;
  const hash = sha256(stableJson(input.map(p=>[p.article_id,p.title,p.summary ?? ''])));
  await sql`INSERT INTO story_digests(story_id,version,digest,latest,article_ids,inputs_hash) VALUES (${story!.id},1,${oldClaim},${oldClaim},${ids},${hash})`;
  await sql`UPDATE stories SET digest=${oldClaim},latest=${oldClaim},summary=${oldClaim},digest_updated_at=now() WHERE id=${story!.id}`;
  return { ids, storyId: story!.id, publicId, factId: fact!.id };
}
async function publicHasNoOldClaim(publicId: string) {
  for (const path of [`/api/site/stories/${publicId}`,`/api/v1/stories/${publicId}`]) {
    const res = await app.inject({method:'GET',url:path});
    assert.equal(res.statusCode,200,path);
    assert.doesNotMatch(res.body,new RegExp(oldClaim),path);
  }
}
const correctionJobs = (id: number) => sql`SELECT data FROM pgboss.job WHERE name=${QUEUES.digest} AND data->>'storyId'=${String(id)} AND state='created' AND data->>'afterCorrection'='true'`;

test('a summary correction immediately replaces obsolete generated content on site and v1, then regenerates', async () => {
  const f = await fixture();
  const hits = provider.hits();
  await overrideFields(f.ids[0]!,{fields:{summary:newClaim},reason:'correct price',version:0},'test');
  await publicHasNoOldClaim(f.publicId);
  assert.equal(provider.hits(),hits,'editing only queues a model task');
  assert.equal((await correctionJobs(f.storyId)).length,1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM story_digests WHERE story_id=${f.storyId}`)[0]!.n,1,'history is retained');
  const [audit] = await sql`SELECT "before","after" FROM audit_log WHERE action='story.invalidate' AND subject=${`story:${f.storyId}`} ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.before.summary,oldClaim,'the imported summary is retained in the invalidation audit');
  assert.equal(audit!.after.summary,null);
  const [fact] = await sql`SELECT title,subject,occurred_at FROM facts WHERE id=${f.factId}`;
  assert.doesNotMatch(fact!.title,new RegExp(oldClaim));
  assert.equal(fact!.subject,null);
  assert.equal(fact!.occurred_at,null);
  assert.equal(await storyDigestNeedsUpdate(f.storyId),true);
  assert.equal((await composeStoryDigest(f.storyId,{afterCorrection:true})).updated,true);
  const current = await app.inject({method:'GET',url:`/api/v1/stories/${f.publicId}`});
  assert.match(current.body,new RegExp(newClaim));
  assert.doesNotMatch(current.body,new RegExp(oldClaim));
});

test('withdrawing a report removes its derived claims immediately and restoration can regenerate', async () => {
  const f = await fixture('replay');
  await setVisibility(f.ids[0]!,{visibility:'withdrawn',reason:'withdraw evidence',version:0},'test');
  await publicHasNoOldClaim(f.publicId);
  assert.equal((await correctionJobs(f.storyId)).length,1);
  await setVisibility(f.ids[0]!,{visibility:'public',reason:'restore evidence',version:1},'test');
  assert.equal(await storyDigestNeedsUpdate(f.storyId),true,'restoring the old report set must not mistake its history for the current digest');
  assert.equal((await composeStoryDigest(f.storyId,{afterCorrection:true})).updated,true);
});

test('source republication and a manual detach invalidate affected event content', async () => {
  const f = await fixture();
  await detachFromFact(f.ids[0]!,'wrong event','test');
  await publicHasNoOldClaim(f.publicId);
  assert.equal((await correctionJobs(f.storyId)).length,1);
  const second = await fixture();
  await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${source}`;
  try {
    await republishSource(source);
    const [story] = await sql`SELECT digest,latest,summary FROM stories WHERE id=${second.storyId}`;
    assert.deepEqual({...story},{digest:null,latest:null,summary:null});
  } finally { await sql`UPDATE sources SET participation_mode='editorial' WHERE id=${source}`; }
});

test('publication invalidation and its task roll back with the publication write', async () => {
  const f = await fixture();
  await assert.rejects(sql.begin(async tx=>{
    await tx`UPDATE analyses SET summary_zh=${newClaim} WHERE article_id=${f.ids[0]!}`;
    await publishArticleTx(tx,f.ids[0]!);
    assert.equal((await tx`SELECT digest FROM stories WHERE id=${f.storyId}`)[0]!.digest,null);
    throw new Error('rollback-test');
  }),/rollback-test/);
  assert.equal((await sql`SELECT digest FROM stories WHERE id=${f.storyId}`)[0]!.digest,oldClaim);
  assert.equal((await correctionJobs(f.storyId)).length,0);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='story.invalidate' AND subject=${`story:${f.storyId}`}`).length,0);
});

test('unrelated editorial fields do not invalidate a digest, while manual titles survive a real correction', async () => {
  const f = await fixture('manual');
  await overrideFields(f.ids[0]!,{fields:{tags:['模型发布']},reason:'tag only',version:0},'test');
  assert.equal((await sql`SELECT digest FROM stories WHERE id=${f.storyId}`)[0]!.digest,oldClaim);
  await overrideFields(f.ids[0]!,{fields:{summary:newClaim},reason:'correct summary',version:1},'test');
  const [story] = await sql`SELECT title,digest FROM stories WHERE id=${f.storyId}`;
  assert.equal(story!.title,'编辑指定的标题');
  assert.equal(story!.digest,null);
});

test('a correction reaches every event that cites the report, including a mention', async () => {
  const first = await fixture(),second = await fixture();
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${second.factId},${first.ids[0]!},'mention')`;
  await overrideFields(first.ids[0]!,{fields:{summary:newClaim},reason:'shared correction',version:0},'test');
  await publicHasNoOldClaim(first.publicId);
  await publicHasNoOldClaim(second.publicId);
  assert.equal((await correctionJobs(first.storyId)).length,1);
  assert.equal((await correctionJobs(second.storyId)).length,1);
});

test('opposing concurrent merges settle with one survivor without deadlocking or forming a cycle', async () => {
  const first = await fixture(),second = await fixture();
  const results = await Promise.all([mergeStoryInto(first.storyId,second.storyId,'merge A','test'),mergeStoryInto(second.storyId,first.storyId,'merge B','test')]);
  assert.equal(results.filter(Boolean).length,1);
  const stories = await sql`SELECT id,merged_into FROM stories WHERE id IN (${first.storyId},${second.storyId})`;
  const survivors = stories.filter(s=>s.merged_into===null);
  assert.equal(survivors.length,1);
  assert.equal(stories.find(s=>s.merged_into!==null)!.merged_into,survivors[0]!.id);
});

test('a human fact and its manual membership survive publication corrections', async () => {
  const f = await fixture();
  await sql`UPDATE facts SET manual=true,title='编辑保留的事实',subject='编辑保留的主体' WHERE id=${f.factId}`;
  await sql`UPDATE fact_articles SET manual=true WHERE fact_id=${f.factId}`;
  await overrideFields(f.ids[0]!,{fields:{summary:newClaim},reason:'correct report',version:0},'test');
  const [fact] = await sql`SELECT title,subject,manual FROM facts WHERE id=${f.factId}`;
  assert.deepEqual({...fact},{title:'编辑保留的事实',subject:'编辑保留的主体',manual:true});
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE fact_id=${f.factId} AND manual`).length,2);
});
