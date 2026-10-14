import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { pdfDocument } from "@aihot/backend/content/pdf";
import { extractFromUrl, extractArticleBody } from "@aihot/backend/content/extract";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import type { SourceRow } from "@aihot/backend/sources/types";

// A real, complete multipage PDF with a standard font; no network or fixture dependency.
function pdf(pages: string[][], unmappedFont = false): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  if (unmappedFont) {
    const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Unmapped def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <0000> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
    objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 4 0 R >>";
    objects.push(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
  }
  const ids: number[] = [];
  for (const lines of pages) {
    const page = objects.length + 1;
    ids.push(page);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const stream = "BT /F1 12 Tf 50 740 Td\n" + lines.map(s => `(${s.replace(/[\\()]/g, "\\$&")}) Tj 0 -16 Td`).join("\n") + "\nET";
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${ids.map(i => `${i} 0 R`).join(" ")}] /Count ${ids.length} >>`;
  let out = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

const prose = Array.from({ length: 8 }, (_, i) => `Research ${i}: inference costs shape deployment economics and market structure.`);
const bytes = pdf([["Original Research Q4", "Feb 9, 2026", ...prose], ["Second page: customer adoption", ...prose, "END OF ORIGINAL REPORT"]]);

test("a PDF font mapped to a NUL glyph cannot be confirmed as a complete or database-safe body", async () => {
  const result = await pdfDocument(pdf([["A glyph before original prose", ...prose], ["Second page", ...prose, "END OF ORIGINAL REPORT"]], true), "application/pdf");
  assert.equal(result, null, "unknown glyphs must not be removed or replaced while claiming a full report");
});

test("native PDF extracts every page in order and escapes writing without interpreting PDF scripts", async () => {
  const result = await pdfDocument(bytes, "application/pdf; charset=binary");
  assert.equal(result?.via, "pdf-text");
  assert.ok(result?.text.startsWith("Original Research Q4"));
  assert.ok(result?.text.includes("Second page: customer adoption"));
  assert.ok(result?.text.endsWith("END OF ORIGINAL REPORT"));
  assert.ok(result!.text.indexOf("Second page") > result!.text.indexOf("Feb 9, 2026"));
  const escaped = await pdfDocument(pdf([["<script>not code & research</script>", ...prose]]), "application/pdf");
  assert.ok(escaped?.html.includes("&lt;script&gt;not code &amp; research&lt;/script&gt;"));
});

test("wrong responses, corrupt documents, image-only pages and exceeded limits cannot confirm a partial PDF", async () => {
  assert.equal(await pdfDocument(bytes, "text/html"), null);
  assert.equal(await pdfDocument(Buffer.from("<html>PDF viewer error</html>"), "application/pdf"), null);
  assert.equal(await pdfDocument(Buffer.from("%PDF-1.7 broken"), "application/pdf"), null);
  assert.equal(await pdfDocument(pdf([[], []]), "application/pdf"), null);
  assert.equal(await pdfDocument(pdf([prose, [], prose]), "application/pdf"), null);
  assert.equal(await pdfDocument(pdf(Array.from({ length: 151 }, () => prose)), "application/pdf"), null);
  const tooLarge = Buffer.alloc(16 * 1024 * 1024 + 1); tooLarge.write("%PDF-");
  assert.equal(await pdfDocument(tooLarge, "application/pdf"), null);
  assert.deepEqual(unsupportedConfig("web_list", { bodyExtractionPdf: true }), []);
  assert.deepEqual(unsupportedConfig("rss", { bodyExtractionPdf: "yes" }), ["bodyExtractionPdf=boolean required"]);
});

test("PDF opt-in reaches guarded detail/body requests, stores the body and reads actual dates from report writing", async () => {
  const ua = "ResearchBot/1.0 (+https://example.org/about)";
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.headers["user-agent"] !== ua) { res.writeHead(403); res.end(); return; }
    if (req.url === "/viewer") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<article>${prose.join(" ")}</article>`); return; }
    if (req.url === "/date-example.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(pdf([['API example: "datePublished":"2099-01-01"', ...prose]])); return; }
    res.writeHead(200, { "content-type": "application/pdf" }); res.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const old = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  const source: SourceRow = { id: `pdf-${tag()}`, name: "PDF research", kind: "web_list", config: { url: base, userAgent: ua, bodyExtractionPdf: true,
    detail: { titleRegex: "^<p>(Original Research Q4)", publishedAtRegex: "(Feb 9, 2026)", publishedAtAuthoritative: true, publishedAtUtcOffset: "+00:00" } },
    tier: "T2", participation_mode: "editorial", first_party: false, interval_minutes: 180, enabled: true, cursor: null, fail_count: 0 };
  try {
    const detail = await fetchDetail(base + "/report.pdf", source, { date: true, title: true, summary: false, body: true });
    assert.equal(detail.title, "Original Research Q4");
    assert.equal(detail.publishedAt?.toISOString(), "2026-02-09T00:00:00.000Z");
    assert.ok(detail.body?.text.endsWith("END OF ORIGINAL REPORT"));
    const withoutRule = { ...source, config: { ...source.config, detail: {} } };
    assert.equal((await fetchDetail(base + "/report.pdf", withoutRule, { date: true, title: false, summary: false, body: true })).publishedAt, null);
    assert.equal((await fetchDetail(base + "/date-example.pdf", withoutRule, { date: true, title: false, summary: false, body: true })).publishedAt, null);
    const jinaListing = { ...source, config: { ...source.config, url: "https://r.jina.ai/https://example.org/reports" } };
    const nativeDetail = await fetchDetail(base + "/report.pdf", jinaListing, { date: true, title: true, summary: false, body: true });
    assert.equal(nativeDetail.title, "Original Research Q4");
    assert.equal(nativeDetail.publishedAt?.toISOString(), "2026-02-09T00:00:00.000Z");
    assert.equal(await extractFromUrl(base + "/viewer", { allowJina: true, subject: source.id, userAgent: ua, bodyExtractionPdf: true }), null);
    const before = hits;
    assert.equal(await extractFromUrl(base + "/report.pdf", { allowJina: true, subject: source.id, userAgent: ua, bodyExtractionPdf: true, bodySelector: "article" }), null);
    assert.equal(hits, before);
    await sql`INSERT INTO sources(id,name,kind,config) VALUES (${source.id},'PDF research','web_list',${sql.json(source.config)})`;
    const article = await upsertMaterial({ sourceId: source.id, url: base + "/report.pdf", title: "Original research", via: "fetch" });
    assert.equal(await extractArticleBody(article.articleId, false), "ok");
    const [stored] = await sql`SELECT body_status,body_text,published_at FROM articles WHERE id=${article.articleId}`;
    assert.equal(stored.body_status, "ok");
    assert.ok(stored.body_text.endsWith("END OF ORIGINAL REPORT"));
    assert.equal(stored.published_at, null); // extraction does not manufacture article metadata
  } finally {
    await sql`DELETE FROM articles WHERE source_id=${source.id}`;
    await sql`DELETE FROM sources WHERE id=${source.id}`;
    config.allowPrivateNetworkFetch = old;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closeDb();
  }
});
