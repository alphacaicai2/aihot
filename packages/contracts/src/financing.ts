export interface FinancingClaim {
  company: string;
  round: string | null;
  amountText: string | null;
  currency: string | null;
  valuationText: string | null;
  investors: string[];
  status: "planned" | "ongoing" | "announced" | "closed" | "unknown";
  kind: "company_round" | "fund_raise";
  amountBasis: "round" | "cumulative" | "target" | "unknown";
  evidence: string;
}
export interface FinancingReport {
  id: string; title: string; url: string; sourceName: string; publishedAt: string | null;
  claim: FinancingClaim;
}
export interface FinancingResponse {
  events: Array<{ id: string; latestAt: string; reports: FinancingReport[]; reportCount: number; differingClaims: boolean }>;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface InvestorOption {
  name: string;
  aliases: string[];
}

export function investorSearchKey(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/[\s·._’'-]+/gu, "");
}
