import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";

interface PrimaryClaim {
  providerKey: string;
  token: string;
  generation: string;
  probe: boolean;
}

const probeOnly = () => process.env.LLM_PRIMARY_MODE === "probe";
const cooldown = () => Math.max(1, Number(process.env.LLM_FALLBACK_COOLDOWN_SECONDS) || 300);

/** A shared circuit and concurrency cap. A full or open primary routes new work to its fallback. */
export async function acquirePrimary(providerKey: string, timeoutMs: number): Promise<PrimaryClaim | null> {
  const token = randomUUID();
  const limit = Math.max(1, Number(process.env.LLM_PRIMARY_MAX_CONCURRENCY) || 20);
  const leaseSeconds = Math.ceil(timeoutMs / 1000) + 60;
  return sql.begin(async (tx) => {
    await tx`INSERT INTO model_circuits(provider_key) VALUES (${providerKey}) ON CONFLICT DO NOTHING`;
    const [row] = await tx<{ generation: string; open_until: Date | null; open: boolean }[]>`
      SELECT generation, open_until, coalesce(open_until > now(), false) AS open
      FROM model_circuits WHERE provider_key = ${providerKey} FOR UPDATE`;
    if (row!.open) return null;
    await tx`DELETE FROM model_primary_leases WHERE provider_key = ${providerKey} AND expires_at <= now()`;
    const [active] = await tx<{ n: number }[]>`SELECT count(*) AS n FROM model_primary_leases WHERE provider_key = ${providerKey}`;
    if (active!.n >= limit) return null;
    const probe = probeOnly() || row!.open_until !== null;
    let generation = row!.generation;
    if (probe) {
      const [claimed] = await tx<{ generation: string }[]>`
        UPDATE model_circuits SET generation = gen_random_uuid(), probe_token = ${token},
          open_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
        WHERE provider_key = ${providerKey} RETURNING generation`;
      generation = claimed!.generation;
    }
    await tx`INSERT INTO model_primary_leases(token, provider_key, expires_at)
             VALUES (${token}, ${providerKey}, now() + make_interval(secs => ${leaseSeconds}))`;
    return { providerKey, token, generation, probe };
  }) as Promise<PrimaryClaim | null>;
}

/** Old in-flight results cannot close a newer open circuit or another process's probe. */
export async function settlePrimary(claim: PrimaryClaim, failed: boolean): Promise<void> {
  const threshold = Math.max(1, Number(process.env.LLM_FALLBACK_FAILURE_THRESHOLD) || 3);
  await sql.begin(async (tx) => {
    const [row] = await tx<{ failures: number; open_until: Date | null; probe_token: string | null }[]>`
      SELECT failures, open_until, probe_token FROM model_circuits
      WHERE provider_key = ${claim.providerKey} AND generation = ${claim.generation} FOR UPDATE`;
    if (!row || (claim.probe ? row.probe_token !== claim.token : row.open_until !== null)) return;
    if (failed) {
      const failures = row.failures + 1;
      if (claim.probe || failures >= threshold) {
        await tx`UPDATE model_circuits SET failures = ${failures}, generation = gen_random_uuid(), probe_token = NULL,
          open_until = now() + make_interval(secs => ${cooldown()}), updated_at = now()
          WHERE provider_key = ${claim.providerKey}`;
      } else {
        await tx`UPDATE model_circuits SET failures = ${failures}, updated_at = now() WHERE provider_key = ${claim.providerKey}`;
      }
    } else if (claim.probe && probeOnly()) {
      await tx`UPDATE model_circuits SET failures = 0, generation = gen_random_uuid(), probe_token = NULL,
        open_until = now() + make_interval(secs => ${cooldown()}), updated_at = now()
        WHERE provider_key = ${claim.providerKey}`;
    } else if (claim.probe) {
      await tx`DELETE FROM model_circuits WHERE provider_key = ${claim.providerKey}`;
    } else {
      await tx`UPDATE model_circuits SET failures = 0, updated_at = now() WHERE provider_key = ${claim.providerKey}`;
    }
  });
}

export async function releasePrimary(claim: PrimaryClaim): Promise<void> {
  await sql`DELETE FROM model_primary_leases WHERE token = ${claim.token}`;
  // A budget/configuration rejection did not probe the provider: release its ownership, without
  // declaring it healthy. The next cooldown expiry may try again.
  await sql`UPDATE model_circuits SET probe_token = NULL,
    open_until = now() + make_interval(secs => ${cooldown()}), updated_at = now()
    WHERE provider_key = ${claim.providerKey} AND generation = ${claim.generation} AND probe_token = ${claim.token}`;
}
