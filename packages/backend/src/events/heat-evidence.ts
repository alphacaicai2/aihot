// Retain signal history, but only current public evidence contributes to a public hot ranking.
import { sql } from '../db.ts';

export const visibleHeatSignals = (at: Date) => sql`(
  SELECT ss.story_id,ss.article_id,ss.participant_key,ss.source_id,ss.observed_at,s.name,s.tier,
    CASE WHEN s.participation_mode='editorial' THEN 'editorial' ELSE 'signal' END AS kind
  FROM story_signals ss JOIN sources s ON s.id=ss.source_id
  JOIN publications p ON p.article_id=ss.article_id AND p.source_id=s.id
  WHERE p.visibility='public' AND (NOT p.selected OR p.visible_after<=${at}) AND (
    (s.participation_mode='hot_signal') OR
    (s.participation_mode='editorial' AND ss.kind='editorial' AND p.eligible AND EXISTS(
      SELECT 1 FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id
      WHERE fa.article_id=ss.article_id AND f.story_id=ss.story_id AND fa.role IN ('primary','report')))))`;
