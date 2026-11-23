import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { listSources, sourceDetail } from "@aihot/backend/admin/sources";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { collectSource } from "@aihot/backend/sources/collect";

const id = `source-health-${tag()}`;
let available = false;
const server = http.createServer((req, res) => {
  const ok = available && req.url !== "/gone";
  res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
  res.end(ok ? "[]" : "");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await closeDb();
});

test("long-failed pull sources stay enabled for daily checks and resume their configured interval on recovery", async () => {
  const cfg = { url };
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, interval_minutes, fail_count, health, created_at, last_ok_at)
    VALUES (${id}, ${id}, 'json_list', 'T2', 'editorial', ${sql.json(cfg)}, 60, 4, 'degraded', now()-interval '10 days', now()-interval '8 days')`;
  const listed = async () => (await listSources({ q: id, health: "long_failed" })).rows;
  assert.equal((await listed()).length, 0);
  assert.equal((await collectSource(id)).status, "failed");
  const [persistent] = await listed();
  assert.equal(persistent?.id, id);
  assert.equal(persistent.fail_count, 5);
  assert.equal(persistent.enabled, true);
  assert.equal(persistent.interval_minutes, 60);
  assert.ok(Math.abs(+persistent.next_fetch_at - +persistent.last_fetch_at - 86400000) < 1000);
  assert.equal((await sourceDetail(id))?.source.long_failed, true);

  await sql`UPDATE sources SET enabled=false WHERE id=${id}`;
  assert.equal((await listed()).length, 0);
  await sql`UPDATE sources SET enabled=true, last_ok_at=now()-interval '1 hour' WHERE id=${id}`;
  assert.equal((await listed()).length, 0, "recent success excludes a short outage");
  await sql`UPDATE sources SET last_ok_at=NULL WHERE id=${id}`;
  assert.equal((await listed()).length, 1, "a never-successful source uses its creation time");

  available = true;
  assert.equal((await collectSource(id)).status, "ok");
  assert.equal((await listed()).length, 0);
  const recovered = (await sourceDetail(id))!.source;
  assert.equal(recovered.long_failed, false);
  assert.deepEqual(recovered.config, cfg);
  assert.equal(recovered.fail_count, 0);
  assert.ok(Math.abs(+recovered.next_fetch_at - +recovered.last_fetch_at - 3600000) < 1000);
  assert.equal((await sql`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id=${id}`)[0]!.n, 2);
});

test("a daily source keeps its normal interval after the first failure", async () => {
  const daily = id + "-daily";
  await sql`INSERT INTO sources (id,name,kind,config,interval_minutes)
    VALUES (${daily},'daily feed','json_list',${sql.json({url: url + "/gone"})},1440)`;
  assert.equal((await collectSource(daily)).status, "failed");
  const [row] = await sql`SELECT fail_count, next_fetch_at - last_fetch_at = interval '1 day' AS daily
    FROM sources WHERE id=${daily}`;
  assert.equal(row?.fail_count, 1);
  assert.equal(row?.daily, true);
});
