// Reset monitor corrections (F12/F19): edit an event, confirm it from a receipt review (a reader's
// or our own account showing the reset when Tibo never posted "done"), withdraw or restore it, and
// move a post between events. Public exits (page, v1 snapshot, version probe) follow updated_at.
import { z } from "zod";
import { sql, type Tx } from "../db.ts";
import { manualSchedule } from "../monitor/time.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";

const Reason = z.string().trim().min(1);
const Version = z.string().datetime({ offset: true });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw Object.assign(new Error(result.error.message), { statusCode: 400 });
  return result.data;
}

export async function listMonitorEvents(opts: { withdrawn?: boolean } = {}) {
  const events = await sql`
    SELECT e.id, e.type, e.status, e.label, e.display_label, e.scope, e.schedule, e.estimate, e.presentation, e.confirmed_at, e.occurred_on,
           e.confirmation_basis, e.withdrawn, e.created_at, e.updated_at,
           coalesce((SELECT jsonb_agg(jsonb_build_object('postId', l.post_id, 'stage', l.stage, 'action', l.action, 'text', l.text, 'originalText', l.original_text,
                                                         'publishedAt', p.published_at, 'url', p.url) ORDER BY p.published_at)
                     FROM monitor_event_posts l JOIN monitor_posts p ON p.id = l.post_id WHERE l.event_id = e.id), '[]'::jsonb) AS posts
    FROM monitor_events e
    WHERE ${opts.withdrawn ? sql`true` : sql`NOT e.withdrawn`}
    ORDER BY e.created_at DESC LIMIT 200`;
  return { events };
}

export async function listMonitorPosts(opts: { filter?: "relevant" | "review" | "pending" | "all"; page?: number }) {
  const page = Math.max(1, opts.page ?? 1);
  const filter = opts.filter ?? "relevant";
  const where =
    filter === "pending" ? sql`p.processed_at IS NULL`
    : filter === "review" ? sql`(p.recognition->>'needsReview')::boolean IS TRUE AND (p.recognition->>'reviewed')::boolean IS NOT TRUE`
    : filter === "relevant" ? sql`(p.recognition->>'relevant')::boolean IS TRUE`
    : sql`true`;
  const rows = await sql`
    SELECT p.id, p.published_at, p.text, p.url, p.translation, p.processed_at, p.receipt_id, p.origin,
           p.recognition->'propositions' AS propositions, (p.recognition->>'needsReview')::boolean AS needs_review,
           p.recognition->'held' AS held, (p.recognition->>'reviewed')::boolean AS reviewed, (p.recognition->>'skipped')::boolean AS skipped,
           (SELECT s.value FROM monitor_state s WHERE s.key = 'failures:' || p.id) AS failures,
           (p.recognition->>'relevant')::boolean AS relevant, p.outage,
           coalesce((SELECT jsonb_agg(jsonb_build_object('eventId', l.event_id, 'stage', l.stage)) FROM monitor_event_posts l WHERE l.post_id = p.id), '[]'::jsonb) AS links
    FROM monitor_posts p WHERE ${where}
    ORDER BY p.published_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`;
  return { page, filter, rows };
}

/**
 * Posts an admin settles by hand. "skip": the recognizer keeps failing on a post and every later one
 * waits behind it (they are recognized in order); after checking it, the post is set aside and the
 * queue moves on. "reviewed": claims held back from a post (a quote not in it, an unsure confirmation)
 * were dealt with (the event edited or confirmed, or nothing to do), so it leaves the review list.
 */
export async function resolveMonitorPost(id: string, input: { action: "skip" | "reviewed"; reason: string }, actor: string) {
  input = parse(z.object({ action: z.enum(["skip", "reviewed"]), reason: Reason }).strict(), input);
  return sql.begin(async (tx) => {
    // The recognizer takes the same post lock before assembling events.
    const [post] = await tx<{ processed_at: Date | null; recognition: Record<string, unknown> | null }[]>`SELECT processed_at, recognition FROM monitor_posts WHERE id = ${id} FOR UPDATE`;
    if (!post) return null;
    if (input.action === "skip") {
      if (post.processed_at) throw new Conflict("这条帖子已经识别过了，请刷新");
      await tx`
        UPDATE monitor_posts SET processed_at = now(),
          recognition = ${tx.json({ skipped: true, relevant: false, needsReview: false, propositions: [], reason: input.reason, by: actor } as never)}
        WHERE id = ${id} AND processed_at IS NULL`;
      await tx`DELETE FROM monitor_state WHERE key = ${`failures:${id}`}`;
    } else {
      await tx`UPDATE monitor_posts SET recognition = coalesce(recognition, '{}'::jsonb) || ${tx.json({ reviewed: true, reviewedBy: actor, reviewReason: input.reason } as never)} WHERE id = ${id}`;
    }
    await audit(actor, `monitor.post.${input.action}`, `monitor-post:${id}`, input.reason, { processedAt: post.processed_at }, { action: input.action }, undefined, tx);
    return { id, action: input.action };
  });
}

