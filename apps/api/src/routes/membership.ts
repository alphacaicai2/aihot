import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "@aihot/backend/config";
import { billingConfigured } from "@aihot/backend/reader/billing";
import { upgradeReaderCookies } from "@aihot/backend/reader/google";
import {
  agentPrincipal, changeMembershipGrant, confirmReaderEmail, hasAgentToken, identityAccess, issueConfirmationCode, listMembershipGrants, memberIdentity,
  memberPrincipal, revokeAgentToken, rotateAgentToken,
} from "@aihot/backend/reader/membership";
import { applyPublicHeaders, sendProblem } from "../http/respond.ts";
import { adminHandler } from "./admin-auth.ts";

const privateCache = "private, no-store";

/** Match Fastify's resolved route template, including encoded spellings of a URL. */
export function memberOnlyRoute(route: string | undefined) {
  if (!route) return false;
  return route === "/api/v1" || route.startsWith("/api/v1/") || route === "/api/mcp" ||
    route === "/feed.xml" || route.startsWith("/feed/") || route === "/llms.txt" || route === "/openapi-v1.json" ||
    route === "/items/:id/markdown" || route === "/api/site/financing" || route.startsWith("/api/site/financing/");
}

function privateResponse(reply: FastifyReply) {
  reply.header("Cache-Control", privateCache).header("X-Accel-Expires", "0");
  reply.removeHeader("Expires");
  const vary = String(reply.getHeader("Vary") || "").split(",").map(value => value.trim()).filter(Boolean);
  for (const field of ["Cookie", "Authorization"]) if (!vary.some(value => value.toLowerCase() === field.toLowerCase())) vary.push(field);
  reply.header("Vary", vary.join(", "));
}

export function registerMembershipGuard(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!memberOnlyRoute(req.routeOptions.url) || req.method === "OPTIONS") return;
    privateResponse(reply);
    const member = req.headers.authorization !== undefined
      ? await agentPrincipal(req.headers.authorization) : await memberPrincipal(req.headers.cookie);
    if (member.access) return;
    const identified = !!member.email;
    if (req.routeOptions.url?.startsWith("/api/v1") || req.routeOptions.url === "/openapi-v1.json") applyPublicHeaders(reply);
    if (!identified) reply.header("WWW-Authenticate", 'Bearer realm="Caolu Membership"');
    return sendProblem(req, reply, {
      status: identified ? 403 : 401, code: identified ? "membership_required" : "unauthorized",
      detail: identified ? "此功能需要会员权限。" : "请登录会员账户或提供有效的 Agent 令牌。", cacheControl: privateCache,
    });
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (memberOnlyRoute(req.routeOptions.url)) privateResponse(reply);
    return payload;
  });
}

export function registerMembership(app: FastifyInstance) {
  app.get("/api/reader/membership", async (req, reply) => {
    privateResponse(reply);
    const identity = await memberIdentity(req.headers.cookie);
    if (identity && "reader" in identity) {
      const upgrade = upgradeReaderCookies(req.headers.cookie, identity.reader.expires_at);
      if (upgrade) reply.header("Set-Cookie", upgrade);
    }
    return { ...await identityAccess(identity), hasToken: identity ? await hasAgentToken(identity) : false, billingReady: billingConfigured() };
  });
  app.route({
    method: ["POST", "DELETE"], url: "/api/reader/membership/token",
    handler: async (req, reply) => {
      privateResponse(reply);
      if (req.headers.origin !== new URL(config.siteUrl).origin) return reply.code(403).send({ error: "请求来源无效" });
      const identity = await memberIdentity(req.headers.cookie);
      if (!identity) return reply.code(401).send({ error: "请先登录" });
      if (req.method === "DELETE") {
        await revokeAgentToken(identity);
        return { ok: true };
      }
      if (!(await identityAccess(identity)).access) return reply.code(403).send({ error: "此功能需要会员权限" });
      return { token: await rotateAgentToken(identity) };
    },
  });
  app.post("/api/reader/membership/confirm", async (req, reply) => {
    privateResponse(reply);
    if (req.headers.origin !== new URL(config.siteUrl).origin) return reply.code(403).send({ error: "请求来源无效" });
    const identity = await memberIdentity(req.headers.cookie);
    if (!identity || !("reader" in identity)) return reply.code(401).send({ error: "请使用 Google 登录该邮箱" });
    const code = (req.body as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !await confirmReaderEmail(identity.reader, code.trim())) {
      return reply.code(400).send({ error: "确认码无效或已过期，请核对登录邮箱及确认码。" });
    }
    return { ok: true };
  });
  app.post("/api/admin/memberships/code", adminHandler(async (req, reply, admin) => {
    const email = grantEmail(req.body);
    if (!email) return reply.code(400).send({ error: "请输入有效的邮箱地址。" });
    const result = await issueConfirmationCode(email, admin, req.id);
    if (!result) return reply.code(400).send({ error: "请先为该邮箱添加免订阅授权。" });
    return result;
  }));
  app.get("/api/admin/memberships", adminHandler(async () => ({ members: await listMembershipGrants() })));
  app.route({
    method: ["POST", "DELETE"], url: "/api/admin/memberships",
    handler: adminHandler(async (req, reply, admin) => {
      const email = grantEmail(req.body);
      if (!email) {
        return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "请输入有效的邮箱地址。" });
      }
      await changeMembershipGrant(email, req.method === "POST", admin, req.id);
      return { ok: true };
    }),
  });
}

function grantEmail(body: unknown) {
  const value = (body as {email?: unknown} | null)?.email;
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
