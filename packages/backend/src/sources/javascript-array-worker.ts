// Parse publisher syntax as data. Publisher code is never imported or executed.
import { parentPort, workerData } from "node:worker_threads";
import { parse } from "@babel/parser";

const MAX_NODES = 500_000;
const MAX_DEPTH = 256;
const MAX_VALUE_DEPTH = 32;
const MAX_ITEMS = 2_000;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const allowJoinedMarkdown = workerData.allowJoinedMarkdown === true;
type Node = Record<string, any>;

function key(property: Node): string {
  if (property.type !== "ObjectProperty" || property.computed || property.method || property.shorthand) throw new Error("non-static property");
  const k = property.key.type === "Identifier" ? property.key.name : property.key.type === "StringLiteral" ? property.key.value : null;
  if (typeof k !== "string" || forbidden.has(k)) throw new Error("unsafe property key");
  return k;
}

function value(node: Node | null, depth = 0, projection?: Set<string>): unknown {
  if (!node || depth > MAX_VALUE_DEPTH) throw new Error("static value depth limit");
  switch (node.type) {
    case "StringLiteral": case "BooleanLiteral": return node.value;
    case "NumericLiteral":
      if (!Number.isFinite(node.value)) throw new Error("non-finite number");
      return node.value;
    case "NullLiteral": return null;
    case "TemplateLiteral":
      if (node.expressions.length || node.quasis.length !== 1 || node.quasis[0].value.cooked === null) throw new Error("template interpolation refused");
      return node.quasis[0].value.cooked;
    case "UnaryExpression":
      if (node.operator !== "-" || node.argument.type !== "NumericLiteral" || !Number.isFinite(node.argument.value)) throw new Error("non-static unary expression");
      return -node.argument.value;
    case "ArrayExpression":
      if (node.elements.length > MAX_ITEMS) throw new Error("static array item limit");
      return node.elements.map((n: Node) => value(n, depth + 1));
    case "ObjectExpression": {
      const result: Record<string, unknown> = Object.create(null);
      const seen = new Set<string>();
      for (const p of node.properties) {
        const k = key(p); // Even ignored properties cannot spread or change the object's keys.
        if (seen.has(k)) throw new Error("duplicate property refused");
        seen.add(k);
        if (!projection || projection.has(k)) result[k] = value(p.value, depth + 1);
      }
      if (projection && [...projection].some(k => !seen.has(k))) throw new Error("projected property missing");
      return result;
    }
    case "CallExpression": {
      // One explicitly enabled publisher representation; this interprets data, never a call.
      const callee = node.callee;
      if (!allowJoinedMarkdown || node.optional || callee?.type !== "MemberExpression" || callee.computed || callee.object?.type !== "ArrayExpression" || callee.property?.type !== "Identifier" || callee.property.name !== "join" || node.arguments.length !== 1 || !["StringLiteral", "TemplateLiteral"].includes(node.arguments[0]?.type)) throw new Error("non-static call expression");
      const separator = value(node.arguments[0], depth + 1);
      if (separator !== "\n\n") throw new Error("unsupported Markdown paragraph separator");
      const paragraphs = value(callee.object, depth + 1);
      if (!Array.isArray(paragraphs) || paragraphs.some(p => typeof p !== "string")) throw new Error("non-string Markdown paragraphs");
      return paragraphs.join(separator);
    }
    default: throw new Error(`non-static value ${node.type}`);
  }
}

