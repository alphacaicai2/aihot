// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { releaseBoundCache } from "../app/lib/api.server.ts";

let web: ChildProcess;
let origin: string;
let logs = "";
let deadline: number;
let refreshAt: string;
let metaDelayMs = 0;
const apiCookies: Array<string | undefined> = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  apiCookies.push(req.headers.cookie);
  if (url.pathname === "/api/site/pending-download") return;
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") {
    const respond = () => res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
    return metaDelayMs ? setTimeout(respond, metaDelayMs) : respond();
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null, topic: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return res.end(JSON.stringify({ filters, cards: [], nextCursor: null, refreshAt, dayCounts: [], hot: null, generatedAt: "2026-09-28T00:00:00Z" }));
  }
  if (url.pathname === "/api/site/hot") return res.end(JSON.stringify({ entries: [] }));
  if (url.pathname === "/api/site/echo-client") return res.end(JSON.stringify({ forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] }));
  if (url.pathname === "/api/site/items/long-lived") return res.end(JSON.stringify({ id: "long-lived", title: "t" }));
  if (url.pathname === "/api/site/contact") return res.end(JSON.stringify({ wechatQr: "/qr.png", feishuQr: "/qr.png" }));
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return res.end(JSON.stringify({ mergedInto: "surviving-story" }));
  }
  if (url.pathname === "/api/reader/membership") {
    const cookie = req.headers.cookie ?? "";
    const isAdmin = cookie.includes("admin_session=member");
    const isReader = cookie.includes("reader_session=member");
    const isUnpaid = cookie.includes("reader_session=unpaid");
    return res.end(JSON.stringify({
      email: isAdmin ? "admin@example.test" : isReader || isUnpaid ? "reader@example.test" : null,
      emailConfirmed: isAdmin || isReader || isUnpaid,
      access: isAdmin || isReader,
      admin: isAdmin,
      source: isAdmin ? "admin" : isReader ? "subscription" : null,
      customer: isReader,
      billingReady: true,
      hasToken: false,
    }));
  }
  if (url.pathname === "/api/reader/me") {
    const cookie = req.headers.cookie ?? "";
    if (cookie.includes("admin_session=member")) return res.end(JSON.stringify({ enabled: true, email: "second-reader@example.test" }));
    if (cookie.includes("reader_session=member")) return res.end(JSON.stringify({ enabled: true, email: "reader@example.test" }));
    return res.end(JSON.stringify({ enabled: true, email: null }));
  }
  if (url.pathname === "/api/admin/me") {
    if ((req.headers.cookie ?? "").includes("admin_session=member")) return res.end(JSON.stringify({ userId: 1, name: "Admin", csrf: "test-admin-csrf", dev: false }));
    res.statusCode = 401;
    return res.end(JSON.stringify({ code: "unauthorized" }));
  }
  if (url.pathname === "/api/v1/financing") {
    if (!(req.headers.cookie ?? "").includes("reader_session=member")) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ code: "unauthorized" }));
    }
    return res.end(JSON.stringify({ events: [], hasMore: false, nextCursor: null }));
  }
  if (url.pathname === "/api/site/financing/company") {
    if (!(req.headers.cookie ?? "").includes("reader_session=member")) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ code: "unauthorized" }));
    }
    return res.end(JSON.stringify({ events: [], hasMore: false, nextCursor: null, historySummary: { records: 0, latestAt: "2026-09-28T00:00:00Z" } }));
  }
  res.statusCode = url.pathname.startsWith("/api/admin/") ? 401 : 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 20;
  refreshAt = new Date((deadline + 5) * 1000).toISOString();
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_PORT: "0", TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        origin = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

