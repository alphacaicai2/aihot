import test from "node:test";
import assert from "node:assert/strict";
import { wrapText } from "../app/features/hot/share-image.ts";

test("share titles wrap Chinese and long unbroken text without losing content", () => {
  for (const title of ["这是一条需要换行的热点新闻标题", "SuperLongUnbrokenProductReleaseName"]) {
    const lines = wrapText(title, 5, (s) => [...s].length);
    assert.equal(lines.join(""), title);
    assert.ok(lines.every((line) => [...line].length <= 5));
  }
});

test("share title wrapping keeps emoji graphemes intact and normalizes whitespace", () => {
  assert.deepEqual(wrapText("  AI\n 👩‍💻 发布  ", 1, (s) => [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(s)].length), ["A", "I", " ", "👩‍💻", " ", "发", "布"]);
  assert.deepEqual(wrapText("  ", 10, (s) => s.length), []);
});
