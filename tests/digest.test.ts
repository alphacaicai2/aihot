// A model answer is held while current reporting, another digest or an editor changes the event.
// Only the answer for the current input may become public; paid answers remain in their receipts.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { composeStoryDigest } from "@aihot/backend/events/digest";
import { mergeStoryInto } from "@aihot/backend/events/merge";
import { overrideFields } from "@aihot/backend/admin/content";
import { publishArticle } from "@aihot/backend/publication/publish";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

const source = `digest-${tag()}`;
const waiting = new Map<string, { asked: ReturnType<typeof gate<void>>; answer: ReturnType<typeof gate<void>>; output: string }>();
let lastPrompt = "";
const provider = await stub(async (_hit, request) => {
  const user = JSON.parse(request.body).messages[1].content as string;
  lastPrompt = user;
  const match = [...waiting].find(([token]) => user.includes(token));
  if (!match) throw new Error("unexpected digest input");
  const [, pending] = match;
  pending.asked.open();
  await pending.answer.promise;
  return { id: "stub-digest", choices: [{ message: { content: JSON.stringify({ title: "模型拟定的事件标题", digest: pending.output, latest: "最新进展" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${source},'Digest tests','rss','T1','editorial','2100-01-01')`;
});
after(async () => {
  for (const p of waiting.values()) p.answer.open();
  await provider.close(); await stopBoss(); await closeDb();
});

function response(output = "根据当前报道写成的有效事件综述。") {
  const token = `DIGEST_${tag()}`;
  const pending = { asked: gate(), answer: gate(), output };
  waiting.set(token, pending);
  return { token, ...pending };
}
async function fixture(summary: string) {
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/digest/${tag()}`,
    title: `Digest report ${tag()}`, bodyText: "A source report.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','ai-models','测试报道',${summary},80,true)`;
  await publishArticle(articleId);
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title) VALUES (${randomUUID()},'测试事件') RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES (${tag()},${story!.id},'测试事实') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${fact!.id},${articleId},'report')`;
  await publishArticle(articleId);
  return { articleId, storyId: story!.id };
}
const history = (id: number) => sql`SELECT * FROM story_digests WHERE story_id=${id} ORDER BY version`;
async function started(id: number, pending: ReturnType<typeof response>) {
  const work = composeStoryDigest(id);
  await Promise.race([pending.asked.promise, work.then(() => assert.fail("digest ended before asking the model"))]);
  return { work };
}

test("a committed digest is idempotent and completes its paid receipt", async () => {
  const pending = response(); pending.answer.open();
  const { storyId } = await fixture(pending.token);
  const hits = provider.hits();
  assert.deepEqual(await composeStoryDigest(storyId), { updated: true, version: 2 });
  assert.deepEqual(await composeStoryDigest(storyId), { updated: false });
  assert.equal(provider.hits(), hits + 1);
  const [saved] = await history(storyId);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${saved!.receipt_id}`)[0]!.status, "completed");
});

test("an editorial correction during generation cannot be overwritten by the old answer", async () => {
  const old = response("旧价格十元，旧价格十元。"), current = response("更正后的价格二十元，更正后的价格二十元。");
  const { articleId, storyId } = await fixture(old.token);
  const { work } = await started(storyId, old);
  try {
    await overrideFields(articleId, { fields: { summary: current.token }, reason: "correct the price", version: 0 }, "test");
  } finally { old.answer.open(); }
  assert.equal((await work).updated, false);
  assert.equal((await history(storyId)).length, 0, "old reporting never becomes an event version");
  const [receipt] = await sql`SELECT status,response FROM receipts WHERE purpose='story_digest' AND subject=${`story:${storyId}@1`} ORDER BY id LIMIT 1`;
  assert.equal(receipt!.status, "received", "the discarded paid answer remains saved for diagnosis and reuse");
  assert.ok(receipt!.response);
  const queued = await sql`SELECT data FROM pgboss.job WHERE name=${QUEUES.digest} AND data->>'storyId'=${String(storyId)} AND state='created'`;
  assert.ok(queued.some(j => j.data.afterCorrection === true), "the current input has a durable correction task");
  current.answer.open();
  assert.equal((await composeStoryDigest(storyId, { afterCorrection: true })).updated, true);
  assert.equal((await history(storyId))[0]!.digest, current.output);
});

test("concurrent answers finishing out of order cannot regress the latest digest or reuse its version", async () => {
  const old = response("第一份旧报道的综述，不能覆盖后来的更正。"), current = response("第二份更正报道的综述，应该保留在事件中。");
  const { articleId, storyId } = await fixture(old.token);
  const first = await started(storyId, old);
  await sql`UPDATE publications SET summary=${current.token} WHERE article_id=${articleId}`;
  const second = await started(storyId, current);
  current.answer.open();
  try { assert.equal((await second.work).updated, true); } finally { old.answer.open(); }
  assert.equal((await first.work).updated, false);
  const rows = await history(storyId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.digest, current.output);
  assert.equal(rows[0]!.version, 2);
});

test("an event merged while its answer is pending receives no new digest", async () => {
  const pending = response();
  const { storyId } = await fixture(pending.token);
  const [target] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title) VALUES (${randomUUID()},'保留事件') RETURNING id`;
  const { work } = await started(storyId, pending);
  try { await mergeStoryInto(storyId, target!.id, "same event", "test"); } finally { pending.answer.open(); }
  assert.equal((await work).updated, false);
  assert.equal((await history(storyId)).length, 0);
  const [story] = await sql`SELECT version,digest,merged_into FROM stories WHERE id=${storyId}`;
  assert.equal(story!.version, 2);
  assert.equal(story!.digest, null);
  assert.equal(story!.merged_into, target!.id);
});

test("changed event context is regenerated and the editor's title stays", async () => {
  const pending = response();
  const { storyId } = await fixture(pending.token);
  const { work } = await started(storyId, pending);
  await sql`UPDATE stories SET title='编辑更正的事件',origin='manual',version=version+1 WHERE id=${storyId}`;
  pending.answer.open();
  assert.equal((await work).updated, false);
  assert.equal((await history(storyId)).length, 0);
  assert.ok((await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.digest} AND data->>'storyId'=${String(storyId)} AND state='created'`).length);
  assert.equal((await composeStoryDigest(storyId, { afterCorrection: true })).updated, true);
  assert.equal((await sql`SELECT title FROM stories WHERE id=${storyId}`)[0]!.title, "编辑更正的事件");
});

