import type { FastifyInstance } from "fastify";
import { config } from "@aihot/backend/config";
import { cookie, parseCookies } from "@aihot/backend/lib/cookies";
import { CALLBACK_PATH, finishGoogleLogin, googleLoginEnabled, logoutReader, readerSession, readerSessionCookies, readerTokens, upgradeReaderCookies, SESSION_SECONDS, startGoogleLogin } from "@aihot/backend/reader/google";

const secure = config.siteUrl.startsWith("https://");
const flowName = "reader_google_flow";
const flowCookie = (value: string, seconds: number) => cookie(flowName, value, seconds, secure, CALLBACK_PATH);

export async function registerReaderAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
  });

  app.get("/api/reader/me", async (req, reply) => {
    const reader = await readerSession(req.headers.cookie);
    const upgrade = reader && upgradeReaderCookies(req.headers.cookie, reader.expires_at);
    if (upgrade) reply.header("Set-Cookie", upgrade);
    return { enabled: googleLoginEnabled(), email: reader?.email ?? null };
  });

  app.get<{ Querystring: { return?: string } }>("/api/reader/google", async (req, reply) => {
    const start = await startGoogleLogin(req.query.return);
    if (!start) return reply.redirect("/#google-login-unavailable");
    return reply.header("Set-Cookie", flowCookie(start.flow, 600)).redirect(start.url);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(CALLBACK_PATH, async (req, reply) => {
    reply.header("Set-Cookie", flowCookie("", 0));
    if (req.query.error === "access_denied") return reply.redirect("/");
    try {
      const { token, returnTo } = await finishGoogleLogin(req.query.code ?? "", req.query.state ?? "", parseCookies(req.headers.cookie)[flowName]);
      reply.header("Set-Cookie", readerSessionCookies(token, SESSION_SECONDS));
      return reply.redirect(returnTo);
    } catch {
      return reply.redirect("/#google-login-failed");
    }
  });

  app.post("/api/reader/logout", async (req, reply) => {
    if (req.headers.origin !== new URL(config.siteUrl).origin) return reply.code(403).send();
    const { root, legacy } = readerTokens(req.headers.cookie);
    await Promise.all([logoutReader(root), logoutReader(legacy)]);
    return reply.header("Set-Cookie", readerSessionCookies("", 0)).redirect("/", 303);
  });
}
