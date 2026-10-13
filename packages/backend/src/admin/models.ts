// Admin "模型与评测": the model each capability uses and where that choice comes from,
// the prompt versions in use, quality / latency / cost of the last days per model, the switch history
// and the SelectBench runs that compare models on the same batch. A switch is audited and applies to
// new work only.
import { sql } from "../db.ts";
import { CAPABILITIES, modelSources, type Capability, type CapabilityKey } from "../editorial/models.ts";
import { MODELS } from "../providers/llm.ts";
import { audit } from "./auth.ts";

interface UsageRow {
  purpose: string;
  score_slot: number | null;
  service: string;
  model: string | null;
  prompt_version: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokens_in: string | null;
  tokens_out: string | null;
  actual_cost: string | null;
  actual_calls: number;
  currency: string | null;
  official_estimate: string | null;
  estimated_calls: number;
}

export async function modelsOverview(days = 7, period: "rolling" | "today" | "yesterday" = "rolling") {
  const now = new Date();
  const bjDay = Math.floor((now.getTime() + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  const since = new Date(period === "rolling" ? now.getTime() - days * 86400_000 : bjDay - (period === "yesterday" ? 86400_000 : 0));
  const until = period === "yesterday" ? new Date(bjDay) : now;
  const [sources, usage, prices, history, benches] = await Promise.all([
    modelSources(),
    sql<UsageRow[]>`
      SELECT r.purpose, a.service, a.model, r.request->>'promptVersion' AS prompt_version,
             CASE WHEN r.purpose = 'score_article' THEN CASE WHEN r.logical_key LIKE '%:score-2' THEN 2 ELSE 1 END END AS score_slot,
             count(*)::int AS calls,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok,
             count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
             sum((a.usage->>'prompt_tokens')::bigint) AS tokens_in, sum((a.usage->>'completion_tokens')::bigint) AS tokens_out,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'actual') AS actual_cost, a.currency,
             count(a.cost) FILTER (WHERE a.cost_basis = 'actual')::int AS actual_calls,
             sum(estimate_deepseek_v41_flash_cny(a.usage, a.started_at))
               FILTER (WHERE a.model IN ('deepseek-v4.1-flash', 'deepseek-flash')) AS official_estimate,
             count(estimate_deepseek_v41_flash_cny(a.usage, a.started_at))
               FILTER (WHERE a.model IN ('deepseek-v4.1-flash', 'deepseek-flash'))::int AS estimated_calls
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${since} AND a.started_at < ${until} AND a.origin = 'live' AND a.model IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5, a.currency ORDER BY 1, 6 DESC`,
    sql<{ service: string; model: string; currency: string; input_per_mtok: string | null; output_per_mtok: string | null }[]>`
      SELECT service, model, currency, input_per_mtok, output_per_mtok FROM service_prices`,
    sql<{ at: Date; actor: string; subject: string; reason: string | null; before: unknown; after: unknown }[]>`
      SELECT created_at AS at, actor, subject, reason, before, after FROM audit_log WHERE action = 'models.switch' ORDER BY created_at DESC LIMIT 30`,
    sql<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; summary: unknown; created_at: Date }[]>`
      SELECT id, label, sample_size, prompt_version, models,
             (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
             created_at FROM selectbench_runs r ORDER BY created_at DESC LIMIT 8`,
  ]);
  const serviceOf = (model: string) => Object.values(MODELS).find((m) => m.model === model || m.key === model)?.service ?? null;
  const priced = (u: UsageRow) => {
    if (u.official_estimate !== null) return { amount: Number(u.official_estimate), currency: "CNY", note: "DeepSeek 人民币官方估算：按缓存命中和请求时间分峰谷（含 2026 中国节假日）；缓存数据缺失按未命中算，缺少用量的请求不计入。代理通道估值不代表官方账户扣费。", sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/" };
    if (u.model === "deepseek-v4.1-flash" || u.model === "deepseek-flash") return null;
    const service = u.model ? serviceOf(u.model) : null;
    const p = prices.find((x) => x.service === service && x.model === u.model) ?? prices.find((x) => x.service === service && x.model === "");
    if (!p || (!p.input_per_mtok && !p.output_per_mtok)) return null;
    return { amount: (Number(u.tokens_in ?? 0) / 1e6) * Number(p.input_per_mtok ?? 0) + (Number(u.tokens_out ?? 0) / 1e6) * Number(p.output_per_mtok ?? 0), currency: p.currency, note: "按用量 × 单价推算", sourceUrl: null };
  };
  const capabilities = (Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>).map(([key, c]) => ({
    key,
    label: c.label,
    env: c.env,
    defaultModel: c.default,
    vision: !!c.vision,
    current: sources[key]!,
    usage: usage
      .filter((u) => c.purposes.includes(u.purpose) && (key === "score" ? u.score_slot === 1 : key === "scoreSecond" ? u.score_slot === 2 : true))
      .map((u) => ({
        purpose: u.purpose,
        service: u.service,
        model: u.model,
        promptVersion: u.prompt_version,
        calls: u.calls,
        ok: u.ok,
        failed: u.failed,
        unknown: u.unknown,
        p50: u.p50,
        p95: u.p95,
        tokensIn: Number(u.tokens_in ?? 0),
        tokensOut: Number(u.tokens_out ?? 0),
        actualCost: u.actual_cost === null ? null : Number(u.actual_cost),
        currency: u.currency,
        estimate: priced(u),
        unestimatedCalls: u.calls - u.estimated_calls,
      })),
  }));
  const choices = Object.values(MODELS).map((m) => ({ key: m.key, service: m.service, vision: !!m.vision }));
  // Include every purpose, not only the capabilities displayed below. Never include proxy estimates.
  const official = usage.filter((u) => u.service === "deepseek" && u.model === "deepseek-flash");
  const estimatedCalls = official.reduce((n, u) => n + u.estimated_calls, 0);
  const deepseek = {
    calls: official.reduce((n, u) => n + u.calls, 0),
    tokensIn: official.reduce((n, u) => n + Number(u.tokens_in ?? 0), 0),
    tokensOut: official.reduce((n, u) => n + Number(u.tokens_out ?? 0), 0),
    estimatedCalls,
    amount: estimatedCalls ? official.reduce((n, u) => n + Number(u.official_estimate ?? 0), 0) : null,
    currency: "CNY",
  };
  const currencies = new Map<string, { currency: string; actual: number; estimated: number; amount: number }>();
  let unpricedCalls = 0;
  for (const u of usage) {
    const actual = u.actual_cost !== null && u.currency !== null;
    const estimate = !actual && u.service === "deepseek" && u.model === "deepseek-flash" && u.official_estimate !== null;
    const pricedCalls = actual ? u.actual_calls : estimate ? u.estimated_calls : 0;
    unpricedCalls += u.calls - pricedCalls;
    if (!actual && !estimate) continue;
    const currency = actual ? u.currency! : "CNY";
    const total = currencies.get(currency) ?? { currency, actual: 0, estimated: 0, amount: 0 };
    if (actual) total.actual += Number(u.actual_cost);
    else total.estimated += Number(u.official_estimate);
    total.amount = total.actual + total.estimated;
    currencies.set(currency, total);
  }
  const costs = { currencies: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)), unpricedCalls };
  return { days, period, since, until, costs, deepseek, capabilities, choices, history, benches };
}

