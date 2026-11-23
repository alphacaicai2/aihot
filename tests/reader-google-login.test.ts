import "./setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../apps/api/src/app.ts";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { tag } from "./setup.ts";

const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

test("Google sign-in creates only a reader session and logout revokes it", async t => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.deepEqual((await app.inject("/api/reader/me")).json(), { enabled: false, email: null });
  assert.equal((await app.inject("/api/reader/google")).headers.location, "/#google-login-unavailable");

  const client = "test-reader-client";
  process.env.GOOGLE_CLIENT_ID = client;
  process.env.GOOGLE_CLIENT_SECRET = "test-reader-secret";
  const destination = "/financing/company?" + new URLSearchParams({ name: "公司", list: "investor=A%2BB", cursor: "old" });
  const start = await app.inject("/api/reader/google?" + new URLSearchParams({ return: destination }));
  const google = new URL(String(start.headers.location));
  const params = google.searchParams;
  assert.equal(google.origin, "https://accounts.google.com");
  assert.equal(params.get("scope"), "openid email");
  assert.equal(params.get("redirect_uri"), config.siteUrl + "/api/reader/google/callback");
  assert.equal(params.get("code_challenge_method"), "S256");
  const flow = start.cookies[0]!;
  assert.equal(flow.httpOnly, true);
  const cookies = { [flow.name]: flow.value };
  const callback = "/api/reader/google/callback?code=test-code&state=";
  assert.equal((await app.inject({ url: callback + "wrong", cookies })).headers.location, "/#google-login-failed");
  assert.equal((await app.inject(callback + params.get("state"))).headers.location, "/#google-login-failed");

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const subject = tag();
  const email = subject + "@example.com";
  let nonce = "wrong";
  let audience = client;
  let verified = true;
  let hd: string | undefined;
  t.mock.method(globalThis, "fetch", async (input: URL | string, init?: RequestInit) => {
    if (String(input) === "https://www.googleapis.com/oauth2/v3/certs") {
      return Response.json({ keys: [{ ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" }] });
    }
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    const body = init!.body as URLSearchParams;
    assert.equal(body.get("client_id"), client);
    assert.equal(body.get("code"), "test-code");
    assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), params.get("code_challenge"));
    const token = await new SignJWT({ email, email_verified: verified, nonce, hd })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuedAt().setExpirationTime("5m")
      .setSubject(subject).setIssuer("https://accounts.google.com").setAudience(audience).sign(privateKey);
    return Response.json({ id_token: token });
  });
  const finish = () => app.inject({ url: callback + params.get("state"), cookies });
  assert.equal((await finish()).headers.location, "/#google-login-failed");
  nonce = params.get("nonce")!;
  audience = "another-client";
  assert.equal((await finish()).headers.location, "/#google-login-failed");
  audience = client;
  verified = false;
  assert.equal((await finish()).headers.location, "/#google-login-failed");
  verified = true;
  const result = await finish();
  assert.equal(result.headers.location, destination);
  assert.equal(result.cookies.find(c => c.name === flow.name)?.maxAge, 0);
  const session = result.cookies.find(c => c.name === (config.siteUrl.startsWith("https://") ? "__Host-caolu_reader" : "caolu_reader"))!;
  assert.equal(session.httpOnly, true);
  assert.equal(session.path, "/");
  const readerCookies = { [session.name]: session.value };
  const me = () => app.inject({ url: "/api/reader/me", cookies: readerCookies });
  assert.deepEqual((await me()).json(), { enabled: true, email });
  const member = () => app.inject({ url: "/api/reader/membership", cookies: readerCookies });
  assert.equal((await member()).json().emailConfirmed, false);
  hd = "example.com";
  assert.equal((await finish()).headers.location, destination);
  assert.equal((await member()).json().emailConfirmed, true);
  assert.equal((await me()).headers["cache-control"], "private, no-store");
  assert.equal((await app.inject({ url: "/api/auth/check", cookies: readerCookies })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/reader/logout", cookies: readerCookies, headers: { origin: "https://elsewhere.example" } })).statusCode, 403);
  assert.equal((await me()).json().email, email);
  assert.equal((await app.inject({ method: "POST", url: "/api/reader/logout", cookies: readerCookies, headers: { origin: new URL(config.siteUrl).origin } })).statusCode, 303);
  assert.equal((await me()).json().email, null);
  await sql`DELETE FROM readers WHERE google_subject = ${subject}`;
});
