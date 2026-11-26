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

test("事件和机构分享地址可在登录后恢复，机构分页保留列表筛选", async () => {
  const {financingEventPath, financingInvestorPath} = await import("../app/lib/financing-navigation.ts");
  const {memberDestination, membershipOffer, offerDestination} = await import("@aihot/contracts/member-destination");
  const origin = "https://example.com";
  for (const path of [financingEventPath("round:abc"), financingInvestorPath("A+B & Co", "?company=Acme&ignored=1","+/=")]) {
    assert.equal(memberDestination(path),path);
    assert.equal(offerDestination(new URL(membershipOffer(path),origin).searchParams),path);
  }
});


test("机构档案进入公司时保留原数据库查询和机构所在页，登录返回也保留", async () => {
  const { memberDestination } = await import("@aihot/contracts/member-destination");
  const query = new URLSearchParams({company:"A+B", investor:"乙", from:"2026-10-01", to:"2026-10-31",cursor:"list+/="});
  const to = financingCompanyPath("Acme", query.toString(), "history", {name:"甲 & 乙",cursor:"investor+/="});
  assert.equal(memberDestination(to),to);
  const company = new URL(to, "https://local.invalid").searchParams;
  assert.equal(company.get("viaInvestor"),"甲 & 乙");
  assert.equal(company.get("viaCursor"),"investor+/=");
  assert.equal(financingListSearch(company),query.toString());
});

test("带尾斜杠的融资列表和档案沿用同一路由与会员返回条件", async () => {
  const {memberPathname, memberDestination} = await import("@aihot/contracts/member-destination");
  for (const path of ["/financing","/financing/company","/financing/investor"]) {
    assert.equal(memberPathname(path + "/"),path);
    assert.equal(memberDestination(path + "/?name=甲&company=甲"), memberDestination(path + "?name=甲&company=甲"));
  }
  assert.equal(memberDestination("//example.com/financing/?company=甲"),null);
});
