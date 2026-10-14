import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { javascriptArray, JAVASCRIPT_MAX_BYTES, scriptAsset, textBlocks } from "@aihot/backend/sources/javascript-array";

const blue = readFileSync(new URL("./fixtures/static-js/bluepointe-articles.js", import.meta.url), "utf8");
const augment = readFileSync(new URL("./fixtures/static-js/augment-articles.js", import.meta.url), "utf8");
const matchKeys = ["id", "title", "content"];
const projectionKeys = ["id", "title", "content", "date", "author"];
let hash = "fresh-hash";
const fetchedPaths: string[] = [];
let offOriginRequests = 0;
const offOrigin = http.createServer((_req, res) => {
  offOriginRequests++;
  res.end('const posts=[{id:"leak",title:"Redirect target",content:"Must not be requested"}];');
});
await new Promise<void>(resolve => offOrigin.listen(0, "127.0.0.1", resolve));
const offOriginBase = `http://127.0.0.1:${(offOrigin.address() as { port: number }).port}`;
const pages: Record<string, () => string> = {
  "/perspectives": () => `<script src="/assets/vendor.js"></script><script type="module" src="/assets/index-${hash}.js"></script>`,
  "/insights": () => `<script type="module" src="/assets/router-${hash}.js"></script>`,
  "/unknown-block.js": () => `const articles=[{id:"one",title:"Unknown",content:[{type:"image",text:"missing writing"}]}];`,
  "/ambiguous-insights": () => '<script type="module" src="/assets/ambiguous.js"></script>',
  "/metadata-insights": () => '<script type="module" src="/assets/metadata.js"></script>',
  "/assets/metadata.js": () => 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/insights-unknown-base.js"])))=>i.map(i=>d[i]);',
  "/root-insights": () => '<script type="module" src="/assets/root.js"></script>',
  "/assets/root.js": () => `const declared="/assets/insights-${hash}.js";`,
  "/assets/ambiguous.js": () => 'const one=()=>import("./insights-one.js"),two=()=>import("./insights-two.js");',
  "/big.js": () => " ".repeat(JAVASCRIPT_MAX_BYTES + 1),
  "/redirect-insights": () => '<script type="module" src="/assets/redirect.js"></script>',
  "/plain-blocks.js": () => 'const posts=[{id:"plain",title:"Plain blocks",content:[{type:"paragraph",text:"Literal <rule> and <token> plus <script>globalThis.blockExecuted=true</script> remain plain text."}]}];',
  "/html-summary.json": () => JSON.stringify([{ id: "html", title: "HTML summary", content: "<p>HTML &amp; text</p>" }]),
  "/plain.json": () => JSON.stringify([{ id: "plain", title: "Existing JSON", content: "Complete JSON body", date: "2026-10-01" }]),
};
const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  fetchedPaths.push(path);
  if (path === "/assets/redirect.js") {
    res.writeHead(302, { location: `${offOriginBase}/target.js` });
    res.end();
    return;
  }
  let body = pages[path]?.();
  if (path === `/assets/index-${hash}.js`) body = blue;
  if (path === `/assets/router-${hash}.js`) body = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/insights-${hash}.js"])))=>i.map(i=>d[i]); const route=()=>import(\`./insights-${hash}.js\`);`;
  if (path === `/assets/insights-${hash}.js`) body = augment;
  res.writeHead(body === undefined ? 404 : 200, { "content-type": path.endsWith(".js") ? "application/javascript" : "text/html" });
  res.end(body ?? "");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>(resolve => server.close(() => resolve())));
after(() => new Promise<void>(resolve => offOrigin.close(() => resolve())));
const source = (c: Record<string, unknown>) => ({ id: "static-test", config: c }) as never;

test("the BluePointe-shaped synthetic dictionary maps complete long bodies through changing public script hashes", async () => {
  const c = { url: `${base}/perspectives`, mode: "html_script_array", collectionKind: "object", itemsObjectValues: true,
    scriptSelector: 'script[type="module"][src]', arrayMatchKeys: matchKeys, arrayProjectionKeys: projectionKeys,
    titlePaths: ["title"], authorPaths: ["author"], publishedAtPath: "date", summaryPaths: ["content"], summaryIsBody: true,
    urlTemplate: `${base}/perspectives/article/{id}` };
  assertSupportedConfig("json_list", c);
  const first = await fetchJsonList(source(c));
  assert.equal(first.length, 2);
  assert.equal(first[0]!.title, "Synthetic enterprise software analysis");
  assert.equal(first[0]!.author, "Fixture Editorial Team");
  assert.equal(first[0]!.publishedAt?.toISOString(), "2026-02-10T00:00:00.000Z");
  assert.equal(first[0]!.url, `${base}/perspectives/article/synthetic-enterprise-analysis`);
  const dictionary = await javascriptArray(blue, matchKeys, projectionKeys, undefined, "object") as Record<string, any>;
  assert.ok(!("image" in dictionary["synthetic-enterprise-analysis"]));
  assert.ok(first.every(p => p.bodyStatus === "ok" && p.bodyText!.length > 10_000));
  assert.deepEqual(first.map(p => p.bodyText!.length), [26_695, 18_232], "both long bodies are complete, not teasers");
  assert.ok(first[0]!.bodyText!.endsWith("END OF SYNTHETIC ENTERPRISE BODY"));
  assert.ok(first[1]!.bodyText!.endsWith("END OF SYNTHETIC PRICING BODY"));
  assert.ok(first[0]!.bodyText!.includes("Section 189:"));
  assert.ok(first[1]!.bodyText!.includes("Section 129:"));
  assert.equal(first[1]!.publishedAt?.toISOString(), "2026-01-15T00:00:00.000Z");
  hash = "new-deploy-hash";
  assert.deepEqual(await fetchJsonList(source(c)), first, "published identity and writing survive an asset rename");
});

