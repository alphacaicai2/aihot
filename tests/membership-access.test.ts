import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

if (!/_(test|ci)$/.test(new URL(process.env.DATABASE_URL || "postgres://localhost/unset").pathname)) throw Error("Use a dedicated test database");
process.env.COLLECT_ENABLED = process.env.MODEL_CALLS_ENABLED = process.env.FEISHU_INTERNAL_ENABLED = "false";
process.env.ADMIN_PASSWORD = "test-membership-local-pass";
process.env.SESSION_SECRET = "local-membership-testing-secret";
process.env.SITE_URL = "https://membership.example.test";
delete process.env.DEV_AUTH_ROLE;
const { buildApp } = await import("../apps/api/src/app.ts");
const { passwordLogin, sessionPrincipal } = await import("@aihot/backend/admin/auth");
const { config } = await import("@aihot/backend/config");
const { sql, closeDb } = await import("@aihot/backend/db");
const { sha256 } = await import("@aihot/backend/lib/ids");
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });
const origin = "https://membership.example.test";

test("all membership exports authenticate before sending data and keep membership traffic private", async () => {
  for (const [url, method] of [
    ["/api/mcp", "POST"], ["/api/v1/financing?format=csv", "GET"], ["/api/site/financing/investors", "GET"],
    ["/api/v1/items", "HEAD"], ["/feed.xml", "GET"], ["/feed/full/category/tech.xml", "GET"],
    ["/llms.txt", "GET"], ["/openapi-v1.json", "GET"], ["/items/test-item/markdown", "GET"],
  ] as const) {
    const r = await app.inject({ method, url, headers: { "if-none-match": "*" } });
    assert.equal(r.statusCode, 401, url);
    assert.equal(r.headers["cache-control"], "private, no-store", url);
  }
  const preflight = await app.inject({ url: "/api/v1/items", method: "OPTIONS" });
  assert.equal(preflight.statusCode, 204);
  assert.match(String(preflight.headers["access-control-allow-headers"]), /Authorization/i);
  assert.equal((await app.inject("/api/site/meta")).statusCode, 200);
});

