import Stripe from "stripe";
import { config, credential } from "../config.ts";
import { sql, type Tx } from "../db.ts";

const setting = (name: string) => credential("integrations", name);
const application = "caolu_reader_membership_v1";
const memberUrl = () => config.siteUrl + "/membership";
const normalize = (email: string) => email.trim().toLowerCase();
const idOf = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id;

export function billingConfigured(): boolean {
  return !!setting("STRIPE_SECRET_KEY") && !!setting("STRIPE_PRICE_ID") && !!setting("STRIPE_WEBHOOK_SECRET");
}

function stripeSettings() {
  const key = setting("STRIPE_SECRET_KEY");
  const price = setting("STRIPE_PRICE_ID");
  const signingSecret = setting("STRIPE_WEBHOOK_SECRET");
  if (!key || !price || !signingSecret) throw new Error("Stripe membership billing is unavailable");
  return {
    stripe: new Stripe(key, { timeout: 10000, maxNetworkRetries: 1, httpClient: Stripe.createFetchHttpClient() }),
    price, signingSecret, live: /^(sk|rk)_live_/.test(key),
  };
}

export async function billingStatus(googleSubject: string): Promise<{subscribed: boolean; customer: boolean}> {
  const [row] = await sql<{subscribed: boolean; customer: boolean}[]>`
    SELECT a.stripe_customer IS NOT NULL AS customer, EXISTS (
      SELECT 1 FROM reader_billing_subscriptions s
      WHERE s.stripe_customer=a.stripe_customer AND s.status='active' AND s.paid_until>now()
    ) AS subscribed FROM reader_billing_accounts a WHERE a.google_subject=${googleSubject}`;
  return row ?? { customer: false, subscribed: false };
}

type Account = { id: string; stripe_customer: string | null; checkout_session: string | null };

async function customerForCheckout(stripe: Stripe, googleSubject: string, email: string): Promise<string> {
  // Persist the idempotency-key seed before calling Stripe, so database rollback/retry reuses it.
  await sql`INSERT INTO reader_billing_accounts (google_subject, email) VALUES (${googleSubject}, ${email}) ON CONFLICT DO NOTHING`;
  return sql.begin(async tx => {
    const [account] = await tx<Account[]>`SELECT * FROM reader_billing_accounts WHERE google_subject=${googleSubject} FOR UPDATE`;
    if (account.stripe_customer) return account.stripe_customer;
    const customer = await stripe.customers.create({ email, metadata: { application } },
      { idempotencyKey: "caolu-reader-customer-" + account.id });
    await tx`UPDATE reader_billing_accounts SET stripe_customer=${customer.id} WHERE id=${account.id}`;
    return customer.id;
  });
}

function monthlyPrice(price: Stripe.Price): boolean {
  return price.currency === "usd" && price.unit_amount === 500 && price.billing_scheme === "per_unit"
    && price.recurring?.interval === "month" && price.recurring.interval_count === 1
    && price.recurring.usage_type === "licensed" && !price.transform_quantity;
}

async function portalUrl(stripe: Stripe, customer: string) {
  const configuration = setting("STRIPE_PORTAL_CONFIGURATION_ID") ?? undefined;
  const session = await stripe.billingPortal.sessions.create({ customer, configuration, return_url: memberUrl() });
  return session.url;
}

export async function billingPortal(googleSubject: string): Promise<string> {
  const [account] = await sql<Account[]>`SELECT stripe_customer FROM reader_billing_accounts WHERE google_subject=${googleSubject}`;
  if (!account?.stripe_customer) return memberUrl();
  return portalUrl(stripeSettings().stripe, account.stripe_customer);
}

export async function billingCheckout(googleSubject: string, verifiedEmail: string): Promise<string> {
  const email = normalize(verifiedEmail);
  const { stripe, price } = stripeSettings();
  const configuredPrice = await stripe.prices.retrieve(price);
  if (!configuredPrice.active || !monthlyPrice(configuredPrice)) throw new Error("Invalid Stripe membership price");
  const customer = await customerForCheckout(stripe, googleSubject, email);
  return sql.begin(async tx => {
    const [account] = await tx<Account[]>`SELECT * FROM reader_billing_accounts WHERE google_subject=${googleSubject} FOR UPDATE`;
    if (account.checkout_session) {
      const previous = await stripe.checkout.sessions.retrieve(account.checkout_session, { expand: ["subscription"] });
      if (idOf(previous.customer) !== customer) throw new Error("Mismatched Checkout customer");
      if (previous.status === "open" && previous.url) return previous.url;
      if (previous.status === "complete") {
        // Incomplete, past-due, or active subscriptions must be managed, never duplicated.
        const sub = previous.subscription;
        if (!sub || typeof sub === "string") throw new Error("Missing Checkout subscription");
        if (sub.status !== "canceled" && sub.status !== "incomplete_expired") return portalUrl(stripe, customer);
      } else if (previous.status !== "expired") {
        throw new Error("Unexpected Checkout session state");
      }
    }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", customer, line_items: [{ price, quantity: 1 }], currency: "usd",
      adaptive_pricing: { enabled: false },
      subscription_data: { metadata: { application } },
      success_url: memberUrl() + "?checkout=success", cancel_url: memberUrl() + "?checkout=canceled",
    }, { idempotencyKey: "caolu-reader-checkout-" + account.id + "-" + (account.checkout_session ?? "first") });
    if (!session.url) throw new Error("Missing Stripe Checkout URL");
    await tx`UPDATE reader_billing_accounts SET checkout_session=${session.id} WHERE id=${account.id}`;
    return session.url;
  });
}

