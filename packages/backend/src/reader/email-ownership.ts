import type { Tx } from "../db.ts";

export function normalizedEmail(email: string) {
  return email.trim().toLowerCase();
}

// Serialize proof, code rotation and revocation for the same mailbox.
export async function lockEmail(tx: Tx, email: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${email}, 6021))`;
}

async function revokeReaderCredentials(tx: Tx, subject: string) {
  await tx`DELETE FROM reader_sessions WHERE google_subject=${subject}`;
  await tx`DELETE FROM membership_agent_tokens WHERE reader_subject=${subject}`;
}

/** Caller holds the mailbox lock and the new owner's readers row. */
export async function bindEmail(tx: Tx, subject: string, email: string, method: "google" | "confirmation") {
  const [previous] = await tx<{google_subject: string}[]>`SELECT google_subject FROM reader_email_bindings WHERE email=${email}`;
  if (previous && previous.google_subject !== subject) await revokeReaderCredentials(tx, previous.google_subject);
  await tx`DELETE FROM reader_email_bindings WHERE google_subject=${subject} AND email<>${email}`;
  await tx`INSERT INTO reader_email_bindings(email, google_subject, method) VALUES (${email},${subject},${method})
    ON CONFLICT(email) DO UPDATE SET google_subject=EXCLUDED.google_subject, method=EXCLUDED.method`;
  await tx`DELETE FROM membership_confirmation_codes WHERE email=${email}`;
}

/** Record only the identity from a Google token whose signatures and claims have been verified. */
export async function recordGoogleEmail(tx: Tx, subject: string, rawEmail: string, hostedDomain: unknown) {
  const email = normalizedEmail(rawEmail);
  await lockEmail(tx, email);
  await tx`INSERT INTO readers(google_subject,email) VALUES (${subject},${email}) ON CONFLICT DO NOTHING`;
  const [previous] = await tx<{email: string}[]>`SELECT email FROM readers WHERE google_subject=${subject} FOR UPDATE`;
  if (normalizedEmail(previous!.email) !== email) {
    // A session or Agent key issued for the old mailbox must not gain the new mailbox's grants.
    await revokeReaderCredentials(tx, subject);
    await tx`DELETE FROM reader_email_bindings WHERE google_subject=${subject}`;
    await tx`UPDATE readers SET email=${email} WHERE google_subject=${subject}`;
  }
  if (email.endsWith("@gmail.com") || (typeof hostedDomain === "string" && hostedDomain.trim())) {
    await bindEmail(tx, subject, email, "google");
  } else {
    // A fresh ID token without hd can no longer vouch for a Workspace-managed mailbox.
    await tx`DELETE FROM reader_email_bindings WHERE google_subject=${subject} AND method='google'`;
  }
}
