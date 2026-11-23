-- Only a verified site account can create its customer mapping. Webhooks never bind by Stripe email.
CREATE TABLE reader_billing_accounts (
  google_subject text PRIMARY KEY REFERENCES readers(google_subject),
  email text NOT NULL CHECK (email = lower(trim(email)) AND email <> ''),
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  stripe_customer text UNIQUE,
  checkout_session text
);

CREATE TABLE reader_billing_subscriptions (
  stripe_subscription text PRIMARY KEY,
  stripe_customer text NOT NULL REFERENCES reader_billing_accounts(stripe_customer),
  status text NOT NULL,
  paid_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reader_billing_customer_subscriptions ON reader_billing_subscriptions(stripe_customer);

CREATE TABLE reader_billing_events (
  event_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
