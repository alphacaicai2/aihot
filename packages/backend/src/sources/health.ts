import { sql } from "../db.ts";

/** Automatic recovery checks apply to independently scheduled pull sources. */
export function longFailedSource(recordingFailure = false) {
  // The failure UPDATE sees the counter before this attempt's increment.
  return sql`(enabled AND kind IN ('rss', 'web_list', 'json_list')
    AND fail_count >= ${recordingFailure ? 4 : 5}
    AND coalesce(last_ok_at, created_at) <= now() - interval '7 days')`;
}
