// Reading the latest published hot ranking. The web shows heat values; machine exits only ranks.
import type { HotParticipant, HotStripEntry } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { visibleHeatSignals } from "./heat-evidence.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";

export interface HotEntry {
  rank: number;
  storyId: number;
  storyPublicId: string;
  title: string;
  heat: number;
  /** "unknown": the earlier participants' sources were behind on collection, so there is no comparison. */
  trend: "up" | "down" | "flat" | "new" | "unknown";
  trendPct: number | null;
  badges: Array<"surge" | "new" | "rising">;
  participantCount: number;
  sourceCount: number;
  signalCount: number;
  reportCount: number;
  sourceNames: string[];
  latestAt: string;
  firstReportAt: string;
  representativeItemId: string | null;
  representativeUrl: string | null;
  representativeSource: string | null;
  /** 精选组 first by tier, then 氛围组; tier is absent on rankings from before 2026-09-29. */
  participants: Array<{ name: string; kind: "editorial" | "signal"; tier?: string }>;
  /** Internal snapshot witnesses; public response builders expose only the fields above. */
  evidence?: { reportIds:string[]; signals:Array<{articleId:string;sourceId:string;participantKey:string;kind:string;at:string;name:string;tier:string}> };
}

/** Faces are the 精选组 sources, T1 before T1.5 before T2; the rest (and 氛围组) count in "+N". */
const MAX_FACES = 6;
const TIER_ORDER = ["T1", "T1_5", "T2"];
export function tierRank(tier: string | undefined): number {
  const i = TIER_ORDER.indexOf(tier ?? "");
  return i < 0 ? TIER_ORDER.length : i;
}

export interface HotRanking {
  id: number;
  computedAt: string;
  ruleVersion: string;
  entries: HotEntry[];
  coverage: Record<string, unknown> | null;
}

let rankingPending: Promise<HotRanking | null> | null = null;

export function latestHotRanking(): Promise<HotRanking | null> {
  rankingPending ??= queryLatestHotRanking().finally(() => { rankingPending = null; });
  return rankingPending;
}

async function queryLatestHotRanking(): Promise<HotRanking | null> {
  const [row] = await sql<{ id: number; computed_at: Date; rule_version: string; entries: HotEntry[]; evidence: Record<string, unknown> | null }[]>`
    SELECT id, computed_at, rule_version, entries, evidence FROM hot_rankings WHERE published ORDER BY computed_at DESC LIMIT 1`;
  if (!row) return null;
  // The snapshot is historical evidence, not permission to keep exposing a withdrawn report,
  // isolated/renamed source, merged event or obsolete event title until the next scheduled ranking.
  const ids = row.entries.map(e => e.storyId);
  const [stories, people] = await Promise.all([
    sql<{ id:number; title:string; merged_into:number|null; report_ids:string[]; representative_id:string|null; representative_url:string|null; representative_source:string|null }[]>`
      SELECT s.id,s.title,s.merged_into,
        (SELECT coalesce(array_agg(DISTINCT p.article_id),ARRAY[]::text[]) FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id
          JOIN publications p ON p.article_id=fa.article_id JOIN sources src ON src.id=p.source_id
          WHERE f.story_id=s.id AND p.visibility='public' AND p.eligible AND src.participation_mode='editorial'
            AND (NOT p.selected OR p.visible_after<=${row.computed_at})) AS report_ids,
        p.article_id AS representative_id,p.url AS representative_url,src.name AS representative_source
      FROM stories s LEFT JOIN publications p ON p.article_id IN (
        SELECT e->>'representativeItemId' FROM jsonb_array_elements(${sql.json(row.entries as never)}) e
        WHERE (e->>'storyId')::bigint=s.id) AND p.visibility='public' AND p.eligible
        AND (NOT p.selected OR p.visible_after<=${row.computed_at})
      LEFT JOIN sources src ON src.id=p.source_id AND src.participation_mode='editorial'
      WHERE s.id=ANY(${ids}::bigint[])`,
    sql<{ story_id:number; article_id:string;source_id:string;participant_key:string;observed_at:Date;name:string; kind:'editorial'|'signal'; tier:string }[]>`
      SELECT ss.story_id,ss.article_id,ss.source_id,ss.participant_key,ss.observed_at,ss.name,ss.kind,ss.tier
      FROM ${visibleHeatSignals(row.computed_at)} ss
      WHERE ss.story_id=ANY(${ids}::bigint[]) AND ss.observed_at>${row.computed_at}::timestamptz-interval '48 hours'
        AND ss.observed_at<=${row.computed_at}
      ORDER BY ss.story_id,ss.participant_key,(ss.kind='editorial'),ss.observed_at`,
  ]);
  const byStory = new Map(stories.map(s => [s.id,s]));
  const entries = row.entries.filter(e => {
    const s = byStory.get(e.storyId), signals = people.filter(p => p.story_id===e.storyId);
    const participants = [...new Map(signals.map(p => [p.participant_key,p])).values()];
    if (!s || s.merged_into!==null || !s.report_ids.length) return false;
    if (e.representativeItemId && (s.representative_id!==e.representativeItemId || !s.representative_source
      || s.representative_source!==e.representativeSource || s.representative_url!==e.representativeUrl)) return false;
    if (e.evidence) return e.evidence.reportIds.every(id => s.report_ids.includes(id))
      && e.evidence.signals.every(old => signals.some(p => p.article_id===old.articleId && p.source_id===old.sourceId
        && p.participant_key===old.participantKey && p.kind===old.kind && p.observed_at.toISOString()===old.at
        && p.name===old.name && p.tier===old.tier));
    // Rankings predating witnesses use the conservative aggregate checks until recomputed.
    const editorial = participants.filter(p => p.kind==='editorial');
    return s.report_ids.length===e.reportCount && participants.length===e.participantCount && editorial.length===e.sourceCount && participants.length-editorial.length===e.signalCount
      && e.sourceNames.every(name => editorial.some(p => p.name===name))
      && e.participants.every(old => participants.some(p => p.name===old.name && p.kind===old.kind && (!old.tier || p.tier===old.tier)));
  }).map((e,i) => ({...e,title:byStory.get(e.storyId)!.title,rank:i+1}));
  return { id: row.id, computedAt: row.computed_at.toISOString(), ruleVersion: row.rule_version, entries, coverage: row.evidence };
}

