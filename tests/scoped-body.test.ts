import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readable } from "@aihot/backend/content/extract";

const prose = "Inference costs and deployment economics change the investment opportunity for AI infrastructure. ".repeat(40);
const html = `<html><head><title>Research</title></head><body><nav>Navigation</nav>
  <header><div class="research"><h1>Research</h1><p>${prose}</p></div></header>
  <article><p>${"Unrelated portfolio content. ".repeat(100)}</p></article></body></html>`;

test("an explicit publisher body container preserves research placed inside a header", () => {
  const body = readable(html, "https://example.org/research", ".research");
  assert.ok(body);
  assert.ok(body.text.includes(prose.trim()));
  assert.ok(!body.text.includes("Unrelated portfolio"));
  assert.ok(!body.text.includes("Navigation"));
});

test("a missing publisher body container never falls back to unrelated page content", () => {
  assert.equal(readable(html, "https://example.org/research", ".removed-research"), null);
});
