import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql, withCustomPlans } from "@aihot/backend/db";
after(closeDb);
test("slow search SQL is cancelled and a rolled-back connection remains usable", async () => {
  await assert.rejects(withCustomPlans(async tx => { await tx`SELECT pg_sleep(0.2)`; }, 20), (e: unknown) => (e as { code?: string }).code === "57014");
  const [row] = await sql`SELECT 1 AS healthy`;
  assert.equal(row!.healthy, 1);
});
