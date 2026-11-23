import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { checkoutDestinationKey, memberDestination, membershipOffer } from "@aihot/contracts/member-destination";
import { packDestination } from "@aihot/contracts/member-destination.server";
import { cookie } from "@aihot/backend/lib/cookies";
import { config } from "@aihot/backend/config";
import { memberIdentity, identityAccess } from "@aihot/backend/reader/membership";
import { billingCheckout, billingPortal, InvalidStripeWebhook, processBillingWebhook } from "@aihot/backend/reader/billing";

export async function registerBilling(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
  });

  async function changeBilling(req: FastifyRequest, reply: FastifyReply, checkout: boolean) {
    if (req.headers.origin !== new URL(config.siteUrl).origin) return reply.code(403).send();
    const target = memberDestination((req.query as { return?: string }).return);
    const identity = await memberIdentity(req.headers.cookie);
    if (!identity) return reply.redirect(membershipOffer(target, ["billing", "login"]), 303);
    if ("administrator" in identity || (checkout && (await identityAccess(identity)).access)) return reply.redirect(target ?? "/membership", 303);
    const reader = identity.reader;
    try {
      const url = await (checkout ? billingCheckout(reader.google_subject, reader.email, target) : billingPortal(reader.google_subject, target));
      // Checkout URLs are immutable and a reader can resume an existing open Stripe session.
      // Keep its navigation context on this site, independently of Stripe's idempotency key.
      if (checkout) reply.header("Set-Cookie", cookie(checkoutDestinationKey, target ? packDestination(target) : "", target ? 86400 : 0,
        config.siteUrl.startsWith("https://"), "/membership"));
      return reply.redirect(url, 303);
    } catch {
      req.log.warn({ operation: checkout ? "checkout" : "portal" }, "Stripe billing unavailable");
      return reply.redirect(membershipOffer(target, ["billing", "unavailable"]), 303);
    }
  }
  app.post("/api/reader/billing/checkout", (req, reply) => changeBilling(req, reply, true));
  app.post("/api/reader/billing/portal", (req, reply) => changeBilling(req, reply, false));

  // Keep raw bytes for Stripe's signature only in the encapsulated webhook route.
  app.register(async webhook => {
    webhook.removeContentTypeParser("application/json");
    webhook.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 },
      (_req, body, done) => done(null, body));
    webhook.post("/api/reader/billing/webhook", async (req, reply) => {
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) return reply.code(400).send();
      try {
        await processBillingWebhook(req.body, signature);
      } catch (error) {
        if (error instanceof InvalidStripeWebhook) return reply.code(400).send();
        req.log.warn("Stripe webhook processing will be retried");
        return reply.code(503).send();
      }
      return reply.code(200).send({ received: true });
    });
  });
}
