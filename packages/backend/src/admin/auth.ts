// Admin identity: the admin password (ADMIN_PASSWORD), or optionally Feishu OAuth with an allowlist of
// union_ids / emails; opaque sessions stored hashed, and an audit trail for every manual change.
// Development may impersonate an admin with DEV_AUTH_ROLE=admin; production refuses to start with it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, credential } from "../config.ts";
import { sql, type Db, type Tx } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

export const SESSION_COOKIE = "aihot_admin";
export const STATE_COOKIE = "aihot_oauth_state";
export const SESSION_DAYS = 30;
/** Register this callback in the Feishu open platform when Feishu sign-in is used. */
export const CALLBACK_URL = `${config.siteUrl}/api/auth/callback`;

/** Feishu sign-in is offered only when its app is configured. */
export function feishuLoginConfigured(): boolean {
  return !!credential("integrations", "FEISHU_LOGIN_APP_ID") && !!credential("integrations", "FEISHU_LOGIN_APP_SECRET");
}

export interface AdminPrincipal {
  userId: number | null;
  name: string;
  csrf: string;
  dev: boolean;
}

function secret(): string {
  const s = credential("auth", "SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
}

function sign(value: string): string {
  return `${value}.${createHmac("sha256", secret()).update(value).digest("base64url")}`;
}

function unsign(signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value).slice(i + 1));
  const given = Buffer.from(signed.slice(i + 1));
  return expected.length === given.length && timingSafeEqual(expected, given) ? value : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const seen=new Set<string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if(i<=0)continue;
    const name=part.slice(0,i).trim();
    if(['__proto__','constructor','prototype'].includes(name))continue;
    if(seen.has(name)){delete out[name];continue;}
    seen.add(name);
    try{out[name]=decodeURIComponent(part.slice(i+1).trim());}catch{ /* Ignore an invalid cookie; other cookies may still be valid. */ }
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Where to send the browser to sign in; the signed state also carries where to return. */
export async function loginRedirect(returnTo: string): Promise<{ url: string; stateCookie: string }> {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  if (!appId) throw new Error("FEISHU_LOGIN_APP_ID is not configured");
  const state = `${randomBytes(16).toString("base64url")}|${safeReturn(returnTo)}`;
  const signed=sign(state);
  await sql.begin(async tx=>{
    await tx`DELETE FROM admin_login_states WHERE expires_at<=now()`;
    await tx`INSERT INTO admin_login_states(id_hash,expires_at) VALUES(${sha256(signed)},now()+interval '10 minutes')`;
  });
  const url = `https://passport.feishu.cn/suite/passport/oauth/authorize?${new URLSearchParams({ client_id: appId, redirect_uri: CALLBACK_URL, response_type: "code", state: signed })}`;
  return { url, stateCookie: signed };
}

/** Only admin paths on this site; anything else (other hosts, protocol-relative) falls back to /admin. */
export function safeReturn(target: string): string {
  if(/[\\\x00-\x20\x7f]/.test(target) || target.startsWith('//'))return '/admin';
  try{
    const u=new URL(target,config.siteUrl);
    if(!['http:','https:'].includes(u.protocol))return '/admin';
    // A proxy may pass the original absolute URL; return only a normalized local admin path.
    return /^\/admin(\/|$)/.test(u.pathname) ? `${u.pathname}${u.search}` : '/admin';
  }catch{return '/admin';}
}

interface FeishuUser {
  union_id?: string;
  email?: string;
  enterprise_email?: string;
  name?: string;
}

