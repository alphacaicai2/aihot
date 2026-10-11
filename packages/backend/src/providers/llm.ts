// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless an
// environment variable or the admin's model page picks one of the named presets below.
import type { z } from "zod";
import { config, credential } from "../config.ts";
import { sha256 } from "../lib/ids.ts";
import { completeReceipt, logicalKeyFor, paidRequest, ProviderRejectedError, ReceiptUnknownError, rejectReceivedResponse, type ReceiptRequest } from "./receipts.ts";
import { sql } from "../db.ts";
import { acquirePrimary, releasePrimary, settlePrimary } from "./model-circuit.ts";

export interface ModelSpec {
  key: string;
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  jsonMode: boolean;
  vision?: boolean;
  /** Only set when the provider documents usage.cost as the amount actually charged. */
  usageCostCurrency?: "USD" | "CNY";
}

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_EXTRA_JSON must be a JSON object, e.g. {\"enable_thinking\": false}");
  }
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  // Named presets (the models AIHOT itself runs on); each needs its own key.
  // GLM 5.3 Flash always reasons; the lowest effort keeps short structured tasks fast.
  "glm-5.3-flash": {
    key: "glm-5.3-flash", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled" }, reasoning_effort: "low" }, jsonMode: true,
  },
  // The scorer's parameters for glm-5.3-flash (score calls; temperature 1 is set per call).
  "glm-5.3-flash-selection": {
    key: "glm-5.3-flash-selection", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 }, jsonMode: true,
  },
  // DeepSeek Flash reasons by default; structured tasks switch it off unless the -think variant is used.
  "deepseek-flash": {
    key: "deepseek-flash", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "deepseek-flash-think": {
    key: "deepseek-flash-think", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY", jsonMode: true,
  },
  "qwen3.7-flash": {
    key: "qwen3.7-flash", service: "dashscope", model: "qwen3.7-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  // Shares the deployment's LLM budget; OpenRouter uses a provider-qualified model ID.
  "openrouter-qwen3.7-flash": {
    key: "openrouter-qwen3.7-flash", service: "llm", model: "qwen/qwen3.7-flash",
    baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY",
    extra: { reasoning: { enabled: false }, provider: { require_parameters: true } }, jsonMode: true,
    usageCostCurrency: "USD",
  },
  "qwen3.8-flash": {
    key: "qwen3.8-flash", service: "dashscope", model: "qwen3.8-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "mimo-v2.6-flash": {
    key: "mimo-v2.6-flash", service: "mimo", model: "mimo-v2.6-flash",
    baseUrlEnv: "XIAOMI_MIMO_BASE_URL", apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "qwen3-vl-flash": {
    key: "qwen3-vl-flash", service: "dashscope", model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: false, vision: true,
  },
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** Recovery may route the configured default elsewhere, but must not release its uncertain call. */
export function configuredDefaultFallback(): { primary: ModelSpec; fallback: ModelSpec } | null {
  const primary = MODELS.default!;
  const fallback = MODELS[process.env.LLM_FALLBACK_MODEL ?? ""];
  if (!primary.model || !fallback || (primary.service === fallback.service && primary.model === fallback.model)) return null;
  if (![primary, fallback].every(spec => credential("models", spec.baseUrlEnv) && credential("models", spec.apiKeyEnv))) return null;
  return { primary, fallback };
}

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  /** Comparisons/benchmarks can require the chosen model without automatic substitution. */
  fallback?: boolean;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

export class ModelOutputError extends Error {}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET_BEFORE_SEND", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

function requestFor<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec): ReceiptRequest {
  const temperature = opts.temperature ?? 0.2;
  const maxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.key.endsWith("-think") ? 4000 : 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  return {
    service: spec.service, model: spec.model, purpose: opts.purpose, subject: opts.subject,
    identity: { model: spec.model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, extra: spec.extra ?? null },
    requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens },
    attemptTag: opts.attemptTag,
  };
}

function fallbackEligible(error: unknown): boolean {
  if (error instanceof ReceiptUnknownError || error instanceof ModelOutputError) return true;
  if (error instanceof ProviderRejectedError) return error.retryable;
  if (!(error instanceof Error)) return false;
  const code = (error as { cause?: { code?: string } }).cause?.code;
  return error.name === "TimeoutError" || (error instanceof TypeError && error.message === "fetch failed")
    || ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code ?? "");
}

