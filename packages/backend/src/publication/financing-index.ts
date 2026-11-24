// Readers use the index only for an unchanged set of visible claims. The live path also
// covers writes committed since the last worker tick and historical as-of queries.
import { sql, type Db } from "../db.ts";
import { listedCondition } from "./items.ts";
import { financingClaims, dealRows, namedDeal } from "./research.ts";
import { financingRounds, type RoundSource } from "./financing-rounds.ts";

export const financingJoins = sql`FROM publications p JOIN analyses an ON an.id=p.analysis_id AND an.article_id=p.article_id
  CROSS JOIN ${dealRows}`;
export const financingCandidate = sql`p.eligible AND (p.category='financing' OR an.output ? 'financingClaims')`;
export const publicFinancing = (now: Date) => sql`${listedCondition(now)} AND ${financingCandidate} AND ${namedDeal}`;

export interface Mention {
  article_id: string;
  seq: number;
  timeline_at: Date;
  preferred: boolean | null;
}

interface Source extends Mention, RoundSource {
  matches: boolean;
}

export async function financingSources(db: Db, now: Date, filter = sql``) {
  // Shared article facts never merge transactions. Reviewed rounds and matching terms do.
  return db<Source[]>`
    SELECT CASE WHEN jsonb_array_length(${financingClaims}) > 1 THEN 'deal:' || p.article_id || ':' || deal.seq
      ELSE 'item:' || p.article_id END AS base_id,
      p.article_id, deal.seq, coalesce(deal.round_id,review.round_id) AS reviewed_id, deal.preferred,
      p.timeline_at, p.published_at AS reported_at, deal.claim->>'company' AS company,
      deal.claim->>'round' AS stage, deal.claim->>'amountText' AS amount, deal.claim->>'currency' AS currency,
      deal.claim->>'kind' AS kind, deal.claim->>'amountBasis' AS basis, deal.claim->>'status' AS status,
      deal.claim->'investors' AS investors, deal.claim->>'recordType' AS record_type, deal.claim->>'evidence' AS evidence,
      (true ${filter}) AS matches
    ${financingJoins} LEFT JOIN financing_round_sources review ON review.article_id=p.article_id
      AND review.company=deal.claim->>'company' AND review.evidence=deal.claim->>'evidence'
    WHERE ${publicFinancing(now)}
    ORDER BY p.timeline_at DESC,p.article_id DESC,deal.seq`;
}

// A rules change or a rebuild by an older worker invalidates the cached grouping.
const rulesKey = "financing.index-rules";
const rulesVersion = 2;

export async function financingIndexReady(db: Db, at: Date) {
  const [row] = await db`SELECT 1 FROM financing_index_state
    JOIN settings rules ON rules.key=${rulesKey} AND rules.value=to_jsonb(${rulesVersion}::int) AND rules.updated_at=built_at
    WHERE singleton AND built_at<=${at}
    AND (valid_until IS NULL OR valid_until>${at}) AND NOT EXISTS (
      SELECT 1 FROM financing_index_changes d
      LEFT JOIN publications p ON p.article_id=d.article_id LEFT JOIN analyses an ON an.id=p.analysis_id
      WHERE d.article_id='' OR EXISTS (SELECT 1 FROM financing_index_members m WHERE m.article_id=d.article_id)
        OR (p.visibility='public' AND ${financingCandidate} AND an.output ?| ARRAY['financingClaims','financing'])
    )`;
  return !!row;
}

export async function refreshFinancingIndex() {
  return sql.begin("isolation level repeatable read", async tx => {
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext('financing.index')) AS acquired`;
    if (!lock.acquired) return;
    const at = new Date();
    const ready = await financingIndexReady(tx, at);
    await tx`DELETE FROM financing_index_changes`;
    if (ready) return;
    const sources = await financingSources(tx, at);
    const groups = financingRounds(sources);
    const members = [...groups].flatMap(([round_id, rows]) => rows.map(row => ({
      article_id: row.article_id, seq: row.seq, round_id, timeline_at: row.timeline_at,
      reported_at: row.reported_at, preferred: row.preferred,
      claim: { company: row.company, kind: row.kind, investors: row.investors },
    })));
    await tx`DELETE FROM financing_index_members`;
    for (let i = 0; i < members.length; i += 1000) {
      await tx`INSERT INTO financing_index_members ${tx(members.slice(i, i + 1000))}`;
    }
    await tx`UPDATE financing_index_state SET built_at=${at}, valid_until=(
      SELECT min(p.visible_after) FROM publications p JOIN analyses an ON an.id=p.analysis_id
      WHERE ${financingCandidate} AND p.visibility='public' AND p.selected AND p.visible_after>${at}
    ) WHERE singleton`;
    await tx`INSERT INTO settings (key,value,updated_at) VALUES (${rulesKey},to_jsonb(${rulesVersion}::int),${at})
      ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`;
    return { rounds: groups.size, mentions: members.length };
  });
}
