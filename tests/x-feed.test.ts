import assert from "node:assert/strict";
import { test } from "node:test";
import { xFeedContent } from "@aihot/backend/content/x-feed";

const url = "https://x.com/example/status/123456789";
const footer = " 🔗 View on Twitter 🔗 View Quoted Tweet 💬 8 🔄 2 ❤️ 26 👀 6415 📊 10 ⚡ Powered by xgo.ing";

test("xgo counters are metadata; quoted content and numbers in the post remain", () => {
  const body = "Model costs $26. Benchmark: 6415. Quoted post: 8 likes yesterday.";
  const result = xFeedContent(url, body + footer);
  assert.equal(result.text, body);
  assert.deepEqual(result.metrics, { replies: "8", reposts: "2", likes: "26", views: "6415", score: "10" });
  assert.equal(xFeedContent(url, body + footer.replace("6415", "9.2K").replace("❤️ 26", "❤️ 100")).text, body);
  assert.equal(xFeedContent(url, body + footer.replace(" 🔗 View on Twitter", "")).text, body);
  assert.equal(xFeedContent(url, body + footer.replace(" 🔗 View on Twitter 🔗 View Quoted Tweet", "")).text, body);
});

test("ordinary articles and posts discussing engagement are untouched", () => {
  const text = "Our post received ❤️ 26 👀 6415.";
  assert.equal(xFeedContent(url, text).text, text);
  assert.equal(xFeedContent("https://example.org/article", "Post" + footer).text, "Post" + footer);
  assert.equal(xFeedContent(url, "Post" + footer + " A real continuation.").text, "Post" + footer + " A real continuation.");
  assert.equal(xFeedContent(url, null).text, null);
});
