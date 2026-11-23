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

test("shared news facts cannot join different rounds or pass a review to an unrelated claim", () => {
  const a = source("a",{base_id:"fact:shared",reviewed_id:"one"});
  const b = source("b",{base_id:"fact:shared",stage:"E+"});
  assert.equal(financingRounds([a,b]).size,2);
  assert.equal(financingRounds([{...a,reviewed_id:null},b]).size,2);
});

test("an unstaged report needs a matching investor and amount and an unambiguous round", () => {
  const a = source("a",{investors:["Example Capital"]});
  const b = source("b",{stage:null, investors:["Example Capital"]});
  assert.equal(financingRounds([a,b]).size,1);
  assert.equal(financingRounds([a,{...b,investors:["Other"]}]).size,2);
  assert.equal(financingRounds([a,b,source("c",{stage:"E+",investors:["Example Capital"]})]).size,3);
  assert.equal(financingRounds([a,{...b,amount:"数亿美元"}]).size,2);
  assert.equal(financingRounds([a,b,{...a,article_id:"c",base_id:"item:c",stage:"种子轮",amount:"1000万美元"}]).size,2);
});

test("two named investors and a specific round can corroborate a report with no individual amount", () => {
  const a = source("a",{investors:["甲基金","乙资本"]});
  const b = source("b",{amount:null,currency:null,basis:"unknown",investors:["乙资本","甲基金"]});
  assert.equal(financingRounds([a,b]).size,1);
  assert.equal(financingRounds([a,{...b,stage:"E+"}]).size,2);
  assert.equal(financingRounds([a,{...b,investors:["甲基金"]}]).size,2);
  assert.equal(financingRounds([a,{...b,basis:"cumulative"}]).size,2);
  const alias = source("x",{reviewed_id:"r",company:"示例科技有限公司", stage:null,amount:null});
  const groups = financingRounds([{...a,reviewed_id:"r"},alias,{...b,company:"示例科技有限公司"}]);
  assert.equal(groups.get("round:r")?.length,3);
});

test("fundraising matches only the same identified vehicle, phase and amount", () => {
  const a = source("a",{company:"Example Capital",stage:"Fund III",kind:"fund_raise",amount:"$150M",evidence:"Fund III reached a final close at $150M."});
  const b = {...a,article_id:"b",base_id:"item:b",amount:"1.5亿美元"};
  assert.equal(financingRounds([a,b]).size,1);
  for (const patch of [{stage:"Fund IV"},{evidence:"first close at $150M"},{amount:"$151M"},{kind:"company_round"}]) {
    assert.equal(financingRounds([a,{...b,...patch}]).size,2);
  }
  assert.equal(financingRounds([{...a,stage:null},{...b,stage:null}]).size,2);
});
