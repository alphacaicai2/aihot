import { useEffect, useState, type FormEvent } from "react";
import { checkoutDestinationCookie } from "@aihot/contracts/member-destination.server";
import { checkoutDestinationKey, memberDestination, membershipOffer, offerDestination } from "@aihot/contracts/member-destination";
import { Link, redirect, useRevalidator } from "react-router";
import type { SiteStats } from "@aihot/contracts/site";
import { MCP_TOOL_NAMES as T } from "@aihot/contracts/mcp";
import { SITE, withSubject } from "@aihot/industry/site";
import type { Route } from "./+types/membership";
import {
  IconArrowRight,
  IconChart,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconExternal,
  IconPlug,
  IconSparkles,
} from "../components/icons";
import { Badge } from "../components/ui/Badge";
import { buttonClass } from "../components/ui/Controls";
import { Kicker } from "../components/ui/Kicker";
import { adminGet } from "../lib/admin.server";
import { apiGet } from "../lib/api.server";
import { getMembership, memberGet, privateHeaders, type Membership } from "../lib/membership.server";
import { pageMeta, siteUrl } from "../lib/seo";

export const headers = () => privateHeaders;

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const [membership, stats] = await Promise.all([
    getMembership(request),
    apiGet<SiteStats>("/api/site/stats", { signal: request.signal }).catch(() => null),
  ]);
  const checkout = params.get("checkout");
  const target = offerDestination(params);
  if (membership.access && target) throw redirect(target, { headers: privateHeaders });
  const checkoutReturn = !target && (checkout === "success" || checkout === "canceled");
  const returnTo = target ?? (checkoutReturn ? checkoutDestinationCookie(request.headers.get("cookie")) : null);
  const offer = new URL(membershipOffer(returnTo), request.url).searchParams;
  const [adminSession, reader] = membership.admin
    ? await Promise.all([
        adminGet<{ csrf: string }>(request, "/api/admin/me"),
        memberGet<{ email: string | null }>(request, "/api/reader/me"),
      ])
    : [null, membership];
  return {
    membership,
    stats,
    base: siteUrl(),
    adminCsrf: adminSession?.csrf,
    readerEmail: reader.email,
    checkout, checkoutReturn, returnTo,
    billing: params.get("billing"),
    feature: offer.get("feature"),
    company: offer.get("company")?.trim().slice(0, 120) || null,
  };
}

export const meta: Route.MetaFunction = () =>
  pageMeta({
    title: "读者会员",
    description: `订阅 ${SITE.name} 读者会员（US$5 / 月）：解锁结构化融资数据库、公司历次融资档案与 CSV 导出，以及 MCP、REST API 和会员 RSS 接入。`,
    path: "/membership",
    image: "/og/pages/membership.png",
    noindex: true,
  });

const PLAN_POINTS = [
  "单笔交易融资库：按公司、投资机构别名与日期精准检索",
  "公司历次融资档案与多来源口径核对，一键导出 CSV",
  "个人只读访问令牌：接入 MCP Server（5 个工具）与 REST API v1",
  "会员 RSS 全量与分类订阅，支持 Claude Code、Codex 与自动化脚本",
];

const AUDIENCES = [
  {
    title: "投资研究与行研",
    detail: "按投资机构或公司查单笔交易与历次融资，展开直接核对各篇报道原文引句，导出 CSV 做进一步整理。",
  },
  {
    title: "AI 创业与战略追踪",
    detail: "不只看每天的新闻标题，持续跟踪关键公司拿了谁的钱、处在什么轮次与交易阶段。",
  },
  {
    title: "用 Agent 消费信息的开发者",
    detail: "一枚只读令牌打通 MCP、REST API v1 与 RSS，让 Claude Code、Codex 或内部脚本按需拉取精选、热点与日报。",
  },
];

