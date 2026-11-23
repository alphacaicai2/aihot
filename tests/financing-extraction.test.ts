import assert from "node:assert/strict";
import test from "node:test";
import { financingText, validateFinancing, validateTransactions } from "../packages/backend/src/editorial/financing-extraction.ts";

test("only institution names with supporting quotes in this report are published", () => {
  const text = "星辰完成近亿元A轮融资。此轮由蓝海创投领投。";
  const input = { company:"星辰", evidence:"星辰完成近亿元A轮融资。", kind:"company_round" as const,
    amountText:"近亿元", valuationText:"5亿元", status:"closed" as const, amountBasis:"round" as const,
    investors:[{name:"蓝海创投",quote:"此轮由蓝海创投领投。"}, {name:"蓝海创投",quote:"蓝海创投领投"},
      {name:"另一机构",quote:"此轮由蓝海创投领投。"}, {name:"上一轮机构",quote:"上一轮机构参与本轮"}] };
  const {claim,investorEvidence} = validateFinancing({id:1,text},input);
  assert.deepEqual(claim?.investors, ["蓝海创投"]);
  assert.equal(investorEvidence.length, 1);
  assert.equal(claim?.valuationText,null);
  assert.equal(validateFinancing({id:2,text:"另一篇材料"},input).claim,null);
  assert.equal(validateFinancing({id:3,text},null).claim,null);
});
test("financing text retains investor attribution from deep in a long original", () => {
  assert.match(financingText("标题",null,"开头。".repeat(1500)+"此轮由蓝海领投。"),/蓝海领投/);
});

test("Chinese layout spaces are tolerated and the retained quote is from the original", () => {
  const text = "图灵科技 （ Turing ） 完成融资，由 蓝海 创投领投。";
  const {claim,investorEvidence} = validateFinancing({id:1,text}, {
    company: "图灵科技", evidence: "图灵科技（Turing）完成融资", investors: [{ name: "蓝海创投", quote: "由蓝海创投领投" }],
    kind: "company_round", status: "announced", amountBasis: "unknown",
  });
  assert.equal(claim?.evidence, "图灵科技 （ Turing ） 完成融资");
  assert.deepEqual(investorEvidence,[{name:"蓝海创投",quote:"由 蓝海 创投领投"}]);
});
test("an HTML-encoded source keeps a literal attribution for a readable investor name", () => {
  const text = "Atlas raised with Sprout &#38; Oak at the company&#8217;s first close.";
  const {claim,investorEvidence} = validateFinancing({id:1,text},{
    company:"Atlas", evidence:"Atlas raised with Sprout & Oak", kind:"company_round", status:"closed",
    amountBasis:"unknown", investors:[{name:"Sprout & Oak",quote:"Sprout & Oak at the company’s first close"}],
  });
  assert.deepEqual(claim?.investors,["Sprout & Oak"]);
  assert.equal(investorEvidence[0]?.quote,"Sprout &#38; Oak at the company&#8217;s first close");
});
test("a lead investor at the end of a long feed excerpt reaches extraction", () => {
  const excerpt = "Introduction. ".repeat(450) + "FirstMark is excited to lead Fragment’s Series A.";
  assert.match(financingText("Our investment in Fragment",excerpt,null),/FirstMark is excited to lead/);
});

test("a roundup claim can only use fields from its own named transaction passage", () => {
  const first = "甲公司获50亿美元投资。";
  const second = "镁伽科技完成近2亿美元E轮融资，乙基金领投。";
  const source = { id: 1, text: first + second };
  const claim = { company: "甲公司", passage: first, evidence: first, kind: "company_round", amountText: "近2亿美元",
    round: "E轮", investors: [{ name: "乙基金", quote: "乙基金领投" }] };
  const { claims, review } = validateTransactions(source, [claim, claim,
    { ...claim, company: "镁伽科技" }, { ...claim, evidence: second }]);
  assert.equal(claims.length, 1);
  assert.equal(review.rejected, 2);
  assert.equal(claims[0]?.amountText, null);
  assert.equal(claims[0]?.round, null);
  assert.deepEqual(claims[0]?.investors, []);
});

test("roundup input preserves named recipients deep inside the original report", () => {
  const original = "本周市场简讯。".repeat(1250) + "本周海外榜首是 Isomorphic Labs。";
  assert.match(financingText("全球投融资周报", null, original, true), /Isomorphic Labs/);
});

test("stored answers without a passage use the named evidence and its immediately adjacent investor list", () => {
  const evidence = "甲科技 完成E轮融资，融资金额近2亿美元";
  const investors = "投资方：甲基金 乙创投";
  const source = { id: 1, text: evidence + " " + investors + "。丙公司获得50亿美元融资，投资方：丙基金。" };
  const claim = { company: "甲科技", evidence, kind: "company_round", round: "E轮", amountText: "近2亿美元",
    investors: [{name:"甲基金",quote:investors}, {name:"丙基金",quote:"投资方：丙基金"}] };
  const result = validateTransactions(source, [claim]);
  assert.equal(result.claims[0]?.amountText, "近2亿美元");
  assert.deepEqual(result.claims[0]?.investors, ["甲基金"]);
  assert.equal(validateTransactions(source,[{...claim,amountText:"50亿美元"}]).claims[0]?.amountText,null);
});