const Patch = z
  .object({
    type: z.enum(["direct_reset", "reset_credit"]),
    status: z.enum(["announced", "confirmed"]),
    confirmedAt: z.string().datetime({ offset: true }).nullable(),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    confirmationBasis: z.enum(["source_post", "receipt_review"]).nullable(),
    schedule: z
      .object({ precision: z.enum(["exact", "approximate", "deadline", "date", "window"]), from: z.string().datetime({ offset: true }), through: z.string().datetime({ offset: true }) })
      .nullable(),
    scope: z.string().max(200),
    scopeLabel: z.string().max(200).nullable(),
    audienceZh: z.string().max(300).nullable(),
    productsZh: z.string().max(200).nullable(),
  })
  .partial()
  .strict();

async function lockEvent(tx: Tx, id: string, version: string) {
  const [e] = await tx`SELECT * FROM monitor_events WHERE id = ${id} FOR UPDATE`;
  if (!e) return null;
  if (new Date(e.updated_at as Date).toISOString() !== version) throw new Conflict("这个事件已被修改（可能是新帖子刚到），请刷新后再改");
  return e;
}

export async function updateMonitorEvent(id: string, input: { patch: unknown; reason: string; version: string }, actor: string) {
  const parsed = parse(z.object({ patch: Patch, reason: Reason, version: Version }).strict(), input);
  const { patch } = parsed;
  input = parsed;
  return sql.begin(async (tx) => {
    const before = await lockEvent(tx, id, input.version);
    if (!before) return null;
    const schedule = patch.schedule === undefined ? undefined : patch.schedule ? manualSchedule(patch.schedule.precision, new Date(patch.schedule.from), new Date(patch.schedule.through)) : null;
    const presentation: Record<string, unknown> = {};
    if (patch.scopeLabel !== undefined) Object.assign(presentation, { scopeLabel: patch.scopeLabel, scopeKnown: !!patch.scopeLabel });
    if (patch.audienceZh !== undefined) presentation.audienceZh = patch.audienceZh;
    if (patch.productsZh !== undefined) presentation.productsZh = patch.productsZh;
    if (patch.status === "confirmed") presentation.inProgress = false;
    const confirming = patch.status === "confirmed" && before.status !== "confirmed";
    const [after] = await tx`
      UPDATE monitor_events SET
        type = coalesce(${patch.type ?? null}, type),
        label = CASE WHEN ${patch.type ?? null}::text IS NULL THEN label WHEN ${patch.type ?? null} = 'reset_credit' THEN '发重置卡' ELSE '全员重置' END,
        status = coalesce(${patch.status ?? null}, status),
        confirmed_at = CASE WHEN ${patch.confirmedAt !== undefined} THEN ${patch.confirmedAt ?? null}::timestamptz ELSE confirmed_at END,
        occurred_on = CASE WHEN ${patch.occurredOn !== undefined} THEN ${patch.occurredOn ?? null}::date ELSE occurred_on END,
        confirmation_basis = CASE WHEN ${patch.confirmationBasis !== undefined} THEN ${patch.confirmationBasis ?? null} ELSE confirmation_basis END,
        schedule = CASE WHEN ${schedule !== undefined} THEN ${schedule ? tx.json(schedule as never) : null}::jsonb ELSE schedule END,
        estimate = CASE WHEN ${confirming || patch.status === "confirmed"} THEN NULL ELSE estimate END,
        scope = coalesce(${patch.scope ?? null}, scope),
        presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json(presentation as never)},
        updated_at = greatest(clock_timestamp(), date_trunc('milliseconds', updated_at) + interval '1 millisecond')
      WHERE id = ${id} RETURNING *`;
    await audit(actor, "monitor.update", `monitor-event:${id}`, input.reason, pick(before, patch), pick(after!, patch), undefined, tx);
    return after;
  });
}

