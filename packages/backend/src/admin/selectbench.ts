// SelectBench: selection-model comparison runs on the human gold set. Runs come from
// scripts/eval-selection.ts (imported automatically) or an uploaded report; the admin compares
// models on the same cases and browses each case.
import { randomUUID } from "node:crypto";
import {z} from 'zod';
import { sql } from "../db.ts";
import {sha256,stableJson} from '../lib/ids.ts';
import { audit } from "./auth.ts";
import {previousAdminCommand} from './commands.ts';
import {selectionMetrics as metrics} from '../editorial/evaluation.ts';

interface CaseIn {
  caseId: string;
  title: string;
  stratum?: string | null;
  gold: 'select'|'reject'|'either';
  decision: 'select'|'reject'|null;
  score?: number | null;
  relevance?: string | null;
  category?: string | null;
  reason?: string | null;
  receiptId?: number | null;
  error?: string | null;
}

const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),rate=z.number().min(0).max(1);
const Summary=z.object({n:integer.max(1000000).optional(),tp:integer.optional(),fp:integer.optional(),fn:integer.optional(),tn:integer.optional(),decisive:integer.optional(),either:integer.optional(),errors:integer.optional(),accuracy:rate.optional(),precision:rate.optional(),recall:rate.optional(),f1:rate.optional(),selectedRate:rate.optional(),goldSelectRate:rate.optional(),tokensIn:integer.optional(),tokensOut:integer.optional(),avgLatencyMs:z.number().nonnegative().optional(),wallSeconds:z.number().nonnegative().optional()}).passthrough();
const Case=z.object({caseId:z.string().trim().min(1).max(200),title:z.string().min(1).max(4000),stratum:z.string().max(200).nullable().optional(),gold:z.enum(['select','reject','either']),decision:z.enum(['select','reject']).nullable(),score:z.number().min(0).max(100).nullable().optional(),relevance:z.string().max(64).nullable().optional(),category:z.string().max(200).nullable().optional(),reason:z.string().max(10000).nullable().optional(),receiptId:integer.positive().nullable().optional(),error:z.string().max(2000).nullable().optional()});
const Sweep=z.object({t:z.number().min(0).max(100),acc:rate,P:rate,R:rate,F1:rate,sel:rate});
const Model=z.object({summary:Summary,sweep:z.array(Sweep).max(101).optional(),cases:z.array(Case).max(10000).optional()}).passthrough();
const Models=z.record(z.string().min(1).max(200).refine(s=>s===s.trim() && !['__proto__','constructor','prototype','meta'].includes(s)),Model);
const Meta=z.object({n:integer.max(1000000).optional(),split:z.string().max(200).optional(),seed:z.number().int().min(-2147483648).max(2147483647).optional(),promptVersion:z.union([z.string().max(2000),integer.transform(String)]).optional()}).passthrough();
const invalid=(message:string):never=>{throw Object.assign(new Error(message),{statusCode:400});};
function parse<T>(schema:z.ZodType<T>,input:unknown):T {
  const r=schema.safeParse(input);if(r.success)return r.data;throw Object.assign(new Error('报告格式不正确，请检查模型汇总、样本字段与数值范围'),{statusCode:400});
}
function checkMetrics(reported:Record<string,unknown>,expected:Record<string,number>,model:string) {
  for(const [key,value] of Object.entries(expected)){
    const tolerance=['n','tp','fp','fn','tn','decisive','either','errors'].includes(key) ? 0 : .0005+1e-9;
    const given=reported[key];if(given!==undefined && (typeof given!=='number' || Math.abs(given-value)>tolerance))invalid(`${model} 的 ${key} 与逐条样本不一致`);
  }
}

