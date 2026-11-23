// Preview explicitly identified non-financing digests that were never extracted.
// Pass --apply to enqueue the listed analysis IDs behind new reporting. Worker budgets
// and receipts still govern every request; repeating the command skips queued work.
import { closeDb } from "@aihot/backend/db";
import { historicalFinancingDigests } from "@aihot/backend/editorial/financing-sweep";

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
const ids = [...new Set((apply ? args.slice(1) : args).map(Number))];
try {
  const eligible = await historicalFinancingDigests(ids, apply);
  console.log(JSON.stringify({ mode: apply ? "queued" : "preview", eligible, skipped: ids.filter(id => !eligible.includes(id)) }));
} finally { await closeDb(); }
