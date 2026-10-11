// Delayed two-model decisions must not merge changed roots; merge projections commit as a unit.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { overrideFields, detachFromFact } from "@aihot/backend/admin/content";
import { consolidate } from "@aihot/backend/events/group";
import { mergeStoryInto } from "@aihot/backend/events/merge";
import { queueConsolidation } from "@aihot/backend/jobs/consolidation";
import { stopBoss } from "@aihot/backend/jobs/queue";

const source = `merge-${tag()}`;
type Held = { asked: ReturnType<typeof gate<void>>; answer: ReturnType<typeof gate<void>> };
let steps: Held[] = [];
const hold = (): Held => ({ asked: gate(), answer: gate() });
const provider = await stub(async () => {
  const step = steps.shift();
  if (step) { step.asked.open(); await step.answer.promise; }
  return { id: "merge-stub", choices: [{ message: { content: JSON.stringify({ a: "发布", b: "发布", relation: "SAME_STORY", difference: "", confidence: 0.95 }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${source},'Merge tests','rss','T1','editorial','2100-01-01')`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=10000,per_day=100000 WHERE service='deepseek'`;
});
after(async () => { for (const s of steps) s.answer.open(); await provider.close(); await stopBoss(); await closeDb(); });

async function fixture(origin = "model") {
  const title = `事件 ${tag()}`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/merge/${tag()}`, title, bodyText: title, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','ai-models',${title},${title},80,false)`;
  const [s] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories(public_id,title,origin) VALUES(${randomUUID()},${title},${origin}) RETURNING id,public_id`;
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES(${tag()},${s!.id},${title}) RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${f!.id},${articleId},'report')`;
  await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${s!.id},${articleId},${`source:${source}`},${source},'editorial',now())`;
  await publishArticle(articleId);
  return { story: s!.id, publicId: s!.public_id, fact: f!.id, article: articleId };
}
async function unchangedMembership(a: Awaited<ReturnType<typeof fixture>>, b: Awaited<ReturnType<typeof fixture>>) {
  const facts = await sql`SELECT id,story_id FROM facts WHERE id IN (${a.fact},${b.fact}) ORDER BY id`;
  assert.deepEqual(facts.map(f => [f.id,f.story_id]), [[a.fact,a.story],[b.fact,b.story]]);
  assert.equal((await sql`SELECT 1 FROM story_aliases WHERE public_id IN (${a.publicId},${b.publicId})`).length, 0);
}

test("a corrected root invalidates the first merge judgement before another paid review", async () => {
  const a = await fixture(), b = await fixture(), first = hold(); steps = [first];
  const hits = provider.hits();
  const pending = consolidate([a.story,b.story]);
  await Promise.race([first.asked.promise,pending.then(() => assert.fail("no judgement requested"))]);
  await overrideFields(a.article,{fields:{summary:"编辑更正的不同事件"},reason:"correct root",version:0},"test");
  first.answer.open();
  const result = await pending;
  assert.equal(result[0]!.merge,false);
  assert.equal(provider.hits()-hits,1,"an obsolete first judgement must not trigger the review");
  await unchangedMembership(a,b);
});

test("a root correction while the second model answers prevents the merge", async () => {
  const a = await fixture(), b = await fixture(), first = hold(), second = hold(); first.answer.open(); steps = [first,second];
  const pending = consolidate([a.story,b.story]);
  await Promise.race([second.asked.promise,pending.then(() => assert.fail("no review requested"))]);
  await overrideFields(b.article,{fields:{title:"编辑更正后的另一个事件"},reason:"correct review root",version:0},"test");
  second.answer.open();
  assert.equal((await pending)[0]!.merge,false);
  await unchangedMembership(a,b);
});

test("an editor detaching the root during judgement keeps the events separate", async () => {
  const a = await fixture(), b = await fixture(), first = hold(); steps = [first];
  const pending = consolidate([a.story,b.story]);
  await Promise.race([first.asked.promise,pending.then(() => assert.fail("no judgement requested"))]);
  await detachFromFact(b.article,"not this event","test");
  first.answer.open();
  assert.equal((await pending)[0]!.merge,false);
  await unchangedMembership(a,b);
});

test("a competing merge cannot be reported as an applied stale automatic decision", async () => {
  const a = await fixture(), b = await fixture(), c = await fixture(), first = hold(); steps = [first];
  const pending = consolidate([a.story,b.story]);
  await Promise.race([first.asked.promise,pending.then(() => assert.fail("no judgement requested"))]);
  await mergeStoryInto(b.story,c.story,"editor chose another event","test");
  first.answer.open();
  assert.equal((await pending)[0]!.merge,false);
  assert.equal((await sql`SELECT story_id FROM facts WHERE id=${b.fact}`)[0]!.story_id,c.story);
});

test("failure publishing a moved report rolls back the merge, alias, signals and audit", async () => {
  const a = await fixture(), b = await fixture(); steps=[];
  const before = await sql`SELECT article_id,md5(to_jsonb(p)::text) AS hash FROM publications p WHERE article_id IN (${a.article},${b.article}) ORDER BY article_id`;
  const fn = `merge_fail_${tag()}`;
  await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.article_id='${b.article}' THEN RAISE EXCEPTION 'test merged publication failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON publications FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    await assert.rejects(mergeStoryInto(b.story,a.story,"atomic merge","test"),/test merged publication failure/);
    await unchangedMembership(a,b);
    const after = await sql`SELECT article_id,md5(to_jsonb(p)::text) AS hash FROM publications p WHERE article_id IN (${a.article},${b.article}) ORDER BY article_id`;
    assert.deepEqual(after,before);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='story.merge' AND subject=${`story:${b.story}`}`).length,0);
    assert.equal((await sql`SELECT story_id FROM story_signals WHERE article_id=${b.article}`)[0]!.story_id,b.story);
  } finally {
    await sql.unsafe(`DROP TRIGGER ${fn} ON publications`); await sql.unsafe(`DROP FUNCTION ${fn}()`);
  }
});

