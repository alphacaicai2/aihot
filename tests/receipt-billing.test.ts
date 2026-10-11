import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { paidRequest, ReceiptUnknownError } from '@aihot/backend/providers/receipts';
import { autoReleaseUnknownReceipts, confirmZeroCostReceipts, runsOverview } from '@aihot/backend/admin/runs';
import { getBoss, stopBoss } from '@aihot/backend/jobs/queue';
import { collectFindings } from '@aihot/backend/operations/alerts';

before(async () => { await getBoss(); });
after(async () => { await stopBoss(); await closeDb(); });
const note = '使用者确认：上游已计费，金额为 0，没有返回计费元数据';

async function lost() {
  const req = { service: 'billing-test', model: 'primary', purpose: 'billing_test', subject: tag(), identity: tag() };
  await assert.rejects(paidRequest(req, async () => { throw new Error('original lost response'); }));
  const [r] = await sql<{ id: number; logical_key: string }[]>`SELECT id,logical_key FROM receipts WHERE subject=${req.subject}`;
  return { ...r!, req };
}

const snapshots = async (id: number) => ({
  receipt: await sql`SELECT id,status,error,response,usage,request_id,cost,currency,cost_basis,created_at,updated_at,received_at,completed_at FROM receipts WHERE id=${id}`,
  attempts: await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${id} ORDER BY attempt`,
  fallback: await sql`SELECT * FROM model_fallback_routes WHERE primary_receipt_id=${id}`,
});

test('zero billing confirmation preserves unknown outcome, errors, provider data and fallback without queuing', async () => {
  const a = await lost();
  const b = await lost();
  await sql`INSERT INTO model_fallback_routes(primary_key,fallback_model,primary_receipt_id,reason)
    VALUES (${a.logical_key},'deepseek-flash',${a.id},'existing fallback')`;
  const before = await snapshots(a.id);
  const [jobsBefore] = await sql`SELECT count(*)::int n FROM pgboss.job`;
  const viewBefore = await runsOverview();
  const beforeFinding = (await collectFindings()).find(f => f.key === 'receipts.unknown');
  assert.equal(beforeFinding?.title, `${viewBefore.receipts.recovery.billing_unreviewed} 个响应结果未知的付费请求尚待核账`);
  assert.ok(!beforeFinding?.title.includes('自动重试'));
  const done = await confirmZeroCostReceipts({ receiptIds: [a.id,b.id,a.id], note }, 'test:billing');
  assert.deepEqual(done, { requested: 2, confirmed: 2, alreadyConfirmed: 0, released: false, requeued: false });
  assert.deepEqual(await snapshots(a.id), before);
  assert.equal((await sql`SELECT count(*)::int n FROM pgboss.job`)[0]!.n, jobsBefore!.n);
  const [r] = await sql`SELECT billing_review FROM receipts WHERE id=${a.id}`;
  assert.equal(r!.billing_review.billed, true);
  assert.equal(r!.billing_review.amount, 0);
  assert.equal(r!.billing_review.source, 'operator');
  assert.equal(r!.billing_review.note, note);
  const [audit] = await sql`SELECT * FROM audit_log WHERE actor='test:billing' AND action='receipt.billing-confirm-zero' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(audit!.before.receiptIds, [a.id,b.id]);
  assert.equal(audit!.after.status, 'unknown');
  assert.equal(audit!.after.requeued, false);
  const view = await runsOverview();
  assert.equal(view.receipts.recovery.unknown, viewBefore.receipts.recovery.unknown);
  assert.equal(view.receipts.recovery.billing_unreviewed, viewBefore.receipts.recovery.billing_unreviewed - 2);
  assert.equal(view.receipts.recovery.billing_confirmed_zero, viewBefore.receipts.recovery.billing_confirmed_zero + 2);
  assert.ok(!view.receipts.issues.some(r => r.id === a.id || r.id === b.id));
  const afterFinding = (await collectFindings()).find(f => f.key === 'receipts.unknown');
  if (view.receipts.recovery.billing_unreviewed > 0) {
    assert.equal(afterFinding?.title, `${view.receipts.recovery.billing_unreviewed} 个响应结果未知的付费请求尚待核账`);
  } else {
    assert.equal(afterFinding, undefined, 'confirmed unknown outcomes do not generate another billing follow-up');
  }
  assert.deepEqual(await snapshots(a.id), before, 'collecting alerts is read-only');
});

test('concurrent confirmations record one review and one audit without overwriting its evidence', async () => {
  const a = await lost();
  const actor = `test:billing-concurrent-${tag()}`;
  const results = await Promise.all([1,2].map(() => confirmZeroCostReceipts({ receiptIds: [a.id], note }, actor)));
  assert.equal(results.reduce((n,r) => n + r.confirmed, 0), 1);
  const [original] = await sql`SELECT billing_review FROM receipts WHERE id=${a.id}`;
  await confirmZeroCostReceipts({ receiptIds: [a.id], note: 'later note' }, actor);
  assert.deepEqual((await sql`SELECT billing_review FROM receipts WHERE id=${a.id}`)[0]!.billing_review, original!.billing_review);
  assert.equal((await sql`SELECT count(*)::int n FROM audit_log WHERE actor=${actor} AND action='receipt.billing-confirm-zero'`)[0]!.n, 1);
});

test('a missing or settled receipt rejects the whole batch and creates no partial review', async () => {
  const a = await lost();
  const b = await lost();
  await sql`UPDATE receipts SET status='received' WHERE id=${b.id}`;
  await assert.rejects(confirmZeroCostReceipts({ receiptIds: [a.id,b.id], note }, 'test:billing-invalid'), /状态已变化/);
  await assert.rejects(confirmZeroCostReceipts({ receiptIds: [a.id,Number.MAX_SAFE_INTEGER], note }, 'test:billing-invalid'), /回执缺失/);
  await assert.rejects(confirmZeroCostReceipts({ receiptIds: [], note }, 'test:billing-invalid'), /required/);
  await assert.rejects(confirmZeroCostReceipts({ receiptIds: [a.id], note: ' ' }, 'test:billing-invalid'), /required/);
  assert.equal((await sql`SELECT billing_review FROM receipts WHERE id=${a.id}`)[0]!.billing_review, null);
  assert.equal((await sql`SELECT count(*)::int n FROM audit_log WHERE actor='test:billing-invalid'`)[0]!.n, 0);
});

test('a zero-cost confirmation does not permit automatic release or resending the lost request', async () => {
  const a = await lost();
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${a.id}`;
  await confirmZeroCostReceipts({ receiptIds: [a.id], note }, 'test:billing-no-retry');
  await autoReleaseUnknownReceipts();
  let sent = 0;
  await assert.rejects(paidRequest(a.req, async () => { sent++; return { response: {} }; }), ReceiptUnknownError);
  assert.equal(sent, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${a.id}`)[0]!.status, 'unknown');
  assert.equal((await sql`SELECT count(*)::int n FROM receipt_attempts WHERE receipt_id=${a.id}`)[0]!.n, 1);
});