async function feishuUser(code: string): Promise<FeishuUser> {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  const appSecret = credential("integrations", "FEISHU_LOGIN_APP_SECRET");
  if (!appId || !appSecret) throw new Error("Feishu login app is not configured");
  const tokenRes = await fetch("https://passport.feishu.cn/suite/passport/oauth/token", {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: appId, client_secret: appSecret, code, redirect_uri: CALLBACK_URL }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenRes.ok || typeof token.access_token!=='string' || !token.access_token) throw new Error('Feishu token exchange failed');
  const userRes = await fetch("https://passport.feishu.cn/suite/passport/oauth/userinfo", {
    redirect: "error",
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const user=await userRes.json() as FeishuUser;
  if(!userRes.ok || !user || Object.entries(user).some(([key,value])=>['union_id','email','enterprise_email','name'].includes(key) && value!==undefined && typeof value!=='string'))throw new Error('Feishu identity response invalid');
  return user;
}

export class LoginRejected extends Error {}

function sessionBinding(method:'password'|'feishu'):string {
  return createHmac('sha256',secret()).update(`admin-session-v1:${method}:${method==='password' ? config.adminPassword ?? '' : ''}`).digest('hex');
}

async function createSession(userId: number, userAgent: string | undefined, method:'password'|'feishu',tx:Tx,previousCookie?:string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const previous=parseCookies(previousCookie)[SESSION_COOKIE];
  if(previous)await tx`DELETE FROM admin_sessions WHERE id_hash=${sha256(previous)}`;
  await tx`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, user_agent,auth_method,auth_binding)
            VALUES (${sha256(token)}, ${userId}, ${randomBytes(18).toString("base64url")}, ${new Date(Date.now() + SESSION_DAYS * 86400_000)}, ${userAgent?.slice(0, 300) ?? null},${method},${sessionBinding(method)})`;
  return token;
}

/** OAuth callback: verify state, identify the Feishu user, admit only allowlisted admins. */
export async function completeLogin(code: string, state: string, stateCookie: string | undefined, userAgent: string | undefined,previousCookie?:string) {
  const expected = unsign(stateCookie);
  const given = unsign(state);
  if (!code || code.length>2048 || !expected || !given || expected !== given) throw new LoginRejected("登录状态已失效，请重新登录");
  const consumed=await sql`DELETE FROM admin_login_states WHERE id_hash=${sha256(state)} AND expires_at>now() RETURNING id_hash`;
  if(!consumed.length)throw new LoginRejected('登录状态已失效，请重新登录');
  const returnTo = safeReturn(given.slice(given.indexOf('|')+1));
  const u = await feishuUser(code);
  const email = (u.enterprise_email ?? u.email ?? "").toLowerCase() || null;
  const allowed = (u.union_id && config.adminUnionIds.includes(u.union_id)) || (email && config.adminEmails.includes(email));
  if (!allowed) throw new LoginRejected("这个飞书账号没有后台权限");
  if(email===PASSWORD_ADMIN)throw new LoginRejected('这个飞书账号没有后台权限');
  return sql.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(hashtext('admin-login-users'))`;
    const existing=await tx<{id:number;feishu_union_id:string|null}[]>`SELECT id,feishu_union_id FROM admin_users
      WHERE (${u.union_id ?? null}::text IS NOT NULL AND feishu_union_id=${u.union_id ?? null}) OR (${email}::text IS NOT NULL AND email=${email}) FOR UPDATE`;
    if(existing.length>1 || (existing[0]?.feishu_union_id && u.union_id && existing[0].feishu_union_id!==u.union_id))throw new LoginRejected('账号身份不一致，请联系管理员');
    const [user]=existing[0]
      ? await tx<{id:number}[]>`UPDATE admin_users SET feishu_union_id=coalesce(feishu_union_id,${u.union_id ?? null}),email=coalesce(email,${email}),display_name=coalesce(${u.name ?? null},display_name),last_login_at=now() WHERE id=${existing[0].id} RETURNING id`
      : await tx<{id:number}[]>`INSERT INTO admin_users(feishu_union_id,email,display_name,last_login_at) VALUES(${u.union_id ?? null},${email},${u.name ?? null},now()) RETURNING id`;
    const token=await createSession(user!.id,userAgent,'feishu',tx,previousCookie);
    await audit(`admin:${user!.id}`,'auth.login',`session:${sha256(token)}`,null,null,{method:'feishu'},undefined,tx);
    return {token,returnTo,userId:user!.id};
  });
}

/** The single password admin: one row, found by its reserved address. */
const PASSWORD_ADMIN = "admin@local";

/** Password sign-in: a constant-time comparison of digests, so the length leaks nothing either. */
export async function passwordLogin(password: string, returnTo: string, userAgent: string | undefined,previousCookie?:string) {
  const expected = config.adminPassword;
  if (!expected || expected.length < 12) throw new LoginRejected("还没有设置管理员密码（环境变量 ADMIN_PASSWORD，至少 12 位）");
  const given = createHmac("sha256", "admin-password").update(password).digest();
  const wanted = createHmac("sha256", "admin-password").update(expected).digest();
  if (!timingSafeEqual(given, wanted)) throw new LoginRejected("密码不对");
  return sql.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(hashtext('admin-login-users'))`;
    const [user]=await tx<{id:number}[]>`INSERT INTO admin_users(email,display_name,last_login_at) VALUES(${PASSWORD_ADMIN},'管理员',now())
      ON CONFLICT(email) DO UPDATE SET last_login_at=now() RETURNING id`;
    const token=await createSession(user!.id,userAgent,'password',tx,previousCookie);
    await audit(`admin:${user!.id}`,'auth.login',`session:${sha256(token)}`,null,null,{method:'password'},undefined,tx);
    return {token,returnTo:safeReturn(returnTo),userId:user!.id};
  });
}

