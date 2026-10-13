// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import * as cheerio from "cheerio";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash } from "./materials.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jsonld" | "embedded-json" | "json-api" | "markdown-document" | "jina";
}

export interface BodyJsonConfig {
  selector?: string;
  urlTemplate?: string;
  path: string;
  format: "html" | "markdown";
  adapter?: "magnolia_article" | "sanity_article";
  bodySelector?: string;
}

export interface BodyMarkdownConfig { urlTemplate: string }

export function bodyDocumentUrl(url: string, template: string): string | null {
  if (!/\{(?:path|slug)\}/.test(template)) return null;
  const path = new URL(url).pathname;
  const target = template.replaceAll("{path}", path).replaceAll("{slug}", path.split("/").filter(Boolean).at(-1) ?? "");
  return /[{}]/.test(target) ? null : target;
}

const MIN_BODY_CHARS = 200;

/** Restore React's streamed HTML fragments without executing the page's scripts. */
function restoreStreamedHtml(document: ReturnType<typeof parseHTML>["document"]): void {
  for (const script of document.querySelectorAll("script")) {
    for (const m of (script.textContent ?? "").matchAll(/\$(RS|RC)\("([BSP]:[0-9a-f]+)","([BSP]:[0-9a-f]+)"\)/g)) {
      const source = document.getElementById(m[1] === "RS" ? m[2]! : m[3]!);
      const target = document.getElementById(m[1] === "RS" ? m[3]! : m[2]!);
      if (!source?.hasAttribute("hidden") || source.tagName !== "DIV" || target?.tagName !== "TEMPLATE") continue;
      let end = target.nextSibling;
      if (m[1] === "RC") {
        let depth = 0;
        end = target.nextSibling;
        while (end) {
          if (end.nodeType === 8) {
            const mark = end.textContent;
            if (["$", "$?", "$~", "$!", "&"].includes(mark ?? "")) depth++;
            if (["/$", "/&"].includes(mark ?? "")) {
              if (depth === 0) break;
              depth--;
            }
          }
          end = end.nextSibling;
        }
        // A truncated response must not remove unrelated visible content.
        if (!end) continue;
        while (target.nextSibling !== end) target.parentNode!.removeChild(target.nextSibling!);
      } else end = target;
      while (source.firstChild) end.parentNode!.insertBefore(source.firstChild, end);
      source.remove();
      target.remove();
    }
  }
}

