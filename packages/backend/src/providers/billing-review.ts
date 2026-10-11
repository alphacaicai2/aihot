import { sql } from "../db.ts";

// Billing review and request outcome are independent. Confirming a charge (including zero)
// removes the billing follow-up; it never grants permission to resend an unknown request.
export function pendingBillingReview(alias?: string) {
  const column = (name: string) => sql(alias ? `${alias}.${name}` : name);
  return sql`${column("status")} = 'unknown' AND ${column("billing_review")} IS NULL`;
}
