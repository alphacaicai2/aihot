// Remove generated claims as part of the publication/membership write, before a new model answer.
import type { Db } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";

// Callers writing publications take these story locks before writing publication rows, matching
// digest commits' story → publication order. The snapshots remain available in the audit/history.
export async function invalidateStoryDigests(db: Db, storyIds: number[], articleId: string, removedFactIds: number[] = []) {
  if (!storyIds.length) return;
  const stories = await db`SELECT id,title,digest,latest,summary,digest_updated_at,version,origin FROM stories
    WHERE id=ANY(${storyIds}::bigint[]) AND merged_into IS NULL ORDER BY id FOR UPDATE`;
  // A fact's automatically extracted title/date/frame may repeat the corrected claim too. Keep
  // membership and human facts; current public reports become the temporary automatic title.
  const facts = await db`SELECT f.* FROM facts f WHERE NOT f.manual AND f.story_id=ANY(${stories.map(s=>s.id)}::bigint[])
    AND (f.id=ANY(${removedFactIds}::bigint[]) OR EXISTS (
      SELECT 1 FROM fact_articles fa WHERE fa.fact_id=f.id AND fa.article_id=${articleId})) ORDER BY f.id FOR UPDATE`;
  for (const fact of facts) {
    const [after] = await db`UPDATE facts f SET title=coalesce((SELECT p.title FROM fact_articles fa JOIN publications p ON p.article_id=fa.article_id
      WHERE fa.fact_id=f.id AND p.visibility='public' AND p.eligible
      ORDER BY p.first_party DESC,coalesce(p.published_at,p.discovered_at),p.article_id LIMIT 1),'事件报道已更新'),
      subject=NULL,action=NULL,object=NULL,conditions=NULL,occurred_at=NULL,version=version+1,updated_at=now()
      WHERE id=${fact.id} RETURNING title,subject,action,object,conditions,occurred_at,version`;
    await db`INSERT INTO audit_log(actor,action,subject,reason,"before","after") VALUES ('publication','fact.invalidate',
      ${`fact:${fact.id}`},${`article:${articleId} changed public evidence`},${db.json(fact)},${db.json(after!)})`;
  }
  for (const story of stories) {
    const [after] = await db`UPDATE stories s SET digest=NULL,latest=NULL,summary=NULL,digest_updated_at=NULL,
      title=CASE WHEN origin='manual' THEN title ELSE coalesce((
        SELECT p.title FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id JOIN publications p ON p.article_id=fa.article_id
        WHERE f.story_id=s.id AND p.visibility='public' AND p.eligible
        ORDER BY p.first_party DESC,coalesce(p.published_at,p.discovered_at),p.article_id LIMIT 1),'事件报道已更新') END,
      version=version+1,updated_at=now() WHERE id=${story.id}
      RETURNING title,digest,latest,summary,version`;
    await db`INSERT INTO audit_log(actor,action,subject,reason,"before","after")
      VALUES ('publication','story.invalidate',${`story:${story.id}`},${`article:${articleId} changed public evidence`},${db.json(story)},${db.json(after!)})`;
    await enqueue(QUEUES.digest,{storyId:story.id,afterCorrection:true},{singletonKey:`story:${story.id}:correction`},db);
  }
}