test("three unchanged stories merge into one using a fresh survivor input for each pair", async () => {
  const a = await fixture(), b = await fixture(), c = await fixture(); steps=[];
  const result = await consolidate([a.story,b.story,c.story]);
  assert.deepEqual(result.map(r => [r.from,r.into,r.merge]), [[b.story,a.story,true],[c.story,a.story,true]]);
  const pubs = await sql`SELECT story_id FROM publications WHERE article_id IN (${a.article},${b.article},${c.article})`;
  assert.ok(pubs.every(p => p.story_id===a.story));
});

test("an event fixed by an editor is not merged automatically", async () => {
  const a = await fixture(), b = await fixture("manual"); steps=[];
  const hits = provider.hits();
  assert.deepEqual(await consolidate([a.story,b.story]),[]);
  assert.equal(provider.hits(),hits);
  await unchangedMembership(a,b);
});

test("an obsolete pair leaves one debounced follow-up for current inputs", async () => {
  const a = await fixture(), b = await fixture(), first = hold(); steps = [first];
  const pending = consolidate([a.story,b.story]);
  await Promise.race([first.asked.promise,pending.then(() => assert.fail("no judgement requested"))]);
  await overrideFields(a.article,{fields:{summary:"更正后须重新判断"},reason:"follow-up",version:0},"test");
  first.answer.open();
  assert.equal((await pending)[0]!.stale,true);
  assert.equal(await queueConsolidation([b.story,a.story,a.story]),null,"same pair must be debounced");
  const jobs = await sql`SELECT data,start_after > created_on AS delayed FROM pgboss.job
    WHERE name='events.consolidate' AND state='created' AND singleton_key=${`stories:${a.story}:${b.story}`}`;
  assert.equal(jobs.length,1);
  assert.deepEqual(jobs[0]!.data,{storyIds:[a.story,b.story]});
  assert.equal(jobs[0]!.delayed,true);
});