/** Accepts { meta, models } or the older report shape keyed by model name. */
export async function importSelectBenchRun(report: unknown, label: string, actor: string,options:{requestId?:string}={}) {
  label=parse(z.string().trim().min(1).max(300),label);
  const root=parse(z.record(z.string(),z.unknown()),report),meta=parse(Meta,root.meta ?? {});
  const models=parse(Models,root.models ?? Object.fromEntries(Object.entries(root).filter(([k])=>k!=='meta'))),names=Object.keys(models);
  if(!names.length || names.length>32)invalid('报告需要 1–32 个模型汇总');
  const verified=names.every(m=>models[m]!.cases!==undefined);
  if(!verified && names.some(m=>models[m]!.cases!==undefined))invalid('模型必须同时提供同一批逐条样本，或都只提供旧版汇总');
  const reference=models[names[0]!]!.cases, sampleSize=meta.n ?? reference?.length ?? models[names[0]!]!.summary.n ?? 0;
  const gold=new Map(reference?.map(c=>[c.caseId,stableJson({title:c.title,stratum:c.stratum ?? null,gold:c.gold})]));
  if(names.reduce((n,m)=>n+(models[m]!.cases?.length ?? 0),0)>100000)invalid('报告逐条结果超过 100000 条');
  for(const m of names){
    const model=models[m]!,cases=model.cases;
    if(model.summary.n!==undefined && model.summary.n!==sampleSize)invalid(`${m} 的样本数量与报告不一致`);
    if(cases){
      const ids=new Set<string>();
      if(cases.length!==sampleSize)invalid(`${m} 的样本数量与报告不一致`);
      for(const c of cases){
        if(ids.has(c.caseId))invalid(`${m} 有重复的样本编号`);ids.add(c.caseId);
        if(gold.get(c.caseId)!==stableJson({title:c.title,stratum:c.stratum ?? null,gold:c.gold}))invalid(`${m} 的样本、标题、分层或金标与其他模型不一致`);
        if(c.decision!==null && c.error)invalid(`${m} 的成功决定不能同时标为失败`);
      }
      const expected=metrics(cases);checkMetrics(model.summary,expected,m);model.summary={...model.summary,...expected};
      for(const sweep of model.sweep ?? []){
        const simulated=cases.map(c=>({...c,decision:c.decision===null ? null : c.relevance==='pass' && c.score!==null && c.score!==undefined && c.score>=sweep.t ? 'select' as const : 'reject' as const}));
        const s=metrics(simulated);checkMetrics(sweep,{acc:s.accuracy,P:s.precision,R:s.recall,F1:s.f1,sel:s.selectedRate},m);
      }
    }
  }
  const requestId=parse(z.string().regex(/^[\w-]{8,80}$/),options.requestId ?? randomUUID()),fingerprint=sha256(stableJson({label,meta,models}));
  const summary=Object.fromEntries(names.map(m=>[m,{...models[m]!.summary,sweep:models[m]!.sweep ?? []}]));
  return sql.begin(async (tx) => {
    const previous=await previousAdminCommand<{id:string}>(tx,actor,'selectbench.import',null,requestId,fingerprint);if(previous)return previous;
    const id=`sb-${randomUUID()}`;
    await tx`
      INSERT INTO selectbench_runs (id, label, split, sample_size, seed, prompt_version, models, summary, imported_by)
      VALUES (${id}, ${label}, ${(meta.split as string) ?? null}, ${sampleSize}, ${(meta.seed as number) ?? null}, ${(meta.promptVersion as string) ?? null}, ${names}, ${tx.json(summary as never)}, ${actor})`;
    for (const m of names) {
      const cases = models[m]!.cases ?? [];
      for (let i = 0; i < cases.length; i += 500) {
        const rows = cases.slice(i, i + 500).map((c) => ({
          run_id: id,
          model: m,
          case_id: c.caseId,
          title: c.title,
          stratum: c.stratum ?? null,
          gold: c.gold,
          decision: c.decision,
          score: c.score ?? null,
          relevance: c.relevance ?? null,
          category: c.category ?? null,
          reason: c.reason ?? null,
          receipt_id: c.receiptId ?? null,
          error: c.error ?? null,
        }));
        await tx`INSERT INTO selectbench_results ${tx(rows)}`;
      }
    }
    const result={id};await audit(actor,'selectbench.import',`selectbench:${id}`,null,null,{label,models:names,sampleSize,casesVerified:verified,command:{fingerprint,result}},requestId,tx);
    return result;
  });
}

