// Public API v1 (long-term). Field shapes follow reference/public-v1.openapi.json 2.0.0 (the paths stay /api/v1).
import { FinancingExportBusy, loadFinancing, exportFinancingCsv } from "@aihot/backend/publication/financing";
import { FEATURES } from "@aihot/industry/features";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { V1_CACHE_CONTROL } from "@aihot/contracts/http-policy";
import { PUBLIC_API_CATEGORY_KEYS, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { InvalidCursorError } from "@aihot/backend/lib/cursor";
import { SearchBusyError } from "@aihot/backend/publication/pool";
import { selectedChanges, selectedSnapshot, SnapshotRequiredError, v1Items } from "@aihot/backend/publication/v1";
import { resolveStory, v1HotTopics, v1Story } from "@aihot/backend/publication/stories";
import { v1Dailies, v1Daily } from "@aihot/backend/publication/reports";
import { codexResetsRecent, codexResetsSnapshot } from "@aihot/backend/monitor/read";
import { createHash } from "node:crypto";
import { beijingDate, isValidDate } from "@aihot/contracts/time";
import { applyPublicHeaders, QueryError, sendJsonWithEtag, sendProblem, strictQuery } from "../http/respond.ts";

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export function intParam(value: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new QueryError(`${name} must be an integer from ${min} to ${max}.`);
  const n = Number(value);
  if (n < min || n > max) throw new QueryError(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

export function enumParam<T extends string>(value: string | undefined, name: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new QueryError(allowed.length === 2 ? `${name} must be '${allowed[0]}' or '${allowed[1]}'.` : `${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/** Wraps a v1 handler with shared error mapping. Errors never leak internals. */
export function publicHandler(fn: Handler): Handler {
  return async (req, reply) => {
    applyPublicHeaders(reply);
    try {
      return await fn(req, reply);
    } catch (error) {
      if (error instanceof QueryError || error instanceof RangeError) return sendProblem(req, reply, { status: 400, code: "invalid_request", title: "Invalid request", detail: error.message });
      if (error instanceof InvalidCursorError) {
        return sendProblem(req, reply, { status: 400, code: "invalid_cursor", title: "Invalid cursor", detail: "The cursor is malformed." });
      }
      if (error instanceof SnapshotRequiredError) {
        return sendProblem(req, reply, {
          status: 409, code: "snapshot_required", title: "Snapshot required",
          detail: "Missing or invalid v1 cursor; fetch /api/v1/selected/snapshot first.",
        });
      }
      if (error instanceof SearchBusyError) {
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "Search is busy; retry later.", retryAfter: error.retryAfter });
      }
      req.log.error({ err: error, path: req.url.split("?")[0] }, "public api error");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "The service is temporarily unavailable; retry later.", retryAfter: 30 });
    }
  };
}

export function registerV1(app: FastifyInstance) {
  app.get("/api/v1/items", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["mode", "category", "window", "by", "q", "limit", "cursor"]);
    const mode = enumParam(q.mode, "mode", ["selected", "all"] as const, "selected");
    const window = enumParam(q.window, "window", ["24h", "7d"] as const, "7d");
    const by = enumParam(q.by, "by", ["timeline", "published"] as const, "timeline");
    const category = q.category === undefined ? null : enumParam<PublicApiCategoryKey>(q.category, "category", PUBLIC_API_CATEGORY_KEYS, "tip");
    let search: string | null = null;
    if (q.q !== undefined) {
      search = q.q.trim();
      const len = [...search].length;
      if (len < 2 || len > 200) throw new QueryError("q must contain 2 to 200 characters.");
    }
    const limit = intParam(q.limit, "limit", 1, 100, 50);
    if (q.cursor !== undefined && q.cursor.length === 0) throw new InvalidCursorError("empty cursor");
    const body = await v1Items({ mode, window, by, category, q: search, limit, cursor: q.cursor ?? null });
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "v1-items", cacheControl: V1_CACHE_CONTROL.items });
  }));

  app.get("/api/v1/financing", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["from", "to", "company", "investor", "investorMode", "limit", "cursor", "format", "scope"]);
    for (const key of ["company", "investor"] as const) if (q[key] && q[key]!.length > (key === "investor" ? 160 : 120)) throw new QueryError(`${key} is too long.`);
    const format = enumParam(q.format, "format", ["json", "csv"] as const, "json");
    const scope = enumParam(q.scope, "scope", ["page", "all"] as const, "page");
    if (q.cursor !== undefined && !q.cursor.trim()) throw new InvalidCursorError("empty financing cursor");
    if (q.scope && format !== "csv") throw new QueryError("scope requires CSV format.");
    if (scope === "all" && q.cursor !== undefined) throw new QueryError("An all-results export must start without a cursor.");
    const query = { from: q.from, to: q.to, company: q.company?.trim(), investor: q.investor?.trim(), investorExact: enumParam(q.investorMode, "investorMode", ["contains", "exact"] as const, "contains") === "exact", cursor: q.cursor, limit: intParam(q.limit, "limit", 1, 100, 40) };
    if (format === "csv") {
      const today = beijingDate(Date.now());
      const id = createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 8);
      const labels = [query.company, query.investor]
        .filter(Boolean).map(value => [...value!].slice(0, 20).join("").replace(/[^\p{L}\p{N}_-]/gu, "-"));
      if (query.from && query.to) labels.push(query.from + "_" + query.to);
      const name = ["融资", ...labels, scope === "all" ? "全部结果" : "本页", today, id].join("-") + ".csv";
      const controller = new AbortController();
      const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
      reply.raw.once("close", abort);
      try {
        const csv = await exportFinancingCsv(query, scope === "all", controller.signal);
        return await reply.header("Cache-Control", "private, no-store").header("Content-Disposition",
          `attachment; filename="financing-${scope}-${today}-${id}.csv"; filename*=UTF-8''${encodeURIComponent(name)}`).type("text/csv; charset=utf-8").send(csv);
      } catch (error) {
        if (!(error instanceof FinancingExportBusy)) throw error;
        const indexing = error.reason === "index";
        const title = indexing ? "融资索引正在更新" : "导出请求较多";
        const detail = indexing ? "更新完成后即可重新导出。" : "请稍后再试。";
        if (req.headers.accept?.includes("text/html") && (!req.headers["sec-fetch-mode"] || req.headers["sec-fetch-mode"] === "navigate")) {
          const filters = new URLSearchParams();
          for (const key of ["company", "investor", "investorMode", "from", "to", "cursor"] as const) {
            if (q[key]) filters.set(key, q[key]!);
          }
          const back = "/financing" + (filters.size ? "?" + filters.toString().replaceAll("&", "&amp;") : "");
          return reply.code(503).header("Retry-After", error.retryAfter).header("Cache-Control", "private, no-store")
            .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'")
            .type("text/html; charset=utf-8").send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
              <style>:root{color-scheme:light dark}body{max-width:36rem;margin:12vh auto;padding:0 1.25rem;font:1rem/1.65 system-ui}h1{font-size:1.5rem}nav{display:flex;gap:1.5rem}a{color:LinkText}</style>
              <main><h1>${title}</h1><p>${detail}建议 ${error.retryAfter} 秒后重试。</p><nav><a href="">重新导出</a><a href="${back}">返回筛选结果</a></nav></main></html>`);
        }
        return sendProblem(req, reply, { status:503, code:indexing ? "financing_index_refreshing" : "export_busy",
          detail: title + "。" + detail, retryAfter:error.retryAfter, cacheControl:"private, no-store" });
      } finally {
        reply.raw.off("close", abort);
      }
    }
    const result = await loadFinancing(query);
    return sendJsonWithEtag(req, reply, result, { etagPrefix: "v1-financing", cacheControl: V1_CACHE_CONTROL.items });
  }));

  if (FEATURES.codexResetMonitor) registerCodexResets(app);

  app.get("/api/v1/hot-topics", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const body = await v1HotTopics();
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "v1-hot", cacheControl: V1_CACHE_CONTROL.hotTopics });
  }));

  app.get("/api/v1/stories/:publicId", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const publicId = (req.params as { publicId: string }).publicId;
    if (publicId.length > 128) throw new QueryError("publicId must be a short opaque id.");
    const found = await resolveStory(publicId);
    if (found.kind === "merged") {
      return reply.code(308).header("Location", `/api/v1/stories/${found.target}`).header("Cache-Control", V1_CACHE_CONTROL.storyByPublicId).send();
    }
    const body = found.kind === "found" ? await v1Story(found.storyId) : null;
    if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `No public story exists for ${publicId}.`, cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "v1-story", cacheControl: V1_CACHE_CONTROL.storyByPublicId });
  }));

  app.get("/api/v1/dailies", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["limit"]);
    const limit = intParam(q.limit, "limit", 1, 180, 30);
    return sendJsonWithEtag(req, reply, await v1Dailies(limit), { etagPrefix: "v1-dailies", cacheControl: V1_CACHE_CONTROL.dailies });
  }));

  app.get("/api/v1/dailies/latest", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const body = await v1Daily("latest");
    if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "No daily report has been published yet." });
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "v1-daily", cacheControl: V1_CACHE_CONTROL.latestDaily });
  }));

  app.get("/api/v1/dailies/:date", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const date = (req.params as { date: string }).date;
    if (!isValidDate(date)) throw new QueryError("date must be a real YYYY-MM-DD calendar date.");
    const body = await v1Daily(date);
    if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `No daily report exists for ${date}.`, cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "v1-daily", cacheControl: V1_CACHE_CONTROL.dailyByDate });
  }));

  app.get("/api/v1/selected/snapshot", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["fields", "limit", "page"]);
    const fields = q.fields === undefined ? undefined : enumParam(q.fields, "fields", ["default", "minimal"] as const, "default");
    const limit = intParam(q.limit, "limit", 1, 1000, 500);
    const body = await selectedSnapshot({ fields, limit, page: q.page ?? null });
    // asOf (and the next-page token that carries it) differ per request; the page content does not.
    const etagOf = { fields: body.fields, cursor: body.cursor, count: body.count, hasMore: body.hasMore, items: body.items };
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "v1-snapshot", cacheControl: V1_CACHE_CONTROL.selectedSnapshot, etagOf });
  }));

  app.get("/api/v1/selected/changes", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["cursor", "limit"]);
    const limit = intParam(q.limit, "limit", 1, 100, 100);
    if (!q.cursor) throw new SnapshotRequiredError("missing cursor");
    const body = await selectedChanges({ cursor: q.cursor, limit });
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "v1-changes", cacheControl: V1_CACHE_CONTROL.selectedChanges });
  }));
}

