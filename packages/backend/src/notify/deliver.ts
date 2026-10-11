// Content delivery is a durable outbox. Only a pending generation can claim a network attempt;
// sending/unknown attempts are never replayed, even when the queue retries after a crash.
import { config, credential } from "../config.ts";
import { sql, type Tx } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { postWebhook } from "./feishu.ts";
import { FEATURES } from "@aihot/industry/features";

export interface DeliveryRequest {
  subjectKind: "codex_reset" | "selected";
  subjectId: string;
  dedupeKey: string;
  contentAt: Date;
  card: unknown;
}

export async function ensureContentTargets() {
  await sql`INSERT INTO notify_targets(key,purpose,kind,enabled,config_ref,note) VALUES
    ('feishu-content-main','content','feishu_webhook',false,'FEISHU_PUSH_WEBHOOK_URL','飞书内容主群'),
    ('feishu-content-mirror','content','feishu_webhook',false,'FEISHU_PUSH_MIRROR_WEBHOOK_URL','飞书内容镜像群') ON CONFLICT(key) DO NOTHING`;
}

/** Called with the caller's row lock; the job commits with its authorisation and audit. */
export async function queueDelivery(tx: Tx, id: number, generation: number) {
  await tx`INSERT INTO delivery_attempts(delivery_id,generation,status) VALUES(${id},${generation},'pending')`;
  await tx`UPDATE deliveries SET status='pending',dispatch_generation=${generation},response='已授权，等待发送',
    updated_at=greatest(clock_timestamp(),date_trunc('milliseconds',updated_at)+interval '1 millisecond') WHERE id=${id}`;
  const jobId=await enqueue(QUEUES.notifyDelivery,{deliveryId:id,generation},{singletonKey:`delivery:${id}:${generation}`},tx);
  if(!jobId) throw new Error('delivery handoff did not create its job');
  return jobId;
}

export async function deliverContent(req: DeliveryRequest): Promise<Array<{target:string;status:string}>> {
  return sql.begin(async tx=>{
    const targets=await tx<{key:string;kind:string;enabled_at:Date|null}[]>`SELECT key,kind,enabled_at FROM notify_targets
      WHERE purpose='content' AND enabled ORDER BY key FOR SHARE`;
    const results:Array<{target:string;status:string}>=[];
    for(const t of targets){
      if(t.enabled_at && req.contentAt<t.enabled_at) continue;
      const [row]=await tx<{id:number}[]>`INSERT INTO deliveries(target_key,subject_kind,subject_id,dedupe_key,status,payload,content_at)
        VALUES(${t.key},${req.subjectKind},${req.subjectId},${req.dedupeKey},'pending',${tx.json(req.card as never)},${req.contentAt})
        ON CONFLICT(target_key,dedupe_key) DO NOTHING RETURNING id`;
      if(!row) continue;
      if(!config.feishuContentPushEnabled || t.kind!=='feishu_webhook'){
        await tx`UPDATE deliveries SET status='skipped',response='content push disabled' WHERE id=${row.id}`;
        results.push({target:t.key,status:'skipped'});continue;
      }
      await queueDelivery(tx,row.id,1);
      results.push({target:t.key,status:'pending'});
    }
    return results;
  }) as Promise<Array<{target:string;status:string}>>;
}

async function payloadFor(d:{subject_kind:string;subject_id:string;dedupe_key:string},tx:Tx){
  if(d.subject_kind==='selected'){
    const {selectedDeliveryCard}=await import('./selected.ts');
    return selectedDeliveryCard(d.subject_id,tx);
  }
  if(d.subject_kind==='codex_reset' && FEATURES.codexResetMonitor){
    const {resetDeliveryCard}=await import('../monitor/scan.ts');
    return resetDeliveryCard(d.subject_id,d.dedupe_key,tx);
  }
  return null;
}

function transportError(error:unknown){
  const e=error as {name?:string;code?:unknown;cause?:{code?:unknown}};
  const name=['Error','TypeError','TimeoutError','AbortError'].includes(e?.name ?? '') ? e.name! : 'Error';
  const code=e?.cause?.code ?? e?.code;
  return typeof code==='string' && /^[A-Z0-9_]{1,60}$/.test(code) ? `${name}: ${code}` : name;
}

