import { randomBytes } from "node:crypto";
import { actorOf, adminCredentialAllowed, audit, feishuLoginConfigured, realAdminSession, type AdminCredential, type AdminPrincipal } from "../admin/auth.ts";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { billingStatus } from "./billing.ts";
import { bindEmail, lockEmail, normalizedEmail } from "./email-ownership.ts";
import { readerSession } from "./google.ts";

export type MembershipSource = "admin" | "grant" | "subscription" | null;
export interface MemberPrincipal {
  email: string | null;
  access: boolean;
  admin: boolean;
  source: MembershipSource;
}

type Reader = NonNullable<Awaited<ReturnType<typeof readerSession>>>;
type Administrator = NonNullable<Awaited<ReturnType<typeof realAdminSession>>>;
type Identity = { reader: Reader } | { administrator: Administrator };

const guest: MemberPrincipal = { email: null, access: false, admin: false, source: null };

export async function memberIdentity(cookieHeader: string | undefined): Promise<Identity | null> {
  const admin = await realAdminSession(cookieHeader);
  if (admin) return { administrator: admin };
  const reader = await readerSession(cookieHeader);
  return reader ? { reader } : null;
}

function visibleAdminEmail(email: string | null) {
  return email && email !== "admin@local" ? email.toLowerCase() : null;
}

