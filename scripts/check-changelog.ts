import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ChangelogRelease } from "../packages/backend/src/site/meta.ts";

type Changelog = { latestVersion: string; releases: ChangelogRelease[] };
const filename = "industry/changelog.json";
const timestamp = (r: ChangelogRelease) => `${r.date}T${r.time}`;
const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0;

function validate(log: Changelog) {
  assert(Array.isArray(log.releases) && log.releases.length, "更新日志缺少条目");
  assert.equal(log.latestVersion, timestamp(log.releases[0]), "latestVersion 须与首条时间相同");
  let previous = "";
  for (const r of log.releases) {
    const version = timestamp(r);
    assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(version), `日期时间格式错误 ${version}`);
    const iso = version.length === 16 ? version + ":00" : version;
    const d = new Date(iso + "Z");
    assert(Number.isFinite(d.getTime()) && d.toISOString().startsWith(iso), `日期时间无效 ${version}`);
    assert(!previous || iso < previous, "条目须按时间严格倒序");
    assert(["更新", "优化", "公告", "下线"].includes(r.kind), "无效的更新类型");
    assert(hasText(r.title) && Array.isArray(r.body) && r.body.length && r.body.every(hasText), "请填写标题和更新说明");
    previous = iso;
  }
}

function requireNewRelease(current: Changelog, previous: Changelog) {
  validate(previous);
  assert(current.latestVersion > previous.latestVersion, "本次发布缺少新的更新日志条目");
  const versions = new Set(current.releases.map(timestamp));
  assert(previous.releases.every(r => versions.has(timestamp(r))), "更新日志遗漏了以前的发布条目");
}

async function fromSite(site: string, path: string) {
  const url = new URL(path, site);
  url.searchParams.set("release_check", String(Date.now()));
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
  assert(response.ok, `${path} HTTP ${response.status}`);
  return response;
}

async function siteJson(site: string, path: string) {
  const response = await fromSite(site, path);
  return response.json();
}

const [mode, target, ...extra] = process.argv.slice(2);
const current: Changelog = JSON.parse(readFileSync(process.env.AIHOT_CHANGELOG_FILE || new URL("../industry/changelog.json", import.meta.url), "utf8"));
validate(current);
if (mode || target || extra.length) {
  assert(target && !extra.length, "用法：check-changelog.ts [--base-ref REF | --before URL | --after URL]");
  if (mode === "--base-ref") {
    const previous = execFileSync("git", ["show", `${target}:${filename}`], { encoding: "utf8" });
    requireNewRelease(current, JSON.parse(previous));
  } else if (mode === "--before") {
    requireNewRelease(current, await siteJson(target, "/api/site/changelog"));
  } else if (mode === "--after") {
    assert.deepEqual(await siteJson(target, "/api/site/changelog"), current, "站点日志与本次发布不一致");
    assert.equal((await siteJson(target, "/api/site/meta")).changelogVersion, current.latestVersion, "导航提醒版本未更新");
    const page = await fromSite(target, "/changelog");
    const html = await page.text();
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
    const title = current.releases[0].title.replace(/[&<>"']/g, c => entities[c]);
    assert(html.includes(`>${title}</h3>`), "公开更新日志页面尚未显示本次标题");
  } else {
    throw new Error(`未知选项 ${mode}`);
  }
}
console.log(`更新日志检查通过 ${current.latestVersion} · ${current.releases[0].title}`);
