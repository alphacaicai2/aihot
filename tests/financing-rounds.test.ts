import assert from "node:assert/strict";
import test from "node:test";
import { financingRounds, type RoundSource } from "../packages/backend/src/publication/financing-rounds.ts";

function source(id: string, changes: Partial<RoundSource> = {}): RoundSource {
  return { article_id: id, base_id: "item:" + id, reviewed_id: null, reported_at: new Date("2026-11-19"),
    company: "示例科技", stage: "E轮", currency: "USD", amount: "近2亿美元", kind: "company_round", basis: "round", status: "closed", ...changes };
}
test("matching rounds merge across standalone stories and roundups without losing their sources", () => {
  const a = source("a"), b = source("b", { base_id:"deal:b:2", stage:"Series E", amount:"about US$200 million" });
  const groups = financingRounds([a,b]);
  assert.equal(groups.size, 1);
  assert.deepEqual(new Set([...groups.values()][0]), new Set([a,b]));
  for (const patch of [{stage:"E+"}, {amount:"近3亿美元"}, {currency:"CNY"}, {basis:"cumulative"},
    {status:"planned"}, {stage:"新一轮"}, {kind:"fund_raise"}, {company:"其他公司"}, {reported_at:new Date("2024-11-19")}]) {
    assert.equal(financingRounds([a,{...b,...patch}]).size,2);
  }
  assert.equal(financingRounds([a,{...b,article_id:a.article_id}]).size,2);
  assert.equal(financingRounds([a,source("c",{reported_at:new Date("2026-12-01")}),source("d",{reported_at:new Date("2026-12-13")})]).size,3);
});

test("reviewed sources retain aliases and incomplete terms, while separate reviews veto inferred matches", () => {
  const a = source("a",{reviewed_id:"one"}), b = source("b",{company:"Example Inc",stage:null,reviewed_id:"one"}), c = source("c");
  const groups = financingRounds([a,b,c]);
  assert.equal(groups.size,1);
  assert.deepEqual(new Set(groups.get("round:one")),new Set([a,b,c]));
  assert.equal(financingRounds([a,source("c",{reviewed_id:"two"})]).size,2);
});