const COMPARISON_ROWS: Array<{ feature: string; free: string; member: string }> = [
  { feature: `每日精选、全部动态、一手发现与热点榜`, free: "完整开放", member: "完整开放" },
  { feature: `${withSubject("日报")}、周报、月报与主题聚合`, free: "完整开放", member: "完整开放" },
  { feature: "融资数据库（按公司 / 投资机构别名 / 日期筛选）", free: "—", member: "完整开放" },
  { feature: "公司历次融资档案与多来源口径核对", free: "—", member: "完整开放" },
  { feature: "融资记录 CSV 导出（含记录类型标注）", free: "—", member: "完整开放" },
  { feature: "MCP Server（5 个只读工具）", free: "—", member: "个人令牌接入" },
  { feature: "REST API v1（查询、全量快照与增量游标）", free: "—", member: "个人令牌接入" },
  { feature: "会员 RSS、llms.txt 与文章 Markdown 导出", free: "—", member: "个人令牌接入" },
];

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "哪些内容继续免费开放？",
    a: `首页每日精选、全部动态、一手发现、当前热点榜、事件时间线与综述、主题页以及${withSubject("日报")}、周报和月报全部继续免费开放阅读，无需登录。`,
  },
  {
    q: "费用怎么结算？可以随时取消续订吗？",
    a: "读者会员为 US$5 / 月，通过 Stripe 完成订阅和自动续订。你可以随时回到本页点击「管理 Stripe 订阅」，在 Stripe 客户门户中取消续订或更换付款方式；取消后当前已付周期内仍可继续使用。",
  },
  {
    q: "开通后支持哪些 Agent 和客户端？",
    a: "开通后可在 Agent 接入页生成个人访问令牌（仅授予读取权限），通过请求头 Authorization: Bearer <token> 接入任何支持 Streamable HTTP 的 MCP 客户端（如 Claude Code、Codex），以及 REST API v1 和 RSS 阅读器。",
  },
  {
    q: "融资数据库的数据从哪来？口径有差异怎么办？",
    a: "融资记录从站内收录的公开报道中按单笔交易提取并人工/规则核对，每条记录都保留来源媒体、原文引句与原文链接。同一笔融资如有多篇报道且披露口径不同，会并列展示各来源并在卡片上标注提醒。",
  },
  {
    q: "如果管理员已经按邮箱给我授权，还需要订阅吗？",
    a: "不需要。使用被授权邮箱对应的 Google 账号登录后即可直接使用会员功能；如果你使用的是第三方邮箱登录，页面下方会出现一次性的邮箱确认码输入框，填入管理员发给该邮箱的确认码即可完成绑定。",
  },
];

function EmailConfirmation({ email }: { email: string }) {
  const { revalidate } = useRevalidator();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/reader/membership/confirm", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!response.ok) {
        setMessage(
          response.status === 401
            ? "登录已过期，请重新登录。"
            : response.status === 400
              ? "确认码无效或已过期，请核对邮箱并联系管理员获取新码。"
              : "暂时无法确认，请稍后重试。",
        );
        return;
      }
      setCode("");
      await revalidate();
      setMessage("邮箱已确认。");
    } catch {
      setMessage("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="confirm-email" aria-labelledby="confirm-grant" className="card mt-6 p-5 sm:p-6">
      <h2 id="confirm-grant" className="text-[16px] font-semibold text-ink">
        确认邮箱授权
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-3">
        如果管理员已为 {email} 授权，请输入管理员发给该邮箱的一次性确认码。直接订阅可跳过此步。
      </p>
      <form onSubmit={confirm} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
          邮箱确认码
          <input
            required
            maxLength={128}
            autoComplete="one-time-code"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="rounded-control border border-line bg-bg px-3 py-2 font-mono text-ink"
          />
        </label>
        <button className={buttonClass("secondary", "md")} aria-busy={busy} disabled={busy || !code.trim()}>
          {busy ? "确认中…" : "确认邮箱"}
        </button>
      </form>
      {message && (
        <p role="status" className="mt-2 text-sm text-ink-2">
          {message}
        </p>
      )}
    </section>
  );
}