/** A fallback gets its own paid receipt; the primary's unknown outcome is kept for bill review. */
export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const primary = MODELS[opts.model];
  if (!primary) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  if (opts.fallback === false) return chatJsonOnce(opts);
  const primaryKey = logicalKeyFor(requestFor(opts, primary));
  const [saved] = await sql<{ fallback_model: string }[]>`SELECT fallback_model FROM model_fallback_routes WHERE primary_key = ${primaryKey}`;
  const fallbackModel = saved?.fallback_model ?? process.env.LLM_FALLBACK_MODEL;
  const fallback = fallbackModel ? MODELS[fallbackModel] : null;
  if (!fallback) {
    if (fallbackModel) throw new Error(`Unknown fallback model ${fallbackModel}`);
    return chatJsonOnce(opts);
  }
  const fallbackOpts = { ...opts, model: fallback.key, fallback: false };
  const fallbackKey = logicalKeyFor(requestFor(fallbackOpts, fallback));
  if (fallbackKey === primaryKey) return chatJsonOnce(opts);
  const providerKey = sha256(`${primary.service}:${primary.model}:${credential("models", primary.baseUrlEnv) ?? ""}`);
  const useFallback = async (reason: string) => {
    // Persist before sending. Concurrent callers agree on one route and paidRequest owns the call.
    const [route] = await sql<{ fallback_model: string }[]>`
      INSERT INTO model_fallback_routes(primary_key, fallback_model, primary_receipt_id, reason)
      VALUES (${primaryKey}, ${fallback.key}, (SELECT id FROM receipts WHERE logical_key = ${primaryKey}), ${reason.slice(0, 1000)})
      ON CONFLICT (primary_key) DO UPDATE SET primary_key = EXCLUDED.primary_key RETURNING fallback_model`;
    const chosen = { ...opts, model: route!.fallback_model, fallback: false };
    const budget = await sql`SELECT service FROM budgets WHERE service = ${MODELS[chosen.model]!.service}`;
    if (!budget.length) throw new Error(`Fallback model ${chosen.model} requires a service budget`);
    const chosenKey = logicalKeyFor(requestFor(chosen, MODELS[chosen.model]!));
    try {
      return await chatJsonOnce(chosen);
    } finally {
      await sql`UPDATE model_fallback_routes SET fallback_receipt_id = (SELECT id FROM receipts WHERE logical_key = ${chosenKey}), updated_at = now()
                WHERE primary_key = ${primaryKey}`;
    }
  };
  if (saved) return useFallback("reuse existing fallback route");
  const [existing] = await sql<{ status: string; updated_at: Date }[]>`SELECT status, updated_at FROM receipts WHERE logical_key = ${primaryKey}`;
  // A completed step is free to reuse. A still-running request keeps its ownership until it settles.
  if (existing && (["received", "completed"].includes(existing.status)
    || (existing.status === "pending" && Date.now() - existing.updated_at.getTime() < 10 * 60_000))) {
    try { return await chatJsonOnce(opts); }
    catch (error) {
      if (!fallbackEligible(error)) throw error;
      return useFallback(error instanceof Error ? error.message : String(error));
    }
  }
  // Configuration failures must not create a route that cannot ever be executed.
  if (!credential("models", fallback.baseUrlEnv) || !credential("models", fallback.apiKeyEnv)) throw new Error(`Fallback model ${fallback.key} is not configured`);
  if (existing?.status === "unknown") return useFallback("primary outcome unknown; preserve for bill review");
  const claim = await acquirePrimary(providerKey, opts.timeoutMs ?? 120_000);
  if (!claim) return useFallback("primary circuit open or concurrency limit reached");
  try {
    const result = await chatJsonOnce(opts);
    await settlePrimary(claim, false);
    return result;
  } catch (error) {
    if (!fallbackEligible(error)) throw error;
    await settlePrimary(claim, true);
    return useFallback(error instanceof Error ? error.message : String(error));
  } finally {
    await releasePrimary(claim);
  }
}

async function chatJsonOnce<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const baseUrl = credential("models", spec.baseUrlEnv);
  const apiKey = credential("models", spec.apiKeyEnv);
  if (!baseUrl || !apiKey || !spec.model) throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);

  const temperature = opts.temperature ?? 0.2;
  const maxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.key.endsWith("-think") ? 4000 : 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: [
      // A prompt given as one user message (the title/summary prompts) has no system message.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      // Multimodal parts go through as parts; plain objects are sent as JSON text.
      { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
    ...(spec.extra ?? {}),
  };

  const receipt = await paidRequest(
    requestFor(opts, spec),
    async () => {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
      } catch (error) {
        if (error instanceof Error) Object.assign(error, { phase: "headers", elapsedMs: Date.now() - started });
        if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true, { cause: error });
        throw error;
      }
      let text: string;
      try { text = await res.text(); }
      catch (error) {
        if (error instanceof Error) Object.assign(error, { phase: "body", elapsedMs: Date.now() - started });
        throw error;
      }
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderRejectedError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
      } catch {
        json = { unparsable: text.slice(0, 20000) };
      }
      const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
      const amount = usage?.cost;
      return {
        response: { ...json, _latencyMs: Date.now() - started },
        requestId: (json.id as string | undefined) ?? res.headers.get("x-request-id"),
        usage,
        cost: spec.usageCostCurrency && typeof amount === "number" && Number.isFinite(amount) && amount >= 0
          ? { amount, currency: spec.usageCostCurrency, basis: "actual" as const }
          : null,
      };
    },
  );

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer.
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`);
  }
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
}

export async function markReceiptsCompleted(ids: number[]): Promise<void> {
  for (const id of ids) await completeReceipt(sql, id);
}
