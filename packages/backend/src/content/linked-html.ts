import * as cheerio from "cheerio";
import { guardedFetch } from "../lib/http-fetch.ts";
import type { ExtractedBody } from "./extract.ts";

export interface LinkedHtmlConfig {
  selector: string;
  attribute: "href" | "src";
  stripPathSuffix?: string;
  allowedOrigins: string[];
  bodySelector?: string;
}

/** Resolve an explicitly configured publisher embed, without running its script. */
export function linkedHtmlTarget(html: string, pageUrl: string, rule: LinkedHtmlConfig): string | null {
  if (!rule.selector || !["href", "src"].includes(rule.attribute) || !Array.isArray(rule.allowedOrigins) || !rule.allowedOrigins.length) return null;
  try {
    const origins = new Set(rule.allowedOrigins.map((value) => {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || value !== url.origin) throw new Error("invalid allowed origin");
      return url.origin;
    }));
    const $ = cheerio.load(html);
    const targets = new Set<string>();
    const links = $(rule.selector);
    if (!links.length || links.length > 20) return null;
    for (const element of links.toArray()) {
      const value = $(element).attr(rule.attribute);
      if (!value) return null;
      const url = new URL(value, pageUrl);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || !origins.has(url.origin)) return null;
      if (rule.stripPathSuffix) {
        if (!url.pathname.endsWith(rule.stripPathSuffix)) return null;
        url.pathname = url.pathname.slice(0, -rule.stripPathSuffix.length) || "/";
      }
      url.hash = "";
      if (url.href === new URL(pageUrl).href) return null;
      targets.add(url.href);
    }
    return targets.size === 1 ? [...targets][0]! : null;
  } catch { return null; }
}

export async function linkedHtmlDocument(
  html: string, pageUrl: string, rule: LinkedHtmlConfig,
  readBody: (html: string, url: string, selector?: string | null) => ExtractedBody | null,
  userAgent?: string | null,
): Promise<ExtractedBody | null> {
  const target = linkedHtmlTarget(html, pageUrl, rule);
  if (!target) return null;
  try {
    const response = await guardedFetch(target, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024,
      headers: userAgent ? { "user-agent": userAgent } : undefined });
    if (response.status !== 200 || !rule.allowedOrigins.includes(new URL(response.url).origin) || !/html/i.test(response.headers.get("content-type") ?? "")) return null;
    const body = readBody(response.text(), response.url, rule.bodySelector);
    return body ? { ...body, via: "linked-html" } : null;
  } catch { return null; }
}
