import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { cookie, parseCookies } from "../lib/cookies.ts";
import { sha256 } from "../lib/ids.ts";

import { recordGoogleEmail } from "./email-ownership.ts";

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
export const CALLBACK_PATH = "/api/reader/google/callback";
export const SESSION_SECONDS = 30 * 86400;
const flowAudience = "reader-google-login";
const randomToken = () => randomBytes(32).toString("base64url");

function settings() {
  const clientId = credential("integrations", "GOOGLE_CLIENT_ID");
  const clientSecret = credential("integrations", "GOOGLE_CLIENT_SECRET");
  const signingKey = credential("auth", "SESSION_SECRET");
  return clientId && clientSecret && signingKey ? {
    clientId, clientSecret, signingKey: Buffer.from(signingKey), redirectUri: config.siteUrl + CALLBACK_PATH,
  } : null;
}

export const googleLoginEnabled = () => settings() !== null;

export async function startGoogleLogin(destination?: string) {
  const opts = settings();
  if (!opts) return null;
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const flow = await new SignJWT({ state, nonce, verifier, returnTo: destination === "/membership" ? destination : "/" }).setProtectedHeader({ alg: "HS256" })
    .setAudience(flowAudience).setExpirationTime("10m").sign(opts.signingKey);
  const params = new URLSearchParams({
    client_id: opts.clientId, redirect_uri: opts.redirectUri, response_type: "code", scope: "openid email",
    state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  return { flow, url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
}

export async function finishGoogleLogin(code: string, state: string, flow: string | undefined) {
  const opts = settings();
  if (!opts || !code || !state || !flow) throw new Error("Missing Google login request");
  const { payload: request } = await jwtVerify(flow, opts.signingKey, { algorithms: ["HS256"], audience: flowAudience });
  if (request.state !== state || typeof request.verifier !== "string" || typeof request.nonce !== "string") throw new Error("Invalid Google login request");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: opts.clientId, client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri, code, code_verifier: request.verifier,
    }),
  });
  if (!response.ok) throw new Error("Google token exchange failed");
  const { id_token } = await response.json() as { id_token?: string };
  if (typeof id_token !== "string") throw new Error("Missing Google ID token");
  const { payload } = await jwtVerify(id_token, googleKeys, {
    algorithms: ["RS256"], issuer: ["accounts.google.com", "https://accounts.google.com"], audience: opts.clientId,
    requiredClaims: ["exp", "iat", "sub", "nonce"],
  });
  if (payload.nonce !== request.nonce || (payload.azp !== undefined && payload.azp !== opts.clientId)
      || !payload.sub || payload.email_verified !== true || typeof payload.email !== "string" || !payload.email) {
    throw new Error("Invalid Google reader identity");
  }

  const subject = payload.sub;
  const email = payload.email;
  const token = randomToken();
  await sql.begin(async tx => {
    await tx`DELETE FROM reader_sessions WHERE expires_at <= now()`;
    await recordGoogleEmail(tx, subject, email, payload.hd);
    await tx`INSERT INTO reader_sessions (id_hash, google_subject, expires_at)
             VALUES (${sha256(token)}, ${subject}, ${new Date(Date.now() + SESSION_SECONDS * 1000)})`;
  });
  return { token, returnTo: request.returnTo === "/membership" ? "/membership" : "/" };
}

const legacySessionName = "reader_session";
const rootSessionName = config.siteUrl.startsWith("https://") ? "__Host-caolu_reader" : "caolu_reader";
const secureCookies = config.siteUrl.startsWith("https://");

export function readerSessionCookies(token: string, seconds: number) {
  return [cookie(rootSessionName, token, seconds, secureCookies), cookie(legacySessionName, "", 0, secureCookies, "/api/reader")];
}

export function readerTokens(header: string | undefined) {
  const cookies = parseCookies(header);
  return { root: cookies[rootSessionName], legacy: cookies[legacySessionName] };
}

export async function readerSession(header: string | undefined) {
  const { root, legacy } = readerTokens(header);
  const token = root || legacy;
  if (!token) return null;
  const [reader] = await sql<{ google_subject: string; email: string; expires_at: Date }[]>`
    SELECT google_subject, email, expires_at FROM reader_sessions JOIN readers USING (google_subject)
    WHERE id_hash = ${sha256(token)} AND expires_at > now()`;
  return reader ?? null;
}

/** Old cookies were sent only to /api/reader; promote a valid one without extending its original expiry. */
export function upgradeReaderCookies(header: string | undefined, expiresAt: Date) {
  const { root, legacy } = readerTokens(header);
  if (!legacy || root) return null;
  return readerSessionCookies(legacy, Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
}

export async function logoutReader(token: string | undefined) {
  if (token) await sql`DELETE FROM reader_sessions WHERE id_hash = ${sha256(token)}`;
}