after(async () => {
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

test("public route subsets produce the same complete navigation data; filters still differ", async () => {
  const answers = await Promise.all(["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
    const res = await fetch(`${origin}/_.data${query}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control")!, /^public,/);
    assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
    assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
    const body = await res.text();
    assert.ok(body.includes("root") && body.includes("routes/home"));
    return body;
  }));
  assert.ok(answers.every((body) => body === answers[0]));
  const category = CATEGORY_KEYS.at(-1)!;
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.ok(body.includes(category));
  assert.notEqual(body, answers[0]);
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  const plain = await fetch(`${origin}/about.data`);
  const signedIn = await fetch(`${origin}/about.data?_routes=root`, { headers: { cookie: "admin_session=private; aihot_vid=reader" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.match(plain.headers.get("X-Accel-Expires")!, /^@\d+$/);
  assert.equal(plain.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  assert.equal(Date.parse(plain.headers.get("Date")!) / 1000 + 300, Number(plain.headers.get("X-Accel-Expires")!.slice(1)));
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

test("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [["/story/merged.data?_routes=root", "/story/surviving-story"], ["/_.data?q=search&_routes=root", "/all?q=search"]]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

test("admin data and actions never become public cache entries", async () => {
  const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
  assert.equal(admin.status, 202);
  assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
  assert.equal(admin.headers.get("X-Accel-Expires"), "0");
  assert.match(await admin.text(), /admin\/login/);
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("an elapsed release deadline cannot be extended by a fresh page/data response", async () => {
  const saved = refreshAt;
  refreshAt = new Date(Date.now() - 1000).toISOString();
  try {
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }
  } finally {
    refreshAt = saved;
  }
  const now = Date.parse("2026-09-28T00:00:00Z");
  const upstream = new Headers({ "X-Accel-Expires": `@${now / 1000 + 7}` });
  const headers = releaseBoundCache(new Date(now + 20_000).toISOString(), 30, now + 2_000, upstream);
  assert.equal(headers["Cache-Control"], "public, max-age=0, s-maxage=5");
  assert.equal(headers["X-Accel-Expires"], upstream.get("X-Accel-Expires"));
});

test("browser freshness shares the selected deadline, including slow sibling loaders", async () => {
  const savedDeadline = deadline;
  const savedRefresh = refreshAt;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    refreshAt = new Date((deadline + 5) * 1000).toISOString();
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= deadline);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL, but root metadata finishes after it.
    deadline = Math.floor(Date.now() / 1000) + 2;
    refreshAt = new Date((deadline + 5) * 1000).toISOString();
    metaDelayMs = 2300;
    await Promise.all(["/", "/_.data?_routes=routes%2Fhome"].map(async (pathname) => {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }));
  } finally {
    deadline = savedDeadline;
    refreshAt = savedRefresh;
    metaDelayMs = 0;
  }
});

test("the edge may keep a page longer than browsers, which a withdrawal purge cannot reach", async () => {
  const res = await fetch(`${origin}/items/long-lived.data`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300, s-maxage=600, must-revalidate");
  await res.text();
});

test("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});

test("closing a proxied download before response headers aborts the upstream request", async () => {
  const incoming = once(api, "request", {signal:AbortSignal.timeout(2000)});
  const controller = new AbortController();
  const request = fetch(origin + "/api/site/pending-download", {signal:controller.signal});
  const [, response] = await incoming;
  const closed = once(response, "close", {signal:AbortSignal.timeout(2000)});
  controller.abort();
  await assert.rejects(request, {name:"AbortError"});
  await closed;
});

test("homepage links to membership without breaking public caching", async () => {
  const res = await fetch(origin + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Cache-Control")!, /^public,/);
  const html = await res.text();
  assert.match(html, /href="\/membership"/);
  assert.match(html, /读者会员/);
});

test("membership gates private HTML and single-fetch data and forwards financing session cookies", async () => {
  const headers = { cookie: "reader_session=member" };
  for (const path of ["/agent", "/financing"]) {
    const anonymous = await fetch(origin + path, { redirect: "manual" });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get("location"), "/membership?feature=" + path.slice(1));
    assert.equal(anonymous.headers.get("cache-control"), "private, no-store");
    const anonData = await fetch(origin + path + ".data");
    assert.equal(anonData.status, 202);
    assert.match(await anonData.text(), /membership/);
    for (const suffix of ["", ".data", ".data?_routes=root"]) {
      const member = await fetch(origin + path + suffix, { headers });
      assert.equal(member.status, 200);
      assert.equal(member.headers.get("cache-control"), "private, no-store");
      assert.equal(member.headers.get("x-accel-expires"), "0");
      if (!suffix) {
        const html = await member.text();
        assert.match(html, path === "/agent" ? /生成访问令牌/ : /暂时没有融资记录/);
        if (path === "/financing") assert.doesNotMatch(html, /导出本页 CSV/);
      }
    }
  }
  const filters = new URLSearchParams({ company: "OpenAI", investor: "A+B", investorMode: "exact", cursor: "list+/=" });
  const company = "/financing/company?" + new URLSearchParams({ name: "OpenAI", list: filters.toString(), cursor: "old+/=" });
  const companyAnon = await fetch(origin + company, { redirect: "manual" });
  assert.equal(companyAnon.status, 302);
  const navigation = await fetch(origin + company.replace("/company?", "/company.data?") + "&_routes=routes%2Ffinancing-company");
  assert.equal(navigation.status, 202);
  const navigationBody = await navigation.text();
  assert.ok(navigationBody.includes(encodeURIComponent(company)), navigationBody);
  const offer = new URL(companyAnon.headers.get("location")!, origin);
  assert.equal(offer.pathname, "/membership");
  assert.equal(offer.searchParams.get("return"), company);
  assert.equal(offer.searchParams.get("company"), "OpenAI");
  const companyMember = await fetch(offer, { headers, redirect: "manual" });
  assert.equal(companyMember.headers.get("location"), company);
  const agent = await fetch(origin + "/agent?tab=rss", { redirect: "manual" });
  const agentOffer = new URL(agent.headers.get("location")!, origin);
  assert.equal(agentOffer.searchParams.get("return"), "/agent?tab=rss");
  const agentMember = await fetch(agentOffer, { headers, redirect: "manual" });
  assert.equal(agentMember.headers.get("location"), "/agent?tab=rss");
  assert.equal(companyAnon.headers.get("cache-control"), "private, no-store");
  const companyPage = await (await fetch(offer)).text();
  assert.match(companyPage, /查看「OpenAI」的完整历次融资记录需要读者会员权限/);
  const loginHref = companyPage.match(/href="([^"]*api\/reader\/google[^"]*)"/)![1];
  assert.equal(new URL(loginHref.replaceAll("&amp;", "&"), origin).searchParams.get("return"), company);

  const signedIn = { cookie: "reader_session=unpaid" };
  for (const [entry, target] of [[offer, company], [agentOffer, "/agent?tab=rss"]] as const) {
    const protectedRoute = await fetch(origin + target, { headers: signedIn, redirect: "manual" });
    assert.equal(protectedRoute.headers.get("location"), entry.pathname + entry.search);
    const offerBody = await (await fetch(entry, { headers: signedIn })).text();
    assert.match(offerBody, /订阅会员 · US\$5/);
    assert.doesNotMatch(offerBody, /使用 Google 登录/);
    const action = offerBody.match(/action="([^"]*api\/reader\/billing\/checkout[^"]*)"/)![1];
    assert.equal(new URL(action.replaceAll("&amp;", "&"), origin).searchParams.get("return"), target);
    const canceled = new URL(entry);
    canceled.searchParams.set("checkout", "canceled");
    assert.match(await (await fetch(canceled, { headers: signedIn })).text(), /已退出结账/);
  }

  const comeback = await fetch(origin + "/membership?checkout=success", {
    headers: { cookie: headers.cookie + "; caolu_checkout_return=" + encodeURIComponent(company) },
  });
  assert.match(await comeback.text(), /继续访问会员内容/);

  const member = await fetch(origin + "/membership", { headers });
  const readerPage = await member.text();
  assert.match(readerPage, /reader@example.test/);
  assert.match(readerPage, /action="\/api\/reader\/logout"/);
  const admin = await fetch(origin + "/membership", { headers: { cookie: "admin_session=member" } });
  const adminPage = await admin.text();
  assert.match(adminPage, /action="\/api\/auth\/logout"/);
  assert.match(adminPage, /action="\/api\/reader\/logout"/);
  assert.match(adminPage, /second-reader@example.test/);
  assert.match(adminPage, /name="csrf" value="test-admin-csrf"/);
  const anon = await fetch(origin + "/membership");
  assert.equal(anon.headers.get("cache-control"), "private, no-store");
  const body = await anon.text();
  assert.match(body, /US\$5/);
  assert.match(body, /免费阅读与读者会员的区别/);
  assert.match(body, /展示样例/);
  const sample = body.match(/href="data:text\/csv;charset=utf-8,([^"]+)"/);
  assert.ok(sample, "the public offer includes its own downloadable example");
  const lines = decodeURIComponent(sample[1]!).trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /"Anthropic","2025-09-02","F 轮","130"/);
  assert.match(lines[2]!, /"Anthropic","2025-03-03","E 轮","35"/);
  assert.ok(lines.slice(1).every(row => row.includes("https://www.anthropic.com/news/")));
  assert.doesNotMatch(body, /reader@example.test|action="\/api\/(?:auth|reader)\/logout"|test-admin-csrf/);
});
