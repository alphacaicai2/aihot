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
