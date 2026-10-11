// xgo RSS appends mutable counters to posts. These are metadata, not analysis input.
export function xFeedContent(url: string, text: string | null | undefined): { text: string | null | undefined; metrics?: Record<string, string> } {
  if (!text) return { text };
  let post: URL;
  try { post = new URL(url); } catch { return { text }; }
  if (!/^(?:www\.)?(?:x\.com|twitter\.com)$/.test(post.hostname) || !/^\/[^/]+\/status\/\d+\/?$/.test(post.pathname)) return { text };
  const footer = /\s*(?:🔗\s*View on Twitter\s*)?(?:🔗\s*View Quoted Tweet\s*)?((?:(?:💬|🔄|❤️|❤|👀|📊)\s*[\d,.]+[KMBkmb万亿]?\s*)+)⚡\s*Powered by xgo\.ing\s*$/u.exec(text);
  if (!footer) return { text };
  const names: Record<string, string> = { "💬": "replies", "🔄": "reposts", "❤️": "likes", "❤": "likes", "👀": "views", "📊": "score" };
  const metrics = Object.fromEntries([...footer[1]!.matchAll(/(💬|🔄|❤️|❤|👀|📊)\s*([\d,.]+[KMBkmb万亿]?)/gu)].map((m) => [names[m[1]!]!, m[2]!]));
  return { text: text.slice(0, footer.index).trimEnd(), metrics };
}
