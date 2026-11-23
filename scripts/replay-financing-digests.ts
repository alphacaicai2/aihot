// Pass --apply to save verified additions from completed receipts. The default is read-only.
import { closeDb } from "@aihot/backend/db";
import { replayFinancingDigests } from "@aihot/backend/editorial/financing-replay";

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
const ids = [...new Set((apply ? args.slice(1) : args).map(Number))];
try {
  const improved = await replayFinancingDigests(ids,apply);
  console.log(JSON.stringify({ mode:apply ? "applied" : "preview", improved, skipped:ids.filter(id => !improved.some(r => r.id === id)) }));
} finally { await closeDb(); }
