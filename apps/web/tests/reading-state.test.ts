import assert from "node:assert/strict";
import test from "node:test";

const freshState = (key: string): Promise<typeof import("../app/lib/local-state.ts")> =>
  import(new URL(`../app/lib/local-state.ts?${key}`, import.meta.url).href);

test("reading preferences survive reload, validate stored values and work without storage", async () => {
  const values = new Map<string, string>();
  let blocked = false;
  const localStorage = {
    getItem(key: string) { if (blocked) throw new Error("denied"); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (blocked) throw new Error("denied"); values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
  try {
    const state = await freshState("reading");
    assert.deepEqual(state.getReadingPreferences(), { unreadOnly: false, compact: false });
    state.setReadingPreferences({ compact: true });
    state.setReadingPreferences({ unreadOnly: true });
    assert.strictEqual(state.getReadingPreferences(), state.getReadingPreferences());
    const reloaded = await freshState("reading-reload");
    assert.deepEqual(reloaded.getReadingPreferences(), { unreadOnly: true, compact: true });
    values.set(state.KEYS.reading, '{"unreadOnly":"false","compact":1}');
    const invalid = await freshState("reading-invalid");
    assert.deepEqual(invalid.getReadingPreferences(), { unreadOnly: false, compact: false });
    values.set(state.KEYS.reading, "broken json");
    const corrupt = await freshState("reading-corrupt");
    assert.deepEqual(corrupt.getReadingPreferences(), { unreadOnly: false, compact: false });
    blocked = true;
    corrupt.setReadingPreferences({ compact: true });
    assert.equal(corrupt.getReadingPreferences().compact, true);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("marking an item unread preserves other read records and updates the read snapshot", async () => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } } });
  try {
    const state = await freshState("unread");
    state.markRead("article-a"); state.markRead("article-b");
    const before = state.getReadSet();
    state.markUnread("article-a");
    assert.notStrictEqual(state.getReadSet(), before);
    assert.deepEqual([...state.getReadSet()], ["article-b"]);
    assert.deepEqual(JSON.parse(values.get(state.KEYS.read)!), ["article-b"]);
    state.markRead("article-a");
    assert.equal(state.getReadSet().has("article-a"), true);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
