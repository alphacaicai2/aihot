import { useEffect, useState, type FormEvent } from "react";
import { checkoutDestinationCookie } from "@aihot/contracts/member-destination.server";
import { checkoutDestinationKey, memberDestination, membershipOffer, offerDestination } from "@aihot/contracts/member-destination";
import { Link, redirect, useRevalidator } from "react-router";
import { MCP_TOOL_NAMES as T } from "@aihot/contracts/mcp";
import { SITE, withSubject } from "@aihot/industry/site";
import type { Route } from "./+types/membership";
import {
  IconArrowRight,
  IconCheck,
  IconChevronDown,
  IconPlug,
} from "../components/icons";
import { PublicAgentPreview } from "../components/PublicAgentPreview";
import { CodeBlock } from "../components/CodeBlock";
import { Badge } from "../components/ui/Badge";
import { buttonClass } from "../components/ui/Controls";
import { Kicker } from "../components/ui/Kicker";
import { adminGet } from "../lib/admin.server";
import { FinancingSample } from "../features/research/FinancingSample";
import { getMembership, memberGet, privateHeaders, type Membership } from "../lib/membership.server";
import { pageMeta, siteUrl } from "../lib/seo";

export const headers = () => privateHeaders;

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const membership = await getMembership(request);
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
    <div id="agent-sample" className="card flex h-full min-w-0 flex-col overflow-hidden">
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

        <PublicAgentPreview />
        <CodeBlock title="Codex · 读取环境变量中的令牌" code={`codex mcp add ${SITE.mcpPrefix} --url '${mcpUrl}' --bearer-token-env-var CAOLU_AGENT_TOKEN`} />
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
  const { membership, base, adminCsrf, readerEmail, checkout, billing, feature, company, checkoutReturn, returnTo } = loaderData;
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

  const target = returnTo ? new URL(returnTo, "https://site.invalid") : null;
  let intent = "";
  if (!access && feature === "financing") {
    if (company) intent = `查看「${company}」的完整历次融资记录需要读者会员权限。`;
    else if (target?.pathname === "/financing/investor") intent = `开通后继续查看「${target.searchParams.get("name")}」的投资组合。`;
    else if (target?.pathname === "/financing/event") intent = "开通后返回这笔融资交易及其来源。";
    else intent = target?.search ? "开通后返回你刚才筛选的融资记录。" : "开通后进入融资数据库。";
  } else if (!access && feature === "agent") {
    const tab = target?.searchParams.get("tab");
    intent = `开通后继续配置${tab === "rss" ? " RSS 订阅" : tab === "api" ? " REST API" : " MCP 客户端"}。`;
  }

  return (
    <div className="mx-auto max-w-[980px] pb-16 pt-4 lg:pt-2">
      <header className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(310px,0.9fr)] lg:gap-8">
        <div className="lg:pt-4">
          <Kicker>读者会员 · {SITE.name}</Kicker>
          <h1 className="mt-2 text-[26px] font-bold leading-tight tracking-tight text-ink sm:text-[34px]">
            {access ? "你的读者会员权限已生效" : feature === "agent" ? "把精选与日报接入 Agent" : feature === "financing" ? "追踪公司与投资机构的融资记录" : "查融资记录，用 Agent 读资讯"}
          </h1>
          <p className="mt-2 max-w-[36em] text-sm leading-relaxed text-ink-3">
            {intent && <strong className="mr-1 font-medium text-ink">{intent}</strong>}
            按公司、机构和日期查融资，核对报道并导出 CSV。用个人令牌通过 MCP、REST API 或 RSS 读取资讯。
          </p>
          <a href={feature === "agent" ? "#agent-sample" : "#financing-sample"} className="mt-2 inline-flex min-h-8 items-center gap-1 text-sm font-medium text-accent hover:underline">
            {feature === "agent" ? "查看接入示例" : "试用公开融资样例"} <IconArrowRight size={13} />
          </a>
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
          </div>
        </section>
      </header>

      {email && membership.emailConfirmed === false && <EmailConfirmation key={email} email={email} />}

      <section id="samples" aria-labelledby="samples-heading" className="mt-12 scroll-mt-10">
        <div className="mb-5">
          <Kicker>会员能得到什么</Kicker>
          <h2 id="samples-heading" className="mt-2 text-[22px] font-bold tracking-tight text-ink sm:text-[26px]">
            试用融资样例，查看 Agent 接入方式
          </h2>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <FinancingSample />
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
