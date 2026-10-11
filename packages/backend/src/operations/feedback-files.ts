import { unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql, type Tx } from "../db.ts";

export function feedbackScreenshotPath(key: string | null): string | null {
  if (!key?.startsWith("local:")) return null;
  const filename = key.slice(6);
  return /^[\w-][\w.-]*\.(png|jpeg|jpg|webp|gif)$/i.test(filename)
    ? path.join(config.dataDir, "feedback-screenshots", filename) : null;
}

export async function queueFeedbackFileCleanup(tx: Tx, id: number, key: string | null) {
  const file = feedbackScreenshotPath(key);
  if (file) await tx`INSERT INTO feedback_file_cleanup(filename, feedback_id)
    VALUES(${path.basename(file)}, ${id}) ON CONFLICT(filename) DO NOTHING`;
}

/** Retry after commit, including a crash after unlink but before the cleanup record was removed. */
export async function cleanupFeedbackFiles(filenames?: string[]) {
  if (filenames?.length === 0) return { deleted: 0, failed: 0, pending: 0 };
  let deleted = 0, failed = 0, pending = 0;
  await sql.begin(async tx => {
    const rows = await tx<{ filename: string }[]>`SELECT filename FROM feedback_file_cleanup c
      WHERE ${filenames ? tx`filename IN ${tx(filenames)}` : tx`true`}
        AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.screenshot_key='local:' || c.filename)
      ORDER BY attempts, created_at, filename LIMIT 20 FOR UPDATE SKIP LOCKED`;
    for (const row of rows) {
      const key = `local:${row.filename}`, file = feedbackScreenshotPath(key);
      const [reference] = await tx`SELECT 1 FROM feedback WHERE screenshot_key=${key} LIMIT 1`;
      if (reference) { pending++; continue; }
      try {
        if (!file) throw Object.assign(new Error("invalid filename"), { code: "INVALID_FILENAME" });
        await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
        await tx`DELETE FROM feedback_file_cleanup WHERE filename=${row.filename}`;
        deleted++;
      } catch (error) {
        await tx`UPDATE feedback_file_cleanup SET attempts=attempts+1,
          last_error=${String((error as { code?: string }).code ?? "UNLINK_FAILED")} WHERE filename=${row.filename}`;
        failed++; pending++;
      }
    }
  });
  return { deleted, failed, pending };
}