function pick(row: Record<string, unknown>, patch: Record<string, unknown>) {
  const cols: Record<string, string> = { type: "type", status: "status", confirmedAt: "confirmed_at", occurredOn: "occurred_on", confirmationBasis: "confirmation_basis", schedule: "schedule", scope: "scope" };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) out[k] = cols[k] ? row[cols[k]] : (row.presentation as Record<string, unknown> | null)?.[k];
  return out;
}

/**
 * Confirms an event from an account check: the reset or the card showed up in an account, but Tibo
 * never posted "done". The Beijing day is recorded only when known; no notification goes out. A later
 * confirmation post from Tibo takes over as the source (monitor/assemble.ts); this audit entry stays.
 */
export async function reviewReceipt(id: string, input: { occurredOn?: string | null; reason: string; version: string }, actor: string) {
  input = parse(z.object({ occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), reason: Reason, version: Version }).strict(), input);
  const day = input.occurredOn || null;
  const patch = { status: "confirmed", confirmationBasis: "receipt_review", ...(day ? { occurredOn: day } : {}) };
  return updateMonitorEvent(id, { patch, reason: input.reason, version: input.version }, actor);
}

export async function setWithdrawn(id: string, input: { withdrawn: boolean; reason: string; version: string }, actor: string) {
  input = parse(z.object({ withdrawn: z.boolean(), reason: Reason, version: Version }).strict(), input);
  return sql.begin(async (tx) => {
    const before = await lockEvent(tx, id, input.version);
    if (!before) return null;
    const [after] = await tx`UPDATE monitor_events SET withdrawn = ${input.withdrawn},
      updated_at = greatest(clock_timestamp(), date_trunc('milliseconds', updated_at) + interval '1 millisecond') WHERE id = ${id} RETURNING *`;
    await audit(actor, input.withdrawn ? "monitor.withdraw" : "monitor.restore", `monitor-event:${id}`, input.reason, { withdrawn: before.withdrawn }, { withdrawn: input.withdrawn }, undefined, tx);
    return after;
  });
}

/** Moves (or removes) one post's link; both events' versions change. */
export async function relinkPost(input: { postId: string; fromEventId: string; toEventId: string | null; reason: string }, actor: string) {
  input = parse(z.object({ postId: z.string().min(1), fromEventId: z.string().min(1), toEventId: z.string().min(1).nullable(), reason: Reason }).strict(), input);
  if (input.fromEventId === input.toEventId) throw Object.assign(new Error("目标事件不能与原事件相同"), { statusCode: 400 });
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM monitor_posts WHERE id = ${input.postId} FOR UPDATE`;
    const eventIds = [input.fromEventId, input.toEventId].filter((x): x is string => !!x).sort();
    const events = await tx`SELECT id FROM monitor_events WHERE id IN ${tx(eventIds)} ORDER BY id FOR UPDATE`;
    if (events.length !== eventIds.length) throw new Conflict("原事件或目标事件不存在，请刷新");
    const [link] = await tx`SELECT * FROM monitor_event_posts WHERE event_id = ${input.fromEventId} AND post_id = ${input.postId} FOR UPDATE`;
    if (!link) throw new Conflict("这条帖子不在原事件里");
    if (input.toEventId) {
      const [existing] = await tx`SELECT post_id FROM monitor_event_posts WHERE event_id = ${input.toEventId} AND post_id = ${input.postId}`;
      if (existing) throw new Conflict("这条帖子已在目标事件里，请刷新后核对归属");
      await tx`
        INSERT INTO monitor_event_posts (event_id, post_id, stage, action, text, original_text)
        VALUES (${input.toEventId}, ${input.postId}, ${link.stage}, ${link.action}, ${link.text}, ${link.original_text})`;
    }
    await tx`DELETE FROM monitor_event_posts WHERE event_id = ${input.fromEventId} AND post_id = ${input.postId}`;
    await tx`UPDATE monitor_events SET updated_at = greatest(clock_timestamp(), date_trunc('milliseconds', updated_at) + interval '1 millisecond') WHERE id IN ${tx(eventIds)}`;
    await audit(actor, "monitor.relink", `monitor-post:${input.postId}`, input.reason, { event: input.fromEventId }, { event: input.toEventId }, undefined, tx);
    return { moved: true };
  });
}
