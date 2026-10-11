// Operator settings: about-page QR codes (replaced without a release), notification targets
// (switching a group on records enabled_at so older content is never back-filled) and per-service
// request budgets (the circuit breaker paid calls check before sending).
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { loadContact, type ContactSettings } from "../site/contact.ts";
import { audit } from "./auth.ts";

const MAX_QR_BYTES = 2 * 1024 * 1024;

export async function replaceContactQr(input: { slot: keyof ContactSettings; data: Buffer }, actor: string) {
  if (input.slot !== "wechatQr" && input.slot !== "feishuQr") throw Object.assign(new Error("unknown slot"), { statusCode: 400 });
  if (input.data.length > MAX_QR_BYTES) throw Object.assign(new Error("二维码图片最大 2MB"), { statusCode: 400 });
  const meta = await sharp(input.data).metadata().catch(() => null);
  if (!meta || !["png", "jpeg", "webp"].includes(meta.format ?? "")) throw Object.assign(new Error("需要 PNG、JPG 或 WebP 图片"), { statusCode: 400 });
  if ((meta.width ?? 0) < 120 || (meta.height ?? 0) < 120) throw Object.assign(new Error("图片太小，二维码可能扫不出来"), { statusCode: 400 });
  const ext = meta.format === "jpeg" ? "jpg" : meta.format!;
  const digest = sha256(input.data);
  const name = `qr-${input.slot === "wechatQr" ? "wechat" : "feishu"}-${digest}.${ext}`;
  const dir = path.join(config.dataDir, "uploads");
  await mkdir(dir, { recursive: true });
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('settings:contact_qr', 0))`;
    const before = await loadContact(tx);
    const next = { ...before, [input.slot]: `/contact/${name}` };
    await tx`INSERT INTO settings (key, value, updated_by) VALUES ('contact_qr', ${tx.json(next)}, ${actor})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "settings.contact_qr", "settings:contact_qr", null, { [input.slot]: before[input.slot] }, { [input.slot]: next[input.slot] }, undefined, tx);
    // A failed commit may leave an unreferenced file. The public route checks committed references.
    const file = path.join(dir, name);
    const handle = await open(file, 'wx').catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      if (sha256(await readFile(file)) !== digest) throw new Error('QR file content does not match its hash');
      return null;
    });
    if (handle) {
      try { await handle.writeFile(input.data); await handle.close(); }
      catch (error) { await handle.close().catch(() => {}); await unlink(file).catch(() => {}); throw error; }
    }
    return next;
  });
}

export async function listTargets() {
  return sql`
    SELECT t.key, t.purpose, t.kind, t.enabled, t.enabled_at, t.config_ref, t.note, t.updated_at,
           (SELECT count(*)::int FROM deliveries d WHERE d.target_key = t.key AND d.created_at > now() - interval '7 days') AS deliveries_7d,
           (SELECT max(d.sent_at) FROM deliveries d WHERE d.target_key = t.key) AS last_sent_at
    FROM notify_targets t ORDER BY t.purpose, t.key`;
}

export async function setTargetEnabled(key: string, enabled: boolean, reason: string, actor: string) {
  if (typeof reason !== 'string' || !reason.trim()) throw Object.assign(new Error("reason is required"), { statusCode: 400 });
  if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be boolean'), { statusCode: 400 });
  return sql.begin(async tx => {
    const [before] = await tx`SELECT enabled, enabled_at FROM notify_targets WHERE key = ${key} FOR UPDATE`;
    if (!before) return null;
    const [after] = await tx<{ key: string; enabled: boolean; enabled_at: Date | null }[]>`
      UPDATE notify_targets SET enabled = ${enabled}, enabled_at = CASE WHEN ${enabled} AND NOT enabled THEN clock_timestamp() ELSE enabled_at END, updated_at = clock_timestamp()
      WHERE key = ${key} RETURNING key, enabled, enabled_at`;
    await audit(actor, enabled ? "notify.enable" : "notify.disable", `notify-target:${key}`, reason, before, after, undefined, tx);
    return { ...after, pushEnabledHere: config.feishuContentPushEnabled };
  });
}

export async function listBudgets() {
  return sql`
    SELECT b.service, b.per_minute, b.per_hour, b.per_day, b.note, b.updated_at,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day') AS used_day,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 hour') AS used_hour
    FROM budgets b ORDER BY b.service`;
}

export async function updateBudget(service: string, input: { perMinute: number; perHour: number; perDay: number; reason: string }, actor: string) {
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw Object.assign(new Error("reason is required"), { statusCode: 400 });
  for (const v of [input.perMinute, input.perHour, input.perDay]) if (!Number.isInteger(v) || v < 0 || v > 2147483647) throw Object.assign(new Error("budgets must be integers from 0 through 2147483647 (0 stops the service)"), { statusCode: 400 });
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`budget:${service}`}, 0))`;
    const [before] = await tx`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
    const [after] = await tx`
      INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${service}, ${input.perMinute}, ${input.perHour}, ${input.perDay}, ${input.reason})
      ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day, note = EXCLUDED.note, updated_at = now()
      RETURNING service, per_minute, per_hour, per_day`;
    await audit(actor, "budget.update", `budget:${service}`, input.reason, before ?? null, after, undefined, tx);
    return after;
  });
}