test("Augment-shaped imports resolve relative to their module despite document-relative dependency metadata", async () => {
  const c = { url: `${base}/insights`, mode: "html_script_array", scriptSelector: 'script[type="module"][src]',
    assetNameIncludes: "insights-", arrayMatchKeys: ["slug", "title", "dateLabel", "blocks"],
    arrayProjectionKeys: ["slug", "title", "dateLabel", "blocks"], titlePaths: ["title"], publishedAtPath: "dateLabel",
    summaryBlocksPath: "blocks", summaryIsBody: true, preserveUrlFragment: true, urlTemplate: `${base}/insights#newsletter-{slug}` };
  assertSupportedConfig("json_list", c);
  const rows = await fetchJsonList(source(c));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.title, "Synthetic newsletter September 2026");
  assert.equal(rows[0]!.url, `${base}/insights#newsletter-synthetic-september-2026`);
  assert.ok(rows.every(row => row.publishedAt === null && row.bodyText!.length > 12_000));
  const original = await javascriptArray(augment, c.arrayMatchKeys) as any[];
  assert.deepEqual(rows.map(row => row.bodyText), original.map(item => item.blocks.map((b: any) => b.text).join("\n\n")));
  assert.ok(rows[0]!.bodyText!.includes("Section 89:"));
  assert.ok(rows[1]!.bodyText!.includes("Section 74:"));
  assert.ok(fetchedPaths.includes(`/assets/insights-${hash}.js`));
  assert.ok(!fetchedPaths.some(path => path.startsWith("/assets/assets/")), "dependency-table path must never be guessed relative to the script");
  assert.deepEqual(await fetchJsonList(source({ ...c, url: `${base}/root-insights` })), rows, "explicit root-relative literal needs no guessed base");
});

test("unsafe syntax cannot become complete article data, including mutations through ignored fields", async () => {
  const badObjects = [
    `{id:"one",title:"Title",content:run()}`, `{id:"one",title:"Title",content:secret}`,
    '{id:"one",title:"Title",content:`prefix ${secret}`}',
    `{id:"one",title:"Title",content:"Body",[dynamic]:"value"}`,
    `{id:"one",title:"Title",content:"Body",...rest}`,
    `{id:"one",title:"Title",content:"Body",__proto__:{}}`,
    `{id:"one",title:"Title",content:"Body",constructor:"x"}`,
    `{id:"one",title:"Title",content:"Body",content:"Overwrite"}`,
    `{id:"one",title:"Title",content:"Body",get ignored(){return "x"}}`,
  ];
  for (const object of badObjects) await assert.rejects(javascriptArray(`const posts=[${object}];`, matchKeys, matchKeys), /non-static|interpolation|unsafe|duplicate/);
  await assert.rejects(javascriptArray(`const posts=[{id:"one",title:"Title",content:"Body"},null];`, matchKeys), /depth|non-article/);
  await assert.rejects(javascriptArray(`const posts=[{id:"one",title:"Title",content:"Body"},...others];`, matchKeys), /non-static/);
  await assert.rejects(javascriptArray(`globalThis.publisherExecuted=true;const posts=[{id:"one",title:"Title",content:(()=>"Body")()}];`, matchKeys), /non-static/);
  assert.equal((globalThis as any).publisherExecuted, undefined);
});

test("unique collection and bounded parse are mandatory", async () => {
  const one = `{id:"one",title:"Title",content:"Body"}`;
  await assert.rejects(javascriptArray(`const a=[${one}],b=[${one}];`, matchKeys), /ambiguous/);
  await assert.rejects(javascriptArray(`const a={first:${one}},b={second:${one}};`, matchKeys, undefined, undefined, "object"), /ambiguous/);
  await assert.rejects(javascriptArray(`const a={first:${one},first:${one}};`, matchKeys, undefined, undefined, "object"), /duplicate dictionary/);
  await assert.rejects(javascriptArray(`const a=[];`, matchKeys), /missing/);
  await assert.rejects(javascriptArray(" ".repeat(JAVASCRIPT_MAX_BYTES + 1), matchKeys), /byte limit/);
  await assert.rejects(javascriptArray(`const a=[{id:"x",title:"Title",content:${"[".repeat(40)}"x"${"]".repeat(40)}}];`, matchKeys), /depth limit/);
  await assert.rejects(javascriptArray(`const a=[${Array(2_001).fill(one).join(",")}];`, matchKeys), /item limit/);
  await assert.rejects(javascriptArray(`const deep=${Array(300).fill("0").join("+")};const a=[${one}];`, matchKeys), /syntax limit/);
  await assert.rejects(javascriptArray(`const a=[${one}];`, matchKeys, undefined, 1), /timeout/);
  await assert.rejects(javascriptArray(`const a=[${one}];`, ["id"]), /arrayMatchKeys/);
  await assert.rejects(javascriptArray(`const a=[${one}];`, matchKeys, ["id", "title"]), /include/);
});