async function emailPrivileges(db: Db, email: string) {
  const [flags] = await db<{ granted: boolean; feishu_admin: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM membership_grants WHERE email = ${email}) AS granted,
      EXISTS(SELECT 1 FROM admin_users WHERE lower(email) = ${email}
        AND feishu_union_id = ANY(${config.adminUnionIds}::text[])) AS feishu_admin`;
  const adminEmail = config.adminEmails.includes(email) || (flags!.feishu_admin && feishuLoginConfigured());
  return adminEmail ? "admin" : flags!.granted ? "grant" : null;
}

async function readerAccess(subject: string, rawEmail: string) {
  const email = normalizedEmail(rawEmail);
  const [owner] = await sql`SELECT 1 FROM reader_email_bindings WHERE email=${email} AND google_subject=${subject}`;
  const emailConfirmed = !!owner;
  const privilege = emailConfirmed ? await emailPrivileges(sql, email) : null;
  const billing = await billingStatus(subject);
  const source: MembershipSource = privilege ?? (billing.subscribed ? "subscription" : null);
  return { email, access: !!source, admin: false, source, customer: billing.customer, emailConfirmed };
}

export async function identityAccess(identity: Identity | null): Promise<MemberPrincipal & { customer: boolean; emailConfirmed: boolean }> {
  if (!identity) return { ...guest, customer: false, emailConfirmed: false };
  if ("reader" in identity) return readerAccess(identity.reader.google_subject, identity.reader.email);
  const email = visibleAdminEmail(identity.administrator.email);
  return { email, access: true, admin: true, source: "admin", customer: false, emailConfirmed: true };
}

export async function memberPrincipal(cookieHeader: string | undefined): Promise<MemberPrincipal> {
  return identityAccess(await memberIdentity(cookieHeader));
}

export async function hasAgentToken(identity: Identity) {
  const [row] = "reader" in identity
    ? await sql`SELECT 1 FROM membership_agent_tokens WHERE reader_subject = ${identity.reader.google_subject}`
    : await sql`SELECT 1 FROM membership_agent_tokens WHERE admin_user_id = ${identity.administrator.user_id}
        AND admin_binding = ${identity.administrator.auth_binding} AND admin_method = ${identity.administrator.auth_method}`;
  return !!row;
}

export async function rotateAgentToken(identity: Identity) {
  const token = "caolu_" + randomBytes(32).toString("base64url");
  const digest = sha256(token);
  if ("reader" in identity) {
    await sql`INSERT INTO membership_agent_tokens(reader_subject, token_hash) VALUES (${identity.reader.google_subject}, ${digest})
      ON CONFLICT(reader_subject) DO UPDATE SET token_hash = EXCLUDED.token_hash`;
  } else {
    const admin = identity.administrator;
    await sql`INSERT INTO membership_agent_tokens(admin_user_id, admin_method, admin_binding, token_hash)
      VALUES (${admin.user_id}, ${admin.auth_method}, ${admin.auth_binding}, ${digest})
      ON CONFLICT(admin_user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, admin_method = EXCLUDED.admin_method,
        admin_binding = EXCLUDED.admin_binding`;
  }
  return token;
}

export async function revokeAgentToken(identity: Identity) {
  if ("reader" in identity) await sql`DELETE FROM membership_agent_tokens WHERE reader_subject = ${identity.reader.google_subject}`;
  else await sql`DELETE FROM membership_agent_tokens WHERE admin_user_id = ${identity.administrator.user_id}`;
}

/** A key authenticates its owner; current privileges are always evaluated again. */
export async function agentPrincipal(header: string): Promise<MemberPrincipal> {
  const token = /^Bearer (caolu_[A-Za-z0-9_-]{43})$/i.exec(header)?.[1];
  if (!token) return guest;
  const [row] = await sql<(AdminCredential & { admin_user_id: number | null; reader_subject: string | null; reader_email: string | null })[]>`
    SELECT k.reader_subject, k.admin_user_id, k.admin_method AS auth_method, k.admin_binding AS auth_binding,
           u.email, u.feishu_union_id, r.email AS reader_email
    FROM membership_agent_tokens k LEFT JOIN admin_users u ON u.id = k.admin_user_id
    LEFT JOIN readers r ON r.google_subject = k.reader_subject WHERE k.token_hash = ${sha256(token)}`;
  if (row?.reader_subject && row.reader_email) return readerAccess(row.reader_subject, row.reader_email);
  if (row?.admin_user_id && adminCredentialAllowed(row)) {
    return { email: visibleAdminEmail(row.email), access: true, admin: true, source: "admin" };
  }
  return guest;
}

export async function listMembershipGrants() {
  return sql<{ email: string; createdAt: Date }[]>`SELECT email, created_at AS "createdAt" FROM membership_grants ORDER BY created_at DESC, email`;
}

export async function changeMembershipGrant(email: string, grant: boolean, admin: AdminPrincipal, requestId: string) {
  await sql.begin(async tx => {
    await lockEmail(tx, email);
    const changed = grant
      ? await tx`INSERT INTO membership_grants(email) VALUES (${email}) ON CONFLICT DO NOTHING`
      : await tx`DELETE FROM membership_grants WHERE email = ${email}`;
    if (!grant && !await emailPrivileges(tx, email)) {
      await tx`DELETE FROM membership_confirmation_codes WHERE email=${email}`;
      await tx`DELETE FROM reader_email_bindings WHERE email=${email} AND method='confirmation'`;
    }
    if (changed.count) {
      await audit(actorOf(admin), grant ? "membership.grant" : "membership.revoke", email, null, !grant, grant, requestId, tx);
    }
  });
}

export async function issueConfirmationCode(email: string, admin: AdminPrincipal, requestId: string) {
  return sql.begin(async tx => {
    await lockEmail(tx, email);
    if (!await emailPrivileges(tx, email)) return null;
    const code = randomBytes(18).toString("base64url");
    const [row] = await tx<{ expiresAt: Date }[]>`INSERT INTO membership_confirmation_codes(email,code_hash,expires_at)
      VALUES (${email},${sha256(code)},now()+interval '24 hours')
      ON CONFLICT(email) DO UPDATE SET code_hash=EXCLUDED.code_hash, expires_at=EXCLUDED.expires_at
      RETURNING expires_at AS "expiresAt"`;
    await audit(actorOf(admin), "membership.confirmation.issue", email, null, null, true, requestId, tx);
    return { code, expiresAt: row!.expiresAt };
  });
}

export async function confirmReaderEmail(reader: Reader, code: string) {
  if (!/^[A-Za-z0-9_-]{24}$/.test(code)) return false;
  const email = normalizedEmail(reader.email);
  return sql.begin(async tx => {
    await lockEmail(tx, email);
    const [current] = await tx`SELECT 1 FROM readers WHERE google_subject=${reader.google_subject}
      AND lower(btrim(email))=${email} FOR UPDATE`;
    if (!current || !await emailPrivileges(tx, email)) return false;
    const consumed = await tx`DELETE FROM membership_confirmation_codes WHERE email=${email}
      AND code_hash=${sha256(code)} AND expires_at>now()`;
    if (!consumed.count) return false;
    await bindEmail(tx, reader.google_subject, email, "confirmation");
    return true;
  });
}
