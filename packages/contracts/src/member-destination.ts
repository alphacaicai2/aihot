export function financingQuery(params: URLSearchParams) {
  const query = new URLSearchParams();
  for (const key of ["company", "investor", "investorMode", "from", "to", "cursor"]) {
    const value = params.get(key)?.trim();
    if (value) query.set(key, value);
  }
  return query;
}

// Only the reader-facing membership features may be resumed after login or payment.
const memberPaths = new Set(["/financing", "/financing/company", "/financing/investor", "/financing/event", "/agent"]);

export function memberPathname(pathname: string) {
  return pathname.replace(/\/+$/, "");
}

export function memberDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\/[^?#]*)(\?[^#]*)?$/.exec(value);
  if (!match) return null;
  const pathname = memberPathname(match[1]);
  if (!memberPaths.has(pathname)) return null;
  const query = new URLSearchParams(match[2]);
  let selected = new URLSearchParams();
  if (pathname === "/financing") {
    selected = financingQuery(query);
  } else if (pathname === "/financing/event") {
    const id = query.get("id");
    if (!id?.trim()) return null;
    selected.set("id", id);
  } else if (pathname === "/financing/company" || pathname === "/financing/investor") {
    const name = query.get("name");
    if (!name?.trim()) return null;
    selected.set("name", name);
    const list = financingQuery(new URLSearchParams(query.get("list") ?? ""));
    if (list.size) selected.set("list", list.toString());
    const cursor = query.get("cursor");
    if (cursor) selected.set("cursor", cursor);
    if (pathname === "/financing/company" && query.get("viaInvestor")?.trim()) {
      selected.set("viaInvestor", query.get("viaInvestor")!.slice(0, 320));
      const viaCursor = query.get("viaCursor");
      if (viaCursor) selected.set("viaCursor", viaCursor);
    }
  } else {
    const tab = query.get("tab");
    if (tab === "mcp" || tab === "rss" || tab === "api") selected.set("tab", tab);
  }
  return pathname + (selected.size ? "?" + selected : "");
}

export function membershipOffer(target: string | null, status?: ["billing" | "checkout", string]) {
  const params = new URLSearchParams();
  if (target) {
    const url = new URL(target, "https://site.invalid");
    const feature = url.pathname === "/agent" ? "agent" : "financing";
    params.set("feature", feature);
    const company = url.pathname === "/financing/company" ? url.searchParams.get("name") : null;
    if (company) params.set("company", company);
    if (target !== "/" + feature) params.set("return", target);
  }
  if (status) params.set(...status);
  return "/membership" + (params.size ? "?" + params : "");
}

export function offerDestination(params: URLSearchParams) {
  const target = memberDestination(params.get("return"));
  if (target) return target;
  if (params.get("feature") === "agent") return "/agent";
  if (params.get("feature") !== "financing") return null;
  const company = params.get("company");
  return company ? "/financing/company?" + new URLSearchParams({ name: company }) : "/financing";
}

export const checkoutDestinationKey = "caolu_checkout_return";
