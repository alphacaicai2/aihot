import assert from "node:assert/strict";
import { test } from "node:test";
import { errorDetails } from "../packages/backend/src/lib/error-details.ts";

test("network cause diagnostics omit nested secrets and request objects", () => {
  const cause = Object.assign(new Error("Bearer secret-value"), {
    code: "ECONNRESET", syscall: "read", headers: { authorization: "secret-value" },
  });
  const text = errorDetails(new TypeError("fetch failed", { cause }));
  assert.match(text, /TypeError: fetch failed/);
  assert.match(text, /error.cause: .*code=ECONNRESET syscall=read/);
  assert.doesNotMatch(text, /secret-value|authorization/);
});

test("aggregate connection errors are bounded and cyclic causes terminate", () => {
  const cause = new AggregateError([
    Object.assign(new Error("private endpoint"), { code: "ETIMEDOUT", syscall: "connect" }),
    Object.assign(new Error("private endpoint"), { code: "ENETUNREACH" }),
  ]);
  cause.cause = cause;
  const text = errorDetails(new TypeError("fetch failed", { cause }));
  assert.match(text, /ETIMEDOUT/);
  assert.match(text, /ENETUNREACH/);
  assert.doesNotMatch(text, /private endpoint/);
  assert.ok(text.length <= 2000);
});