try {
  const { source, matchKeys, projectionKeys, assetNameIncludes, collectionKind, documentVariable } = workerData as {
    source: string; matchKeys?: string[]; projectionKeys?: string[]; assetNameIncludes?: string; collectionKind?: string; documentVariable?: string;
  };
  const ast = parse(source, { sourceType: "unambiguous", attachComment: false });
  const pending: Array<{ node: Node; depth: number }> = [{ node: ast, depth: 0 }];
  const arrays: Node[] = [];
  const assets = new Set<string>();
  const imports = new Set<string>();
  const documents = new Set<string>();
  let fetchesDocument = false;
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > MAX_NODES || depth > MAX_DEPTH) throw new Error("JavaScript syntax limit");
    const literal = (n: Node | undefined): string | null => n?.type === "StringLiteral" ? n.value :
      n?.type === "TemplateLiteral" && n.expressions.length === 0 && n.quasis.length === 1 ? n.quasis[0].value.cooked : null;
    const asset = (s: string | null) => typeof s === "string" && s.includes(assetNameIncludes!) && /^(?:\.?\.?\/|https?:\/\/)?[\w./:@-]+\.js(?:\?[^\s]*)?$/.test(s);
    if (documentVariable) {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.name === documentVariable) {
        const declared = literal(node.init);
        if (declared === null) throw new Error("JSON document URL is not a static literal");
        documents.add(declared);
      }
      if (node.type === "AssignmentExpression" && node.left.type === "Identifier" && node.left.name === documentVariable) throw new Error("JSON document variable is reassigned");
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "fetch" && node.arguments[0]?.type === "Identifier" && node.arguments[0].name === documentVariable) fetchesDocument = true;
    }
    if (assetNameIncludes) {
      const s = literal(node);
      if (asset(s)) assets.add(s!);
      const imported = literal(node.type === "ImportDeclaration" || node.type === "ImportExpression" ? node.source :
        node.type === "CallExpression" && node.callee.type === "Import" ? node.arguments[0] : undefined);
      if (asset(imported)) imports.add(imported!);
    }
    const matches = (n: Node | null) => n?.type === "ObjectExpression" && matchKeys!.every(k => n.properties.some((p: Node) =>
      p.type === "ObjectProperty" && !p.computed && (p.key.name ?? p.key.value) === k));
    if (matchKeys && (collectionKind === "object"
      ? node.type === "ObjectExpression" && node.properties.some((p: Node) => matches(p.value))
      : node.type === "ArrayExpression" && node.elements.some(matches))) arrays.push(node);
    for (const [k, child] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens", "errors"].includes(k)) continue;
      if (Array.isArray(child)) {
        for (const n of child) if (n && typeof n === "object" && typeof n.type === "string") pending.push({ node: n, depth: depth + 1 });
      } else if (child && typeof child === "object" && typeof child.type === "string") pending.push({ node: child, depth: depth + 1 });
    }
  }
  if (documentVariable) {
    if (!fetchesDocument || documents.size !== 1) throw new Error("declared JSON document is missing or ambiguous");
    parentPort!.postMessage({ documentUrl: [...documents][0] });
  } else if (assetNameIncludes) {
    // Bare dependency-table strings do not declare their URL base. Imports are module-relative;
    // without an import, only an absolute URL or root-relative literal is unambiguous.
    const declared = imports.size ? imports : new Set([...assets].filter(s => s.startsWith("/") || /^https?:\/\//.test(s)));
    if (declared.size !== 1) throw new Error("declared JavaScript asset is missing or ambiguous");
    parentPort!.postMessage({ asset: [...declared][0], assetBase: imports.size ? "module" : "absolute" });
  } else {
    if (arrays.length !== 1) throw new Error("static article array is missing or ambiguous");
    const array = arrays[0]!;
    if ((collectionKind === "object" ? array.properties : array.elements).length > MAX_ITEMS) throw new Error("static array item limit");
    const projection = projectionKeys ? new Set(projectionKeys) : undefined;
    const dictionary: Record<string, unknown> = Object.create(null);
    if (collectionKind === "object") {
      for (const p of array.properties) {
        const k = key(p);
        if (Object.hasOwn(dictionary, k)) throw new Error("duplicate dictionary key");
        dictionary[k] = value(p.value, 0, projection);
      }
    }
    const items = collectionKind === "object" ? Object.values(dictionary) : array.elements.map((n: Node) => value(n, 0, projection));
    if (items.some((item: any) => !item || typeof item !== "object" || matchKeys!.some(k => !Object.hasOwn(item, k)))) throw new Error("static array contains non-article items");
    parentPort!.postMessage({ items: collectionKind === "object" ? dictionary : items });
  }
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : "JavaScript parsing failed" });
}
