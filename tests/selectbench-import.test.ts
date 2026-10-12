import {tag} from './setup.ts';
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {sql,closeDb} from '@aihot/backend/db';
import {importSelectBenchRun,selectBenchRun,listSelectBenchRuns} from '@aihot/backend/admin/selectbench';
import {buildApp} from '../apps/api/src/app.ts';
import {config} from '@aihot/backend/config';
const actor=`test:selectbench-${tag()}`,label='temporary comparison';
const cases=()=>[
 {caseId:'c1',title:'Test one',gold:'select',decision:'select',score:79.5,relevance:'pass'},
 {caseId:'c2',title:'Test two',gold:'reject',decision:'select',score:90,relevance:'pass'},
 {caseId:'c3',title:'Test three',gold:'select',decision:'reject',score:40,relevance:'pass'},
 {caseId:'c4',title:'Test either',gold:'either',decision:'reject',score:0,relevance:'reject'},
 {caseId:'c5',title:'Test error',gold:'reject',decision:null,score:null,error:'local fixture error'},
];
const report=()=>({meta:{n:5,split:'development',seed:12,promptVersion:'test'},models:{'test-model':{summary:{n:5,tp:1,fp:1,fn:1,tn:0,decisive:3,either:1,errors:1,accuracy:.333,precision:.5,recall:.5,f1:.5,selectedRate:.667,goldSelectRate:.667},cases:cases()}}});
const state=async()=>({runs:await sql`SELECT * FROM selectbench_runs WHERE imported_by=${actor} ORDER BY id`,rows:await sql`SELECT * FROM selectbench_results WHERE run_id IN(SELECT id FROM selectbench_runs WHERE imported_by=${actor}) ORDER BY run_id,model,case_id`,audits:await sql`SELECT * FROM audit_log WHERE actor=${actor} ORDER BY id`});
after(async()=>{await sql`DELETE FROM audit_log WHERE actor IN ${sql([actor,`dev:${actor}`])}`;await sql`DELETE FROM selectbench_runs WHERE imported_by IN ${sql([actor,`dev:${actor}`])}`;await closeDb();});
test('failed audit cannot leave an imported comparison',async()=>{
 const name=`selectbench_fault_${tag()}`,before=await state();
 await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor='${actor}' THEN RAISE EXCEPTION 'injected SelectBench audit failure'; END IF; RETURN NEW; END $$`);
 await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try{await assert.rejects(importSelectBenchRun(report(),label,actor),/injected SelectBench audit failure/);assert.deepEqual(await state(),before);}finally{await sql.unsafe(`DROP TRIGGER ${name} ON audit_log`);await sql.unsafe(`DROP FUNCTION ${name}()`);}
});
test('duplicate case IDs are rejected instead of silently discarding data',async()=>{
 const r=report();r.models['test-model'].cases.push({...r.models['test-model'].cases[0]!});const before=await state();await assert.rejects(importSelectBenchRun(r,label,actor),{statusCode:400});assert.deepEqual(await state(),before);
});
test('different gold labels cannot be compared under the same case ID',async()=>{
 const r=report(),other=cases();other[0]!.gold='reject';(r.models as Record<string,unknown>)['other-model']={summary:{n:5},cases:other};await assert.rejects(importSelectBenchRun(r,label,actor),{statusCode:400});
});
test('declared sample size must match full case coverage',async()=>{
 const r=report();r.meta.n=6;await assert.rejects(importSelectBenchRun(r,label,actor),{statusCode:400});
});
test('confusion counts and metrics must match the individual decisions',async()=>{
 const r=report();r.models['test-model'].summary.f1=1;await assert.rejects(importSelectBenchRun(r,label,actor),{statusCode:400});
});
test('malformed report shapes have a validation error',async()=>{
 for(const r of [null,[],{models:{x:{summary:{n:1},cases:'invalid'}}},{models:{x:{summary:{n:1},cases:[{caseId:'x',title:'test',gold:'invalid',decision:'select'}]}}}])await assert.rejects(importSelectBenchRun(r,label,actor),{statusCode:400});
});
test('models must evaluate the same complete sample set',async()=>{
 const r=report();(r.models as Record<string,unknown>)['other-model']={summary:{n:4},cases:cases().slice(0,4)};await assert.rejects(importSelectBenchRun(r,label,actor),{statusCode:400});
});
test('a repeated import command commits one run and one audit',async()=>{
 const before=await state(),requestId=`import-${tag()}`,results=await Promise.all([1,2,3].map(()=>importSelectBenchRun(report(),label,actor,{requestId})));
 assert.deepEqual(results[0],results[1]);assert.deepEqual(results[0],results[2]);const after=await state();assert.equal(after.runs.length,before.runs.length+1);assert.equal(after.audits.length,before.audits.length+1);
});
test('valid full reports keep fractional scores and verified confusion metrics',async()=>{
 const r=report();(r.models as Record<string,unknown>)['other-model']={summary:{n:5},cases:cases().map((c,i)=>i===0?{...c,decision:'reject'}:c)};
 const imported=await importSelectBenchRun(r,label,actor),run=await selectBenchRun(imported.id,{});assert.ok(run!.run.cases_verified);
 assert.equal(run!.run.summary['other-model'].fn,2);assert.equal(run!.run.summary['other-model'].f1,0);assert.equal(run!.rows[0]!.by_model['test-model'].score,79.5);
 assert.ok((await listSelectBenchRuns()).find(x=>x.id===imported.id)!.cases_verified);
});
test('legacy summary-only reports remain readable and are explicitly unverified',async()=>{
 const r=await importSelectBenchRun({'legacy-model':{summary:{n:7,f1:.7}}},label,actor),run=await selectBenchRun(r.id,{});
 assert.equal(run!.run.sample_size,7);assert.equal(run!.rows.length,0);assert.equal(run!.run.cases_verified,false);assert.equal((await listSelectBenchRuns()).find(x=>x.id===r.id)!.cases_verified,false);
});
test('summary-only and complete reports cannot be combined in one comparison',async()=>{
 const r=report();(r.models as Record<string,unknown>)['legacy-model']={summary:{n:5}};await assert.rejects(importSelectBenchRun(r,label,actor),{statusCode:400});
});
test('changed parameters cannot reuse an already committed command',async()=>{
 const requestId=`changed-${tag()}`,first=await importSelectBenchRun(report(),label,actor,{requestId}),before=await state();
 await assert.rejects(importSelectBenchRun(report(),label+'changed',actor,{requestId}),{code:'conflict'});assert.deepEqual(await state(),before);
 assert.deepEqual(await importSelectBenchRun(report(),label,actor,{requestId}),first);
});
test('object-key order does not alter command identity',async()=>{
 const requestId=`ordered-${tag()}`,r=report(),first=await importSelectBenchRun(r,label,actor,{requestId});
 assert.deepEqual(await importSelectBenchRun({models:r.models,meta:r.meta},label,actor,{requestId}),first);
});
test('scores, counts, metadata and labels are validated before database writes',async()=>{
 const r=report();r.models['test-model'].cases[0]!.score=101;await assert.rejects(importSelectBenchRun(r,label,actor),{statusCode:400});
 await assert.rejects(importSelectBenchRun({...report(),meta:{n:2147483648}},label,actor),{statusCode:400});
 await assert.rejects(importSelectBenchRun({...report(),meta:{n:5,seed:2147483648}},label,actor),{statusCode:400});
 await assert.rejects(importSelectBenchRun(report(),' ',actor),{statusCode:400});
});
test('threshold sweep summaries must describe the provided raw scores',async()=>{
 const r=report();(r.models['test-model'] as Record<string,unknown>).sweep=[{t:70,acc:.333,P:.5,R:.5,F1:.5,sel:.667}];await importSelectBenchRun(r,label,actor);
 (r.models['test-model'] as Record<string,unknown>).sweep=[{t:70,acc:1,P:1,R:1,F1:1,sel:1}];await assert.rejects(importSelectBenchRun(r,label,actor),{statusCode:400});
});
test('all-error and either cases use the evaluator denominator conventions',async()=>{
 const imported=await importSelectBenchRun({models:{model:{summary:{},cases:[{caseId:'x',title:'error',gold:'either',decision:null},{caseId:'y',title:'either',gold:'either',decision:'select'}]}}},label,actor);
 const run=await selectBenchRun(imported.id,{}),s=run!.run.summary.model;assert.equal(s.n,2);assert.equal(s.either,1);assert.equal(s.errors,1);assert.equal(s.decisive,0);assert.equal(s.f1,0);
});
test('pagination reaches samples beyond the old 400-row cap without repeating them',async()=>{
 const c=Array.from({length:401},(_,i)=>({caseId:`case-${String(i).padStart(4,'0')}`,title:`Sample ${i}`,gold:'select',decision:'select'}));
 const r=await importSelectBenchRun({meta:{n:401},models:{model:{summary:{n:401},cases:c}}},label,actor);
 const a=await selectBenchRun(r.id,{}),b=await selectBenchRun(r.id,{page:2});assert.equal(a!.rows.length,400);assert.equal(a!.hasMore,true);assert.equal(b!.rows.length,1);assert.equal(b!.rows[0]!.case_id,'case-0400');assert.equal(b!.hasMore,false);
 assert.equal(new Set([...a!.rows,...b!.rows].map(x=>x.case_id)).size,401);
});
test('filtering includes errors and disagreements without changing the gold set',async()=>{
 const r=report();(r.models as Record<string,unknown>).other={summary:{n:5},cases:cases().map((c,i)=>i===0?{...c,decision:'reject'}:c)};const run=await importSelectBenchRun(r,label,actor);
 assert.equal((await selectBenchRun(run.id,{model:'test-model',outcome:'fp'}))!.rows[0]!.case_id,'c2');
 assert.equal((await selectBenchRun(run.id,{model:'test-model',outcome:'error'}))!.rows[0]!.case_id,'c5');
 assert.equal((await selectBenchRun(run.id,{disagree:true}))!.rows[0]!.case_id,'c1');
 await assert.rejects(selectBenchRun(run.id,{model:'missing'}),{statusCode:400});await assert.rejects(selectBenchRun(run.id,{page:0}),{statusCode:400});
});
test('unstratified, empty and named strata remain distinct without reserved-name collisions',async()=>{
 const c=[{caseId:'null',title:'none',gold:'reject',decision:'reject'},{caseId:'empty',title:'empty',gold:'reject',decision:'reject',stratum:''},{caseId:'named',title:'named',gold:'reject',decision:'reject',stratum:'__none__'}];
 const run=await importSelectBenchRun({models:{model:{summary:{n:3},cases:c}}},label,actor);
 assert.equal((await selectBenchRun(run.id,{}))!.rows.length,3);
 assert.deepEqual((await selectBenchRun(run.id,{unstratified:true}))!.rows.map(r=>r.case_id),['null']);
 assert.deepEqual((await selectBenchRun(run.id,{stratum:''}))!.rows.map(r=>r.case_id),['empty']);
 assert.deepEqual((await selectBenchRun(run.id,{stratum:'__none__'}))!.rows.map(r=>r.case_id),['named']);
 await assert.rejects(selectBenchRun(run.id,{unstratified:true,stratum:'x'}),{statusCode:400});
});
test('HTTP rejects malformed imports and missing command keys, and replays a valid import',async()=>{
 const before={devAdmin:config.devAdmin,environmentName:config.environmentName};config.devAdmin={displayName:actor};config.environmentName='development';const app=await buildApp(),requestId=`http-${tag()}`;
 try{
  const base={method:'POST' as const,url:'/api/admin/selectbench/import',headers:{'x-csrf-token':'dev','idempotency-key':requestId}};
  assert.equal((await app.inject({...base,payload:{label,report:null}})).statusCode,400);
  assert.equal((await app.inject({...base,headers:{'x-csrf-token':'dev'},payload:{label,report:report()}})).statusCode,400);
  assert.equal((await app.inject({...base,headers:{'x-csrf-token':'wrong','idempotency-key':requestId},payload:{label,report:report()}})).statusCode,403);
  const a=await app.inject({...base,payload:{label,report:report()}}),b=await app.inject({...base,payload:{label,report:report()}});assert.equal(a.statusCode,200);assert.deepEqual(b.json(),a.json());
  assert.equal((await app.inject({method:'GET',url:`/api/admin/selectbench/${a.json().id}?page=0`})).statusCode,400);
  assert.equal((await app.inject({method:'GET',url:`/api/admin/selectbench/${a.json().id}?disagree=2`})).statusCode,400);
 }finally{await app.close();Object.assign(config,before);}
});
