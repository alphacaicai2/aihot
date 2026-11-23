// Pass --apply to save verified additions from completed receipts. The default is read-only.
import { closeDb } from "@aihot/backend/db";
import { replayFinancingDigests, replayInvalidFinancingArticle } from "@aihot/backend/editorial/financing-replay";

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
const selection = apply ? args.slice(1) : args;
const single = selection[0] === "--single-invalid";
const ids = [...new Set((single ? selection.slice(1) : selection).map(Number))];
try {
  if (single && selection.length !== 2) throw new Error("--single-invalid requires exactly one analysis ID");
  const improved = single ? await replayInvalidFinancingArticle(ids[0]!,apply) : await replayFinancingDigests(ids,apply);
  console.log(JSON.stringify({ mode:apply ? "applied" : "preview", improved, skipped:ids.filter(id => !improved.some(r => r.id === id)) }));
} finally { await closeDb(); }
