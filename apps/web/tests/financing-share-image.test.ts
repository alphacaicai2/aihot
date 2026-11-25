import assert from "node:assert/strict";
import test from "node:test";
import type { FinancingClaim } from "@aihot/contracts/financing";
import { financingPosterFields } from "../app/features/research/financing-share-image.ts";

test("financing poster keeps round proceeds, cumulative disclosures, targets and undisclosed values distinct", () => {
  const base: FinancingClaim = {
    company: "示例公司", kind:"company_round", status:"ongoing", round:null, amountText:null, currency:null,
    amountBasis:"unknown", valuationText:"估值 80 亿美元", investors:[], evidence:""
  };
  assert.deepEqual(financingPosterFields(base), [
    {label:"轮次",value:"未披露"}, {label:"融资金额",value:"未披露"}, {label:"投资机构",value:"未披露"}
  ]);
  for (const [basis,label] of [["round","本轮金额"],["cumulative","累计金额"],["target","目标金额"]] as const) {
    const fields = financingPosterFields({...base, round:"A+ 轮", amountText:"超 2 亿美元", currency:"USD",
      amountBasis:basis, investors:["甲基金","乙资本","丙产业投资"]});
    assert.deepEqual(fields.map(f=>f.value), ["A+ 轮","超 2 亿美元 USD","甲基金、乙资本、丙产业投资"]);
    assert.equal(fields[1]!.label,label);
  }
});
