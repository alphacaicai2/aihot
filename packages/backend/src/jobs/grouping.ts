// Analysis hands grouping the same input generation; pending older jobs are promoted atomically.
import { sql, type Db } from "../db.ts";
import type { ProcessingInput } from "../content/processing.ts";
import { enqueue, QUEUES } from "./queue.ts";

export async function queueGrouping(articleId: string, input: ProcessingInput, opts: { signalOnly?: boolean; priority?: number; db?: Db } = {}): Promise<string | null> {
  const run = async (db: Db) => {
    const [current] = await db<{ revision: number; generation: number }[]>`
      SELECT revision,processing_generation AS generation FROM articles WHERE id=${articleId} FOR UPDATE`;
    if (!current || current.revision !== input.revision || current.generation !== input.generation) return null;
    const data = { articleId, revision: input.revision, generation: input.generation, ...(opts.signalOnly ? { signalOnly: true } : {}) };
    const options = { singletonKey: articleId, priority: opts.priority ?? 0 };
    let jobId = await enqueue(QUEUES.group, data, options, db);
    if (!jobId) {
      const [pending] = await db<{ id: string }[]>`UPDATE pgboss.job SET data=${db.json(data)},priority=${options.priority}
        WHERE name=${QUEUES.group} AND singleton_key=${articleId} AND state='created' RETURNING id`;
      jobId = pending?.id ?? await enqueue(QUEUES.group, data, options, db);
      if (!jobId) throw new Error("grouping handoff raced with queue activation; retry the handoff");
    }
    return jobId;
  };
  const db = opts.db ?? sql;
  return "begin" in db ? (db as typeof sql).begin(run) : run(db);
}
