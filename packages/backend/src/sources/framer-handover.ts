import { load } from "cheerio";
import { FetchError } from "./types.ts";

/** Decode the public devalue reference graph; no publisher scripts or custom classes run. */
export function framerHandover(html: string, rule: { selector: string; matchKeys: string[] }): unknown[] {
  const $ = load(html), scripts = $(rule.selector);
  if (scripts.length !== 1 || !scripts.is('script[type="framer/handover"]')) throw new FetchError("Framer handover must be one declared data script");
  let nodes: unknown;
  try { nodes = JSON.parse(scripts.text()); } catch { throw new FetchError("Framer handover is not JSON"); }
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 50_000) throw new FetchError("Framer reference graph size limit");
  const graph = nodes, cache = new Map<number, unknown>(), visiting = new Set<number>();
  const arrays: unknown[][] = [];
  let count = 0;
  const read = (reference: unknown, depth = 0): unknown => {
    if (!Number.isInteger(reference) || Number(reference) < 0 || Number(reference) >= graph.length || depth > 32 || ++count > 100_000) throw new FetchError("Framer invalid reference or expansion limit");
    const index = Number(reference);
    if (visiting.has(index)) throw new FetchError("Framer cyclic references refused");
    if (cache.has(index)) return cache.get(index);
    visiting.add(index);
    const value = graph[index];
    let result: unknown;
    if (Array.isArray(value)) {
      if (typeof value[0] === "string") {
        if (value[0] !== "Map" || value.length % 2 !== 1) throw new FetchError("Framer unsupported tagged value");
        const pairs = [];
        for (let i = 1; i < value.length; i += 2) pairs.push([read(value[i], depth + 1), read(value[i + 1], depth + 1)]);
        result = pairs;
      } else {
        result = value.map(ref => read(ref, depth + 1));
        arrays.push(result as unknown[]);
      }
    } else if (value && typeof value === "object") {
      const object: Record<string, unknown> = Object.create(null);
      for (const [key, ref] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new FetchError("Framer unsafe property");
        object[key] = read(ref, depth + 1);
      }
      result = object;
    } else if (value === null || ["string", "number", "boolean"].includes(typeof value)) result = value;
    else throw new FetchError("Framer unsupported graph value");
    visiting.delete(index); cache.set(index, result); return result;
  };
  read(0);
  const matching = arrays.filter(items => items.length > 0 && items.length <= 2_000 && items.every(item => item && typeof item === "object" && !Array.isArray(item) && rule.matchKeys.every(key => Object.hasOwn(item, key))));
  if (matching.length !== 1) throw new FetchError("Framer article collection is missing or ambiguous");
  return matching[0]!;
}
