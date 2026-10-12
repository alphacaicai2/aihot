import {z} from 'zod';

const nullableText=(max:number)=>z.string().max(max).nullable().default(null);
const Gold=z.object({
  caseId:z.string().min(1).max(200).refine(s=>!!s.trim()),
  material:z.object({title:z.string().min(1).max(4000),originalTitle:nullableText(4000),publishedAt:z.string().datetime({offset:true}).nullable().default(null),sourceName:z.string().min(1).max(200),bodyZh:nullableText(1000000),bodyOriginal:nullableText(1000000)}),
  sourceFacts:z.object({sourceKind:z.enum(['rss','web_list','json_list','x_search','mp','external']),sourceTier:z.string().min(1).max(100).optional(),firstParty:z.boolean().optional(),language:z.string().max(40).nullable().optional()}),
  samplingContext:z.object({benchmarkSplit:z.string().min(1).max(200).optional(),samplingStratum:z.string().max(200).optional()}).optional(),
  gold:z.object({decision:z.enum(['select','reject','either'])}),
});
export type GoldRow=z.infer<typeof Gold>;

/** Validate the entire gold file before any paid model step, including cases outside the chosen split. */
export function parseGoldJsonl(text:string):GoldRow[] {
  if(Buffer.byteLength(text)>32*1024*1024)throw new Error('金标文件最大 32MB');
  const rows:GoldRow[]=[],ids=new Set<string>();
  for(const [index,line] of text.split('\n').entries()){
    if(!line.trim() || line.trim().startsWith('//'))continue;
    let raw:unknown;try{raw=JSON.parse(line);}catch{throw new Error(`金标第 ${index+1} 行不是合法 JSON`);}
    const parsed=Gold.safeParse(raw);if(!parsed.success)throw new Error(`金标第 ${index+1} 行字段不合法：${parsed.error.issues[0]?.path.join('.')}`);
    if(ids.has(parsed.data.caseId))throw new Error(`金标有重复编号：${parsed.data.caseId}`);
    ids.add(parsed.data.caseId);rows.push(parsed.data);
    if(rows.length>10000)throw new Error('金标最多 10000 条');
  }
  if(!rows.length)throw new Error('金标文件没有样本');return rows;
}

export interface SelectionDecision {gold:'select'|'reject'|'either';decision:'select'|'reject'|null}
/** Failures and either cases do not enter decisive denominators; this is shared by CLI and imports. */
export function selectionMetrics(cases:SelectionDecision[]) {
  let tp=0,fp=0,fn=0,tn=0,either=0,errors=0;
  for(const c of cases){
    if(c.decision===null){errors++;continue;}
    if(c.gold==='either'){either++;continue;}
    if(c.decision==='select' && c.gold==='select')tp++;
    else if(c.decision==='select')fp++;
    else if(c.gold==='select')fn++;
    else tn++;
  }
  const decisive=tp+fp+fn+tn,P=tp/Math.max(1,tp+fp),R=tp/Math.max(1,tp+fn),round=(n:number)=>+n.toFixed(3);
  return {n:cases.length,tp,fp,fn,tn,decisive,either,errors,accuracy:round((tp+tn)/Math.max(1,decisive)),precision:round(P),recall:round(R),f1:round(2*P*R/Math.max(1e-9,P+R)),selectedRate:round((tp+fp)/Math.max(1,decisive)),goldSelectRate:round((tp+fn)/Math.max(1,decisive))};
}
