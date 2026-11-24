import assert from "node:assert/strict";
import { test } from "node:test";
import { additionalDigestEntries } from "@aihot/backend/editorial/financing-supplemental-sections";

test("mixed-digest supplemental candidates retain the exact paragraph, not another company's news or historical funding", () => {
  const section = "【北桥跻身独角兽】据报道，北桥已达成估值10亿美元轮次的融资。";
  const body = "【已有公司完成A轮融资】已有公司本轮由甲领投。" + section +
    "【开源新产品】去年北桥完成A轮融资。今天发布开源产品。" +
    "【公司上市】IPO募资预计超过10亿元。";
  const existing = [{heading: "已有公司完成A轮融资"}];
  assert.deepEqual(additionalDigestEntries({title:"早报", excerpt:section, body},existing), [
    {heading:"北桥跻身独角兽",sourceText:section}
  ]);
  assert.deepEqual(additionalDigestEntries({title:"投融资日报", excerpt:null, body:section},[]), [{heading:"北桥跻身独角兽",sourceText:section}]);
});

test("an issuer already verified in the opening isn't charged again for headline shorthand; an investor cannot cover it", async () => {
  const {missingDigestSections}=await import("@aihot/backend/editorial/financing-followup");
  const entry={heading:"创始人旗下团队获得新一轮融资"};
  const claim={company:"北桥科技有限公司",kind:"company_round" as const,round:"A轮",amountText:null,currency:null,valuationText:null,investors:[],status:"closed" as const,amountBasis:"unknown" as const,evidence:""};
  for(const sentence of ["据北桥科技有限公司消息，北桥科技有限公司宣布于近期完成A轮融资。","北桥科技有限公司，已连续完成A轮融资。","北桥科技有限公司官宣完成A轮融资。"]){
    const res=missingDigestSections({title:"日报",excerpt:null,body:"【"+entry.heading+"】"+sentence},[entry],[{...claim,evidence:sentence}]);
    assert.equal(res.coverage.verified,1);assert.equal(res.material.length,0);
  }
  const other="北桥科技有限公司完成了对另一家企业的投资。";
  assert.equal(missingDigestSections({title:"日报",excerpt:null,body:"【"+entry.heading+"】"+other},[entry],[{...claim,evidence:other}]).coverage.verified,0);
});
