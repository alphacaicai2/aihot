// A changed or interrupted automatic comparison keeps a durable, debounced follow-up.
import { enqueue, QUEUES } from "./queue.ts";

export async function queueConsolidation(storyIds: number[]): Promise<string | null> {
  const ids = [...new Set(storyIds)].sort((a,b) => a-b);
  if (ids.length < 2) return null;
  return enqueue(QUEUES.consolidate,{storyIds:ids},{singletonKey:`stories:${ids.join(":")}`,startAfter:60});
}
