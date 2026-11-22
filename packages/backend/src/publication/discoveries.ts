import { sql } from "../db.ts";
import { ITEM_COLUMNS, ITEM_FROM, selectedCondition, toFeedItemSummary, type ItemRow } from "./items.ts";
import { withSearchCapacity } from "./pool.ts";

/** One observed source is a coverage fact, not a claim of an exclusive scoop. */
export async function loadDiscoveries(now = new Date()) {
  const rows = await withSearchCapacity(db => db<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
    WHERE ${selectedCondition(now)} AND p.eligible AND p.first_party AND p.fact_id IS NOT NULL
      AND p.timeline_at > ${new Date(now.getTime() - 7 * 86400000)}
      AND NOT EXISTS (SELECT 1 FROM publications other WHERE other.fact_id = p.fact_id
        AND other.source_id <> p.source_id AND other.visibility = 'public' AND other.eligible
        AND (NOT other.selected OR other.visible_after <= ${now}))
      AND NOT EXISTS (SELECT 1 FROM publications newer WHERE newer.fact_id = p.fact_id
        AND newer.source_id = p.source_id AND newer.selected AND newer.eligible AND newer.visibility = 'public'
        AND newer.visible_after <= ${now} AND (newer.timeline_at, newer.article_id) > (p.timeline_at, p.article_id))
    ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT 40`);
  return { items: rows.map(toFeedItemSummary) };
}
