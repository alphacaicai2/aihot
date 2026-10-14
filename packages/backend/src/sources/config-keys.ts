// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";

// Rules applied in collect.ts to every kind read through collectSource.
const COLLECTED = ["_aihot", "allowUrlPrefixes", "denyUrlPrefixes", "ingestNoiseFilter", "itemUrlPrefixRewrite", "sortByPublishedAt", "detail", "fetchPublicContent", "userAgent", "bodySelector", "bodyJsonLdType", "bodyExtractionJson", "bodyExtractionMarkdown", "bodyExtractionPdf", "bodyExtractionLinkedHtml"];

const KEYS: Record<SourceRow["kind"], string[]> = {
  rss: [...COLLECTED, "feedUrl", "summaryIsBody", "feedContentIsSummary", "preserveUrlFragment", "allowCategories", "denyCategories", "minifluxFeedId", "minifluxLookbackDays", "rssMaxBytes"],
  web_list: [
    ...COLLECTED, "url", "baseUrl", "parseMode", "adapter", "cacheToleranceSeconds", "linksStartLine", "preserveUrlFragment",
    "itemSelector", "linkSelector", "titleSelector", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset",
    "nextPageSelector", "maxPages",
  ],
  json_list: [
    ...COLLECTED, "url", "mode", "method", "headers", "bodyJson", "jsonKey", "windowVar", "itemsPath", "itemsObjectValues",
    "titlePaths", "summaryPaths", "summaryIsBody", "authorPaths", "publishedAtPath", "publishedAtUnit", "externalIdPath",
    "urlTemplate", "urlTemplateFallback", "rawDropKeys", "requireBoolean", "minNumeric",
    "arrayMatchKeys", "arrayProjectionKeys", "scriptSelector", "assetNameIncludes", "summaryBlocksPath", "collectionKind", "preserveUrlFragment",
  ],
  // X accounts are mostly read in shards, which apply only these.
  x_search: ["_aihot", "ingestNoiseFilter", "itemUrlPrefixRewrite", "query", "searchType"],
  mp_account: ["wxid", "ghid", "nickname"],
  external: [],
};

// Objects with fixed keys (headers and bodyJson are request data, free-form).
const NESTED: Record<string, string[]> = {
  bodyExtractionJson: ["selector", "urlTemplate", "path", "format", "adapter", "bodySelector"],
  bodyExtractionMarkdown: ["urlTemplate"],
  bodyExtractionLinkedHtml: ["selector", "attribute", "stripPathSuffix", "allowedOrigins", "bodySelector"],
  _aihot: ["initialBackfillLimit", "initialBackfillMonths", "skipInitialRemainder"],
  ingestNoiseFilter: ["dropMarkers", "dropMarkersTitleOnly", "keepIfMatches"],
  itemUrlPrefixRewrite: ["from", "to"],
  requireBoolean: ["path", "equals"],
  minNumeric: ["path", "min"],
  detail: [
    "maxFetches", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset", "publishedAtAuthoritative", "upgradeDatePrecision",
    "titleSelector", "titleRegex", "titleAuthoritative", "summarySelector",
  ],
};

const VALUES: Record<string, string[]> = {
  adapter: ["mimo_home"],
  parseMode: ["html", "markdown", "docusaurus_changelog"],
  mode: ["json", "html_json_key", "html_window_var", "javascript_array", "html_script_array"],
};

