import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { billingCheckout, billingPortal, billingStatus, InvalidStripeWebhook, processBillingWebhook } from "../packages/backend/src/reader/billing.ts";
import Fastify from "fastify";
import { registerBilling } from "../apps/api/src/routes/billing.ts";
import { config } from "../packages/backend/src/config.ts";
import { sql, closeDb } from "../packages/backend/src/db.ts";

if (!/_(test|ci)$/.test(new URL(process.env.DATABASE_URL ?? "http://invalid").pathname)) {
  throw new Error("Run Stripe billing tests against a dedicated _test or _ci database");
}

test("verified Stripe customers, concurrent Checkout, signed and reordered membership events", async t => {
  const tag = randomUUID().replaceAll("-", "");
  const email = "billing+" + tag + "@example.test";
  const subject = "reader-" + tag;
  const successor = "successor-" + tag;
  const customer = "cus_" + tag;
  const priceId = "price_" + tag;
  const subscription = "sub_" + tag;
  const item = "si_" + tag;
  const checkout = "cs_" + tag;
  const webhookSecret = "whsec_offline_" + tag;
  process.env.STRIPE_SECRET_KEY = "sk_test_offline";
  process.env.STRIPE_PRICE_ID = priceId;
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  const start = Math.floor(Date.now() / 1000);
  const periodEnd = start + 30 * 86400;
  const price = { id: priceId, active: true, currency: "usd", unit_amount: 500, billing_scheme: "per_unit",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } };
  let sessionStatus = "open";
  let subscriptionStatus = "active";
  let invoiceStatus = "open";
  let invoicePaid = 0;
  let end = periodEnd;
  let customerRequests = 0, checkoutRequests = 0, subscriptionReads = 0;
  const checkoutUrl = "https://checkout.stripe.com/c/pay/offline";
  const portalUrl = "https://billing.stripe.com/p/session/offline";
  t.mock.method(globalThis, "fetch", async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(url.origin, "https://api.stripe.com");
    const params = new URLSearchParams(String(init?.body ?? ""));
    const path = url.pathname;
    if (path === "/v1/prices/" + priceId) return Response.json(price);
    if (path === "/v1/customers") {
      customerRequests++;
      assert.equal(params.get("email"), email);
      assert.ok(new Headers(init?.headers).get("idempotency-key"));
      return Response.json({id:customer});
    }
    if (path === "/v1/checkout/sessions") {
      checkoutRequests++;
      assert.equal(params.get("customer"),customer);
      assert.equal(params.get("mode"),"subscription");
      assert.equal(params.get("success_url"),config.siteUrl + "/membership?checkout=success");
      assert.equal(params.get("cancel_url"),config.siteUrl + "/membership?checkout=canceled");
      assert.equal(params.get("line_items[0][price]"),priceId);
      assert.equal(params.get("subscription_data[metadata][application]"),"caolu_reader_membership_v1");
      assert.ok(new Headers(init?.headers).get("idempotency-key"));
      return Response.json({id:checkout,url:checkoutUrl});
    }
    if (path === "/v1/checkout/sessions/" + checkout) return Response.json({
      customer, status: sessionStatus, url: checkoutUrl, subscription: {id:subscription,status:subscriptionStatus},
    });
    if (path === "/v1/billing_portal/sessions") {
      assert.equal(params.get("customer"), customer);
      return Response.json({url:portalUrl});
    }
    if (path === "/v1/subscriptions/" + subscription) {
      subscriptionReads++;
      return Response.json({
        id: subscription, customer, status: subscriptionStatus, metadata: {application:"caolu_reader_membership_v1"},
        items: {data:[{id:item,price,quantity:1,current_period_end:end}]},
        latest_invoice: { id:"in_test",customer,currency:"usd",status:invoiceStatus, amount_paid:invoicePaid,
          parent:{subscription_details:{subscription}},lines:{data:[{period:{end},quantity:1,amount:500,
            pricing:{price_details:{price:priceId}},parent:{subscription_item_details:{subscription_item:item,proration:false}}}]}}
      });
    }
    throw Error("Unexpected external call in Stripe test");
  });
  const signed = (id: string, type = "customer.subscription.updated", object = {id:subscription, customer}) => {
    const raw = Buffer.from(JSON.stringify({ object: "event", livemode:false, id:"evt_"+tag+id, type, data:{object} }));
    const timestamp = String(Math.floor(Date.now()/1000));
    const digest = createHmac("sha256",webhookSecret).update(timestamp+".").update(raw).digest("hex");
    return { raw, signature: "t="+timestamp+",v1="+digest };
  };
  const event = (id:string, type?:string) => {
    const {raw,signature} = signed(id,type);
    return processBillingWebhook(raw,signature);
  };
  const app = Fastify();
  app.register(registerBilling);
  try {
    await sql`INSERT INTO readers (google_subject,email) VALUES (${subject},${email}),(${successor},${email})`;
    const checkoutPath = "/api/reader/billing/checkout";
    assert.equal((await app.inject({ method: "POST", url: checkoutPath, headers: { origin: "https://other.example" } })).statusCode, 403);
    const guest = await app.inject({ method: "POST", url: checkoutPath,
      headers: { origin: new URL(config.siteUrl).origin }, payload: { email } });
    assert.equal(guest.statusCode, 303);
    assert.equal(guest.headers.location, "/membership?billing=login");
    const target = "/agent?tab=rss";
    const continued = await app.inject({ method: "POST", url: checkoutPath + "?" + new URLSearchParams({ return: target }),
      headers: { origin: new URL(config.siteUrl).origin } });
    assert.equal(new URL(continued.headers.location!, config.siteUrl).searchParams.get("return"), target);
    assert.deepEqual(await billingStatus(subject), {customer:false,subscribed:false});
    price.unit_amount = 700;
    await assert.rejects(billingCheckout(subject, email),/Invalid Stripe membership price/);
    assert.equal(customerRequests, 0);
    price.unit_amount = 500;
    assert.deepEqual(await Promise.all([billingCheckout(subject, email.toUpperCase()),billingCheckout(subject, email)]),[checkoutUrl,checkoutUrl]);
    assert.equal(customerRequests,1);
    assert.equal(checkoutRequests,1);
    const token = randomUUID();
    await sql`INSERT INTO reader_sessions (id_hash,google_subject,expires_at)
      VALUES (${createHash("sha256").update(token).digest("hex")}, ${subject}, now()+interval '1 hour')`;
    const restart = await app.inject({ method: "POST", url: checkoutPath + "?" + new URLSearchParams({ return: target }),
      cookies: { [config.siteUrl.startsWith("https://") ? "__Host-caolu_reader" : "caolu_reader"]: token },
      headers: { origin: new URL(config.siteUrl).origin } });
    assert.equal(restart.headers.location,checkoutUrl);
    const continuation = restart.cookies.find(c => c.name === "caolu_checkout_return")!;
    assert.equal(decodeURIComponent(continuation.value),target);
    assert.equal(continuation.httpOnly,true);
    assert.equal(continuation.path,"/membership");
    assert.equal(checkoutRequests,1);
    sessionStatus = "complete";
    assert.equal(await billingCheckout(subject, email),portalUrl);
    assert.equal(await billingPortal(subject),portalUrl);
    assert.equal(checkoutRequests,1);
    assert.deepEqual(await billingStatus(subject),{customer:true,subscribed:false});

    const forged = signed("invalid");
    await assert.rejects(processBillingWebhook(forged.raw,"t=0,v1=invalid"),InvalidStripeWebhook);
    await assert.rejects(processBillingWebhook(Buffer.concat([forged.raw, Buffer.from(" ")]),forged.signature),InvalidStripeWebhook);
    assert.equal(subscriptionReads,0);

    // Even an active subscription with an open invoice, observed twice, grants no paid period.
    await event("unpaid-1");
    await event("unpaid-2");
    assert.equal((await billingStatus(subject)).subscribed,false);
    invoiceStatus = "paid";
    invoicePaid = 500;
    const before = subscriptionReads;
    const invoicePayload = {
      object: "event", id: "evt_" + tag + "invoice", livemode: false, type: "invoice.paid",
      data: { object: { customer, parent: { subscription_details: { subscription } } } },
    };
    const raw = JSON.stringify(invoicePayload, null, 2);
    const digest = createHmac("sha256", webhookSecret).update(String(start) + "." + raw).digest("hex");
    const webhook = { method: "POST" as const, url: "/api/reader/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": "t="+start+",v1="+digest }, payload: raw };
    assert.equal((await app.inject({ ...webhook, payload: raw + " " })).statusCode, 400);
    const results = await Promise.all([app.inject(webhook), app.inject(webhook)]);
    assert.deepEqual(results.map(r => r.statusCode), [200, 200]);
    assert.equal(subscriptionReads,before+1);
    assert.equal((await billingStatus(subject)).subscribed,true);
    // A different Google account presenting the same address cannot inherit billing.
    assert.deepEqual(await billingStatus(successor), {customer:false,subscribed:false});
    assert.equal(await billingPortal(successor), config.siteUrl + "/membership");
    end += 30*86400;
    invoiceStatus = "open";
    invoicePaid = 0;
    await event("renewal-pending");
    const [period] = await sql`SELECT EXTRACT(epoch FROM paid_until)::bigint AS ending FROM reader_billing_subscriptions WHERE stripe_subscription=${subscription}`;
    assert.equal(Number(period.ending),periodEnd);
    subscriptionStatus="past_due";
    await event("past-due");
    assert.equal((await billingStatus(subject)).subscribed,false);
    subscriptionStatus="active";
    invoiceStatus="paid";
    invoicePaid=500;
    await event("renewed");
    assert.equal((await billingStatus(subject)).subscribed,true);
    subscriptionStatus="canceled";
    await event("deleted","customer.subscription.deleted");
    await event("arrived-late","customer.subscription.created");
    assert.equal((await billingStatus(subject)).subscribed,false);
    assert.equal((await billingStatus("other-"+email)).subscribed,false);
  } finally {
    await app.close();
    await sql`DELETE FROM reader_billing_events WHERE left(event_id, ${tag.length+4})=${"evt_"+tag}`;
    await sql`DELETE FROM reader_billing_subscriptions WHERE stripe_subscription=${subscription}`;
    await sql`DELETE FROM reader_billing_accounts WHERE email=${email}`;
    await sql`DELETE FROM readers WHERE google_subject IN (${subject}, ${successor})`;
    await closeDb();
  }
});
