import assert from "node:assert/strict";
import test from "node:test";
import { financingText, validateFinancing } from "../packages/backend/src/editorial/financing-extraction.ts";

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
