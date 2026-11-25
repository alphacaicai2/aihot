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

test("a full bookmark list rejects a new entry and keeps all saved content after removal and undo", async () => {
  const state = await freshState("bookmark-capacity");
  const saved = Array.from({length:state.STARRED_LIMIT}, (_, i) => ({
    id:"bookmark-" + i, title:"标题 " + i, summary:null, sourceName:"来源", publishedAt:null,
    score:null, aiSelected:false, savedAt:new Date(Date.UTC(2026,1,1) - i * 1000).toISOString(),
  }));
  const before = JSON.stringify(saved);
  const values = new Map([[state.KEYS.starred as string, before]]);
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable:true, value:{localStorage:{
    getItem:(key:string) => values.get(key) ?? null,
    setItem:(key:string,value:string) => values.set(key,value),
  }} });
  try {
    const extra = {...saved[0]!, id:"new-bookmark"};
    assert.throws(() => state.setStarred(extra, true), /500/);
    assert.equal(values.get(state.KEYS.starred), before);
    assert.equal(state.setStarred(saved[10]!, true), true);
    assert.equal(state.removeStar(saved[10]!.id), true);
    assert.equal(state.getStarred().length, state.STARRED_LIMIT - 1);
    assert.equal(state.restoreStar(saved[10]!), true);
    assert.deepEqual(state.getStarred(), saved);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
