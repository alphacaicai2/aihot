import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { config } from "@aihot/backend/config";
import { framerHandover } from "@aihot/backend/sources/framer-handover";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

function serialize(value: unknown): unknown[] {
  const nodes: unknown[] = [];
  const ref = (v: unknown): number => {
    const index = nodes.length; nodes.push(null);
    nodes[index] = v instanceof Map ? ["Map", ...[...v].flatMap(([k, value]) => [ref(k), ref(value)])] :
      Array.isArray(v) ? v.map(ref) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, ref(value)])) : v;
    return index;
  };
  ref(value); return nodes;
}
const html = (nodes: unknown[]) => `<script type="framer/handover" id="publisher-data">${JSON.stringify(nodes)}</script>`;
const string = (value: string) => ({ type: "string", value });
const article = (title: string, slug: string) => ({ title: string(title), slug: string(slug), categories: [] });
const rule = { selector: "#publisher-data", matchKeys: ["title", "slug", "categories"] };

test("the declared complete Framer collection is recovered instead of its featured subset", () => {
  const full = [article("Full original A", "real-a"), article("Full original B", "real-b")];
  const graph = serialize({ "0": new Map<string, unknown>([["featured-query", [{ title: string("Full original A"), slug: string("real-a") }]], ["all-query", full]]), "1": new Map() });
  const result = framerHandover(html(graph), rule) as any[];
  assert.equal(result.length, 2);
  assert.equal(result[1].title.value, "Full original B");
  assert.equal(result[1].slug.value, "real-b");
  assert.throws(() => framerHandover(html(graph), { ...rule, matchKeys: ["title", "slug"] }), /ambiguous/);
});

test("native collection maps typed title and slug values while an absent publication day remains null", async () => {
  const graph = serialize({ "0": new Map([["articles", [article("Actual original title", "published-original")]]]) });
  const server = createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end(html(graph)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  config.allowPrivateNetworkFetch = true;
  try {
    const source = { kind: "json_list", config: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, mode: "framer_handover", framerHandover: rule,
      titlePaths: ["title.value"], urlTemplate: "https://example.org/articles/{slug.value}" } } as any;
    assertSupportedConfig("json_list", source.config);
    const [record] = await fetchJsonList(source);
    assert.equal(record?.title, "Actual original title");
    assert.equal(record?.url, "https://example.org/articles/published-original");
    assert.equal(record?.publishedAt, null);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("ambiguous collections, cycles, unknown types and unsafe graph properties fail as a whole", () => {
  const duplicate = serialize(new Map([["first", [article("A", "a")]], ["second", [article("B", "b")]]]));
  assert.throws(() => framerHandover(html(duplicate), rule), /ambiguous/);
  assert.throws(() => framerHandover(html([[0]]), rule), /cyclic/);
  assert.throws(() => framerHandover(html([["CustomExecutableClass", 1], "value"]), rule), /unsupported tagged/);
  assert.throws(() => framerHandover(html([JSON.parse('{"__proto__":1}'), "value"]), rule), /unsafe property/);
  assert.throws(() => framerHandover(html([[5]]), rule), /invalid reference/);
  assert.throws(() => framerHandover(html(["No article arrays"]), rule), /missing/);
  assert.throws(() => framerHandover(html(new Array(50_001).fill(null)), rule), /size limit/);
});

test("only explicitly selected data scripts are decoded and source configuration is validated", () => {
  assert.throws(() => framerHandover(`<script id="publisher-data">globalThis.mustNeverRun=true</script>`, rule), /declared data script/);
  assert.equal((globalThis as any).mustNeverRun, undefined);
  const config = { mode: "framer_handover", framerHandover: rule };
  assertSupportedConfig("json_list", config);
  assert.throws(() => assertSupportedConfig("json_list", { ...config, itemsPath: "firstArray" }), /declared keys/);
  assert.throws(() => assertSupportedConfig("json_list", { ...config, framerHandover: { ...rule, matchKeys: ["title", "__proto__"] } }), /collection keys/);
  assert.throws(() => assertSupportedConfig("json_list", { framerHandover: rule }), /requires framer_handover/);
});