function ActionControls({
  membership,
  pending, returnTo,
  size = "lg",
}: {
  membership: Membership;
  pending: boolean;
  returnTo: string | null;
  size?: "md" | "lg";
}) {
  const { access, email, admin, customer, billingReady } = membership;
  const [openingBilling, setOpeningBilling] = useState(false);
  useEffect(() => {
    const restore = () => setOpeningBilling(false);
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);
  const returnQuery = returnTo ? "?" + new URLSearchParams({ return: returnTo }) : "";
  if (access) {
    return (
      <div className="flex flex-wrap items-center gap-2.5">
        <Link to={returnTo ?? "/financing"} className={buttonClass("primary", size)}>
          {returnTo ? "继续访问会员内容" : "进入融资数据库"} <IconArrowRight size={15} />
        </Link>
        <Link to="/agent" className={buttonClass("secondary", size)}>
          配置 Agent 接入
        </Link>
        {customer && billingReady && (
          <form method="post" action={"/api/reader/billing/portal" + returnQuery} onSubmit={() => setOpeningBilling(true)}>
            <button type="submit" disabled={openingBilling} className={buttonClass("ghost", "md")}>
              {openingBilling ? "正在打开订阅管理…" : "管理订阅"}
            </button>
          </form>
        )}
      </div>
    );
  }
  if (!email && !admin) {
    return (
      <div className="space-y-2">
        <a href={"/api/reader/google?" + new URLSearchParams({ return: returnTo ?? "/membership" })} className={`${buttonClass("primary", size)} w-full justify-center sm:w-auto`}>
          使用 Google 登录
        </a>
        <p className="text-[12px] leading-relaxed text-ink-4">{billingReady ? "登录后可选择订阅，付款前可查看价格。" : "订阅支付暂未开放，已有会员可以登录。"}</p>
      </div>
    );
  }
  if (pending) return null;
  if (!billingReady) {
    return (
      <p role="status" className="text-sm text-ink-3">
        订阅支付暂未开放。
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <form method="post" action={"/api/reader/billing/checkout" + returnQuery}
        onSubmit={() => {
          setOpeningBilling(true);
          // Open Checkout sessions are shared by a reader; billing can start from two different tabs.
          try { sessionStorage.setItem(checkoutDestinationKey, returnTo ?? ""); } catch { /* server cookie fallback */ }
        }}>
        <button type="submit" disabled={openingBilling} className={`${buttonClass("primary", size)} w-full justify-center sm:w-auto`}>
          {openingBilling ? "正在打开安全结账…" : "订阅会员 · US$5 / 月"}
        </button>
      </form>
      <p className="text-[12px] leading-relaxed text-ink-4">跳转至 Stripe 安全结账 · 付款确认后立即生效</p>
    </div>
  );
}

function FinancingSampleCard() {
  return (
    <div className="card flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-control bg-accent-soft text-accent">
            <IconChart size={15} />
          </span>
          <h3 className="text-[15.5px] font-bold text-ink">融资数据库与公司历次融资</h3>
        </div>
        <Badge tone="neutral">展示样例</Badge>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <p className="text-[13.5px] leading-relaxed text-ink-3">
          每笔交易归并多篇公开报道，保留各来源披露口径与原文引句；点击公司名查看历次融资，支持按投资机构别名筛选并导出 CSV。
        </p>

        <div className="mt-4 rounded-card border border-line bg-bg/70 p-4">
          <div className="flex items-start gap-3">
            <div className="hidden w-14 shrink-0 border-r border-line pr-3 text-ink-3 sm:block">
              <span className="mono block text-[15px] font-bold text-accent">11/23</span>
              <span className="mono text-[11px]">2026</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
                <span>4 篇报道</span>
                <Badge tone="amber" className="h-[19px] px-1.5 text-[10.5px]">来源口径有差异</Badge>
              </div>
              <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[16px] font-bold text-accent underline decoration-accent/40 underline-offset-4">
                  镁伽科技
                </span>
                <span className="text-[11.5px] text-ink-4">点击公司名可查历次融资</span>
              </div>
              <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px] text-ink-3">
                <div>
                  <dt className="inline text-ink-4">轮次 · </dt>
                  <dd className="inline font-medium text-ink-2">E 轮</dd>
                </div>
                <div>
                  <dt className="inline text-ink-4">本轮金额 · </dt>
                  <dd className="inline font-semibold text-accent">近 2 亿美元</dd>
                </div>
                <div className="col-span-2">
                  <dt className="inline text-ink-4">投资方 · </dt>
                  <dd className="inline text-ink-2">支持机构中英文与简称别名检索</dd>
                </div>
              </dl>
              <blockquote className="mt-3 border-l-2 border-accent/50 pl-3 text-[12.5px] leading-relaxed text-ink-3">
                “每条交易记录均保留原文引句与媒体链接，多笔合计披露和待核实记录单独标明。”
              </blockquote>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-[12px] text-ink-3">
          <span className="inline-flex items-center gap-1 rounded-control bg-bg-sunk px-2.5 py-1">
            <IconDownload size={12} className="text-accent" />
            导出筛选结果 CSV
          </span>
          <span className="inline-flex items-center gap-1 rounded-control bg-bg-sunk px-2.5 py-1">
            <IconExternal size={12} className="text-accent" />
            逐条回溯报道原文
          </span>
        </div>
      </div>
    </div>
  );
}

function AgentSampleCard({ base }: { base: string }) {
  const mcpUrl = `${base}/api/mcp`;
  const tools = [
    [T.latest, "24h / 7d 精选与全部"],
    [T.search, "按公司与话题检索"],
    [T.hot, "当前热点榜 Top 10"],
    [T.story, "事件时间线与综述"],
    [T.daily, `最新与历史${withSubject("日报")}`],
  ];
  return (
    <div className="card flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-control bg-accent-soft text-accent">
            <IconPlug size={15} />
          </span>
          <h3 className="text-[15.5px] font-bold text-ink">Agent 接入（MCP / REST API / RSS）</h3>
        </div>
        <Badge tone="neutral">展示样例</Badge>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <p className="text-[13.5px] leading-relaxed text-ink-3">
          在站内生成一枚只读个人访问令牌，同一枚令牌即可接入 MCP Server、REST API v1（含全量快照与增量游标）以及全部分类 RSS。
        </p>

        <pre className="mt-4 overflow-x-auto rounded-card border border-line bg-[var(--code-bg)] p-3.5 font-mono text-[12px] leading-[1.65] text-ink-2">
          <code>{`# Claude Code 接入 MCP\nclaude mcp add --transport http \\\n  --header "Authorization: Bearer $CAOLU_AGENT_TOKEN" \\\n  ${SITE.mcpPrefix} '${mcpUrl}'\n\n# REST API 查询融资记录\ncurl -H "Authorization: Bearer $CAOLU_AGENT_TOKEN" \\\n  '${base}/api/v1/financing?investor=a16z'`}</code>
        </pre>

        <div className="mt-4">
          <div className="text-[11.5px] font-semibold tracking-wide text-ink-4">MCP 内置 5 个只读工具</div>
          <ul className="mt-2 grid grid-cols-1 gap-1.5 text-[12.5px] sm:grid-cols-2">
            {tools.map(([tool, desc]) => (
              <li key={tool} className="flex items-baseline gap-1.5 rounded-control bg-bg-sunk px-2.5 py-1.5">
                <code className="mono shrink-0 text-[11.5px] text-accent">{tool}</code>
                <span className="truncate text-ink-3">{desc}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function MembershipPage({ loaderData }: Route.ComponentProps) {
  const { membership, stats, base, adminCsrf, readerEmail, checkout, billing, feature, company, checkoutReturn, returnTo } = loaderData;
  const { access, email, admin, customer, billingReady, source } = membership;
  const { revalidate } = useRevalidator();
  const pending = checkout === "success" && !access;

  useEffect(() => {
    if (!checkoutReturn) return;
    let target = returnTo;
    try {
      const saved = sessionStorage.getItem(checkoutDestinationKey);
      if (saved !== null) {
        target = memberDestination(saved);
        sessionStorage.removeItem(checkoutDestinationKey);
      }
    } catch { /* use the server cookie when browser storage is unavailable */ }
    if (target) window.location.replace(membershipOffer(target, ["checkout", checkout!]));
  }, [checkoutReturn, checkout, returnTo]);

  useEffect(() => {
    // The browser can present a legacy /api/reader cookie that this page's SSR loader cannot see.
    if (email || admin) return;
    const controller = new AbortController();
    fetch("/api/reader/membership", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const current: Membership = await response.json();
        if (current.email || current.access) void revalidate();
      })
      .catch(() => {});
    return () => controller.abort();
  }, [email, admin, revalidate]);

  useEffect(() => {
    if (!pending) return;
    // Stripe may redirect before the payment webhook is delivered.
    const timers = [2000, 5000, 10000, 20000].map((delay) => window.setTimeout(() => void revalidate(), delay));
    return () => timers.forEach(window.clearTimeout);
  }, [pending, revalidate]);

  const featureName = feature === "agent" ? "Agent 接入" : feature === "financing" ? "融资数据库" : null;
  const contextPrompt =
    !access && feature === "financing" && company
      ? `查看「${company}」的完整历次融资记录需要读者会员权限。开通后可按时间查看轮次、金额口径、投资机构与原文引句。`
      : !access && feature === "financing"
        ? "融资数据库需要读者会员权限。开通后可按公司、投资机构和日期筛选单笔交易，并导出 CSV。"
        : !access && feature === "agent"
          ? "Agent 接入需要读者会员权限。开通后可生成个人只读访问令牌，接入 MCP、REST API v1 和会员 RSS。"
          : null;

  return (
    <div className="mx-auto max-w-[980px] pb-16 pt-5 lg:pt-2">
      {contextPrompt && (
        <div
          role="status"
          className="mb-6 flex flex-wrap items-center justify-between gap-2 rounded-card border border-accent/30 bg-accent-softer px-4 py-3 text-[13.5px] text-ink-2"
        >
          <span className="leading-relaxed">{contextPrompt}</span>
          <a href="#plan-card" className="shrink-0 font-semibold text-accent hover:underline">
            立即开通 ↓
          </a>
        </div>
      )}

      <header className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(310px,0.95fr)] lg:gap-8">
        <div>
          <Kicker>
            <span className="inline-flex items-center gap-1.5">
              <IconSparkles size={13} />
              读者会员 · {SITE.name}
            </span>
          </Kicker>
          <h1 className="mt-4 text-[30px] font-black leading-[1.2] tracking-[-0.025em] text-ink [text-wrap:balance] sm:text-[38px] lg:text-[42px]">
            {access ? (
              "你的读者会员权限已生效"
            ) : (
              <>
                从每天看 {SITE.subject} 资讯，
                <br />
                <span className="text-accent">到持续追踪融资与接入 Agent。</span>
              </>
            )}
          </h1>
          <p className="mt-4 max-w-[38em] text-[15px] leading-[1.85] text-ink-3">
            {access
              ? "你已可以查询并导出融资数据库、追踪公司历次融资档案，并管理个人 Agent 访问令牌。"
              : `每日精选、热点榜与${withSubject("日报")}继续免费开放阅读。订阅读者会员后，解锁单笔交易融资数据库、公司历次融资档案与 CSV 导出，以及 MCP / REST API / RSS 个人令牌接入。`}
          </p>

          {stats && (
            <dl className="mt-6 grid grid-cols-3 gap-3 border-y border-line py-4">
              <div>
                <dt className="text-[12px] text-ink-4">持续监控</dt>
                <dd className="num mt-0.5 text-[22px] font-bold tracking-tight text-ink sm:text-[26px]">
                  {stats.sources.toLocaleString("en-US")}
                  <span className="ml-1 text-[12px] font-normal text-ink-3">个信源</span>
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-ink-4">累计精选</dt>
                <dd className="num mt-0.5 text-[22px] font-bold tracking-tight text-ink sm:text-[26px]">
                  {stats.selected.toLocaleString("en-US")}
                  <span className="ml-1 text-[12px] font-normal text-ink-3">条归档</span>
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-ink-4">持续出刊</dt>
                <dd className="num mt-0.5 text-[22px] font-bold tracking-tight text-ink sm:text-[26px]">
                  {stats.dailies.toLocaleString("en-US")}
                  <span className="ml-1 text-[12px] font-normal text-ink-3">期日报</span>
                </dd>
              </div>
            </dl>
          )}

          {!access && (
            <div className="mt-6 space-y-3">
              <div className="text-[12px] font-semibold tracking-wide text-ink-4">谁最常用读者会员</div>
              <ul className="grid gap-2.5">
                {AUDIENCES.map((item) => (
                  <li key={item.title} className="rounded-control border border-line-soft bg-surface/80 px-3.5 py-2.5">
                    <div className="text-[13.5px] font-semibold text-ink">{item.title}</div>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{item.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <section id="plan-card" aria-label="会员方案" className="card overflow-hidden">
          <div className="border-b border-line-soft p-5 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[17px] font-bold text-ink">{access ? "当前会员权限" : "月度会员"}</h2>
              {access ? (
                <Badge tone="ok">已生效</Badge>
              ) : (
                <Badge tone="accent">随时可取消</Badge>
              )}
            </div>

            {access ? (
              <p className="mt-3 flex items-center gap-2 text-[15px] font-semibold text-accent">
                <IconCheck size={18} aria-hidden="true" />
                {source === "admin" ? "管理员权限已启用" : source === "grant" ? "已获管理员授权" : "订阅已生效"}
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap items-baseline gap-2">
                <strong className="num text-[40px] font-black leading-none tracking-tight text-ink">US$5</strong>
                <span className="text-sm text-ink-3">/ 月 · 自动续订，可随时取消续订</span>
              </div>
            )}

            {readerEmail && (
              <form method="post" action="/api/reader/logout" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 break-all text-sm text-ink-3">{readerEmail}</span>
                <button type="submit" className={buttonClass("ghost", "sm")}>
                  退出登录
                </button>
              </form>
            )}
            {admin && (
              <form method="post" action="/api/auth/logout" className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                {email && email !== readerEmail && <span className="min-w-0 break-all text-sm text-ink-3">{email}</span>}
                <input type="hidden" name="csrf" value={adminCsrf} />
                <button type="submit" className={buttonClass("ghost", "sm")}>
                  退出管理员登录
                </button>
              </form>
            )}
          </div>

          <ul className="space-y-2.5 p-5 text-[13.5px] leading-relaxed text-ink-2 sm:p-6">
            {PLAN_POINTS.map((point) => (
              <li key={point} className="flex items-start gap-2.5">
                <span className="mt-0.5 grid size-4.5 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                  <IconCheck size={12} />
                </span>
                <span>{point}</span>
              </li>
            ))}
          </ul>

          <div className="space-y-3 border-t border-line-soft bg-bg-sunk/50 px-5 py-4 sm:px-6">
            {billing === "unavailable" && (
              <p role="alert" className="text-sm text-hot">
                暂时无法打开 Stripe，请稍后再试。
              </p>
            )}
            {billing === "login" && !email && !admin && (
              <p role="status" className="text-sm text-ink-2">
                请先使用 Google 登录，再进入 Stripe 订阅。
              </p>
            )}
            {checkout === "canceled" && !access && (
              <p role="status" className="text-sm text-ink-3">
                已退出结账，未产生扣费。
              </p>
            )}
            {pending && (
              <p role="status" className="text-sm text-ink-2">
                正在确认付款。会员权限会在 Stripe 确认后开通。{" "}
                <button type="button" className="font-semibold text-accent hover:underline" onClick={() => void revalidate()}>
                  刷新状态
                </button>
              </p>
            )}

            <ActionControls membership={membership} pending={pending} returnTo={returnTo} />

            {email && membership.emailConfirmed === false && (
              <p className="text-[12.5px] text-ink-3">
                已获管理员邮箱授权？
                <a href="#confirm-email" className="ml-1 font-medium text-accent hover:underline">
                  在下方输入确认码
                </a>
              </p>
            )}
            {access && !customer && (
              <div>
                <Link to="/" className="text-sm text-ink-3 hover:text-accent">
                  返回首页
                </Link>
              </div>
            )}
            {!access && !featureName && (
              <div className="pt-0.5">
                <a href="#samples" className="text-[12.5px] font-medium text-ink-3 hover:text-accent">
                  先看融资库与 Agent 真实样例 ↓
                </a>
              </div>
            )}
          </div>
        </section>
      </header>

      {email && membership.emailConfirmed === false && <EmailConfirmation key={email} email={email} />}

      <section id="samples" aria-labelledby="samples-heading" className="mt-12 scroll-mt-10">
        <div className="mb-5">
          <Kicker>会员能得到什么</Kicker>
          <h2 id="samples-heading" className="mt-2 text-[22px] font-bold tracking-tight text-ink sm:text-[26px]">
            两项核心能力，直接接进你的研究与工作流
          </h2>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <FinancingSampleCard />
          <AgentSampleCard base={base} />
        </div>
      </section>

      <section aria-labelledby="compare-heading" className="mt-12">
        <div className="mb-4">
          <Kicker>权益边界</Kicker>
          <h2 id="compare-heading" className="mt-2 text-[22px] font-bold tracking-tight text-ink sm:text-[26px]">
            免费阅读与读者会员的区别
          </h2>
          <p className="mt-1.5 text-[14px] text-ink-3">公开资讯继续免费开放，付费只针对结构化融资数据库与程序化 Agent 接口。</p>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[540px] border-collapse text-left text-[13.5px]">
            <thead>
              <tr className="border-b border-line bg-bg-sunk/60 text-[12.5px] text-ink-3">
                <th className="px-4 py-3 font-semibold text-ink">功能与内容</th>
                <th className="w-36 px-4 py-3 font-semibold text-ink-2">免费阅读</th>
                <th className="w-44 px-4 py-3 font-semibold text-accent">读者会员 · US$5/月</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.feature}>
                  <td className="px-4 py-3 text-ink-2">{row.feature}</td>
                  <td className={`px-4 py-3 ${row.free === "—" ? "text-ink-4" : "text-ink-2"}`}>{row.free}</td>
                  <td className="px-4 py-3 font-medium text-ink">
                    <span className="inline-flex items-center gap-1.5">
                      <IconCheck size={14} className="shrink-0 text-accent" />
                      {row.member}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="faq-heading" className="mt-12">
        <div className="mb-4">
          <Kicker>常见问题</Kicker>
          <h2 id="faq-heading" className="mt-2 text-[22px] font-bold tracking-tight text-ink sm:text-[26px]">
            订阅前你可能关心的事
          </h2>
        </div>
        <div className="card divide-y divide-line-soft overflow-hidden">
          {FAQS.map((item) => (
            <details key={item.q} className="disclosure group">
              <summary className="flex items-center justify-between gap-4 px-5 py-4 text-[14.5px] font-semibold text-ink transition-colors hover:bg-bg-sunk/50">
                <span>{item.q}</span>
                <IconChevronDown size={16} className="shrink-0 text-ink-4 transition-transform group-open:rotate-180" />
              </summary>
              <p className="px-5 pb-4 text-[13.5px] leading-[1.85] text-ink-3">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {!access && (
        <section
          aria-label="开通读者会员"
          className="mt-12 flex flex-col gap-4 rounded-panel border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:flex-row sm:items-center sm:justify-between sm:p-6"
        >
          <div className="min-w-0">
            <h2 className="text-[18px] font-bold text-ink">准备好把行业动态接进你的研究流了吗？</h2>
            <p className="mt-1 text-[13.5px] text-ink-3">US$5 / 月解锁融资数据库与 Agent 全链路接入，可随时在 Stripe 取消续订。</p>
          </div>
          <div className="shrink-0">
            <ActionControls membership={membership} pending={pending} returnTo={returnTo} size="md" />
          </div>
        </section>
      )}

      <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[12.5px] text-ink-4">
        <span>订阅和账户规则以站点条款为准。</span>
        <nav className="flex flex-wrap gap-5" aria-label="相关说明">
          <Link to="/terms" className="transition-colors hover:text-accent">
            使用规则
          </Link>
          <Link to="/privacy" className="transition-colors hover:text-accent">
            隐私说明
          </Link>
          <Link to="/feedback" className="transition-colors hover:text-accent">
            问题反馈
          </Link>
        </nav>
      </footer>
    </div>
  );
}
