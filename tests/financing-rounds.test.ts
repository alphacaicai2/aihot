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

test("an identified primary amount matches across currency conversions without equating a valuation or tranche", () => {
  const digest = source("digest",{company:"TypeSafe AI", stage:"A轮",amount:"8.7 亿美元（约61.16亿人民币）"});
  const report = source("report",{company:"TypeSafe AI",stage:"A 轮",amount:"8.7亿美元"});
  assert.equal(financingRounds([digest,report]).size,1);
  for (const amount of ["8.7亿美元（投后估值75亿美元）","8.7亿美元（含此前3亿美元）","8.7亿美元（其中3亿美元贷款）"]) {
    assert.equal(financingRounds([{...digest,amount},report]).size,2);
  }
});

test("an explicitly declared alias and corroborated vague amount merge the same stage only", () => {
  const common={stage:"B轮",currency:"CNY",investors:["杭州高新金投","鸿瑞达投资"]};
  const full=source("standalone",{...common,company:"杭州原子矩阵计算有限公司",amount:"数亿元人民币",
    evidence:"杭州原子矩阵计算有限公司（MatriQ，下称“原子矩阵”）近日宣布完成数亿元人民币B轮融资。"});
  const card=source("digest",{...common,company:"原子矩阵",amount:"数亿 人民币",investors:["鸿瑞达投资"]});
  assert.equal(financingRounds([full,card]).size,1);
  for (const patch of [{amount:"数千万元"}, {investors:[]}, {stage:"B+轮"}, {currency:"USD"}, {status:"planned"}]) {
    assert.equal(financingRounds([full,{...card,...patch}]).size,2);
  }
  const unrelated={...full,evidence:"杭州原子矩阵计算有限公司等参投另外一家公司（简称“原子矩阵”）。"};
  assert.equal(financingRounds([unrelated,card]).size,2);
  const other=source("other",{...common,company:"另一家有限公司",amount:full.amount,evidence:"另一家有限公司（简称“原子矩阵”）完成B轮。"});
  assert.equal(financingRounds([full,other,card]).size,3);
});

test("near one hundred million normalizes without equating a lower bound, cumulative or different round", () => {
  const a=source("digest1",{company:"格物通智",stage:"天使轮",currency:"CNY",amount:"近亿元",investors:["匹克投资","鸿富资产"]});
  const b={...a,article_id:"digest2",base_id:"item:digest2",amount:"近1亿元人民币"};
  assert.equal(financingRounds([a,b]).size,1);
  for (const patch of [{amount:"超亿元"},{basis:"cumulative"},{record_type:"aggregate_disclosure"},{stage:"天使+轮"}]) {
    assert.equal(financingRounds([a,{...b,...patch}]).size,2);
  }
  assert.equal(financingRounds([{...a,amount:"超亿元",investors:[]},{...b,amount:"超1亿元"}]).size,2);
});

test("an explicit bilingual recipient connects three spellings and leaves competing brands separate", () => {
  const a=source("a",{company:"量子示例（Quantum Example）",amount:"亿元级",currency:"CNY",investors:["甲基金"]});
  const b={...a,base_id:"item:b",article_id:"b",company:"量子示例"};
  const c={...a,base_id:"item:c",article_id:"c",company:"Quantum Example"};
  assert.equal(financingRounds([a,b,c]).size,1);
  assert.equal(financingRounds([a,b,{...c,company:"Quantum Example Energy"}]).size,2);
  const d={...a,base_id:"item:d",article_id:"d",company:"另一品牌（Quantum Example）"};
  assert.equal(financingRounds([a,b,c,d]).size,3);
});