/** The config entries a source of this kind would ignore or cannot run, e.g. ["adapter=site_cards", "detail.titleFoo"]. */
export function unsupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): string[] {
  const allowed = new Set(KEYS[kind] ?? []);
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) out.push(key);
    else if (key === "bodyExtractionPdf" && typeof value !== "boolean") out.push(`${key}=boolean required`);
    else if (VALUES[key] && !VALUES[key]!.includes(String(value))) out.push(`${key}=${String(value)}`);
    else if (NESTED[key] && value && typeof value === "object") {
      for (const sub of Object.keys(value)) if (!NESTED[key]!.includes(sub)) out.push(`${key}.${sub}`);
    }
  }
  if (kind === "web_list" && (config.nextPageSelector !== undefined || config.maxPages !== undefined)) {
    if (typeof config.nextPageSelector !== "string" || !config.nextPageSelector || config.nextPageSelector.length > 300) out.push("nextPageSelector=explicit selector required");
    if (!Number.isInteger(config.maxPages) || Number(config.maxPages) < 2 || Number(config.maxPages) > 5) out.push("maxPages=integer from2 to5 required");
    if (config.adapter || config.baseUrl || (config.parseMode !== undefined && config.parseMode !== "html") || String(config.url ?? "").startsWith("https://r.jina.ai/")) out.push("pagination=requires canonical native HTML listing");
  }
  if (kind === "json_list") {
    const staticMode = config.mode === "javascript_array" || config.mode === "html_script_array";
    const validKeys = (keys: unknown): keys is string[] => Array.isArray(keys) && keys.length >= 2 && keys.length <= 20 &&
      keys.every(k => typeof k === "string" && /^[a-zA-Z_$][\w$]*$/.test(k) && !["__proto__", "prototype", "constructor"].includes(k)) && new Set(keys).size === keys.length;
    if (staticMode) {
      if (!validKeys(config.arrayMatchKeys)) out.push("arrayMatchKeys=2-20 distinct static keys required");
      if (config.arrayProjectionKeys !== undefined && (!validKeys(config.arrayProjectionKeys) ||
        (validKeys(config.arrayMatchKeys) && config.arrayMatchKeys.some(k => !(config.arrayProjectionKeys as string[]).includes(k))))) out.push("arrayProjectionKeys=must include arrayMatchKeys");
      if (validKeys(config.arrayProjectionKeys)) {
        const paths = [config.publishedAtPath, config.externalIdPath, config.summaryBlocksPath,
          ...(Array.isArray(config.titlePaths) ? config.titlePaths : []), ...(Array.isArray(config.authorPaths) ? config.authorPaths : []),
          ...(Array.isArray(config.summaryPaths) ? config.summaryPaths : []),
          (config.requireBoolean as any)?.path, (config.minNumeric as any)?.path];
        for (const template of [config.urlTemplate, config.urlTemplateFallback]) if (typeof template === "string")
          for (const match of template.matchAll(/\{(?:raw:)?([^}]+)\}/g)) paths.push(match[1]);
        if (paths.some(p => typeof p === "string" && p && !(config.arrayProjectionKeys as string[]).includes(p.split(".")[0]!))) out.push("arrayProjectionKeys=must include all mapped fields");
      }
      if (config.collectionKind !== undefined && !["array", "object"].includes(String(config.collectionKind))) out.push("collectionKind=invalid");
      if (config.collectionKind === "object" ? config.itemsObjectValues !== true : config.itemsObjectValues) out.push("itemsObjectValues=required only for object collection");
      if (config.itemsPath || config.jsonKey || config.windowVar) out.push("static array mode does not support nested items selectors");
      if (config.mode === "html_script_array" && (typeof config.scriptSelector !== "string" || !config.scriptSelector || config.scriptSelector.length > 300)) out.push("scriptSelector=required");
      if (config.assetNameIncludes !== undefined && (config.mode !== "html_script_array" || typeof config.assetNameIncludes !== "string" || !/^[\w-]{3,100}$/.test(config.assetNameIncludes))) out.push("assetNameIncludes=invalid");
    } else {
      for (const k of ["arrayMatchKeys", "arrayProjectionKeys", "scriptSelector", "assetNameIncludes", "collectionKind"]) if (config[k] !== undefined) out.push(`${k}=requires static array mode`);
    }
    if (config.summaryBlocksPath !== undefined && (typeof config.summaryBlocksPath !== "string" || !config.summaryBlocksPath || (Array.isArray(config.summaryPaths) && config.summaryPaths.length))) out.push("summaryBlocksPath=single block path required");
  }
  return out;
}

export class UnsupportedConfig extends Error {
  readonly statusCode = 400;
}

/** Refuses a config with entries its kind does not implement (admin create, edit and preview). */
export function assertSupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): void {
  const bad = unsupportedConfig(kind, config);
  if (bad.length) throw new UnsupportedConfig(`不支持的配置项：${bad.join("、")}`);
}
