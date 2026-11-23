import assert from "node:assert/strict";
import { test } from "node:test";
import { receiptChannel } from "../app/features/admin/model-usage.ts";

test("usage distinguishes providers of the same model and ambiguous shared LLM receipts", () => {
  const choices = [
    { key: "go", service: "opencode-go", channel: "OpenCode Go", model: "flash" },
    { key: "official", service: "deepseek", channel: "DeepSeek 官方", model: "flash" },
    { key: "custom", service: "llm", channel: "自定义", model: "shared" },
    { key: "router", service: "llm", channel: "OpenRouter", model: "shared" },
    { key: "router2", service: "llm", channel: "OpenRouter", model: "other" },
  ];
  assert.equal(receiptChannel(choices, "opencode-go", "flash"), "OpenCode Go");
  assert.equal(receiptChannel(choices, "deepseek", "flash"), "DeepSeek 官方");
  assert.equal(receiptChannel(choices, "opencode-go", "retired"), "OpenCode Go");
  assert.equal(receiptChannel(choices, "llm", "shared"), null);
  assert.equal(receiptChannel(choices, "llm", "other"), "OpenRouter");
});
