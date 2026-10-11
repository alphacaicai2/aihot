import assert from "node:assert/strict";
import test from "node:test";
import { ago, money, retryTime } from "../app/features/admin/format.ts";

test("fees keep their currency and small actual charges remain visible", () => {
  assert.equal(money(0.0000247255, "USD"), "$0.0000247255");
  assert.equal(money("0.000054848900", "USD"), "$0.0000548489");
  assert.equal(money(0, "USD"), "$0.00");
  assert.equal(money(1.235, "USD"), "$1.235");
  assert.equal(money(12.345, "CNY"), "¥12.35");
  assert.equal(money(null, "USD"), "—");
  assert.equal(money("invalid", "USD"), "—");
});

test("relative times use the same checked-at snapshot across server and browser renders", () => {
  const checkedAt = Date.parse("2026-10-12T00:00:30Z");
  const heartbeat = "2026-10-12T00:00:00Z";
  const clock = Date.now;
  try {
    Date.now = () => checkedAt;
    const server = [ago(heartbeat, checkedAt), retryTime("2026-10-12T00:01:00Z", checkedAt)];
    Date.now = () => checkedAt + 70_000;
    const browser = [ago(heartbeat, checkedAt), retryTime("2026-10-12T00:01:00Z", checkedAt)];
    assert.deepEqual(browser, server);
    assert.equal(browser[0], "30 秒前");
    assert.equal(browser[1], "下次重试 30 秒后");
  } finally {
    Date.now = clock;
  }
});

test("retry times distinguish a future retry from work already due for scheduling", () => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  assert.equal(retryTime("2026-10-12T00:05:00Z", now), "下次重试 5 分钟后");
  assert.equal(retryTime("2026-10-11T23:55:00Z", now), "已到重试时间，等待调度");
  assert.equal(retryTime("2026-10-12T00:00:00Z", now), "已到重试时间，等待调度");
  assert.equal(retryTime(null, now), "等待调度");
  assert.equal(retryTime("invalid", now), "等待调度");
});