export async function sessionPrincipal(cookieHeader: string | undefined): Promise<AdminPrincipal | null> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) {
    const [row] = await sql<{ user_id: number; csrf_token: string; name: string | null; email: string | null;feishu_union_id:string|null;auth_method:'password'|'feishu'|null;auth_binding:string|null }[]>`
      SELECT s.user_id, s.csrf_token, u.display_name AS name, u.email,u.feishu_union_id,s.auth_method,s.auth_binding FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.id_hash = ${sha256(token)} AND s.expires_at > now()`;
    const permitted=row?.auth_method==='password'
      ? row.email===PASSWORD_ADMIN && !!config.adminPassword && config.adminPassword.length>=12
      : row?.auth_method==='feishu' && feishuLoginConfigured() && ((!!row.feishu_union_id && config.adminUnionIds.includes(row.feishu_union_id)) || (!!row.email && config.adminEmails.includes(row.email.toLowerCase())));
    if (row && permitted && row.auth_method && row.auth_binding===sessionBinding(row.auth_method)) return { userId: row.user_id, name: row.name ?? row.email ?? `admin:${row.user_id}`, csrf: row.csrf_token, dev: false };
  }
  if (config.devAdmin && config.environmentName !== "production") return { userId: null, name: config.devAdmin.displayName, csrf: "dev", dev: true };
  return null;
}

export async function endSession(cookieHeader: string | undefined) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if(token)await sql.begin(async tx=>{
    const [ended]=await tx`DELETE FROM admin_sessions WHERE id_hash=${sha256(token)} RETURNING user_id`;
    if(ended)await audit(`admin:${ended.user_id}`,'auth.logout',`session:${sha256(token)}`,null,null,{ended:true},undefined,tx);
  });
}

/** One database window for all API instances; rejected attempts cannot clear the global cap. */
export async function reservePasswordAttempt(ip:string):Promise<boolean> {
  return sql.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(hashtext('admin-password-attempts'))`;
    await tx`DELETE FROM admin_password_attempts WHERE attempted_at<=clock_timestamp()-interval '15 minutes'`;
    const [n]=await tx`SELECT count(*)::int AS total,count(*) FILTER(WHERE client_hash=${sha256(ip)})::int AS client FROM admin_password_attempts`;
    if(n!.total>=50 || n!.client>=10)return false;
    await tx`INSERT INTO admin_password_attempts(client_hash) VALUES(${sha256(ip)})`;return true;
  }) as Promise<boolean>;
}

/** Every manual change: who, when, what, why. */
export async function audit(actor: string, action: string, subject: string | null, reason: string | null, before: unknown, after: unknown, requestId?: string, db: Db = sql) {
  await db`INSERT INTO audit_log (actor, action, subject, reason, before, after, request_id)
            VALUES (${actor}, ${action}, ${subject}, ${reason}, ${before === null || before === undefined ? null : db.json(before as never)},
                    ${after === null || after === undefined ? null : db.json(after as never)}, ${requestId ?? null})`;
}

export function actorOf(p: AdminPrincipal): string {
  return p.dev ? `dev:${p.name}` : `admin:${p.userId}`;
}
