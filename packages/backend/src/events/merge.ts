// Facts, aliases, heat, public projections and the audit commit together; no locks span a model call.
import { sql, type Db } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { stableJson } from "../lib/ids.ts";
import { storyEvidence, type StoryEvidence } from "./grouping-evidence.ts";

export interface MergeOptions {
  expected?: { from: StoryEvidence; into: StoryEvidence };
  receiptIds?: number[];
  dryRun?: boolean;
  requireEmptyFrom?: boolean;
}

const memberArticles = (db: Db, fromId: number, intoId: number) => db<{ article_id: string }[]>`
  SELECT DISTINCT fa.article_id FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id
  WHERE f.story_id IN (${fromId},${intoId}) ORDER BY fa.article_id`;

class MembershipChanged extends Error {}

/** Null when the pair is no longer current. Dry runs validate the pair but do not write a merge. */
export async function mergeStoryInto(fromId: number, intoId: number, reason: string, actor: string, opts: MergeOptions = {}): Promise<{ moved: number } | null> {
  if (fromId === intoId) throw new Error("cannot merge a story into itself");
  // An insertion that finished before we locked the stories can enlarge the article set. Restart
  // the short transaction rather than taking a new article lock after a story lock (deadlock).
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await sql.begin(async tx => {
        const initial = await memberArticles(tx, fromId, intoId);
        const ids = initial.map(a => a.article_id);
        if (ids.length) await tx`SELECT id FROM articles WHERE id=ANY(${ids}) ORDER BY id FOR UPDATE`;
        // Publishing can invalidate another story citing a report as a mention. Lock the full
        // affected set in order before publications, matching digest and grouping commits.
        const affected = await tx<{ id: number }[]>`SELECT s.id FROM stories s WHERE s.id IN (${fromId},${intoId}) OR s.id IN (
          SELECT f.story_id FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id WHERE fa.article_id=ANY(${ids})) OR s.id IN (
          SELECT p.story_id FROM publications p WHERE p.article_id=ANY(${ids})) ORDER BY s.id`;
        const locked = await tx<{ id: number; public_id: string; merged_into: number | null; title: string; version: number; origin: string }[]>`
          SELECT id,public_id,merged_into,title,version,origin FROM stories WHERE id=ANY(${affected.map(s => s.id)}::bigint[]) ORDER BY id FOR UPDATE`;
        const from = locked.find(s => s.id===fromId), into = locked.find(s => s.id===intoId);
        if (!from || !into || from.merged_into || into.merged_into) return null;
        if (stableJson(initial)!==stableJson(await memberArticles(tx,fromId,intoId))) throw new MembershipChanged();
        await tx`SELECT id FROM facts WHERE story_id IN (${fromId},${intoId}) ORDER BY id FOR UPDATE`;
        if (ids.length) {
          await tx`SELECT article_id FROM publications WHERE article_id=ANY(${ids}) ORDER BY article_id FOR UPDATE`;
          await tx`SELECT id FROM sources WHERE id IN (SELECT source_id FROM articles WHERE id=ANY(${ids})) ORDER BY id FOR SHARE`;
          await tx`SELECT article_id FROM regroup_pending WHERE article_id=ANY(${ids}) ORDER BY article_id FOR SHARE`;
        }
        if (opts.expected) {
          const fromInput = await storyEvidence(fromId,tx), intoInput = await storyEvidence(intoId,tx);
          if (!fromInput || !intoInput || from.origin==='manual' || into.origin==='manual'
            || stableJson(fromInput)!==stableJson(opts.expected.from) || stableJson(intoInput)!==stableJson(opts.expected.into)) return null;
        }
        if (opts.requireEmptyFrom) {
          const [report] = await tx`SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id
            WHERE f.story_id=${fromId} AND fa.role IN ('primary','report') LIMIT 1`;
          if (report || from.origin==='manual') return null;
        }
        if (opts.dryRun) {
          for (const id of opts.receiptIds ?? []) await completeReceipt(tx,id);
          return { moved: 0 };
        }
        await tx`UPDATE facts SET story_id=${intoId},updated_at=now() WHERE story_id=${fromId}`;
        await tx`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
          SELECT ${intoId},article_id,participant_key,source_id,kind,observed_at FROM story_signals WHERE story_id=${fromId}
          ON CONFLICT(story_id,article_id) DO NOTHING`;
        await tx`DELETE FROM story_signals WHERE story_id=${fromId}`;
        await tx`UPDATE stories SET merged_into=${intoId},version=version+1,updated_at=now() WHERE id=${fromId}`;
        await tx`UPDATE stories SET version=version+1,updated_at=now(),
          latest_at=greatest(latest_at,(SELECT latest_at FROM stories WHERE id=${fromId})),
          first_report_at=least(first_report_at,(SELECT first_report_at FROM stories WHERE id=${fromId})) WHERE id=${intoId}`;
        await tx`INSERT INTO story_aliases(public_id,story_id) VALUES(${from.public_id},${intoId}) ON CONFLICT DO NOTHING`;
        for (const id of ids) await publishArticleTx(tx,id);
        await enqueue(QUEUES.digest,{storyId:intoId},{singletonKey:`story:${intoId}`},tx);
        await tx`INSERT INTO audit_log(actor,action,subject,reason,"before","after") VALUES(${actor},'story.merge',${`story:${fromId}`},${reason},
          ${tx.json({from,into})},${tx.json({into:intoId})})`;
        for (const id of opts.receiptIds ?? []) await completeReceipt(tx,id);
        return { moved: ids.length };
      });
    } catch (error) {
      if (!(error instanceof MembershipChanged)) throw error;
    }
  }
  throw new Error("story membership changed repeatedly during merge; retry the merge");
}
