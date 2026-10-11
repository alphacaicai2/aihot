// Model failures may buy one answer from an independent provider, never release the lost answer.
import { stub, tag, Reply, gate } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ReceiptUnknownError, ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";

let mode = "ok";
let fallbackMode = "ok";
let primaryHits = 0;
let held = gate();
let arrived = gate();
const primary = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    primaryHits++;
    const currentMode = mode;
    const release = held;
    if (currentMode === "socket") { req.socket.destroy(); return; }
    if (currentMode === "body-socket") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"choices":');
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }
    const status = currentMode === "503" ? 503 : currentMode === "safety" ? 400 : 200;
    const send = () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status !== 200 ? { error: { code: status === 400 ? "1301" : "overloaded" } }
        : { choices: [{ message: { content: currentMode === "invalid" ? "not JSON" : '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    };
    if (currentMode === "held") { arrived.open(); void release.promise.then(send); }
    else if (currentMode === "delay") setTimeout(send, 150); else send();
  });
});
await new Promise<void>(resolve => primary.listen(0, "127.0.0.1", resolve));
const primaryUrl = `http://127.0.0.1:${(primary.address() as { port: number }).port}`;
const fallback = await stub(() => fallbackMode === "503" ? new Reply(503, { error: "overloaded" })
  : { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 3, completion_tokens: 3 } });
