import { financingQuery } from "@aihot/contracts/member-destination";

export { financingQuery };

export function financingCompanyPath(name: string, listSearch: string, historyCursor?: string | null, investor?: { name: string; cursor?: string | null }) {
  const params = new URLSearchParams({ name });
  const list = financingQuery(new URLSearchParams(listSearch)).toString();
  if (list) params.set("list", list);
  if (historyCursor) params.set("cursor", historyCursor);
  if (investor?.name) {
    params.set("viaInvestor", investor.name);
    if (investor.cursor) params.set("viaCursor", investor.cursor);
  }
  return `/financing/company?${params}`;
}

export function financingListSearch(companyParams: URLSearchParams) {
  return financingQuery(new URLSearchParams(companyParams.get("list") ?? "")).toString();
}

export function financingEventPath(id: string) {
  return "/financing/event?" + new URLSearchParams({ id });
}

export function financingInvestorPath(name: string, listSearch = "", cursor?: string | null) {
  const params = new URLSearchParams({ name });
  const list = financingQuery(new URLSearchParams(listSearch));
  if (list.size) params.set("list", list.toString());
  if (cursor) params.set("cursor", cursor);
  return "/financing/investor?" + params;
}


export function financingListPath(search: string) {
  return search ? "/financing?" + search : "/financing";
}
