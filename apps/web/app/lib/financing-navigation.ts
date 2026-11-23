export function financingQuery(params: URLSearchParams) {
  const query = new URLSearchParams();
  for (const key of ["company", "investor", "investorMode", "from", "to", "cursor"]) {
    const value = params.get(key)?.trim();
    if (value) query.set(key, value);
  }
  return query;
}

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
