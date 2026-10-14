import * as cheerio from "cheerio";
import { guardedFetch } from "../lib/http-fetch.ts";
import type { ExtractedBody } from "./extract.ts";
import { parse } from "@babel/parser";
import { pdfDocument } from "./pdf.ts";

export interface LinkedHtmlConfig {
  selector: string;
  attribute: "href" | "src";
  stripPathSuffix?: string;
  allowedOrigins: string[];
  bodySelector?: string;
  format?: "html" | "adobe_pdf";
  pdfOrigins?: string[];
}

/** Adobe's literal public PDF declaration only; never execute the publisher's viewer script. */
export function adobePdfTarget(html: string, pageUrl: string, allowedOrigins: string[]): string | null {
  try {
    if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.length > 4) return null;
    const origins = new Set(allowedOrigins.map(value => {
      const u = new URL(value);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || value !== u.origin) throw Error("invalid PDF origin");
      return u.origin;
    }));
    const $ = cheerio.load(html);
    const scripts = $("#adobe-dc-view script:not([src])").toArray();
    if (!scripts.length || scripts.length > 10) return null;
    let steps = 0;
    const literal = (node: any, depth: number): any => {
      if (++steps > 50_000 || depth > 16) throw Error("viewer declaration too complex");
      if (["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(node?.type)) return node.value;
      if (node?.type === "NullLiteral") return null;
      if (node?.type !== "ObjectExpression") throw Error("viewer content must be literal data");
      const result: Record<string, unknown> = Object.create(null);
      for (const p of node.properties) {
        if (p.type !== "ObjectProperty" || p.computed || !["Identifier", "StringLiteral"].includes(p.key.type)) throw Error("dynamic viewer property");
        const key = p.key.type === "Identifier" ? p.key.name : p.key.value;
        if (["__proto__", "constructor", "prototype"].includes(key) || Object.hasOwn(result, key)) throw Error("ambiguous viewer property");
        result[key] = literal(p.value, depth + 1);
      }
      return result;
    };
    const targets = new Set<string>();
    const viewers = new Set<string>();
    const visit = (node: any, depth: number): void => {
      if (++steps > 50_000 || depth > 100) throw Error("viewer script too complex");
      if (!node || typeof node !== "object") return;
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init?.type === "NewExpression" &&
        node.init.callee?.type === "MemberExpression" && !node.init.callee.computed &&
        node.init.callee.object?.name === "AdobeDC" && node.init.callee.property?.name === "View") {
        if (viewers.has(node.id.name) || literal(node.init.arguments[0], 0)?.divId !== "adobe-dc-view") throw Error("ambiguous viewer binding");
        viewers.add(node.id.name);
      }
      if (node.type === "AssignmentExpression" && node.left?.type === "Identifier" && viewers.has(node.left.name)) throw Error("viewer binding was reassigned");
      if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" && !node.callee.computed &&
        node.callee.object?.type === "Identifier" && viewers.has(node.callee.object.name) && node.callee.property?.name === "previewFile") {
        const value = literal(node.arguments[0], 0)?.content?.location?.url;
        if (typeof value !== "string") throw Error("PDF URL must be literal");
        const url = new URL(value, pageUrl);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || !origins.has(url.origin) || !url.pathname.toLowerCase().endsWith(".pdf")) throw Error("unexpected PDF location");
        targets.add(url.href);
      }
      for (const [key, value] of Object.entries(node)) if (!["loc", "start", "end", "extra", "comments"].includes(key)) {
        if (Array.isArray(value)) for (const child of value) visit(child, depth + 1);
        else if (value && typeof value === "object") visit(value, depth + 1);
      }
    };
    for (const script of scripts) {
      const text = $(script).html() ?? "";
      if (text.length > 200_000) return null;
      visit(parse(text), 0);
    }
    return targets.size === 1 ? [...targets][0]! : null;
  } catch { return null; }
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
    if (rule.format === "adobe_pdf") {
      if (rule.bodySelector || !rule.pdfOrigins) return null;
      const target = adobePdfTarget(response.text(), response.url, rule.pdfOrigins);
      if (!target) return null;
      const pdf = await guardedFetch(target, { timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024, maxRedirects: 0,
        headers: userAgent ? { "user-agent": userAgent } : undefined });
      return pdf.status === 200 ? await pdfDocument(pdf.body, pdf.headers.get("content-type") ?? "") : null;
    }
    if (rule.format && rule.format !== "html") return null;
    const body = readBody(response.text(), response.url, rule.bodySelector);
    return body ? { ...body, via: "linked-html" } : null;
  } catch { return null; }
}
