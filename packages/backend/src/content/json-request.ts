export interface BodyJsonRequestConfig {
  urlTemplate?: string;
  method?: "GET" | "POST";
  bodyJson?: Record<string, unknown>;
}

/** A publisher's declared anonymous read endpoint; interpolate JSON values, never JSON syntax. */
export function bodyJsonRequest(url: string, rule: BodyJsonRequestConfig): { url: string; method: "GET" | "POST"; body?: string } | null {
  try {
    if (typeof rule.urlTemplate !== "string" || rule.urlTemplate.length > 2048) return null;
    const method = rule.method ?? "GET";
    if (!["GET", "POST"].includes(method) || (method === "GET" && rule.bodyJson !== undefined)) return null;
    const path = new URL(url).pathname, slug = path.split("/").filter(Boolean).at(-1) ?? "";
    let mapped = false, nodes = 0;
    const interpolate = (value: string): string => {
      if (/\{(?:path|slug)\}/.test(value)) mapped = true;
      const result = value.replaceAll("{path}", path).replaceAll("{slug}", slug);
      if (/\{[^{}]*\}/.test(result)) throw new Error("unknown request placeholder");
      return result;
    };
    const target = new URL(interpolate(rule.urlTemplate));
    if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.hash) return null;
    const ancestors = new Set<object>();
    const visit = (value: unknown, depth: number): unknown => {
      if (++nodes > 2000 || depth > 10) throw new Error("request too complex");
      if (typeof value === "string") {
        if (value.length > 64 * 1024) throw new Error("request string too large");
        return interpolate(value);
      }
      if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
      if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("invalid request data");
      ancestors.add(value);
      let result: unknown;
      if (Array.isArray(value)) result = value.map(v => visit(v, depth + 1));
      else {
        if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("request must be JSON data");
        result = Object.fromEntries(Object.entries(value).map(([key, v]) => {
          if (["__proto__", "constructor", "prototype"].includes(key) || /[{}]/.test(key)) throw new Error("invalid request key");
          return [key, visit(v, depth + 1)];
        }));
      }
      ancestors.delete(value);
      return result;
    };
    let body: string | undefined;
    if (method === "POST") {
      if (!rule.bodyJson || typeof rule.bodyJson !== "object" || Array.isArray(rule.bodyJson)) return null;
      body = JSON.stringify(visit(rule.bodyJson, 0));
      if (Buffer.byteLength(body) > 64 * 1024) return null;
    }
    return mapped ? { url: target.href, method, ...(body === undefined ? {} : { body }) } : null;
  } catch { return null; }
}