test("an audit failure rolls back every merge write and recovery reuses both saved answers", async () => {
  const a = await fixture(), b = await fixture(); steps = [];
  const hits = provider.hits(), fn = `merge_audit_fail_${tag()}`;
  const before = await sql`SELECT article_id,md5(to_jsonb(p)::text) AS hash FROM publications p WHERE article_id IN (${a.article},${b.article}) ORDER BY article_id`;
  const digestJobs = () => sql`SELECT id FROM pgboss.job WHERE name='events.digest' AND data->>'storyId'=${String(a.story)} ORDER BY id`;
  const jobsBefore = await digestJobs();
  await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='story.merge' AND NEW.subject='story:${b.story}' THEN RAISE EXCEPTION 'test merge audit failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    await assert.rejects(consolidate([a.story,b.story]),/test merge audit failure/);
    await unchangedMembership(a,b);
    assert.deepEqual(await sql`SELECT article_id,md5(to_jsonb(p)::text) AS hash FROM publications p WHERE article_id IN (${a.article},${b.article}) ORDER BY article_id`,before);
    assert.deepEqual(await digestJobs(),jobsBefore,"failed commit must not enqueue a digest");
    const receipts = await sql`SELECT id,status FROM receipts WHERE subject IN (${`story:${a.story}:${b.story}`},${`story:${b.story}:${a.story}`}) ORDER BY id`;
    assert.equal(receipts.length,2);
    assert.ok(receipts.every(r => r.status==='received'),"saved answers must remain recoverable");
    assert.equal(provider.hits()-hits,2);
  } finally {
    await sql.unsafe(`DROP TRIGGER ${fn} ON audit_log`); await sql.unsafe(`DROP FUNCTION ${fn}()`);
  }
  assert.equal((await consolidate([a.story,b.story]))[0]!.merge,true);
  assert.equal(provider.hits()-hits,2,"retry must reuse both paid responses");
  const receipts = await sql`SELECT status FROM receipts WHERE subject IN (${`story:${a.story}:${b.story}`},${`story:${b.story}:${a.story}`})`;
  assert.ok(receipts.every(r => r.status==='completed'));
});

test("a dry run reports the confirmed merge without changing memberships or publications", async () => {
  const a = await fixture(), b = await fixture(); steps=[];
  const before = await sql`SELECT article_id,md5(to_jsonb(p)::text) AS hash FROM publications p WHERE article_id IN (${a.article},${b.article}) ORDER BY article_id`;
  assert.equal((await consolidate([a.story,b.story],{dryRun:true}))[0]!.merge,true);
  await unchangedMembership(a,b);
  assert.deepEqual(await sql`SELECT article_id,md5(to_jsonb(p)::text) AS hash FROM publications p WHERE article_id IN (${a.article},${b.article}) ORDER BY article_id`,before);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='story.merge' AND subject=${`story:${b.story}`}`).length,0);
});

test("empty-event redirection rechecks reports and protects manual events at commit", async () => {
  const a = await fixture(), b = await fixture(), manual = await fixture('manual');
  assert.equal(await mergeStoryInto(b.story,a.story,'obsolete empty selection','grouping',{requireEmptyFrom:true}),null);
  await unchangedMembership(a,b);
  await sql`DELETE FROM fact_articles WHERE fact_id=${manual.fact}`;
  assert.equal(await mergeStoryInto(manual.story,a.story,'manual address','grouping',{requireEmptyFrom:true}),null);
  await sql`DELETE FROM fact_articles WHERE fact_id=${b.fact}`;
  assert.ok(await mergeStoryInto(b.story,a.story,'now empty','grouping',{requireEmptyFrom:true}));
  assert.equal((await sql`SELECT merged_into FROM stories WHERE id=${b.story}`)[0]!.merged_into,a.story);
});