export async function listSelectBenchRuns() {
  return sql`
    SELECT r.id, r.label, r.split, r.sample_size, r.prompt_version, r.models,
           EXISTS(SELECT 1 FROM audit_log a WHERE a.subject='selectbench:'||r.id AND a.action='selectbench.import' AND a.after->>'casesVerified'='true') AS cases_verified,
           (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
           r.created_at, r.imported_by,
           (SELECT count(*)::int FROM selectbench_results x WHERE x.run_id = r.id) AS cases
    FROM selectbench_runs r ORDER BY r.created_at DESC LIMIT 100`;
}

export async function selectBenchRun(id: string, f: { model?: string; outcome?: string; stratum?: string; disagree?: boolean;page?:number;unstratified?:boolean }) {
  f=parse(z.object({model:z.string().max(200).optional(),outcome:z.enum(['fp','fn','tp','tn','either','error']).optional(),stratum:z.string().max(200).optional(),unstratified:z.boolean().optional(),disagree:z.boolean().optional(),page:z.number().int().min(1).max(10000).optional()}).strict(),f);
  if(f.unstratified && f.stratum!==undefined)invalid('未分层和指定分层不能同时筛选');
  const [run] = await sql`SELECT r.*,EXISTS(SELECT 1 FROM audit_log a WHERE a.subject='selectbench:'||r.id AND a.action='selectbench.import' AND a.after->>'casesVerified'='true') AS cases_verified FROM selectbench_runs r WHERE id = ${id}`;
  if (!run) return null;
  if(f.model!==undefined && !(run.models as string[]).includes(f.model))invalid('这个运行没有所选模型');
  const page=f.page ?? 1;
  const outcome = f.outcome ?? null;
  // One row per case with every model's decision, so disagreements are visible side by side.
  const rows = await sql`
    SELECT case_id, min(title) AS title, min(stratum) AS stratum, min(gold) AS gold,
           jsonb_object_agg(model, jsonb_build_object('decision', decision, 'score', score, 'relevance', relevance, 'category', category, 'reason', reason, 'error', error, 'receiptId', receipt_id)) AS by_model
    FROM selectbench_results WHERE run_id = ${id} AND (${f.stratum ?? null}::text IS NULL OR stratum = ${f.stratum ?? null})
      AND (${!!f.unstratified} IS FALSE OR stratum IS NULL)
    GROUP BY case_id
    HAVING (${outcome}::text IS NULL OR bool_or(
      model = ${f.model ?? (run.models as string[])[0]!} AND CASE ${outcome}
        WHEN 'fp' THEN decision = 'select' AND gold = 'reject'
        WHEN 'fn' THEN decision = 'reject' AND gold = 'select'
        WHEN 'tp' THEN decision = 'select' AND gold = 'select'
        WHEN 'tn' THEN decision = 'reject' AND gold = 'reject'
        WHEN 'either' THEN gold = 'either'
        WHEN 'error' THEN decision IS NULL
        ELSE true END))
      AND (${!!f.disagree} IS FALSE OR count(DISTINCT decision) > 1)
    ORDER BY min(stratum), case_id LIMIT 401 OFFSET ${(page-1)*400}`;
  const strata = await sql`SELECT stratum, count(DISTINCT case_id)::int AS n FROM selectbench_results WHERE run_id = ${id} GROUP BY 1 ORDER BY 2 DESC`;
  return { run, rows:rows.slice(0,400), strata,page,hasMore:rows.length>400 };
}
