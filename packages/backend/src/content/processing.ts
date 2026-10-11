import { sql, type Db } from "../db.ts";

export interface ProcessingInput { revision: number; generation: number }

export async function processingInput(articleId: string, db: Db = sql): Promise<ProcessingInput | null> {
  const [row] = await db<{ revision: number; generation: number }[]>`
    SELECT revision, processing_generation AS generation FROM articles WHERE id = ${articleId}`;
  return row ?? null;
}
