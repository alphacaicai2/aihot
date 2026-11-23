import test from "node:test";
import assert from "node:assert/strict";
import { checkoutDestinationCookie, packDestination, unpackDestination } from "@aihot/contracts/member-destination.server";
import { memberDestination, membershipOffer, offerDestination } from "@aihot/contracts/member-destination";

test("会员回跳只接受本站的三个读者入口，并沿用已有会员链接", () => {
  for (const target of ["/admin", "/api/auth/logout", "//example.test/agent", "https://example.test/agent", "/financing/../admin", "/agent.data"]) {
    assert.equal(memberDestination(target), null);
  }
  assert.equal(memberDestination("/agent?tab=rss&token=secret"), "/agent?tab=rss");
  assert.equal(offerDestination(new URLSearchParams("feature=financing&company=OpenAI")), "/financing/company?name=OpenAI");
  assert.equal(offerDestination(new URLSearchParams("feature=agent")), "/agent");
  assert.equal(checkoutDestinationCookie("caolu_checkout_return=%"), null);
  assert.equal(checkoutDestinationCookie("caolu_checkout_return=%2Fadmin"), null);
  const original = "/financing?" + new URLSearchParams({ investor: "A & B", cursor: "cursor+/=" });
  assert.equal(offerDestination(new URL(membershipOffer(original, ["checkout", "success"]), "https://example.com").searchParams), original);
  assert.equal(checkoutDestinationCookie("caolu_checkout_return=" + encodeURIComponent(original)), original);
});

test("公司历史及长筛选条件可以存入登录和结账回跳 cookie", () => {
  const list = new URLSearchParams({ company: "公司".repeat(60), investor: "投资".repeat(80), cursor: "next".repeat(45) });
  const target = "/financing/company?" + new URLSearchParams({ name: "公司".repeat(60), list: list.toString(), cursor: "old".repeat(40) });
  const compact = packDestination(target);
  assert.ok(compact.length < 2600);
  assert.equal(memberDestination(unpackDestination(compact)), target);
  assert.equal(checkoutDestinationCookie("caolu_checkout_return=" + encodeURIComponent(compact)), target);
});