/** Only the article area's ordered writing components; related stories and CMS chrome are excluded. */
function magnoliaArticle(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>, order = root["@nodes"];
  if (!Array.isArray(order) || order.some(k => typeof k !== "string") || new Set(order).size !== order.length) return null;
  const parts: string[] = [];
  const chrome = new Set(["insightDetails", "imageComponent", "bannerButtonsComponent", "halfImage", "insightsRelated", "bannerLocation", "newsletterSubcriptionCTA"]);
  for (const key of order) {
    const node = root[key];
    if (!node || typeof node !== "object") return null;
    const component = node as Record<string, unknown>;
    const kind = String(component["mgnl:template"] ?? "").replace(/^site-lm:components\//, "");
    if (kind === "richText") {
      if (typeof component.richText !== "string") return null;
      parts.push(component.richText);
    } else if (kind === "cardsInformative") {
      const cards = component.cardsInformativeSection as Record<string, unknown> | undefined;
      if (!cards || !Array.isArray(cards["@nodes"]) || new Set(cards["@nodes"]).size !== cards["@nodes"].length) return null;
      if (typeof component.cardsInformativeTitle1 === "string") parts.push(markdownToHtml(`### ${component.cardsInformativeTitle1}`));
      for (const cardKey of cards["@nodes"]) {
        if (typeof cardKey !== "string") return null;
        const card = cards[cardKey] as Record<string, unknown> | undefined;
        if (!card || typeof card.cardInformativeText !== "string") return null;
        parts.push(card.cardInformativeText);
      }
    } else if (kind === "unorderedList") {
      const items = component.unorderedListItems as Record<string, unknown> | undefined;
      if (!items || !Array.isArray(items["@nodes"])) return null;
      for (const itemKey of items["@nodes"]) {
        if (typeof itemKey !== "string") return null;
        const item = items[itemKey] as Record<string, unknown> | undefined;
        if (!item || typeof item.itemText !== "string") return null;
        if (typeof item.itemTitle === "string" && item.itemTitle.trim()) parts.push(markdownToHtml(`### ${item.itemTitle}`));
        parts.push(item.itemText);
      }
    } else if (!chrome.has(kind)) return null;
  }
  return parts.length ? parts.join("\n") : null;
}

/** Sanity's article components only; unknown nodes must not produce a partial confirmed body. */
function sanityArticle(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const tags = new Map([["strong", "strong"], ["em", "em"], ["code", "code"], ["underline", "u"], ["strike-through", "s"]]);
  const parts: string[] = [];
  const lists: Array<{ kind: string; tag: string }> = [];
  const closeLists = (depth = 0) => {
    while (lists.length > depth) parts.push(`</li></${lists.pop()!.tag}>`);
  };
  for (const component of value) {
    if (component?._type !== "markdownComponent" || !Array.isArray(component.text)) return null;
    for (const node of component.text) {
      if (node?._type === "image" || (node?._type === "file" && typeof node._imageUrl === "string" && /\.gif(?:[?#]|$)/i.test(node._imageUrl))) {
        closeLists();
        if (typeof node._imageUrl !== "string" || !/^https?:\/\//.test(node._imageUrl)) return null;
        if (node.caption !== undefined && typeof node.caption !== "string") return null;
        parts.push(`<figure><img src="${escape(node._imageUrl)}" alt="${escape(typeof node.alt === "string" ? node.alt : "")}">${node.caption ? `<figcaption>${escape(node.caption)}</figcaption>` : ""}</figure>`);
        continue;
      }
      if (node?._type !== "block" || !Array.isArray(node.children) || !Array.isArray(node.markDefs ?? [])) return null;
      const definitions = new Map<string, string>();
      for (const definition of node.markDefs ?? []) {
        if (definition?._type !== "link" || typeof definition._key !== "string" || typeof definition.href !== "string" || definitions.has(definition._key)) return null;
        definitions.set(definition._key, definition.href);
      }
      const spans: string[] = [];
      for (const span of node.children) {
        if (span?._type !== "span" || typeof span.text !== "string" || !Array.isArray(span.marks ?? [])) return null;
        let text = escape(span.text).replace(/\n/g, "<br>");
        for (const mark of span.marks ?? []) {
          if (typeof mark !== "string") return null;
          const tag = tags.get(mark);
          if (tag) text = `<${tag}>${text}</${tag}>`;
          else if (definitions.has(mark)) text = `<a href="${escape(definitions.get(mark)!)}">${text}</a>`;
          else return null;
        }
        spans.push(text);
      }
      const style = node.style ?? "normal";
      if (typeof style !== "string" || !/^(normal|blockquote|h[1-6])$/.test(style)) return null;
      const text = spans.join("");
      if (node.listItem) {
        if (!["bullet", "number", "alpha"].includes(node.listItem)) return null;
        const level = node.level ?? 1;
        if (!Number.isInteger(level) || level < 1 || level > 6 || level > lists.length + 1) return null;
        closeLists(level);
        if (lists.length === level && lists.at(-1)!.kind !== node.listItem) closeLists(level - 1);
        if (lists.length < level) {
          const tag = node.listItem === "bullet" ? "ul" : "ol";
          parts.push(`<${tag}${node.listItem === "alpha" ? ' type="a"' : ""}><li>${text}`);
          lists.push({ kind: node.listItem, tag });
        } else parts.push(`</li><li>${text}`);
      } else {
        closeLists();
        const tag = style === "normal" ? "p" : style;
        parts.push(`<${tag}>${text}</${tag}>`);
      }
    }
    closeLists();
  }
  return parts.length ? parts.join("\n") : null;
}

function jsonBody(value: unknown, url: string, rule: BodyJsonConfig, via: "embedded-json" | "json-api"): ExtractedBody | null {
  if (!rule.path || !["html", "markdown"].includes(rule.format)) return null;
  for (const key of rule.path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  if (rule.adapter) {
    if (rule.format !== "html") return null;
    if (rule.adapter === "magnolia_article") value = magnoliaArticle(value);
    else if (rule.adapter === "sanity_article") value = sanityArticle(value);
    else return null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  let html = rule.format === "markdown" ? markdownToHtml(value) : value;
  if (rule.bodySelector) {
    if (rule.format !== "html") return null;
    const $ = cheerio.load(html);
    const nodes = $(rule.bodySelector);
    // A verified article container must be unique; never merge related story containers.
    if (nodes.length !== 1) return null;
    html = nodes.html() ?? "";
  }
  const clean = trimTrailingChrome(sanitizeBody(html, url));
  const text = stripTags(clean);
  return text.length >= MIN_BODY_CHARS ? { html: clean, text, images: [], via } : null;
}

export function readable(html: string, url: string, bodySelector?: string | null, bodyJsonLdType?: string | null, bodyExtractionJson?: BodyJsonConfig | null): ExtractedBody | null {
  let { document } = parseHTML(html);
  restoreStreamedHtml(document);
  if (bodyExtractionJson) {
    if (bodySelector || bodyJsonLdType || bodyExtractionJson.urlTemplate || !bodyExtractionJson.selector) return null;
    const scripts = document.querySelectorAll(bodyExtractionJson.selector);
    const values = new Set<string>();
    for (const script of scripts) {
      if (script.tagName !== "SCRIPT" || script.getAttribute("type") !== "application/json") return null;
      values.add(script.textContent ?? "");
    }
    if (values.size !== 1) return null;
    try { return jsonBody(JSON.parse([...values][0]!), url, bodyExtractionJson, "embedded-json"); }
    catch { return null; }
  }
  let structuredText: string | undefined;
  if (bodyJsonLdType) {
    // Opt in only for verified report publishers. Never select a description or arbitrary nested text.
    if (bodySelector) return null;
    const texts = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { for (const node of value) visit(node); return; }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      if (types.includes(bodyJsonLdType) && typeof node.text === "string" && node.text.trim()) texts.add(node.text.trim());
      if (node["@graph"]) visit(node["@graph"]);
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent ?? "")); } catch { /* ignore malformed metadata */ }
    }
    // Multiple different documents are ambiguous; missing metadata cannot fall back to page chrome.
    if (texts.size !== 1) return null;
    structuredText = [...texts][0]!;
  }
  if (bodySelector) {
    let nodes = document.querySelectorAll(bodySelector);
    if (!nodes.length) {
      // HTML's --!> comment terminator is valid, but linkedom can swallow the rest of the page.
      document = parseHTML(cheerio.load(html).html()).document;
      restoreStreamedHtml(document);
      nodes = document.querySelectorAll(bodySelector);
    }
    if (!nodes.length) return null;
    const content = document.createElement("article");
    for (const node of nodes) content.appendChild(node.cloneNode(true));
    const scoped = parseHTML("<html><head></head><body></body></html>").document;
    scoped.body.appendChild(content);
    document = scoped;
  }
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const content = structuredText ?? new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse()?.content;
  if (!content) return null;
  const clean = trimTrailingChrome(sanitizeBody(content, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: structuredText ? "jsonld" : "readability" };
}

function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const blocks = md.split(/\n{2,}/);
  return blocks
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (/^```/.test(t)) return `<pre><code>${esc(t.replace(/^```\w*\n?|```$/g, ""))}</code></pre>`;
      const h = /^(#{1,4})\s+(.+)$/.exec(t);
      if (h) return `<h${Math.min(h[1]!.length + 1, 4)}>${inline(h[2]!)}</h${Math.min(h[1]!.length + 1, 4)}>`;
      if (/^[-*]\s/.test(t)) return `<ul>${t.split("\n").map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      if (/^>\s?/.test(t)) return `<blockquote><p>${inline(t.replace(/^>\s?/gm, ""))}</p></blockquote>`;
      return `<p>${inline(t).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

export function markdownDocument(text: string, url: string, contentType: string): ExtractedBody | null {
  if (!/^text\/(markdown|plain)\b/i.test(contentType) || !/^#{1,6}\s+\S/m.test(text) || /<(?:!doctype|html|body)\b/i.test(text)) return null;
  const html = trimTrailingChrome(sanitizeBody(markdownToHtml(text), url));
  const body = stripTags(html);
  return body.length >= MIN_BODY_CHARS ? { html, text: body, images: [], via: "markdown-document" } : null;
}

export async function extractFromUrl(url: string, opts: { allowJina: boolean; subject: string; userAgent?: string | null; bodySelector?: string | null; bodyJsonLdType?: string | null; bodyExtractionJson?: BodyJsonConfig | null; bodyExtractionMarkdown?: BodyMarkdownConfig | null }): Promise<ExtractedBody | null> {
  if (opts.bodyExtractionMarkdown) {
    if (opts.bodySelector || opts.bodyJsonLdType || opts.bodyExtractionJson) return null;
    try {
      const target = bodyDocumentUrl(url, opts.bodyExtractionMarkdown.urlTemplate);
      if (!target) return null;
      const res = await guardedFetch(target, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024, headers: opts.userAgent ? { "user-agent": opts.userAgent } : undefined });
      return res.status === 200 ? markdownDocument(res.text(), url, res.headers.get("content-type") ?? "") : null;
    } catch { return null; }
  }
  if (opts.bodyExtractionJson?.urlTemplate) {
    if (opts.bodySelector || opts.bodyJsonLdType || opts.bodyExtractionJson.selector) return null;
    if (!/\{(?:path|slug)\}/.test(opts.bodyExtractionJson.urlTemplate)) return null;
    try {
      const path = new URL(url).pathname;
      const slug = path.split("/").filter(Boolean).at(-1) ?? "";
      const target = opts.bodyExtractionJson.urlTemplate.replaceAll("{path}", path).replaceAll("{slug}", slug);
      if (/[{}]/.test(target)) return null;
      const res = await guardedFetch(target, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024,
        headers: opts.userAgent ? { "user-agent": opts.userAgent } : undefined });
      if (res.status !== 200 || !/json/.test(res.headers.get("content-type") ?? "")) return null;
      return jsonBody(JSON.parse(res.text()), url, opts.bodyExtractionJson, "json-api");
    } catch { return null; }
  }
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024,
      headers: opts.userAgent ? { "user-agent": opts.userAgent } : undefined });
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url, opts.bodySelector, opts.bodyJsonLdType, opts.bodyExtractionJson);
      if (got) return got;
    }
  } catch {
    // fall through to Jina
  }
  // CSS scope cannot be carried into a markdown fallback without losing the publisher boundary.
  if (!opts.allowJina || opts.bodySelector || opts.bodyJsonLdType || opts.bodyExtractionJson) return null;
  try {
    const page = await jinaRead(url, { purpose: "body_fallback", subject: opts.subject });
    const html = trimTrailingChrome(sanitizeBody(markdownToHtml(page.markdown), url));
    const text = stripTags(html);
    if (text.length < MIN_BODY_CHARS) return null;
    return { html, text, images: [], via: "jina" };
  } catch (error) {
    if (error instanceof BudgetExceededError) return null;
    throw error;
  }
}

/** Pages extraction can fetch: ordinary web pages (X posts and WeChat articles arrive whole or not at all). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string, allowJina = process.env.JINA_BODY_FALLBACK !== "false"): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; x_post: { tweetId?: string } | null; user_agent: string | null; body_selector: string | null; body_jsonld_type: string | null; body_json: BodyJsonConfig | null; body_markdown: BodyMarkdownConfig | null }[]>`
    SELECT a.id, a.url, a.body_status, a.revision, a.x_post, s.config->>'userAgent' AS user_agent, s.config->>'bodySelector' AS body_selector, s.config->>'bodyJsonLdType' AS body_jsonld_type, s.config->'bodyExtractionJson' AS body_json, s.config->'bodyExtractionMarkdown' AS body_markdown
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId);
  const got = await extractFromUrl(a.url, { allowJina, subject: `article:${a.id}`, userAgent: a.user_agent, bodySelector: a.body_selector, bodyJsonLdType: a.body_jsonld_type, bodyExtractionJson: a.body_json, bodyExtractionMarkdown: a.body_markdown });
  if (!got) {
    await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now() WHERE id = ${articleId} AND body_status <> 'ok'`;
    return "unconfirmed";
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null }[]>`SELECT title, excerpt FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!row) return;
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${tx.json(got.images as never)}::jsonb ELSE media END,
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${row.title}, ${got.text})`;
  });
  return "ok";
}

/**
 * The X Article a post published (SocialData, paid, by the post's own id). The article joins the
 * post's body as a new revision; a post that is only the article's link takes the article's title.
 * No article (the link points at someone else's, or X has none) leaves the post "unconfirmed", and
 * the judging steps are told the article was not fetched.
 */
async function extractXArticle(articleId: string, tweetId: string): Promise<"ok" | "unconfirmed"> {
  const found = await getArticle(tweetId, { purpose: "x_article", subject: `article:${articleId}` });
  const got = found ? xArticleText(found) : null;
  if (!got) {
    await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now() WHERE id = ${articleId} AND body_status <> 'ok'`;
    return "unconfirmed";
  }
  await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null }[]>`
      SELECT title, excerpt, body_text, x_post FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!row) return;
    const title = got.title && onlyXArticleLink(row.x_post?.text) ? got.title : row.title;
    const bodyText = [row.body_text ?? "", got.title ? `# ${got.title}` : "", got.text].filter(Boolean).join("\n\n");
    const hash = contentHash({ title, bodyText, excerpt: row.excerpt });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET title = ${title}, body_text = ${bodyText}, x_article = ${tx.json(got as never)}, body_status = 'ok',
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${title}, ${bodyText})`;
  });
  return "ok";
}

export { collapseWhitespace };
