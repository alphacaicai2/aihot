import { financingQuery } from "@aihot/contracts/member-destination";

export { financingQuery };

export function financingCompanyPath(name: string, listSearch: string, historyCursor?: string | null) {
  const params = new URLSearchParams({ name });
  const list = financingQuery(new URLSearchParams(listSearch)).toString();
  if (list) params.set("list", list);
  if (historyCursor) params.set("cursor", historyCursor);
  return `/financing/company?${params}`;
}

export function financingListSearch(companyParams: URLSearchParams) {
  return financingQuery(new URLSearchParams(companyParams.get("list") ?? "")).toString();
}
