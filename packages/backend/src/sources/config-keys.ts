// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";
import { bodyJsonRequest, type BodyJsonRequestConfig } from "../content/json-request.ts";

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
    "urlTemplate", "urlTemplateFallback", "urlLookup", "rawDropKeys", "requireBoolean", "minNumeric",
    "arrayMatchKeys", "arrayProjectionKeys", "scriptSelector", "assetNameIncludes", "summaryBlocksPath", "summaryBlocksFormat", "collectionKind", "preserveUrlFragment", "jsonDocument", "framerHandover", "allowJoinedMarkdown",
  ],
  // X accounts are mostly read in shards, which apply only these.
  x_search: ["_aihot", "ingestNoiseFilter", "itemUrlPrefixRewrite", "query", "searchType"],
  mp_account: ["wxid", "ghid", "nickname"],
  external: [],
};

// Objects with fixed keys (headers and bodyJson are request data, free-form).
const NESTED: Record<string, string[]> = {
  bodyExtractionJson: ["selector", "urlTemplate", "path", "format", "adapter", "bodySelector", "allowPlainTextJson", "method", "bodyJson"],
  bodyExtractionMarkdown: ["urlTemplate"],
  bodyExtractionLinkedHtml: ["selector", "attribute", "stripPathSuffix", "allowedOrigins", "bodySelector", "format", "pdfOrigins"],
  jsonDocument: ["selector", "variable", "allowedOrigins"],
  urlLookup: ["url", "itemsPath", "keyPath", "valuePath", "itemKeyPath"],
  framerHandover: ["selector", "matchKeys"],
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
  mode: ["json", "html_json_key", "html_window_var", "javascript_array", "html_script_array", "html_json_document", "framer_handover"],
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
  const bodyJson = config.bodyExtractionJson as Record<string, unknown> | undefined;
  const linked = config.bodyExtractionLinkedHtml as Record<string, unknown> | undefined;
  if (linked?.format !== undefined && !["html", "adobe_pdf"].includes(String(linked.format))) out.push("bodyExtractionLinkedHtml.format=unsupported");
  if (linked?.format === "adobe_pdf") {
    if (linked.bodySelector || !Array.isArray(linked.pdfOrigins) || !linked.pdfOrigins.length || linked.pdfOrigins.length > 4) out.push("bodyExtractionLinkedHtml.adobe_pdf=explicit PDF origins required");
    else for (const value of linked.pdfOrigins) {
      try { const u = new URL(String(value)); if (u.origin !== value || !/^https?:$/.test(u.protocol) || u.username || u.password) out.push("bodyExtractionLinkedHtml.pdfOrigins=exact public origins required"); } catch { out.push("bodyExtractionLinkedHtml.pdfOrigins=invalid"); }
    }
  } else if (linked?.pdfOrigins !== undefined) out.push("bodyExtractionLinkedHtml.pdfOrigins=requires adobe_pdf format");
  if (bodyJson && (bodyJson.method !== undefined || bodyJson.bodyJson !== undefined) &&
    (bodyJson.selector || !bodyJsonRequest("https://publisher.example/post/article-id", bodyJson as BodyJsonRequestConfig)))
    out.push("bodyExtractionJson.request=explicit GET or read-only POST JSON article mapping required");
  if (bodyJson?.allowPlainTextJson !== undefined && typeof bodyJson.allowPlainTextJson !== "boolean") out.push("bodyExtractionJson.allowPlainTextJson=boolean required");
  if (bodyJson?.adapter === "x_article" && (bodyJson.format !== "html" || bodyJson.path !== "tweet" || typeof bodyJson.urlTemplate !== "string" || !bodyJson.urlTemplate.includes("{slug}") || bodyJson.selector || bodyJson.bodySelector)) out.push("bodyExtractionJson.x_article=requires complete tweet JSON API mapping");
  if (config.mode === "html_json_document") {
    const rule = config.jsonDocument as Record<string, unknown> | undefined;
    if (!rule || typeof rule.selector !== "string" || !rule.selector || rule.selector.length > 300 || typeof rule.variable !== "string" || !/^[a-zA-Z_$][\w$]*$/.test(rule.variable) || ["__proto__", "constructor", "prototype"].includes(rule.variable) || !Array.isArray(rule.allowedOrigins) || !rule.allowedOrigins.length || rule.allowedOrigins.length > 4) out.push("jsonDocument=explicit inline loader and public origins required");
    else for (const origin of rule.allowedOrigins) {
      try { if (typeof origin !== "string" || new URL(origin).origin !== origin || !/^https?:$/.test(new URL(origin).protocol)) out.push("jsonDocument.allowedOrigins=exact HTTP origins required"); } catch { out.push("jsonDocument.allowedOrigins=invalid origin"); }
    }
  } else if (config.jsonDocument !== undefined) out.push("jsonDocument=requires html_json_document mode");
  if (kind === "json_list") {
    if (config.urlLookup !== undefined) {
      const rule = config.urlLookup as Record<string, unknown>;
      const path = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256 && v.split(".").every(k => /^[\w$]+$/.test(k) && !["__proto__", "constructor", "prototype"].includes(k));
      if (!rule || typeof rule !== "object" || Array.isArray(rule) || typeof rule.url !== "string" || ![rule.itemsPath, rule.keyPath, rule.valuePath, rule.itemKeyPath].every(path)) out.push("urlLookup=explicit public index and stable field paths required");
      else try {
        const listing = new URL(String(config.url)), target = new URL(rule.url, listing);
        if (!/^https?:$/.test(target.protocol) || target.origin !== listing.origin || target.username || target.password || target.hash || !target.pathname.endsWith(".json")) out.push("urlLookup=same-origin public JSON file required");
      } catch { out.push("urlLookup=invalid public index URL"); }
    }
    if (config.summaryBlocksFormat !== undefined && (!["text_objects", "markdown_strings"].includes(String(config.summaryBlocksFormat)) || typeof config.summaryBlocksPath !== "string" || !config.summaryBlocksPath)) out.push("summaryBlocksFormat=explicit supported format and block path required");
    const staticMode = config.mode === "javascript_array" || config.mode === "html_script_array";
    if (config.allowJoinedMarkdown !== undefined && (!staticMode || typeof config.allowJoinedMarkdown !== "boolean")) out.push("allowJoinedMarkdown=boolean for static JavaScript only");
    const validKeys = (keys: unknown): keys is string[] => Array.isArray(keys) && keys.length >= 2 && keys.length <= 20 &&
      keys.every(k => typeof k === "string" && /^[a-zA-Z_$][\w$]*$/.test(k) && !["__proto__", "prototype", "constructor"].includes(k)) && new Set(keys).size === keys.length;
    if (config.mode === "framer_handover") {
      const rule = config.framerHandover as Record<string, unknown> | undefined;
      if (!rule || typeof rule.selector !== "string" || !rule.selector || rule.selector.length > 300 || !validKeys(rule.matchKeys)) out.push("framerHandover=explicit data selector and collection keys required");
      if (config.itemsPath || config.jsonKey || config.itemsObjectValues || config.windowVar) out.push("framerHandover=collection is selected by declared keys");
    } else if (config.framerHandover !== undefined) out.push("framerHandover=requires framer_handover mode");
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