// Coalesce concurrent reads only; edits can change faces and words without a new ranking.
interface Extras {
  faces: Map<string, string | null>;
  texts: Map<number, { summary: string | null; latest: string | null }>;
}
const extrasPending = new Map<number, Promise<Extras>>();

async function readExtras(ranking: HotRanking): Promise<Extras> {
  const pending = extrasPending.get(ranking.id);
  if (pending) return pending;
  const load = queryExtras(ranking);
  extrasPending.set(ranking.id, load);
  try { return await load; }
  finally { extrasPending.delete(ranking.id); }
}

async function queryExtras(ranking: HotRanking): Promise<Extras> {
  const ids = ranking.entries.map((e) => e.storyId);
  const [faces, texts] = await Promise.all([
    // A participant's face: the source's icon, else the avatar on that account's latest post in the story.
    sql<{ name: string; icon_url: string | null; avatar: string | null }[]>`
      SELECT DISTINCT ON (s.id) s.name, s.icon_url, a.x_post->>'avatarUrl' AS avatar
      FROM ${visibleHeatSignals(new Date(ranking.computedAt))} ss JOIN sources s ON s.id = ss.source_id
      LEFT JOIN articles a ON a.id = ss.article_id AND a.x_post ? 'avatarUrl'
      WHERE ss.story_id = ANY(${ids}::bigint[])
      ORDER BY s.id, (a.id IS NULL), a.discovered_at DESC`,
    sql<{ id: number; digest: string | null; summary: string | null; latest: string | null }[]>`
      SELECT id, digest, summary, latest FROM stories WHERE id = ANY(${ids}::bigint[])`,
  ]);
  const extras: Extras = {
    faces: new Map(faces.map((f) => [f.name, f.icon_url ?? f.avatar])),
    texts: new Map(texts.map((t) => [Number(t.id), { summary: t.digest ?? t.summary, latest: t.latest }])),
  };
  return extras;
}

/**
 * What the web adds to a ranking entry: participants with proxied faces in the order Faces shows them
 * (精选组 by tier, a real face before an initial within a tier, then 氛围组), the digest and the latest turn.
 */
export async function rankingExtras(ranking: HotRanking) {
  const { faces, texts } = await readExtras(ranking);
  return {
    participants: (e: HotEntry): HotParticipant[] => {
      const people = e.participants
        .map((p, i) => ({ p, i, icon: faces.get(p.name) ?? null }))
        .sort((x, y) => Number(y.p.kind === "editorial") - Number(x.p.kind === "editorial") || tierRank(x.p.tier) - tierRank(y.p.tier) || Number(!!y.icon) - Number(!!x.icon) || x.i - y.i);
      // Every name stays for the tooltip; only visible Faces need srcSet.
      return people.map(({ p, icon }, i): HotParticipant => {
        const person: HotParticipant = { name: p.name, kind: p.kind, iconUrl: proxiedImage(icon, "avatar") };
        const srcSet = p.kind === "editorial" && i < MAX_FACES ? proxiedImageSet(icon, "avatar") : undefined;
        if (srcSet) person.iconSrcSet = srcSet;
        return person;
      });
    },
    text: (e: HotEntry) => texts.get(e.storyId) ?? { summary: null, latest: null },
  };
}

/** Home "current hot" strip: 3–5 entries from the same ranking, hidden when there are fewer than 3. */
export async function loadHotStrip(): Promise<HotStripEntry[] | null> {
  const ranking = await latestHotRanking();
  if (!ranking || ranking.entries.length < 3) return null;
  const extras = await rankingExtras(ranking);
  return ranking.entries.slice(0, 5).map((e) => ({
    rank: e.rank,
    title: e.title,
    heat: e.heat,
    trend: e.trend,
    storyPublicId: e.storyPublicId,
    itemId: e.representativeItemId,
    participants: extras.participants(e),
    participantCount: e.participantCount,
  }));
}
