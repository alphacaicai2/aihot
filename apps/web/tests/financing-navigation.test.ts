import assert from "node:assert/strict";
import test from "node:test";
import { financingCompanyPath, financingListSearch } from "../app/lib/financing-navigation.ts";

test("公司卡片刷新和历史翻页后仍能从网址还原原列表", () => {
  const list = new URLSearchParams({
    company: "A+B & Co", investor: "甲 / 乙", investorMode: "exact",
    from: "2026-10-01", to: "2026-10-31", cursor: "list+/=",
  });
  const openCard = (path: string) => new URL(path, "https://example.com").searchParams;
  const card = openCard(financingCompanyPath("A+B & Co", `?${list}&ignored=1`));
  assert.equal(card.get("name"), "A+B & Co");
  assert.equal(card.has("cursor"), false);
  assert.equal(financingListSearch(card), list.toString());
  const older = openCard(financingCompanyPath("A+B & Co", financingListSearch(card), "history+/="));
  assert.equal(older.get("cursor"), "history+/=");
  assert.equal(financingListSearch(older), list.toString());
});

test("直接打开卡片或仅有未知参数时，返回融资数据库首页", () => {
  assert.equal(financingCompanyPath("ACME", "?unknown=1"), "/financing/company?name=ACME");
  assert.equal(financingListSearch(new URLSearchParams("name=ACME&cursor=history")), "");
  assert.equal(financingListSearch(new URLSearchParams({ list: "unknown=1" })), "");
});
