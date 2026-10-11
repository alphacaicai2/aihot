// Feedback handling: list, status and note, per-source bans, and deletion on request
// (privacy notice: feedback material is removed once handling ends or when the sender asks).
import { z } from "zod";
import { sql } from "../db.ts";
import { cleanupFeedbackFiles, feedbackScreenshotPath, queueFeedbackFileCleanup } from "../operations/feedback-files.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";

export const FEEDBACK_STATUSES = ["new", "triaged", "replied", "resolved", "spam"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

const SourceHash = z.string().min(1).max(200).regex(/^[\w:-]+$/);
const Reason = z.string().trim().min(1).max(2000);
const Version = z.string().datetime({ offset: true });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw Object.assign(new Error(result.error.message), { statusCode: 400 });
  return result.data;
}
function validId(id: number) { parse(z.number().int().positive().max(Number.MAX_SAFE_INTEGER), id); }

export async function listFeedback(f: { status?: string; q?: string; page?: number }) {
  const page = Math.max(1, f.page ?? 1);
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  const rows = await sql`
    SELECT fb.id, fb.content, fb.email, fb.page_url, split_part(fb.screenshot_key, ':', 1) AS screenshot, fb.source_hash, fb.status, fb.note,
           fb.forwarded_at, fb.forward_error, fb.created_at, fb.updated_at, fb.erased_at,
           EXISTS (SELECT 1 FROM feedback_file_cleanup c WHERE c.feedback_id=fb.id) AS cleanup_pending,
           EXISTS (SELECT 1 FROM feedback_bans b WHERE b.source_hash = fb.source_hash) AS banned,
           (SELECT count(*)::int FROM feedback o WHERE o.source_hash = fb.source_hash) AS from_source
    FROM feedback fb
    WHERE (${f.status ?? null}::text IS NULL OR fb.status = ${f.status ?? null})
      AND (${q}::text IS NULL OR fb.content ILIKE ${q} OR fb.email ILIKE ${q} OR fb.page_url ILIKE ${q})
    ORDER BY fb.created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`;
  const counts = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM feedback GROUP BY 1`;
  const bans = await sql`SELECT source_hash, reason, created_by, created_at FROM feedback_bans ORDER BY created_at DESC LIMIT 100`;
  return { page, rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), bans };
}

export async function updateFeedback(id: number, input: { status?: string; note?: string | null; version: string }, actor: string) {
  validId(id);
  input = parse(z.object({ status: z.enum(FEEDBACK_STATUSES).optional(), note: z.string().max(10000).nullable().optional(), version: Version }).strict(), input);
  return sql.begin(async (tx) => {
    const [before] = await tx`SELECT id, status, note, updated_at FROM feedback WHERE id = ${id} FOR UPDATE`;
    if (!before) return null;
    if (new Date(before.updated_at as Date).toISOString() !== input.version) throw new Conflict("这条反馈已被修改，请刷新后再操作");
    const [after] = await tx`
      UPDATE feedback SET status = coalesce(${input.status ?? null}, status), note = ${input.note === undefined ? before.note : input.note},
        updated_at = greatest(clock_timestamp(), date_trunc('milliseconds', updated_at) + interval '1 millisecond')
      WHERE id = ${id} RETURNING id, status, note, updated_at`;
    await audit(actor, "feedback.update", `feedback:${id}`, null, { status: before.status, note: before.note }, { status: after!.status, note: after!.note }, undefined, tx);
    return after;
  });
}

/** Refuses further feedback from one source (an unreadable hash of IP and browser family). */
export async function banSource(sourceHash: string, reason: string, actor: string) {
  sourceHash = parse(SourceHash, sourceHash); reason = parse(Reason, reason);
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`feedback-source:${sourceHash}`},0))`;
    const rows = await tx`INSERT INTO feedback_bans (source_hash, reason, created_by) VALUES (${sourceHash}, ${reason}, ${actor}) ON CONFLICT (source_hash) DO NOTHING RETURNING source_hash`;
    if (rows.length) await audit(actor, "feedback.ban", `feedback-source:${sourceHash}`, reason, null, { banned: true }, undefined, tx);
  });
}

export async function unbanSource(sourceHash: string, actor: string) {
  sourceHash = parse(SourceHash, sourceHash);
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`feedback-source:${sourceHash}`},0))`;
    const rows = await tx`DELETE FROM feedback_bans WHERE source_hash = ${sourceHash} RETURNING reason`;
    if (rows.length) await audit(actor, "feedback.unban", `feedback-source:${sourceHash}`, null, { reason: rows[0]!.reason }, null, undefined, tx);
  });
}

export async function feedbackScreenshot(id: number): Promise<string | null> {
  validId(id);
  const [row] = await sql<{ screenshot_key: string | null }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  return feedbackScreenshotPath(row?.screenshot_key ?? null);
}

/** Removes the sender's material (text, email, page, screenshot) and keeps only the handling record. */
export async function eraseFeedback(id: number, reason: string, actor: string, options: { version?: string } = {}) {
  validId(id); reason = parse(Reason, reason);
  if (options.version !== undefined) parse(Version, options.version);
  const found = await sql.begin(async tx => {
    const [row] = await tx<{ screenshot_key: string | null; erased_at: Date | null; updated_at: Date }[]>`SELECT screenshot_key,erased_at,updated_at FROM feedback WHERE id=${id} FOR UPDATE`;
    if (!row) return false;
    if (row.erased_at) return { filename: null };
    if (options.version !== undefined && row.updated_at.toISOString() !== options.version) throw new Conflict("这条反馈已被修改，请刷新后再删除");
    await queueFeedbackFileCleanup(tx,id,row.screenshot_key);
    await tx`UPDATE feedback SET content='（已按要求删除）',email=NULL,page_url=NULL,screenshot_key=NULL,forward_error=NULL,
      erased_at=clock_timestamp(),updated_at=greatest(clock_timestamp(),date_trunc('milliseconds',updated_at)+interval '1 millisecond') WHERE id=${id}`;
    await audit(actor,"feedback.erase",`feedback:${id}`,reason,null,{ erased: true },undefined,tx);
    return { filename: feedbackScreenshotPath(row.screenshot_key) ? row.screenshot_key!.slice(6) : null };
  });
  if (!found) return null;
  const files = await sql<{ filename: string }[]>`SELECT filename FROM feedback_file_cleanup WHERE feedback_id=${id} OR filename=${found.filename}`;
  if (files.length) await cleanupFeedbackFiles(files.map(f=>f.filename));
  const [pending] = await sql`SELECT 1 FROM feedback_file_cleanup WHERE feedback_id=${id} OR filename=${found.filename}`;
  return { erased: true, cleanupPending: !!pending };
}
