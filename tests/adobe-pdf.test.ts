import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { adobePdfTarget, type LinkedHtmlConfig } from "@aihot/backend/content/linked-html";
import { extractFromUrl } from "@aihot/backend/content/extract";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { config } from "@aihot/backend/config";

const declaration = (url: string) => `var adobeDCView = new AdobeDC.View({clientId: "public-viewer", divId: "adobe-dc-view"});
  adobeDCView.previewFile({content:{location:{url:${JSON.stringify(url)}}},metaData:{fileName:"Original report"}}, {defaultViewMode:"FIT_PAGE"});`;
const viewer = (script: string) => `<div id="adobe-dc-view"><script>${script}</script></div>`;

test("only a literal Adobe viewer PDF on an explicitly allowed origin resolves, without executing scripts", () => {
  const url = "https://cdn.publisher.example/reports/original.pdf", origin = "https://cdn.publisher.example";
  assert.equal(adobePdfTarget(viewer(declaration(url) + ';throw Error("must not execute");'), "https://publisher.example/documents/report", [origin]), url);
  for (const script of [declaration("https://other.example/unrelated.pdf"), declaration("https://user:pass@cdn.publisher.example/report.pdf"),
    declaration(url).replace(JSON.stringify(url), 'getViewerUrl()'), declaration(url).replace('divId: "adobe-dc-view"', 'divId: "other"'),
    declaration(url).replace('url:', '...external,url:'), declaration(url).replace('adobeDCView.previewFile', 'other.previewFile'),
    declaration(url) + `adobeDCView.previewFile({content:{location:{url:"${origin}/different.pdf"}}});`,
    declaration(url) + ';adobeDCView=other;'])
    assert.equal(adobePdfTarget(viewer(script), "https://publisher.example/documents/report", [origin]), null);
  assert.equal(adobePdfTarget(`<script>${declaration(url)}</script>`, "https://publisher.example/report", [origin]), null);
  assert.equal(adobePdfTarget(viewer(declaration(url)), "https://publisher.example/report", [`${origin}/path`]), null);
});

// A real two-page, searchable PDF to verify that an article's introduction is not accepted as its report.
function report(): Buffer {
  const prose = "Original cost research links compute utilization to energy demand and capital deployment.";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let page = 0; page < 2; page++) {
    const n = objects.length + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`);
    const lines = [page === 0 ? "Original report March 2026" : "Second-page conclusions", ...Array(8).fill(prose), ...(page === 1 ? ["END OF ORIGINAL REPORT"] : [])];
    const stream = "BT /F1 12 Tf 40 740 Td\n" + lines.map(s => `(${s}) Tj 0 -16 Td`).join("\n") + "\nET";
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let out = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

test("an article follows its declared document wrapper and extracts all PDF pages; blocked targets never fall back to an intro", async () => {
  const requests: string[] = [];
  let base = "", mode = "normal";
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader("content-type", "text/html");
    if (req.url === "/article") res.end(`<article><h1>Original research</h1><p>${"REPORT INTRODUCTION ONLY. ".repeat(20)}</p><a data-report href="/documents/report">View PDF</a></article>`);
    else if (req.url === "/documents/report") res.end(viewer(declaration(mode === "offsite" ? "https://unrelated.example/report.pdf" : `${base}/report.pdf`)));
    else if (mode === "redirect") { res.writeHead(302, { location: "/must-not-follow" }); res.end(); }
    else if (mode === "html") res.end("<p>Only viewer HTML</p>");
    else { res.setHeader("content-type", "application/pdf"); res.end(report()); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const previous = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  const rule: LinkedHtmlConfig = { selector: "a[data-report]", attribute: "href", allowedOrigins: [base], format: "adobe_pdf", pdfOrigins: [base] };
  try {
    assertSupportedConfig("web_list", { url: base, bodyExtractionLinkedHtml: rule });
    const got = await extractFromUrl(`${base}/article`, { allowJina: false, subject: "test", bodyExtractionLinkedHtml: rule });
    assert.equal(got?.via, "pdf-text");
    assert.ok(got?.text.startsWith("Original report March 2026"));
    assert.ok(got?.text.endsWith("END OF ORIGINAL REPORT"));
    assert.ok(!got?.text.includes("REPORT INTRODUCTION ONLY"));
    assert.deepEqual(requests, ["/article", "/documents/report", "/report.pdf"]);
    for (mode of ["offsite", "redirect", "html"]) {
      assert.equal(await extractFromUrl(`${base}/article`, { allowJina: false, subject: "test", bodyExtractionLinkedHtml: rule }), null, mode);
      assert.ok(!requests.includes("/must-not-follow"));
    }
    assert.throws(() => assertSupportedConfig("rss", { feedUrl: base, bodyExtractionLinkedHtml: { ...rule, pdfOrigins: [base + "/path"] } }), /pdfOrigins/);
    assert.throws(() => assertSupportedConfig("rss", { feedUrl: base, bodyExtractionLinkedHtml: { ...rule, format: "html" } }), /requires adobe_pdf/);
  } finally {
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
