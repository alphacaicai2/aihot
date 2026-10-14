// Public X Article payloads carry Draft.js blocks, not HTML or a complete preview string.
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const styles = new Map([["bold", "strong"], ["italic", "em"], ["underline", "u"], ["strikethrough", "s"], ["code", "code"]]);

function inline(block: Record<string, any>, entities: Map<string, Record<string, any>>): string | null {
  const text = block.text;
  if (typeof text !== "string" || text.length > 256_000 || !Array.isArray(block.inlineStyleRanges) || block.inlineStyleRanges.length > 64 || !Array.isArray(block.entityRanges) || block.entityRanges.length > 64) return null;
  const ranges: Array<{ start: number; end: number; tag: string; href?: string }> = [];
  for (const range of [...block.inlineStyleRanges, ...block.entityRanges]) {
    if (!object(range) || !Number.isInteger(range.offset) || !Number.isInteger(range.length) || range.offset < 0 || range.length <= 0 || range.offset + range.length > text.length) return null;
    let tag: string | undefined, href: string | undefined;
    if (Object.hasOwn(range, "style")) tag = typeof range.style === "string" ? styles.get(range.style.toLowerCase()) : undefined;
    else {
      const entity = entities.get(String(range.key));
      if (entity?.type !== "LINK" || typeof entity.data?.url !== "string" || !/^https?:\/\//.test(entity.data.url)) return null;
      tag = "a"; href = entity.data.url;
    }
    if (!tag) return null;
    ranges.push({ start: range.offset, end: range.offset + range.length, tag, href });
  }
  const boundaries = [...new Set([0, text.length, ...ranges.flatMap(r => [r.start, r.end])])].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1]!, end = boundaries[i]!;
    let part = escape(text.slice(start, end)).replace(/\n/g, "<br>");
    const active = ranges.filter(r => r.start <= start && r.end >= end);
    if (active.filter(r => r.tag === "a").length > 1) return null;
    for (const r of active) part = `<${r.tag}${r.href ? ` href="${escape(r.href)}"` : ""}>${part}</${r.tag}>`;
    parts.push(part);
  }
  return parts.join("");
}

/** An identity mismatch, restricted author, unknown block or missing media fails the whole body. */
export function publicXArticle(value: unknown, canonicalUrl: string): { html: string; text: string; title: string; publishedAt: Date | null } | null {
  if (!object(value) || !object(value.author) || value.author.protected !== false || !object(value.article)) return null;
  let url: URL;
  try { url = new URL(canonicalUrl); } catch { return null; }
  const path = /^\/([a-zA-Z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || !["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(url.hostname) || !path ||
    String(value.id) !== path[2] || typeof value.author.screen_name !== "string" || value.author.screen_name.toLowerCase() !== path[1]!.toLowerCase()) return null;
  try {
    const own = new URL(value.url);
    if (!["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(own.hostname) || own.pathname.replace(/\/$/, "").toLowerCase() !== url.pathname.replace(/\/$/, "").toLowerCase()) return null;
  } catch { return null; }
  const article = value.article, content = article.content;
  if (typeof article.title !== "string" || !article.title.trim() || !object(content) || !Array.isArray(content.blocks) || !content.blocks.length || content.blocks.length > 5000 || !Array.isArray(content.entityMap) || content.entityMap.length > 5000) return null;
  const entities = new Map<string, Record<string, any>>();
  for (const entry of content.entityMap) {
    if (!object(entry) || typeof entry.key !== "string" || !/^\d+$/.test(entry.key) || !object(entry.value) || entities.has(entry.key)) return null;
    entities.set(entry.key, entry.value);
  }
  const media = new Map<string, Record<string, any>>();
  if (article.media_entities !== undefined && !Array.isArray(article.media_entities)) return null;
  for (const entry of article.media_entities ?? []) {
    if (!object(entry) || typeof entry.media_id !== "string" || media.has(entry.media_id)) return null;
    media.set(entry.media_id, entry);
  }
  const parts: string[] = [], writing: string[] = [], lists: string[] = [];
  const closeLists = (depth = 0) => { while (lists.length > depth) parts.push(`</li></${lists.pop()!}>`); };
  const blockTags = new Map([["unstyled", "p"], ["header-one", "h2"], ["header-two", "h2"], ["header-three", "h3"], ["header-four", "h4"], ["header-five", "h5"], ["header-six", "h5"], ["blockquote", "blockquote"], ["code-block", "pre"]]);
  for (const block of content.blocks) {
    if (!object(block) || typeof block.text !== "string") return null;
    const level = Object.hasOwn(block, "depth") ? block.depth : 0;
    if (!Number.isInteger(level) || level < 0 || level > 5) return null;
    if (block.type === "atomic") {
      closeLists();
      if (block.text.trim() || level || !Array.isArray(block.entityRanges) || block.entityRanges.length !== 1 || !Array.isArray(block.inlineStyleRanges) || block.inlineStyleRanges.length) return null;
      const range = block.entityRanges[0];
      if (!object(range) || range.offset !== 0 || range.length !== block.text.length) return null;
      const entity = entities.get(String(range.key));
      if (entity?.type !== "MEDIA" || !object(entity.data) || !Array.isArray(entity.data.mediaItems) || !entity.data.mediaItems.length || (entity.data.caption !== undefined && typeof entity.data.caption !== "string")) return null;
      const images: string[] = [];
      for (const item of entity.data.mediaItems) {
        if (!object(item) || typeof item.mediaId !== "string") return null;
        const info = media.get(item.mediaId)?.media_info;
        if (!object(info) || info.__typename !== "ApiImage" || typeof info.original_img_url !== "string") return null;
        try { const image = new URL(info.original_img_url); if (image.protocol !== "https:" || image.hostname !== "pbs.twimg.com" || image.username || image.password) return null; } catch { return null; }
        images.push(`<img src="${escape(info.original_img_url)}" alt="">`);
      }
      parts.push(`<figure>${images.join("")}${entity.data.caption ? `<figcaption>${escape(entity.data.caption)}</figcaption>` : ""}</figure>`);
      if (entity.data.caption) writing.push(entity.data.caption);
      continue;
    }
    const text = inline(block, entities);
    if (text === null) return null;
    writing.push(block.text);
    if (block.type === "unordered-list-item" || block.type === "ordered-list-item") {
      const depth = level + 1, tag = block.type === "unordered-list-item" ? "ul" : "ol";
      if (depth > lists.length + 1) return null;
      closeLists(depth);
      if (lists.length === depth && lists.at(-1) !== tag) closeLists(depth - 1);
      if (lists.length < depth) { parts.push(`<${tag}><li>${text}`); lists.push(tag); }
      else parts.push(`</li><li>${text}`);
    } else {
      closeLists();
      const tag = blockTags.get(block.type);
      if (!tag || level) return null;
      parts.push(`<${tag}>${text}</${tag}>`);
    }
  }
  closeLists();
  // Only the article's explicit first-publication timestamp, never the tweet's modified time.
  const time = typeof article.created_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(article.created_at) ? Date.parse(article.created_at) : NaN;
  const validTime = Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === article.created_at.slice(0, 19);
  return { html: parts.join("\n"), text: writing.join("\n\n"), title: article.title.trim(), publishedAt: validTime ? new Date(time) : null };
}
