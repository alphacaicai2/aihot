import { deflateRawSync, inflateRawSync } from "node:zlib";
import { checkoutDestinationKey, memberDestination } from "./member-destination.ts";

// A company address embeds its original list query. Percent-encoded names and cursors
// can exceed browser cookie limits when signed into the OAuth flow cookie.
export function packDestination(target: string) {
  return target.length < 512 ? target : "~" + deflateRawSync(target).toString("base64url");
}

export function unpackDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("~")) return value;
  try { return inflateRawSync(Buffer.from(value.slice(1), "base64url"), { maxOutputLength: 32768 }).toString(); }
  catch { return null; }
}

export function checkoutDestinationCookie(header: string | null) {
  const matching = (header ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(checkoutDestinationKey + "="));
  if (matching.length !== 1) return null;
  try { return memberDestination(unpackDestination(decodeURIComponent(matching[0].slice(checkoutDestinationKey.length + 1)))); }
  catch { return null; }
}
