// Checks the selection against your own labelled samples (a "gold set"): each case runs the site's
// selection steps (editorial/analyze.ts) — the prefilter, then the score prompt twice with every model in
// --models, the two scores deciding against the source tier's threshold — and is compared with your
// decision. A threshold sweep shows what another threshold would have done. The format of the gold file
// is in docs/selection.md (industry/gold.example.jsonl has two made-up cases).
// Usage: node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl [--models default,deepseek-flash] [--n 200] [--label "..."]
// Receipts make re-runs free; "either" cases are excluded from decisive metrics. Each run is also
// imported into SelectBench (admin → SelectBench) with every case, unless --no-import is given.
import { readFileSync, writeFileSync, mkdirSync,accessSync,constants } from "node:fs";
import {randomUUID} from 'node:crypto';
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT,config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { ANALYZE_PROMPT_VERSION, normalizeAnalysis, runAnalysis, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";
import { importSelectBenchRun } from "@aihot/backend/admin/selectbench";
import {parseGoldJsonl,selectionMetrics,type GoldRow} from '@aihot/backend/editorial/evaluation';
import {MODELS} from '@aihot/backend/providers/llm';

const { values } = parseArgs({
  options: {
    gold: { type: "string", default: ".data/gold.jsonl" },
    models: { type: "string", default: "default" },
    n: { type: "string", default: "200" },
    split: { type: "string", default: "all" },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    label: { type: "string" },
    "no-import": { type: "boolean", default: false },
  },
});

const rows=parseGoldJsonl(readFileSync(path.resolve(REPO_ROOT,values.gold!),'utf8'));
const n=Number(values.n),concurrency=Number(values.concurrency),seed=Number(values.seed),models=values.models!.split(',').map(m=>m.trim());
if(!Number.isInteger(n) || n<1 || n>10000)throw new Error('--n 需要 1–10000 的整数');
if(!Number.isInteger(concurrency) || concurrency<1 || concurrency>32)throw new Error('--concurrency 需要 1–32 的整数');
if(!Number.isInteger(seed) || seed<-2147483648 || seed>2147483647)throw new Error('--seed 超出整数范围');
if(!models.length || models.length>32 || new Set(models).size!==models.length || models.some(m=>!Object.hasOwn(MODELS,m)))throw new Error('--models 需要不重复的已配置模型名称');
if(values.label!==undefined && (!values.label.trim() || values.label.length>300))throw new Error('--label 需要 1–300 字符');

// Deterministic sampling from the selected split; strata are retained for reviewing results.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const rand = rng(seed);
const pool = values.split === "all" ? rows : rows.filter((r) => r.samplingContext?.benchmarkSplit === values.split);
const shuffled = pool.map((r) => ({ r, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.r);
const sample = shuffled.slice(0,n);
if(!sample.length)throw new Error('所选 split 没有样本');
const label=values.label ?? `${values.split} ${sample.length} 条 · ${models.join(' / ')}`.slice(0,300);
const outDir=path.join(config.dataDir,'eval');
mkdirSync(outDir,{recursive:true,mode:0o700});accessSync(outDir,constants.W_OK);
const splitName=values.split!.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80);
const file=path.join(outDir,`selection-${splitName}-${sample.length}-${Date.now()}-${randomUUID()}.json`);

function toInput(r: GoldRow): AnalyzeInputArticle {
  const m = r.material;
  const isX = r.sourceFacts.sourceKind === "x_search";
  const body = m.bodyOriginal || m.bodyZh || null;
  return {
    id: `gold-${r.caseId}`,
    revision: 1,
    bodyStatus: "ok",
    title: m.originalTitle || m.title,
    url: "https://example.invalid/" + r.caseId,
    author: null,
    publishedAt: m.publishedAt ? new Date(m.publishedAt) : null,
    bodyText: isX ? null : body,
    excerpt: null,
    xPost: isX ? { authorName: m.sourceName, handle: "", text: body ?? m.title } : null,
    media: [],
    source: { name: m.sourceName, kind: r.sourceFacts.sourceKind, tier: r.sourceFacts.sourceTier ?? "T2", firstParty: r.sourceFacts.firstParty ?? false },
  };
}

async function pmap<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }));
  return out;
}

