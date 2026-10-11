import assert from "node:assert/strict";
import test from "node:test";
import { money } from "../app/features/admin/format.ts";

test("fees keep their currency and small actual charges remain visible", () => {
  assert.equal(money(0.0000247255, "USD"), "$0.0000247255");
  assert.equal(money("0.000054848900", "USD"), "$0.0000548489");
  assert.equal(money(0, "USD"), "$0.00");
  assert.equal(money(1.235, "USD"), "$1.235");
  assert.equal(money(12.345, "CNY"), "¥12.35");
  assert.equal(money(null, "USD"), "—");
  assert.equal(money("invalid", "USD"), "—");
});
