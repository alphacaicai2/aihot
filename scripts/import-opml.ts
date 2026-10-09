// node --env-file=.env scripts/import-opml.ts <file.opml> <label> [--dry-run] [--dedup-miniflux]
import { readFileSync } from "node:fs";
import { closeDb } from "@aihot/backend/db";
import { listMinifluxFeeds } from "@aihot/backend/sources/miniflux";
import { importOpml, parseOpml } from "@aihot/backend/sources/opml";

try {
  const [file, label] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!file || !label) throw new Error("Usage: import-opml.ts <file.opml> <label> [--dry-run] [--dedup-miniflux]");
  const parsed = parseOpml(readFileSync(file, "utf8"));
  if (!parsed.feeds.length) throw new Error("OPML contains no valid feeds");
  const result = await importOpml(parsed.feeds, {
    label, dryRun: process.argv.includes("--dry-run"),
    minifluxFeeds: process.argv.includes("--dedup-miniflux") ? await listMinifluxFeeds() : [],
  });
  console.log(JSON.stringify({ feeds: parsed.feeds.length, invalid: parsed.invalid, duplicates: parsed.duplicates,
    added: result.added, skipped: result.skipped, dryRun: process.argv.includes("--dry-run") }));
} finally { await closeDb(); }