/** Registered last: CORS preflight, 405 for other methods, Problem 404 for undefined v1 paths. */
export function registerV1Fallbacks(app: FastifyInstance) {
  const notFound: Handler = async (req, reply) => {
    applyPublicHeaders(reply);
    const path = (req.raw.url ?? "").split("?")[0];
    return sendProblem(req, reply, { status: 404, code: "not_found", title: "Not found", detail: `No public API v1 operation exists at ${path}.` });
  };
  const notAllowed: Handler = async (req, reply) => {
    applyPublicHeaders(reply);
    reply.header("Allow", "GET, HEAD, OPTIONS");
    return sendProblem(req, reply, { status: 405, code: "method_not_allowed", detail: "This endpoint supports only GET, HEAD, and OPTIONS." });
  };
  const preflight: Handler = async (_req, reply) => {
    applyPublicHeaders(reply);
    return reply.code(204).header("Cache-Control", "public, max-age=86400").send();
  };
  for (const url of ["/api/v1", "/api/v1/*", "/api/public/*", "/openapi-v1.json", "/openapi.yaml"]) {
    app.options(url, preflight);
    app.route({ method: ["POST", "PUT", "PATCH", "DELETE"], url, handler: notAllowed });
  }
  app.get("/api/v1", notFound);
  app.get("/api/v1/*", notFound);
}

/** The Codex reset monitor's endpoints (an optional module, industry/features.ts). */
function registerCodexResets(app: FastifyInstance) {
  app.get("/api/v1/codex-resets", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const body = await codexResetsSnapshot();
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "v1-codex-resets", cacheControl: V1_CACHE_CONTROL.codexResets });
  }));

  // The same snapshot limited to the last week and the events still waiting to land: what a poller needs.
  app.get("/api/v1/codex-resets/recent", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const body = await codexResetsRecent();
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "v1-codex-resets-recent", cacheControl: V1_CACHE_CONTROL.codexResets });
  }));
}
