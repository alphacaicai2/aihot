import test from "node:test";
import assert from "node:assert/strict";
import { wrapText } from "../app/features/hot/share-image.ts";
import { canShareImage, shareImage } from "../app/features/hot/share-file.ts";

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

const image = new File([new Uint8Array([137, 80, 78, 71])], "热点榜.png", { type: "image/png" });

test("image sharing requires support for this PNG, not just link sharing", async () => {
  let calls = 0;
  const share = async () => { calls += 1; };
  for (const target of [{}, { share }, { share, canShare: () => false }, { share, canShare: () => { throw new Error("blocked"); } }, { canShare: () => true }]) {
    assert.equal(canShareImage(image, target), false);
    assert.equal(await shareImage(image, target), "unsupported");
  }
  assert.equal(calls, 0);
});

test("image sharing sends the original PNG during the click, before yielding", async () => {
  let called = false;
  const target = {
    canShare: (data: ShareData) => data.files?.[0] === image,
    async share(data: ShareData) {
      called = true;
      assert.deepEqual(data, { files: [image] });
      assert.equal(data.files?.[0]?.type, "image/png");
    },
  };
  const result = shareImage(image, target);
  assert.equal(called, true);
  assert.equal(await result, "shared");
});

test("cancelling the system chooser is distinct from permission or transport failure", async () => {
  for (const [name, expected] of [["AbortError", "cancelled"], ["NotAllowedError", "failed"], ["DataError", "failed"]] as const) {
    assert.equal(await shareImage(image, {
      canShare: () => true,
      share: async () => { throw new DOMException("share stopped", name); },
    }), expected);
  }
});
