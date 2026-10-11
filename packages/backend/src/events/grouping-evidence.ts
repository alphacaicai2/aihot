// Current published evidence shared by candidate recall and automatic event consolidation.
import { sql, type Db } from "../db.ts";
import type { ReportView } from "./relate.ts";

/** A membership is evidence unless its report waits for a regroup; a manual one always is. */
export const trusted = (alias: string) =>
  sql`(${sql(alias)}.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = ${sql(alias)}.article_id))`;

/**
 * The fact that started a story: the one whose earliest trusted report came first. Fact ids do not
 * follow time once stories merge or come from an import, and an emptied fact starts nothing.
 */
export const rootFactOf = (story: ReturnType<typeof sql> | number) => sql`(
  SELECT y.id FROM facts y
  JOIN fact_articles z ON z.fact_id = y.id AND z.role IN ('primary', 'report') AND ${trusted("z")}
  JOIN publications q ON q.article_id = z.article_id AND q.visibility='public' AND q.eligible
  WHERE y.story_id = ${story}
  ORDER BY coalesce(q.published_at, q.discovered_at), y.id
  LIMIT 1)`;

export interface StoryRoot {
  storyId: number;
  at: Date;
  /** The story started as a multi-topic digest: never merged. */
  roundup: boolean;
  report: ReportView;
}

/** A story's root (rootFactOf), when it started, and the report that stands for it. */
async function storyRoot(storyId: number, db: Db): Promise<StoryRoot | null> {
  const [row] = await db<{
    subject: string | null; action: string | null; object: string | null; occurred_at: Date | null;
    title: string; summary: string | null; source: string; first_party: boolean; at: Date; started_at: Date; roundup: boolean;
  }[]>`
    SELECT f.subject, f.action, f.object, f.occurred_at, p.title, p.summary, s.name AS source, p.first_party,
           coalesce(p.published_at, p.discovered_at) AS at,
           (SELECT min(coalesce(q.published_at, q.discovered_at)) FROM fact_articles z JOIN publications q ON q.article_id = z.article_id AND q.visibility='public' AND q.eligible
            WHERE z.fact_id = f.id AND z.role IN ('primary', 'report') AND ${trusted("z")}) AS started_at,
           EXISTS (SELECT 1 FROM grouping_decisions d WHERE d.article_id = fa.article_id AND d.verdict = 'roundup') AS roundup
    FROM facts f
    JOIN fact_articles fa ON fa.fact_id = f.id AND fa.role IN ('primary', 'report') AND ${trusted("fa")}
    JOIN publications p ON p.article_id = fa.article_id AND p.visibility='public' AND p.eligible
    JOIN sources s ON s.id = p.source_id
    WHERE f.id = ${rootFactOf(storyId)}
    ORDER BY (fa.role = 'primary') DESC, p.timeline_at ASC
    LIMIT 1`;
  if (!row) return null;
  return {
    storyId, at: row.started_at, roundup: row.roundup,
    report: {
      title: row.title, source: row.source, firstParty: row.first_party, at: row.at, summary: row.summary,
      frame: { subject: row.subject, action: row.action, object: row.object, occurredAt: row.occurred_at ? row.occurred_at.toISOString().slice(0, 10) : null },
    },
  };
}


export async function storyEvidence(storyId: number, db: Db = sql) {
  const [story] = await db<{ id: number; public_id: string; title: string; version: number; origin: string }[]>`
    SELECT id,public_id,title,version,origin FROM stories WHERE id=${storyId} AND merged_into IS NULL`;
  if (!story) return null;
  const root = await storyRoot(storyId, db);
  if (!root) return null;
  const [facts] = await db<{ hash: string }[]>`SELECT md5(coalesce(string_agg(to_jsonb(f)::text,'' ORDER BY f.id),'')) AS hash
    FROM facts f WHERE story_id=${storyId}`;
  const [memberships] = await db<{ hash: string }[]>`SELECT md5(coalesce(string_agg((to_jsonb(fa) || jsonb_build_object(
    'publication',jsonb_build_array(p.article_id,p.analysis_id,p.revision,p.visibility,p.eligible,p.title,p.summary,p.first_party,p.published_at,p.discovered_at,p.timeline_at),
    'source',jsonb_build_array(s.id,s.name,s.participation_mode,s.first_party),
    'input',jsonb_build_array(a.revision,a.processing_generation), 'regroup',rp.requested_at))::text,'' ORDER BY fa.fact_id,fa.article_id),'')) AS hash
    FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id JOIN articles a ON a.id=fa.article_id
    LEFT JOIN publications p ON p.article_id=fa.article_id LEFT JOIN sources s ON s.id=p.source_id
    LEFT JOIN regroup_pending rp ON rp.article_id=fa.article_id WHERE f.story_id=${storyId}`;
  return { story, root, factsHash: facts!.hash, membershipsHash: memberships!.hash };
}
export type StoryEvidence = NonNullable<Awaited<ReturnType<typeof storyEvidence>>>;
