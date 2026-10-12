import {tag} from './setup.ts';
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFile,mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {parseGoldJsonl,selectionMetrics} from '@aihot/backend/editorial/evaluation';
import {sql,closeDb} from '@aihot/backend/db';
const example=await readFile(new URL('../industry/gold.example.jsonl',import.meta.url),'utf8'),first=example.trim().split('\n')[0]!;
after(closeDb);
test('the documented gold set parses without changing human labels',()=>{
 const rows=parseGoldJsonl(example);assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.gold.decision),['select','reject']);assert.equal(rows[0]!.sourceFacts.sourceTier,'T1');
});
test('duplicate gold IDs are rejected across the entire file',()=>assert.throws(()=>parseGoldJsonl(`${first}\n${first}`),/重复编号/));
test('invalid gold fields and dates are rejected before evaluation',()=>{
 const row=JSON.parse(first);row.gold.decision='invalid';assert.throws(()=>parseGoldJsonl(JSON.stringify(row)),/字段不合法/);
 row.gold.decision='select';row.material.publishedAt='2026-02-30T00:00:00Z';assert.throws(()=>parseGoldJsonl(JSON.stringify(row)),/字段不合法/);
 assert.throws(()=>parseGoldJsonl('{invalid'),/第 1 行/);assert.throws(()=>parseGoldJsonl('// no data\n'),/没有样本/);
});
test('optional material values have explicit nulls and comments preserve line numbers',()=>{
 const row={caseId:'minimal',material:{title:'test',sourceName:'test'},sourceFacts:{sourceKind:'rss'},gold:{decision:'either'}};
 const [parsed]=parseGoldJsonl('//comment\n\n'+JSON.stringify(row));assert.equal(parsed!.material.originalTitle,null);assert.equal(parsed!.material.bodyOriginal,null);assert.equal(parsed!.material.publishedAt,null);
 assert.throws(()=>parseGoldJsonl('//comment\n\ninvalid'),/第 3 行/);
});
test('metrics preserve the evaluator failure and either denominators',()=>{
 const s=selectionMetrics([{gold:'select',decision:'select'},{gold:'reject',decision:'select'},{gold:'select',decision:'reject'},{gold:'reject',decision:'reject'},{gold:'either',decision:'select'},{gold:'select',decision:null}]);
 assert.deepEqual(s,{n:6,tp:1,fp:1,fn:1,tn:1,decisive:4,either:1,errors:1,accuracy:.5,precision:.5,recall:.5,f1:.5,selectedRate:.5,goldSelectRate:.5});
});
test('invalid CLI inputs cannot create paid receipts or reports',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'selection-preflight-')),file=path.join(dir,'gold.jsonl'),before=await sql`SELECT count(*)::int AS n FROM receipts`;
 try{
  await writeFile(file,`${first}\n${first}`);
  await assert.rejects(promisify(execFile)(process.execPath,['scripts/eval-selection.ts','--gold',file]),e=>String((e as {stderr:string}).stderr).includes('重复编号'));
  await writeFile(file,example);
  for(const args of [['--models','default,missing-model'],['--concurrency','0'],['--n','0'],['--split','missing'],['--seed','2147483648']])await assert.rejects(promisify(execFile)(process.execPath,['scripts/eval-selection.ts','--gold',file,...args]));
  await assert.rejects(promisify(execFile)(process.execPath,['scripts/eval-selection.ts','--gold',file],{env:{...process.env,AIHOT_DATA_DIR:file}}),e=>!(e as {stdout:string}).stdout);
  assert.deepEqual(await sql`SELECT count(*)::int AS n FROM receipts`,before);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('the real evaluation CLI emits a report accepted by the importer with calls disabled',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'selection-cli-')),file=path.join(dir,'gold.jsonl'),label=`test-eval-${tag()}`;
 try{
  await writeFile(file,example);
  const result=await promisify(execFile)(process.execPath,['scripts/eval-selection.ts','--gold',file,'--label',label],{env:{...process.env,MODEL_CALLS_ENABLED:'false',AIHOT_DATA_DIR:dir},timeout:20000});
  const [run]=await sql`SELECT * FROM selectbench_runs WHERE label=${label}`;assert.ok(run);assert.equal(run.sample_size,2);assert.equal(run.summary.default.errors,2);assert.equal(run.summary.default.decisive,0);
  const [audit]=await sql`SELECT after FROM audit_log WHERE subject=${`selectbench:${run.id}`}`;assert.equal(audit.after.casesVerified,true);
  const reportFile=/^report: (.+)$/m.exec(result.stdout)?.[1];assert.ok(reportFile);assert.equal((await stat(reportFile)).mode & 0o777,0o600);assert.equal((await stat(path.dirname(reportFile))).mode & 0o777,0o700);await rm(reportFile);
 }finally{
  await sql`DELETE FROM audit_log WHERE subject IN(SELECT 'selectbench:'||id FROM selectbench_runs WHERE label=${label})`;
  await sql`DELETE FROM selectbench_runs WHERE label=${label}`;await rm(dir,{recursive:true,force:true});
 }
});
