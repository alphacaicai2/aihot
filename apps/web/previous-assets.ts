// A deployment may publish one prior build's fingerprinted assets under the configured data directory.
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export async function openPreviousAsset(dataDir: string | undefined, pathname: string) {
  const match = /^\/assets\/([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2))$/.exec(pathname);
  if (!dataDir || !path.isAbsolute(dataDir) || !match) return;
  const root = path.join(dataDir, "web-previous-assets");
  try {
    const generation = (await readFile(path.join(root, "current"), "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(generation)) return;
    const dir = path.join(root, generation);
    if ((await realpath(dir)) !== path.join(await realpath(dataDir), "web-previous-assets", generation)) return;
    const handle = await open(path.join(dir, match[1]!), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (info.isFile()) return { stream: handle.createReadStream(), size: info.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
    await handle.close();
  } catch {
    // Missing assets use the normal routing / 404 path, including during archive replacement.
  }
}