test("withdrawn reports and changed source metadata invalidate in-flight answers", async () => {
  for (const kind of ["withdrawn", "metadata"]) {
    const pending = response();
    const { articleId, storyId } = await fixture(pending.token);
    const { work } = await started(storyId, pending);
    if (kind === "withdrawn") await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleId}`;
    else await sql`UPDATE publications SET first_party=NOT first_party WHERE article_id=${articleId}`;
    pending.answer.open();
    assert.equal((await work).updated, false, kind);
    assert.equal((await history(storyId)).length, 0, kind);
  }
});

test("after a report leaves the event, regeneration cannot carry its claims from the previous digest", async () => {
  const old = response("WITHDRAWN_CLAIM 一份已撤回报道的旧说法。"), remaining = response();
  old.answer.open(); remaining.answer.open();
  const first = await fixture(old.token), second = await fixture(remaining.token);
  await sql`UPDATE facts SET story_id=${first.storyId} WHERE story_id=${second.storyId}`;
  assert.equal((await composeStoryDigest(first.storyId)).updated, true);
  assert.match(lastPrompt, new RegExp(old.token));
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${first.articleId}`;
  assert.equal((await composeStoryDigest(first.storyId)).updated, true);
  assert.doesNotMatch(lastPrompt, /WITHDRAWN_CLAIM/);
  assert.doesNotMatch(lastPrompt, new RegExp(old.token));
  assert.match(lastPrompt, new RegExp(remaining.token));
  assert.match(lastPrompt, /不要沿用以前版本/);
});