export class InvalidStripeWebhook extends Error {}

function eventSubscription(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
      return { customer: idOf(event.data.object.customer), subscription: idOf(event.data.object.subscription) };
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return { customer: idOf(event.data.object.customer), subscription: event.data.object.id };
    case "invoice.paid":
    case "invoice.payment_failed":
      return {
        customer: idOf(event.data.object.customer),
        subscription: idOf(event.data.object.parent?.subscription_details?.subscription),
      };
    default:
      return null;
  }
}

async function syncSubscription(tx: Tx, stripe: Stripe, customer: string, subscription: string, priceId: string) {
  // Always read current Stripe data inside the customer lock; Stripe can deliver in any order.
  const sub = await stripe.subscriptions.retrieve(subscription, { expand: ["latest_invoice"] });
  if (idOf(sub.customer) !== customer) throw new Error("Mismatched Stripe subscription owner");
  const item = sub.items.data.find(i => i.price.id === priceId && i.quantity === 1 && monthlyPrice(i.price));
  if (!item || sub.metadata.application !== application) {
    await tx`DELETE FROM reader_billing_subscriptions WHERE stripe_subscription=${subscription} AND stripe_customer=${customer}`;
    return;
  }

  const invoice = sub.latest_invoice;
  let paidUntil: Date | null = null;
  if (invoice && typeof invoice !== "string" && invoice.status === "paid" && invoice.currency === "usd" && invoice.amount_paid >= 500
      && idOf(invoice.customer) === customer && idOf(invoice.parent?.subscription_details?.subscription) === subscription) {
    const line = invoice.lines.data.find(l => idOf(l.pricing?.price_details?.price) === priceId
      && l.quantity === 1 && l.amount >= 500 && l.parent?.subscription_item_details?.subscription_item === item.id
      && !l.parent.subscription_item_details.proration);
    if (line) paidUntil = new Date(Math.min(line.period.end, item.current_period_end) * 1000);
  }
  await tx`INSERT INTO reader_billing_subscriptions (stripe_subscription, stripe_customer, status, paid_until)
           VALUES (${subscription}, ${customer}, ${sub.pause_collection ? "paused" : sub.status}, ${paidUntil})
           ON CONFLICT (stripe_subscription) DO UPDATE SET status=EXCLUDED.status,
             paid_until=CASE WHEN reader_billing_subscriptions.paid_until IS NOT NULL OR EXCLUDED.paid_until IS NOT NULL
               THEN LEAST(GREATEST(reader_billing_subscriptions.paid_until, EXCLUDED.paid_until), ${new Date(item.current_period_end * 1000)})
             END,
             updated_at=now()
             WHERE reader_billing_subscriptions.stripe_customer=EXCLUDED.stripe_customer`;
}

export async function processBillingWebhook(rawBody: Buffer, signature: string) {
  const { stripe, price, signingSecret, live } = stripeSettings();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, signingSecret);
  } catch {
    throw new InvalidStripeWebhook("Invalid Stripe webhook signature or payload");
  }
  if (event.livemode !== live) throw new InvalidStripeWebhook("Stripe mode mismatch");
  const target = eventSubscription(event);
  if (!target?.customer || !target.subscription) return;
  const { customer, subscription } = target;
  await sql.begin(async tx => {
    const owner = await tx`SELECT 1 FROM reader_billing_accounts WHERE stripe_customer=${customer} FOR UPDATE`;
    if (!owner.length) return;
    const first = await tx`INSERT INTO reader_billing_events (event_id) VALUES (${event.id}) ON CONFLICT DO NOTHING RETURNING 1`;
    if (first.length) await syncSubscription(tx, stripe, customer, subscription, price);
  });
}