const report: Record<string, unknown> = {};
for (const model of models) {
  const started = Date.now();
  const results = await pmap(sample,concurrency,async (r) => {
    try {
      const res = await runAnalysis(toInput(r), { scoreModel: model, stages: "selection" });
      const out = normalizeAnalysis(res);
      return { r, out, receiptIds: [res.prefilter.receiptId, ...(res.scores?.receiptIds ?? [])], error: null as string | null };
    } catch (error) {
      return { r, out: null, receiptIds: [] as number[], error: String(error).slice(0, 200) };
    }
  });
  const statistics=selectionMetrics(results.map(x=>({gold:x.r.gold.decision,decision:x.out ? x.out.selected ? 'select':'reject' : null})));
  const mistakes: Array<Record<string, unknown>> = [];
  for (const x of results) {
    if (!x.out) continue;
    const pred = x.out.selected ? "select" : "reject";
    const gold = x.r.gold.decision;
    if (pred === "select" && gold === "reject") mistakes.push({ kind: "FP", title: x.r.material.title, score: x.out.score, reason: x.out.reasonZh, stratum: x.r.samplingContext?.samplingStratum ?? null });
    else if (pred === "reject" && gold === "select") mistakes.push({ kind: "FN", title: x.r.material.title, score: x.out.score, relevance: x.out.relevance, stratum: x.r.samplingContext?.samplingStratum ?? null });
  }
  const receiptIds = results.flatMap((x) => x.receiptIds);
  const [usage] = receiptIds.length
    ? await sql<{ tin: number; tout: number; latency: number }[]>`
        SELECT sum((usage->>'prompt_tokens')::int) AS tin, sum((usage->>'completion_tokens')::int) AS tout,
               avg((response->>'_latencyMs')::int) AS latency
        FROM receipts WHERE id IN ${sql(receiptIds)}`
    : [{ tin: 0, tout: 0, latency: 0 }];
  const summary = {
    model,...statistics,
    tokensIn: Number(usage?.tin ?? 0), tokensOut: Number(usage?.tout ?? 0), avgLatencyMs: Math.round(Number(usage?.latency ?? 0)),
    wallSeconds: Math.round((Date.now() - started) / 1000),
  };
  console.log(JSON.stringify(summary));
  // Threshold sweep on the raw attention score (selection rule = relevance pass && score >= t).
  const sweep: Array<Record<string, number>> = [];
  for (let t = 40; t <= 90; t += 2) {
    const s=selectionMetrics(results.map(x=>({gold:x.r.gold.decision,decision:!x.out ? null : x.out.relevance==='pass' && x.out.score!==null && x.out.score>=t ? 'select':'reject'})));
    sweep.push({t,acc:s.accuracy,P:s.precision,R:s.recall,F1:s.f1,sel:s.selectedRate});
  }
  console.log(sweep.map((s) => `  t=${s.t} acc=${s.acc} P=${s.P} R=${s.R} F1=${s.F1} sel=${s.sel}`).join("\n"));
  const cases = results.map((x) => ({
    caseId: x.r.caseId,
    title: x.r.material.title,
    stratum: x.r.samplingContext?.samplingStratum ?? null,
    gold: x.r.gold.decision,
    decision: x.out ? (x.out.selected ? "select" : "reject") : null,
    score: x.out?.score ?? null,
    relevance: x.out?.relevance ?? null,
    category: x.out?.category ?? null,
    reason: x.out?.reasonZh ?? null,
    receiptId: x.receiptIds[0] ?? null,
    error: x.error,
  }));
  report[model] = { summary, sweep, mistakes, cases };
}
const meta = { split: values.split, n: sample.length, seed, promptVersion: ANALYZE_PROMPT_VERSION, createdAt: new Date().toISOString() };
writeFileSync(file,JSON.stringify({meta,models:report},null,2),{flag:'wx',mode:0o600});
console.log(`report: ${file}`);
if (!values["no-import"]) {
  const run = await importSelectBenchRun({ meta, models: report },label,"script:eval-selection");
  console.log(`SelectBench run: ${run.id}`);
}
await closeDb();
