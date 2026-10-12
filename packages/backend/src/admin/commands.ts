import type {Tx} from '../db.ts';
import {Conflict} from './sources.ts';

/** Audit records outlive queue jobs; preserve the existing lock namespace during rolling upgrades. */
export async function previousAdminCommand<T>(tx:Tx,actor:string,action:string,subject:string|null,requestId:string,fingerprint:string):Promise<T|null> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-recovery:${actor}:${action}:${requestId}`},0))`;
  const [saved]=await tx<{subject:string;after:{command?:{fingerprint:string;result:T}}}[]>`SELECT subject,after FROM audit_log
    WHERE actor=${actor} AND action=${action} AND request_id=${requestId} ORDER BY id LIMIT 1`;
  if(!saved)return null;
  if((subject!==null && saved.subject!==subject) || saved.after?.command?.fingerprint!==fingerprint)throw new Conflict('这次操作的参数已改变，请刷新页面后重新提交');
  return saved.after.command.result;
}
