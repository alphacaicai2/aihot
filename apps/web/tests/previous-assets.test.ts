import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openPreviousAsset } from "../previous-assets.ts";

test("only serves fingerprinted public assets from the one selected build", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "previous-assets-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = path.join(data, "web-previous-assets");
  const generation = "a".repeat(64);
  const dir = path.join(root, generation);
  const file = "home-DV_x1-90.js";
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), "prior build");
  await writeFile(path.join(root, "current"), generation);
  const asset = await openPreviousAsset(data, "/assets/" + file);
  assert.equal(asset?.size, 11);
  assert.equal((await asset!.stream.toArray()).join(""), "prior build");
  assert.equal(await openPreviousAsset(undefined, "/assets/" + file), undefined);
  for (const url of ["/private/" + file, "/assets/%2e%2e/" + file, "/assets/../" + file, "/assets/home.js", "/assets/source-12345678.map"]) {
    assert.equal(await openPreviousAsset(data, url), undefined);
  }
  await symlink(path.join(root, "current"), path.join(dir, "link-12345678.js"));
  assert.equal(await openPreviousAsset(data, "/assets/link-12345678.js"), undefined);
  await writeFile(path.join(root, "current"), "b".repeat(64));
  assert.equal(await openPreviousAsset(data, "/assets/" + file), undefined);
  await symlink(dir, path.join(root, "b".repeat(64)));
  assert.equal(await openPreviousAsset(data, "/assets/" + file), undefined);
});