/** Switches a capability to another registered model (or back to the environment/default when null). */
export async function switchModel(capability: string, model: string | null, reason: string, actor: string) {
  const c = (CAPABILITIES as Record<string, Capability>)[capability];
  if (!c) throw Object.assign(new Error("unknown capability"), { statusCode: 400 });
  if (typeof reason !== 'string' || !reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  if (model !== null && typeof model !== "string") throw Object.assign(new Error("a model or explicit null is required"), { statusCode: 400 });
  if (model !== null) {
    const spec = MODELS[model];
    if (!spec) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
    if (!!c.vision !== !!spec.vision) throw Object.assign(new Error(c.vision ? "this capability needs a vision model" : "a vision-only model cannot do this"), { statusCode: 400 });
  }
  return sql.begin(async tx => {
    const key = `models.${capability}`;
    // The row may not exist yet; serialize the initial insert and reset as well as later updates.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`settings:${key}`}, 0))`;
    const before = (await modelSources(tx))[capability];
    if (model === null) await tx`DELETE FROM settings WHERE key = ${key}`;
    else {
      await tx`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${tx.json({ model })}, ${actor})
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    }
    const after = (await modelSources(tx))[capability];
    await audit(actor, "models.switch", `capability:${capability}`, reason, before ?? null, after ?? null, undefined, tx);
    return { capability, before, after };
  });
}