test("HTML discovery and block rendering refuse ambiguity or incomplete writing", async () => {
  assert.throws(() => scriptAsset('<script src="/one.js"></script><script src="/two.js"></script>', base, "script[src]"), /exactly one/);
  assert.throws(() => scriptAsset('<script src="https://elsewhere.example/one.js"></script>', base, "script[src]"), /same-origin/);
  assert.throws(() => scriptAsset('<a src="/one.js"></a>', base, "a[src]"), /script/);
  assert.throws(() => textBlocks([{ type: "paragraph", text: "valid" }, { type: "image", text: "missing" }]), /unsupported/);
  assert.throws(() => textBlocks([{ type: "paragraph", text: "valid", hiddenBody: "lost" }]), /unsupported/);
  assert.equal(textBlocks([{ type: "quote", text: "<literal text>" }]), "<literal text>");
  await assert.rejects(fetchJsonList(source({ url: `${base}/unknown-block.js`, mode: "javascript_array", arrayMatchKeys: matchKeys,
    titlePaths: ["title"], summaryBlocksPath: "content", summaryIsBody: true, urlTemplate: `${base}/{id}` })), /unsupported summary block/);
  await assert.rejects(fetchJsonList(source({ url: `${base}/ambiguous-insights`, mode: "html_script_array", scriptSelector: 'script[type="module"][src]',
    assetNameIncludes: "insights-", arrayMatchKeys: matchKeys })), /asset is missing or ambiguous/);
  await assert.rejects(fetchJsonList(source({ url: `${base}/metadata-insights`, mode: "html_script_array", scriptSelector: 'script[type="module"][src]',
    assetNameIncludes: "insights-", arrayMatchKeys: matchKeys })), /asset is missing or ambiguous/);
  await assert.rejects(fetchJsonList(source({ url: `${base}/big.js`, mode: "javascript_array", arrayMatchKeys: matchKeys })), /Response too large/);
  assert.throws(() => assertSupportedConfig("json_list", { mode: "html_script_array", arrayMatchKeys: matchKeys }), /scriptSelector/);
  assert.throws(() => assertSupportedConfig("json_list", { mode: "json", arrayMatchKeys: matchKeys }), /requires static/);
  assert.throws(() => assertSupportedConfig("json_list", { mode: "javascript_array", arrayMatchKeys: ["id", "title"],
    arrayProjectionKeys: ["id", "title"], summaryPaths: ["content"] }), /all mapped fields/);
});

test("ordinary JSON mapping remains unchanged", async () => {
  const rows = await fetchJsonList(source({ url: `${base}/plain.json`, titlePaths: ["title"], summaryPaths: ["content"], summaryIsBody: true,
    publishedAtPath: "date", urlTemplate: `${base}/{id}` }));
  assert.equal(rows[0]!.publishedAt?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(rows[0]!.bodyText, "Complete JSON body");
});

test("plain-text blocks preserve literal angle brackets in both body and excerpt; HTML summaries keep HTML rules", async () => {
  const rows = await fetchJsonList(source({ url: `${base}/plain-blocks.js`, mode: "javascript_array", arrayMatchKeys: matchKeys,
    titlePaths: ["title"], summaryBlocksPath: "content", summaryIsBody: true, urlTemplate: `${base}/{id}` }));
  const expected = "Literal <rule> and <token> plus <script>globalThis.blockExecuted=true</script> remain plain text.";
  assert.equal(rows[0]!.bodyText, expected);
  assert.equal(rows[0]!.excerpt, expected);
  assert.equal((globalThis as any).blockExecuted, undefined);
  const html = await fetchJsonList(source({ url: `${base}/html-summary.json`, titlePaths: ["title"], summaryPaths: ["content"],
    summaryIsBody: true, urlTemplate: `${base}/{id}` }));
  assert.equal(html[0]!.bodyText, "HTML & text");
  assert.equal(html[0]!.excerpt, "HTML & text");
});

test("asset redirects cannot forward source headers to another origin", async () => {
  await assert.rejects(fetchJsonList(source({ url: `${base}/redirect-insights`, mode: "html_script_array",
    scriptSelector: 'script[type="module"][src]', arrayMatchKeys: matchKeys,
    headers: { "x-private-fixture": "must-not-leak" } })), /Too many redirects/);
  assert.equal(offOriginRequests, 0, "off-origin target is never contacted");
});