Object.assign(process.env, {
  LLM_MODEL: "test-primary-fallback", LLM_BASE_URL: primaryUrl, LLM_API_KEY: "test-primary-key",
  LLM_FALLBACK_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: fallback.url, DEEPSEEK_API_KEY: "test-fallback-key",
  LLM_FALLBACK_FAILURE_THRESHOLD: "3", LLM_FALLBACK_COOLDOWN_SECONDS: "300",
});
const ask = (subject: string, extra: Record<string, unknown> = {}) => chatJson({
  model: "default", purpose: "fallback_test", subject, promptVersion: "v1", system: "return JSON", user: subject,
  schema: z.object({ ok: z.boolean() }), ...extra,
});
let budgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }>;
before(async () => {
  config.modelCallsEnabled = true; // Only the two loopback stubs above can receive these requests.
  budgets = await sql<typeof budgets>`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service IN ('llm','deepseek')`;
});
beforeEach(async () => {
  mode = fallbackMode = "ok";
  process.env.LLM_FALLBACK_MODEL = "deepseek-flash";
  process.env.LLM_FALLBACK_FAILURE_THRESHOLD = "3";
  process.env.LLM_PRIMARY_MODE = "normal";
  process.env.LLM_PRIMARY_MAX_CONCURRENCY = "20";
  held = gate();
  arrived = gate();
  await sql`DELETE FROM model_circuits`;
  await sql`DELETE FROM model_primary_leases`;
  await sql`UPDATE budgets SET per_minute=10000, per_hour=100000, per_day=1000000 WHERE service IN ('llm','deepseek')`;
});
after(async () => {
  config.modelCallsEnabled = false;
  for (const budget of budgets ?? []) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day} WHERE service=${budget.service}`;
  await fallback.close();
  await new Promise<void>(resolve => primary.close(() => resolve()));
  await closeDb();
});

test("socket loss keeps the original unknown receipt and permanently reuses the fallback", async () => {
  mode = "socket";
  const subject = `socket-${tag()}`;
  const sent = primaryHits;
  const fb = fallback.hits();
  const first = await ask(subject);
  assert.equal(first.model, "deepseek-flash");
  assert.equal(first.reused, false);
  const rows = await sql`SELECT id,status,service FROM receipts WHERE subject=${subject} ORDER BY id`;
  assert.deepEqual(rows.map(r=>[r.service,r.status]), [["llm","unknown"],["deepseek","received"]]);
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE subject=${subject}`;
  await autoReleaseUnknownReceipts();
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${rows[0]!.id}`)[0]!.status,"unknown");
  // Even an explicit later release must not cause recovery to buy the primary answer again.
  await sql`UPDATE receipts SET status='failed' WHERE id=${rows[0]!.id}`;
  mode = "ok";
  delete process.env.LLM_FALLBACK_MODEL;
  const recovered = await ask(subject);
  assert.equal(recovered.receiptId,first.receiptId);
  assert.equal(recovered.reused,true);
  assert.equal(primaryHits-sent,1);
  assert.equal(fallback.hits()-fb,1);
});

test("time limits trigger a separate budgeted fallback request", async () => {
  mode = "delay";
  const subject = `timeout-${tag()}`;
  assert.equal((await ask(subject,{timeoutMs:30})).model,"deepseek-flash");
  const rows = await sql`SELECT service,status,error FROM receipts WHERE subject=${subject} ORDER BY id`;
  assert.equal(rows[0]!.status,"unknown");
  assert.match(rows[0]!.error,/timeout/i);
  assert.match(rows[0]!.error,/phase=headers/);
  assert.equal(rows[1]!.service,"deepseek");
});

test("connection rejection retains the original transport cause without credentials", async () => {
  const closed = http.createServer();
  await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const subject = `connection-refused-${tag()}`;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await ask(subject)).model, "deepseek-flash");
    const [receipt] = await sql`SELECT status,error FROM receipts WHERE subject=${subject} AND service='llm'`;
    assert.equal(receipt!.status, "failed");
    assert.match(receipt!.error, /ECONNREFUSED/);
    assert.match(receipt!.error, /phase=headers/);
    assert.doesNotMatch(receipt!.error, /test-primary-key|authorization/);
  } finally { process.env.LLM_BASE_URL = primaryUrl; }
});

test("a response body disconnect is recorded as unknown with its response phase", async () => {
  mode = "body-socket";
  const subject = `body-disconnect-${tag()}`;
  assert.equal((await ask(subject)).model, "deepseek-flash");
  const [receipt] = await sql`SELECT status,error FROM receipts WHERE subject=${subject} AND service='llm'`;
  assert.equal(receipt!.status, "unknown");
  assert.match(receipt!.error, /phase=body/);
  assert.match(receipt!.error, /UND_ERR_SOCKET/);
});

test("temporary rejection and invalid output can fall back; content safety rejection cannot", async () => {
  for (const failure of ["503","invalid"]) {
    mode=failure;
    assert.equal((await ask(`${failure}-${tag()}`)).model,"deepseek-flash");
  }
  mode="safety";
  const before=fallback.hits();
  await assert.rejects(ask(`safety-${tag()}`),ProviderRejectedError);
  assert.equal(fallback.hits(),before);
  mode="invalid";
  await assert.rejects(ask(`benchmark-${tag()}`,{fallback:false}),ModelOutputError);
});

test("an open circuit skips new primary requests but still reuses completed primary steps", async () => {
  const settled=`settled-${tag()}`;
  const completed=await ask(settled);
  process.env.LLM_FALLBACK_FAILURE_THRESHOLD="2";
  mode="503";
  const before=primaryHits;
  await ask(`circuit-one-${tag()}`);
  await ask(`circuit-two-${tag()}`);
  await ask(`circuit-three-${tag()}`);
  assert.equal(primaryHits-before,2);
  const reused=await ask(settled);
  assert.equal(reused.receiptId,completed.receiptId);
  assert.equal(reused.model,"default");
  assert.equal(reused.reused,true);
});

test("only one recovery probe uses the primary after circuit cooldown", async () => {
  process.env.LLM_FALLBACK_FAILURE_THRESHOLD="1";
  mode="503";
  await ask(`open-${tag()}`);
  await sql`UPDATE model_circuits SET open_until=now()-interval '1 second'`;
  mode="delay";
  const before=primaryHits;
  const probe=ask(`probe-${tag()}`);
  await new Promise(resolve=>setTimeout(resolve,40));
  const other=await ask(`during-probe-${tag()}`);
  assert.equal(other.model,"deepseek-flash");
  assert.equal((await probe).model,"default");
  assert.equal(primaryHits-before,1);
  assert.equal((await sql`SELECT * FROM model_circuits`).length,0);
});

test("a late success cannot close a circuit opened by newer failures", async () => {
  mode = "held";
  const slow = ask(`old-in-flight-${tag()}`);
  await arrived.promise;
  mode = "503";
  process.env.LLM_FALLBACK_FAILURE_THRESHOLD = "1";
  await ask(`new-failure-${tag()}`);
  const [opened] = await sql`SELECT generation, open_until FROM model_circuits`;
  assert.ok(opened?.open_until);
  held.open();
  assert.equal((await slow).model, "default");
  const [stillOpen] = await sql`SELECT generation, open_until FROM model_circuits`;
  assert.equal(stillOpen?.generation, opened!.generation);
  assert.ok(stillOpen?.open_until);
  const sent = primaryHits;
  assert.equal((await ask(`after-late-success-${tag()}`)).model, "deepseek-flash");
  assert.equal(primaryHits, sent);
});

test("probe mode retains the fallback route after a successful small recovery probe", async () => {
  process.env.LLM_PRIMARY_MODE = "probe";
  mode = "held";
  const probe = ask(`maintenance-probe-${tag()}`);
  await arrived.promise;
  const sent = primaryHits;
  assert.equal((await ask(`during-maintenance-${tag()}`)).model, "deepseek-flash");
  held.open();
  assert.equal((await probe).model, "default");
  mode = "ok";
  assert.equal((await ask(`after-maintenance-probe-${tag()}`)).model, "deepseek-flash");
  assert.equal(primaryHits, sent);
  assert.equal((await sql`SELECT * FROM model_primary_leases`).length, 0);
});

test("the shared concurrency limit bypasses a full primary without losing its existing request", async () => {
  process.env.LLM_PRIMARY_MAX_CONCURRENCY = "1";
  mode = "held";
  const first = ask(`capacity-first-${tag()}`);
  await arrived.promise;
  const sent = primaryHits;
  assert.equal((await ask(`capacity-overflow-${tag()}`)).model, "deepseek-flash");
  assert.equal(primaryHits, sent);
  held.open();
  assert.equal((await first).model, "default");
  assert.equal((await sql`SELECT * FROM model_primary_leases`).length, 0);
  mode = "ok";
  assert.equal((await ask(`capacity-free-${tag()}`)).model, "default");
});

test("fallback budget and primary budget remain effective, without switching to evade limits", async () => {
  mode="socket";
  const before=fallback.hits();
  await sql`UPDATE budgets SET per_minute=0 WHERE service='deepseek'`;
  await assert.rejects(ask(`fallback-budget-${tag()}`),BudgetExceededError);
  assert.equal(fallback.hits(),before);
  await sql`UPDATE budgets SET per_minute=0 WHERE service='llm'`;
  const sent=primaryHits;
  await assert.rejects(ask(`primary-budget-${tag()}`),BudgetExceededError);
  assert.equal(primaryHits,sent);
  assert.equal(fallback.hits(),before);
});

test("fallback failures do not recursively retry the primary", async () => {
  mode="503";
  fallbackMode="503";
  const subject=`fallback-failure-${tag()}`;
  const before=primaryHits;
  await assert.rejects(ask(subject),ProviderRejectedError);
  await assert.rejects(ask(subject),ProviderRejectedError);
  assert.equal(primaryHits-before,1);
  const [route]=await sql`SELECT * FROM model_fallback_routes WHERE fallback_receipt_id IN (SELECT id FROM receipts WHERE subject=${subject})`;
  assert.ok(route);
  // A subsequently lost fallback answer also waits for review instead of an automatic repeat.
  await sql`UPDATE receipts SET status='unknown',updated_at=now()-interval '31 minutes' WHERE id=${route!.fallback_receipt_id}`;
  await autoReleaseUnknownReceipts();
  await assert.rejects(ask(subject),ReceiptUnknownError);
  assert.equal(primaryHits-before,1);
});
