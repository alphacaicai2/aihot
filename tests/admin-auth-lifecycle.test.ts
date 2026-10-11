import {tag} from './setup.ts';
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {sql,closeDb} from '@aihot/backend/db';
import {config} from '@aihot/backend/config';
import {passwordLogin,completeLogin,loginRedirect,sessionPrincipal,parseCookies,safeReturn,endSession,SESSION_COOKIE} from '@aihot/backend/admin/auth';
import {buildApp} from '../apps/api/src/app.ts';
import {sha256} from '@aihot/backend/lib/ids';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const prefix=`auth-${tag()}`,password='test-admin-password-0123456789',original={adminPassword:config.adminPassword,devAdmin:config.devAdmin,environmentName:config.environmentName,adminUnionIds:config.adminUnionIds,adminEmails:config.adminEmails};
const tokens:string[]=[],users:number[]=[],originalFetch=globalThis.fetch;
let oauthHits=0,identity={union_id:prefix,email:`${prefix}@example.org`,name:'Test admin'};
before(async()=>{
 config.adminPassword=password;config.devAdmin=null;config.environmentName='production';config.adminUnionIds=[prefix];config.adminEmails=[];
 process.env.FEISHU_LOGIN_APP_ID='test-login-app';process.env.FEISHU_LOGIN_APP_SECRET='test-login-secret';
 assert.equal((await sql`SELECT id FROM admin_users WHERE email='admin@local'`).length,0);
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url==='https://passport.feishu.cn/suite/passport/oauth/token'){oauthHits++;return Response.json({access_token:'test-token'});}
  if(url==='https://passport.feishu.cn/suite/passport/oauth/userinfo')return Response.json(identity);
  return originalFetch(input,init);
 };
});
after(async()=>{
 Object.assign(config,original);globalThis.fetch=originalFetch;delete process.env.FEISHU_LOGIN_APP_ID;delete process.env.FEISHU_LOGIN_APP_SECRET;
 const owned=await sql`SELECT id FROM admin_users WHERE email='admin@local' OR feishu_union_id=${prefix} OR email=${`${prefix}@example.org`}`;
 await sql`DELETE FROM audit_log WHERE actor=ANY(${[...owned.map(u=>`admin:${u.id}`),...users.map(u=>`admin:${u}`)]}::text[])`;
 await sql`DELETE FROM admin_users WHERE id=ANY(${owned.map(u=>u.id)}::bigint[])`;
 await sql`DELETE FROM admin_login_states`;await sql`DELETE FROM admin_password_attempts`;await closeDb();
});
const header=(token:string)=>`${SESSION_COOKIE}=${token}`;
async function login(){const r=await passwordLogin(password,'/admin/runs','test');tokens.push(r.token);return r;}
async function fault(action:string,user:number,fn:()=>Promise<unknown>){
 const name=`auth_fault_${tag()}`;
 await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' AND NEW.actor='admin:${user}' THEN RAISE EXCEPTION 'injected auth audit failure'; END IF; RETURN NEW; END $$`);
 await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try{await fn();}finally{await sql.unsafe(`DROP TRIGGER ${name} ON audit_log`);await sql.unsafe(`DROP FUNCTION ${name}()`);}
}
test('malformed and prototype-like cookies cannot break or populate authentication',()=>{
 const cookies=parseCookies('broken=%GG; __proto__=fake; constructor=fake; a=ok');assert.equal(cookies.a,'ok');assert.equal(cookies.broken,undefined);assert.equal(cookies.__proto__,undefined);assert.equal(cookies.constructor,undefined);
});
test('ambiguous duplicate session cookies are rejected',()=>assert.equal(parseCookies(`${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second`)[SESSION_COOKIE],undefined));
test('return paths are normalized and cannot leave the admin area',()=>{
 for(const path of ['/admin/../feedback','/admin/../../','/admin\\evil','/admin/%2e%2e/feedback','/admin/../..//example.org'])assert.equal(safeReturn(path),'/admin');
 assert.equal(safeReturn('/admin/runs?group=a%7Cb'),'/admin/runs?group=a%7Cb');
});
test('failed login audit cannot leave a new session or change last login',async()=>{
 const r=await login(),before=await sql`SELECT * FROM admin_users WHERE id=${r.userId}`,sessions=await sql`SELECT * FROM admin_sessions WHERE user_id=${r.userId}`;
 await fault('auth.login',r.userId,()=>assert.rejects(login(),/injected auth audit failure/));
 assert.deepEqual(await sql`SELECT * FROM admin_sessions WHERE user_id=${r.userId}`,sessions);assert.deepEqual(await sql`SELECT * FROM admin_users WHERE id=${r.userId}`,before);
});
test('password rotation and disabling password login invalidate its sessions',async()=>{
 const r=await login();assert.ok(await sessionPrincipal(header(r.token)));
 try{config.adminPassword=password+'changed';assert.equal(await sessionPrincipal(header(r.token)),null);
 config.adminPassword=null;assert.equal(await sessionPrincipal(header(r.token)),null);}finally{config.adminPassword=password;}
});
test('logout without CSRF does not revoke an authenticated session',async()=>{
 const r=await login(),app=await buildApp();
 try{const res=await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:header(r.token)}});assert.equal(res.statusCode,403);assert.ok(await sessionPrincipal(header(r.token)));}finally{await app.close();}
});
test('cross-origin password login creates no session',async()=>{
 const app=await buildApp(),before=await sql`SELECT * FROM admin_sessions ORDER BY id_hash`;
 try{const res=await app.inject({method:'POST',url:'/api/auth/password',headers:{origin:'https://unrelated.example','content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({password,return:'/admin'}).toString()});assert.equal(res.statusCode,403);assert.deepEqual(await sql`SELECT * FROM admin_sessions ORDER BY id_hash`,before);}finally{await app.close();}
});
test('failed logout audit rolls back revocation',async()=>{
 const r=await login();await fault('auth.logout',r.userId,()=>assert.rejects(endSession(header(r.token)),/injected auth audit failure/));assert.ok(await sessionPrincipal(header(r.token)));
});
test('password login rotates the presented session and stores only token digests',async()=>{
 const old=await login(),next=await passwordLogin(password,'/admin/runs','test',header(old.token));
 assert.notEqual(old.token,next.token);assert.equal(await sessionPrincipal(header(old.token)),null);assert.ok(await sessionPrincipal(header(next.token)));
 const rows=await sql`SELECT * FROM admin_sessions WHERE user_id=${next.userId}`;assert.ok(rows.some(r=>r.id_hash===sha256(next.token)));assert.ok(rows.every(r=>!JSON.stringify(r).includes(next.token)));
});
test('failed replacement login preserves the presented session',async()=>{
 const old=await login();await fault('auth.login',old.userId,()=>assert.rejects(passwordLogin(password,'/admin','test',header(old.token)),/injected auth audit failure/));assert.ok(await sessionPrincipal(header(old.token)));
});
test('successful logout accepts the form CSRF and is idempotent',async()=>{
 const r=await login(),principal=await sessionPrincipal(header(r.token)),app=await buildApp();
 try{
  const res=await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:header(r.token),origin:new URL(config.siteUrl).origin,'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({csrf:principal!.csrf}).toString()});
  assert.equal(res.statusCode,303);assert.match(res.headers['set-cookie'] as string,/Max-Age=0/);assert.equal(await sessionPrincipal(header(r.token)),null);
  const n=await sql`SELECT count(*)::int AS n FROM audit_log WHERE actor=${`admin:${r.userId}`} AND action='auth.logout'`;
  assert.equal((await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:header(r.token)}})).statusCode,303);
  assert.deepEqual(await sql`SELECT count(*)::int AS n FROM audit_log WHERE actor=${`admin:${r.userId}`} AND action='auth.logout'`,n);
 }finally{await app.close();}
});
test('cross-origin logout is rejected even with a correct token',async()=>{
 const r=await login(),p=await sessionPrincipal(header(r.token)),app=await buildApp();
 try{assert.equal((await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:header(r.token),origin:'https://other.example','x-csrf-token':p!.csrf}})).statusCode,403);assert.ok(await sessionPrincipal(header(r.token)));}finally{await app.close();}
});
test('expired, legacy and malformed sessions cannot read admin APIs',async()=>{
 const app=await buildApp(),r=await login();
 try{
  await sql`UPDATE admin_sessions SET expires_at=now()-interval '1 second' WHERE id_hash=${sha256(r.token)}`;
  assert.equal((await app.inject({method:'GET',url:'/api/admin/me',headers:{cookie:header(r.token)}})).statusCode,401);
  const legacy=await login();await sql`UPDATE admin_sessions SET auth_method=NULL,auth_binding=NULL WHERE id_hash=${sha256(legacy.token)}`;
  assert.equal((await app.inject({method:'GET',url:'/api/auth/check',headers:{cookie:header(legacy.token)}})).statusCode,401);
  assert.equal((await app.inject({method:'GET',url:'/api/admin/me',headers:{cookie:'broken=%GG; aihot_admin=invalid'}})).statusCode,401);
 }finally{await app.close();}
});
test('OAuth state is consumed once before the upstream exchange',async()=>{
 const redirect=await loginRedirect('/admin/runs?group=a|b'),state=new URL(redirect.url).searchParams.get('state')!,before=oauthHits;
 const results=await Promise.allSettled([1,2].map(()=>completeLogin('code',state,redirect.stateCookie,'test')));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(oauthHits,before+1);
 const result=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof completeLogin>>>).value;
 users.push(result.userId);assert.equal(result.returnTo,'/admin/runs?group=a|b');assert.ok(await sessionPrincipal(header(result.token)));
 await assert.rejects(completeLogin('different-code',state,redirect.stateCookie,'test'),/状态已失效/);assert.equal(oauthHits,before+1);
});
test('expired or mismatched OAuth state never contacts the upstream',async()=>{
 const redirect=await loginRedirect('/admin'),state=new URL(redirect.url).searchParams.get('state')!,before=oauthHits;
 await sql`UPDATE admin_login_states SET expires_at=now()-interval '1 second' WHERE id_hash=${sha256(state)}`;
 await assert.rejects(completeLogin('code',state,redirect.stateCookie,'test'),/状态已失效/);
 await assert.rejects(completeLogin('code',state,redirect.stateCookie+'tampered','test'),/状态已失效/);assert.equal(oauthHits,before);
});
async function oauth(){const r=await loginRedirect('/admin');return completeLogin('test-code',new URL(r.url).searchParams.get('state')!,r.stateCookie,'test');}
test('concurrent valid OAuth sign-ins preserve one administrator identity',async()=>{
 const results=await Promise.all([oauth(),oauth()]);assert.equal(results[0].userId,results[1].userId);
 assert.equal((await sql`SELECT id FROM admin_users WHERE feishu_union_id=${prefix}`).length,1);assert.ok(await sessionPrincipal(header(results[0].token)));assert.ok(await sessionPrincipal(header(results[1].token)));
});
test('removing OAuth permission or configuration invalidates existing sessions',async()=>{
 const r=await oauth();
 try{config.adminUnionIds=[];assert.equal(await sessionPrincipal(header(r.token)),null);config.adminUnionIds=[prefix];delete process.env.FEISHU_LOGIN_APP_SECRET;assert.equal(await sessionPrincipal(header(r.token)),null);}
 finally{config.adminUnionIds=[prefix];process.env.FEISHU_LOGIN_APP_SECRET='test-login-secret';}
});
test('failed OAuth audit leaves no session and does not update the user',async()=>{
 const r=await oauth(),before=await sql`SELECT * FROM admin_users WHERE id=${r.userId}`,sessions=await sql`SELECT * FROM admin_sessions WHERE user_id=${r.userId}`;
 await fault('auth.login',r.userId,()=>assert.rejects(oauth(),/injected auth audit failure/));assert.deepEqual(await sql`SELECT * FROM admin_users WHERE id=${r.userId}`,before);assert.deepEqual(await sql`SELECT * FROM admin_sessions WHERE user_id=${r.userId}`,sessions);
});
test('OAuth cannot attach a different union identity to an existing email',async()=>{
 const old=identity;
 try{identity={...identity,union_id:prefix+'other'};config.adminUnionIds=[identity.union_id];await assert.rejects(oauth(),/身份不一致/);}
 finally{identity=old;config.adminUnionIds=[prefix];}
});
test('OAuth cannot assume the reserved password identity',async()=>{
 const old=identity;try{identity={...identity,email:'admin@local'};await assert.rejects(oauth(),/没有后台权限/);}finally{identity=old;}
});
test('invalid callback clears its state cookie without reflecting query values',async()=>{
 const app=await buildApp();try{
  const res=await app.inject({method:'GET',url:'/api/auth/callback?state=%3Cscript%3E&code=invalid'});assert.equal(res.statusCode,403);assert.match(res.headers['set-cookie'] as string,/aihot_oauth_state=.*Max-Age=0/);assert.doesNotMatch(res.body,/<script>/);
 }finally{await app.close();}
});
test('login audit failure has a recoverable message rather than a password error',async()=>{
 const r=await login(),app=await buildApp();try{
  await fault('auth.login',r.userId,async()=>{const res=await app.inject({method:'POST',url:'/api/auth/password',payload:{password}});assert.equal(res.statusCode,303);assert.match(res.headers.location!,/error=unavailable/);assert.equal(res.headers['set-cookie'],undefined);});
 }finally{await app.close();}
});
test('password rate limits survive another process and concurrent clients',async()=>{
 const {reservePasswordAttempt}=await import('@aihot/backend/admin/auth');await sql`DELETE FROM admin_password_attempts`;
 const results=await Promise.all(Array.from({length:11},()=>reservePasswordAttempt('test-client')));assert.equal(results.filter(Boolean).length,10);
 const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',"const {reservePasswordAttempt}=await import('@aihot/backend/admin/auth');const {closeDb}=await import('@aihot/backend/db');console.log(await reservePasswordAttempt('test-client'));await closeDb();"]);
 assert.equal(child.stdout.trim(),'false');
 const others=await Promise.all(Array.from({length:41},(_,i)=>reservePasswordAttempt(`other-${i}`)));assert.equal(others.filter(Boolean).length,40);assert.equal(await reservePasswordAttempt('new-client'),false);
 const [n]=await sql`SELECT count(*)::int AS n FROM admin_password_attempts`;assert.equal(n!.n,50);
 await sql`UPDATE admin_password_attempts SET attempted_at=clock_timestamp()-interval '16 minutes'`;
 assert.equal(await reservePasswordAttempt('test-client'),true);assert.equal((await sql`SELECT count(*)::int AS n FROM admin_password_attempts`)[0]!.n,1);
});
test('rotating the session secret invalidates password and OAuth sessions',async()=>{
 const p=await login(),f=await oauth(),old=process.env.SESSION_SECRET;
 try{process.env.SESSION_SECRET='rotated-test-session-secret';assert.equal(await sessionPrincipal(header(p.token)),null);assert.equal(await sessionPrincipal(header(f.token)),null);}
 finally{process.env.SESSION_SECRET=old;}
});
test('browser fetch metadata cannot authorize a cross-site sign-in without Origin',async()=>{
 const app=await buildApp();try{assert.equal((await app.inject({method:'POST',url:'/api/auth/password',headers:{'sec-fetch-site':'cross-site'},payload:{password}})).statusCode,403);}finally{await app.close();}
});