test("verified readers, legacy cookies, email grants, paid expiry, revocation and real admin credentials", async () => {
  const id = randomUUID();
  const email = id + "@example.test";
  const session = randomUUID();
  const userCookie = { "__Host-caolu_reader": session };
  const readerHeaders = { cookie: "__Host-caolu_reader=" + session, origin };
  await sql`INSERT INTO readers (google_subject,email) VALUES (${id},${email.toUpperCase()})`;
  await sql`INSERT INTO reader_email_bindings(email,google_subject,method) VALUES (${email},${id},'google')`;
  await sql`INSERT INTO reader_sessions VALUES (${sha256(session)}, ${id}, now()+interval '1 day')`;
  const { token: adminToken } = await passwordLogin(config.adminPassword!, "/admin", undefined);
  const adminCookie = "aihot_admin=" + adminToken;
  const admin = await sessionPrincipal(adminCookie);
  const adminHeaders = { cookie: adminCookie, "x-csrf-token": admin!.csrf, origin };

  try {
    const migrated = await app.inject({ url: "/api/reader/me", cookies: { reader_session: session } });
    assert(migrated.cookies.some(c => c.name === "__Host-caolu_reader" && c.path === "/" && c.secure && c.httpOnly));
    assert(migrated.cookies.some(c => c.name === "reader_session" && c.path === "/api/reader" && c.maxAge === 0));
    const membership = () => app.inject({ url: "/api/reader/membership", cookies: userCookie });
    const content = (headers: Record<string, string>) => app.inject({ url: "/api/v1/financing?format=csv", headers });
    const rotate = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/reader/membership/token", headers });
    const grant = (method: "POST" | "DELETE") => app.inject({ method, url: "/api/admin/memberships", headers: adminHeaders, payload: { email: "  " + email.toUpperCase() + " " } });
    assert.equal((await membership()).json().access, false);
    assert.equal((await content(readerHeaders)).statusCode, 403);
    assert.equal((await rotate(readerHeaders)).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/memberships", headers: { cookie: adminCookie }, payload: { email } })).statusCode, 403);
    assert.equal((await grant("POST")).statusCode, 200);
    assert.equal((await membership()).json().source, "grant");
    assert.equal((await content(readerHeaders)).headers["cache-control"], "private, no-store");
    assert.equal((await content(readerHeaders)).statusCode, 200);
    assert.equal((await rotate({ ...readerHeaders, origin: "https://other.example" })).statusCode, 403);
    const first = (await rotate(readerHeaders)).json().token;
    const key = (await rotate(readerHeaders)).json().token;
    assert.notEqual(first, key);
    const bearer = { authorization: "Bearer " + key };
    assert.equal((await content({ authorization: "Bearer " + first })).statusCode, 401);
    assert.equal((await content(bearer)).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/admin/me", headers: bearer })).statusCode, 401);
    assert.equal((await grant("DELETE")).statusCode, 200);
    assert.equal((await content(bearer)).statusCode, 403);
    const customer = "cus_" + id;
    await sql`INSERT INTO reader_billing_accounts (google_subject,email,stripe_customer) VALUES(${id},${email},${customer})`;
    await sql`INSERT INTO reader_billing_subscriptions(stripe_subscription,stripe_customer,status,paid_until)
              VALUES (${id},${customer},'active',now()+interval '30 days')`;
    assert.equal((await membership()).json().source, "subscription");
    assert.equal((await content(bearer)).statusCode, 200);
    await sql`UPDATE reader_billing_subscriptions SET paid_until=now()-interval '1 second' WHERE stripe_subscription=${id}`;
    assert.equal((await content(bearer)).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/reader/membership/token", headers: readerHeaders })).statusCode, 200);
    assert.equal((await content(bearer)).statusCode, 401);

    config.adminEmails.push(email);
    assert.deepEqual([(await membership()).json().source,(await membership()).json().admin], ["admin",false]);
    assert.equal((await app.inject({ url: "/api/admin/me", cookies: userCookie })).statusCode, 401);
    const adminMembership = await app.inject({ url: "/api/reader/membership", headers: adminHeaders });
    assert.deepEqual([adminMembership.json().source,adminMembership.json().admin], ["admin",true]);
    const adminKey = (await rotate(adminHeaders)).json().token;
    assert.equal((await content({ authorization: "Bearer " + adminKey })).statusCode, 200);
    const oldPass = config.adminPassword;
    try {
      config.adminPassword = "new-test-membership-credentials";
      assert.equal((await content({ authorization: "Bearer " + adminKey })).statusCode, 401);
    } finally { config.adminPassword = oldPass; }
  } finally {
    config.adminEmails = config.adminEmails.filter(e => e !== email);
    await sql`DELETE FROM reader_billing_subscriptions WHERE stripe_subscription=${id}`;
    await sql`DELETE FROM reader_billing_accounts WHERE google_subject=${id}`;
    await sql`DELETE FROM membership_grants WHERE email=${email}`;
    await sql`DELETE FROM membership_agent_tokens WHERE admin_user_id=${admin!.userId}`;
    await sql`DELETE FROM admin_sessions WHERE id_hash=${sha256(adminToken)}`;
    await sql`DELETE FROM readers WHERE google_subject=${id}`;
  }
});

test("legacy local admin sessions bind on first use and continue to respect credential rotation", async () => {
  const { token } = await passwordLogin(config.adminPassword!, "/admin", undefined);
  const hash = sha256(token);
  const header = "aihot_admin=" + token;
  try {
    await sql`UPDATE admin_sessions SET auth_binding='pre-membership-migration' WHERE id_hash=${hash}`;
    assert(await sessionPrincipal(header));
    const [row] = await sql`SELECT auth_binding FROM admin_sessions WHERE id_hash=${hash}`;
    assert.match(row!.auth_binding, /^[a-f0-9]{64}$/);
    await sql`UPDATE admin_sessions SET auth_method=NULL, auth_binding=NULL WHERE id_hash=${hash}`;
    assert.equal(await sessionPrincipal(header), null);
  } finally {
    await sql`DELETE FROM admin_sessions WHERE id_hash=${hash}`;
  }
});

test("email privileges have one proven owner, while a third-party Google login can keep its personal subscription", async () => {
  const { recordGoogleEmail } = await import("../packages/backend/src/reader/email-ownership.ts");
  const email = randomUUID() + "@thirdparty.test";
  const replacementEmail = randomUUID() + "@gmail.com";
  const original = randomUUID(), successor = randomUUID(), firstBuyer = randomUUID();
  const adminLogin = await passwordLogin(config.adminPassword!, "/admin", undefined);
  const cookie = "aihot_admin=" + adminLogin.token;
  const admin = await sessionPrincipal(cookie);
  const adminHeaders = { cookie, "x-csrf-token": admin!.csrf, origin };
  async function login(subject: string, address: string, hd?: string) {
    const session = randomUUID();
    await sql.begin(async tx => {
      await recordGoogleEmail(tx, subject, address, hd);
      await tx`INSERT INTO reader_sessions VALUES (${sha256(session)}, ${subject}, now()+interval '1 day')`;
    });
    return { cookie: "__Host-caolu_reader=" + session, origin };
  }
  const adminCode = (address: string) => app.inject({ method: "POST", url: "/api/admin/memberships/code", headers: adminHeaders, payload: {email: address} });
  const status = async (headers: {cookie: string}) => (await app.inject({ url: "/api/reader/membership", headers })).json();
  const confirm = (headers: {cookie: string}, code: string) => app.inject({ method: "POST", url: "/api/reader/membership/confirm", headers, payload: {code} });
  const rotate = async (headers: {cookie: string}) => (await app.inject({ method: "POST", url: "/api/reader/membership/token", headers })).json().token;
  const agentRead = async (key: string) => (await app.inject({url: "/api/v1/financing", headers: { authorization: "Bearer " + key }})).statusCode;

  try {
    const old = await login(original, email);
    const next = await login(successor, email);
    assert.equal((await adminCode(email)).statusCode,400);
    await sql`INSERT INTO membership_grants(email) VALUES (${email}),(${replacementEmail})`;
    assert.equal((await status(old)).emailConfirmed,false);
    assert.equal((await status(old)).access,false);
    const oldCode = (await adminCode(email)).json().code;
    const code = (await adminCode(email.toUpperCase())).json().code;
    assert.notEqual(code, oldCode);
    assert.equal((await confirm(old, oldCode)).statusCode,400);
    const other = await login(firstBuyer, randomUUID() + "@other.test");
    assert.equal((await confirm(other, code)).statusCode,400);
    const answers = await Promise.all([confirm(old, code),confirm(old, code)]);
    assert.deepEqual(answers.map(v=>v.statusCode).sort(),[200,400]);
    assert.equal((await status(old)).source,"grant");
    assert.equal((await status(next)).access,false);
    const key = await rotate(old);
    assert.equal(await agentRead(key),200);

    // A fresh authoritative Workspace token transfers the mailbox atomically.
    const workspace = await login(successor, email,"thirdparty.test");
    assert.equal((await status(old)).email,null);
    assert.equal(await agentRead(key),401);
    assert.equal((await status(workspace)).source,"grant");
    assert.equal((await confirm(workspace,code)).statusCode,400);
    const inWorkspace = await rotate(workspace);

    // Removing hd disables the stale Google proof, even with email_verified=true.
    const unmanaged = await login(successor, email);
    assert.equal((await status(unmanaged)).access,false);
    assert.equal(await agentRead(inWorkspace),403);
    config.adminEmails.push(email);
    assert.equal((await status(unmanaged)).access,false);
    const expired = (await adminCode(email)).json().code;
    await sql`UPDATE membership_confirmation_codes SET expires_at=now() WHERE email=${email}`;
    assert.equal((await confirm(unmanaged, expired)).statusCode,400);
    assert.equal((await confirm(unmanaged,(await adminCode(email)).json().code)).statusCode,200);
    assert.equal((await status(unmanaged)).source,"admin");
    // A changed mailbox invalidates old browser and Agent credentials before it receives grants.
    const renamed = await login(successor,replacementEmail);
    assert.equal((await status(renamed)).emailConfirmed,true);
    assert.equal((await status(renamed)).source,"grant");
    assert.equal((await status(unmanaged)).email,null);
    assert.equal(await agentRead(inWorkspace),401);
    const originalBuyer = await login(original, email);
    await sql`INSERT INTO reader_billing_accounts(google_subject,email,stripe_customer) VALUES(${original},${email},${"cus_"+original})`;
    await sql`INSERT INTO reader_billing_subscriptions(stripe_subscription,stripe_customer,status,paid_until)
      VALUES(${original},${"cus_"+original},'active',now()+interval '1 month')`;
    assert.equal((await status(originalBuyer)).source,"subscription");
    const sharedEmail = await login(firstBuyer,email);
    assert.equal((await status(sharedEmail)).access,false);
    assert.equal((await status(sharedEmail)).customer,false);
  } finally {
    config.adminEmails=config.adminEmails.filter(e=>e!==email);
    await sql`DELETE FROM reader_billing_subscriptions WHERE stripe_subscription=${original}`;
    await sql`DELETE FROM reader_billing_accounts WHERE google_subject=${original}`;
    await sql`DELETE FROM membership_confirmation_codes WHERE email IN (${email},${replacementEmail})`;
    await sql`DELETE FROM membership_grants WHERE email IN (${email},${replacementEmail})`;
    await sql`DELETE FROM readers WHERE google_subject IN (${original},${successor},${firstBuyer})`;
    await sql`DELETE FROM admin_sessions WHERE id_hash=${sha256(adminLogin.token)}`;
  }
});