export async function dispatchDelivery(id:number,generation:number):Promise<{status:string}> {
  const claimed=await sql.begin(async tx=>{
    const [d]=await tx<{status:string;dispatch_generation:number;attempts:number;target_key:string;subject_kind:string;subject_id:string;dedupe_key:string;content_at:Date|null;created_at:Date}[]>`
      SELECT * FROM deliveries WHERE id=${id} FOR UPDATE`;
    if(!d) return {status:'missing'};
    if(d.dispatch_generation!==generation) return {status:'obsolete'};
    const [a]=await tx`SELECT status FROM delivery_attempts WHERE delivery_id=${id} AND generation=${generation} FOR UPDATE`;
    if(d.status!=='pending' || a?.status!=='pending') return {status:d.status};
    const [t]=await tx<{kind:string;enabled:boolean;enabled_at:Date|null;config_ref:string|null}[]>`SELECT kind,enabled,enabled_at,config_ref FROM notify_targets WHERE key=${d.target_key} FOR SHARE`;
    let reason:string|null=null,status='skipped';
    if(!config.feishuContentPushEnabled || !t?.enabled || t.kind!=='feishu_webhook') reason='content push disabled or target disabled';
    else if(t.enabled_at && (d.content_at ?? d.created_at)<t.enabled_at) reason='content predates target activation';
    const url=t?.config_ref ? credential('integrations',t.config_ref) : undefined;
    if(!reason && !url){reason='webhook not configured';status='failed';}
    const payload=reason ? null : await payloadFor(d,tx);
    if(!reason && !payload) reason='content is no longer eligible for delivery';
    if(reason){
      await tx`UPDATE deliveries SET status=${status},response=${reason},updated_at=clock_timestamp() WHERE id=${id}`;
      await tx`UPDATE delivery_attempts SET status=${status},response=${reason},finished_at=clock_timestamp() WHERE delivery_id=${id} AND generation=${generation}`;
      return {status};
    }
    const attempt=d.attempts+1;
    await tx`UPDATE deliveries SET status='sending',attempts=${attempt},payload=${tx.json(payload as never)},updated_at=clock_timestamp() WHERE id=${id}`;
    await tx`UPDATE delivery_attempts SET status='sending',attempt=${attempt},payload=${tx.json(payload as never)},started_at=clock_timestamp() WHERE delivery_id=${id} AND generation=${generation}`;
    return {status:'sending',url:url!,payload,attempt};
  });
  if(claimed.url===undefined) return {status:claimed.status};
  let outcome:{status:string;response:string};
  try{
    const res=await postWebhook(claimed.url,claimed.payload);
    outcome={status:res.ok?'sent':res.rejected?'failed':'unknown',response:res.body};
  }catch(error){outcome={status:'unknown',response:transportError(error)};}
  // A failed database commit after POST leaves sending, so a queue retry cannot POST again.
  return sql.begin(async tx=>{
    const rows=await tx`UPDATE deliveries SET status=${outcome.status},response=${outcome.response},
      sent_at=CASE WHEN ${outcome.status==='sent'} THEN clock_timestamp() ELSE sent_at END,updated_at=clock_timestamp()
      WHERE id=${id} AND dispatch_generation=${generation} AND status='sending' AND attempts=${claimed.attempt} RETURNING id`;
    if(rows.length){
      await tx`UPDATE delivery_attempts SET status=${outcome.status},response=${outcome.response},finished_at=clock_timestamp()
        WHERE delivery_id=${id} AND generation=${generation} AND status='sending'`;
      return {status:outcome.status};
    }
    await tx`UPDATE delivery_attempts SET late_response=${tx.json(outcome)},finished_at=coalesce(finished_at,clock_timestamp())
      WHERE delivery_id=${id} AND generation=${generation}`;
    const [current]=await tx`SELECT status FROM deliveries WHERE id=${id}`;
    return {status:current?.status ?? 'missing'};
  }) as Promise<{status:string}>;
}

/** Lost pending jobs are safe to repair; a sending attempt is conservatively held for review. */
export async function markStaleDeliveries():Promise<{unknown:number;failed:number;requeued:number}> {
  const cutoff=new Date(Date.now()-15*60_000);
  return sql.begin(async tx=>{
    const rows=await tx<{id:number;status:string;dispatch_generation:number}[]>`SELECT id,status,dispatch_generation FROM deliveries
      WHERE status IN ('pending','sending') AND updated_at<${cutoff} ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`;
    let unknown=0,failed=0,requeued=0;
    for(const r of rows){
      if(r.status==='sending'){
        await tx`UPDATE deliveries SET status='unknown',response='发送中断，是否送达未知',updated_at=clock_timestamp() WHERE id=${r.id}`;
        await tx`UPDATE delivery_attempts SET status='unknown',response='发送中断，是否送达未知',finished_at=clock_timestamp()
          WHERE delivery_id=${r.id} AND generation=${r.dispatch_generation} AND status='sending'`;unknown++;continue;
      }
      const [a]=await tx`SELECT status FROM delivery_attempts WHERE delivery_id=${r.id} AND generation=${r.dispatch_generation}`;
      if(a?.status==='pending'){
        const [busy]=await tx`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.notifyDelivery} AND data->>'deliveryId'=${String(r.id)}
          AND data->>'generation'=${String(r.dispatch_generation)} AND state IN ('created','retry','active')`;
        if(!busy && await enqueue(QUEUES.notifyDelivery,{deliveryId:r.id,generation:r.dispatch_generation},{singletonKey:`delivery:${r.id}:${r.dispatch_generation}`},tx)) requeued++;
      }else{
        await tx`UPDATE deliveries SET status='failed',response='发送前进程中断，没有发出',updated_at=clock_timestamp() WHERE id=${r.id}`;failed++;
      }
    }
    return {unknown,failed,requeued};
  }) as Promise<{unknown:number;failed:number;requeued:number}>;
}
