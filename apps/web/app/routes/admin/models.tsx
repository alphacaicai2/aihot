import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/models";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, money, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, ReasonDialog, Select } from "../../features/admin/ui";

interface Usage {
  purpose: string;
  service: string;
  model: string | null;
  promptVersion: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokensIn: number;
  tokensOut: number;
  actualCost: number | null;
  currency: string | null;
  estimate: { amount: number; currency: string; note: string; sourceUrl: string | null } | null;
  unestimatedCalls: number;
}

interface Models {
  days: number;
  period: "rolling" | "today" | "yesterday";
  since: string;
  until: string;
  costs: { currencies: Array<{ currency: string; actual: number; estimated: number; amount: number }>; unpricedCalls: number };
  deepseek: { calls: number; tokensIn: number; tokensOut: number; estimatedCalls: number; amount: number | null; currency: string };
  capabilities: Array<{ key: string; label: string; env: string; defaultModel: string; vision: boolean; current: { model: string; source: "admin" | "env" | "default" }; usage: Usage[] }>;
  choices: Array<{ key: string; service: string; vision: boolean }>;
  history: Array<{ at: string; actor: string; subject: string; reason: string | null; before: { model: string; source: string } | null; after: { model: string; source: string } | null }>;
  benches: Array<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; created_at: string }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const days = sp.get("days") ?? "7";
  return adminGet<Models>(request, `/api/admin/models?days=${encodeURIComponent(days)}&period=${encodeURIComponent(sp.get("period") ?? "rolling")}`);
}

export const meta: Route.MetaFunction = () => [{ title: `模型与评测 · ${SITE.name} 后台` }];

const SOURCE_LABEL = { admin: "后台切换", env: "环境变量", default: "代码默认" } as const;
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export default function ModelsAdmin({ loaderData: m }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<Models["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const labelOf = (key: string) => m.capabilities.find((c) => `capability:${c.key}` === key)?.label ?? key;

  return (
    <AdminPage
      title="模型与评测"
      subtitle="每项能力当前用哪个模型、来自哪里（后台切换 > 环境变量 > 代码默认），以及近期的成功率、耗时与费用。切换只影响之后的新任务，已有结果不重算；换精选模型前先看 SelectBench 同批对比。"
      actions={<div className="flex flex-wrap gap-1.5">{[
        { query: "period=today", label: "今天", active: m.period === "today" },
        { query: "period=yesterday", label: "昨天", active: m.period === "yesterday" },
        ...[1, 7, 30].map((days) => ({ query: `days=${days}`, label: days === 1 ? "24 小时" : `${days} 天`, active: m.period === "rolling" && m.days === days })),
      ].map((o) => <Link key={o.query} to={`?${o.query}`} preventScrollReset className={`inline-flex rounded-full px-3 py-1 text-[12.5px] ${o.active ? "bg-ink text-bg" : "bg-surface text-ink-2 ring-1 ring-line hover:bg-bg-sunk"}`}>{o.label}</Link>)}</div>}
    >
      <div className="grid gap-5 xl:grid-cols-2">
      <Card title="总费用">
        {m.costs.currencies.length ? m.costs.currencies.map((c) => (
          <div key={c.currency} className="mb-3 last:mb-0">
            <p className="text-[20px] font-semibold" title={`原值：${c.amount} ${c.currency}`}>{c.estimated > 0 ? "≈ " : ""}{c.currency === "USD" ? "$" : "¥"}{num(c.amount, 2)} <span className="text-[12px] font-normal text-ink-3">{c.currency}</span></p>
            <p className="mt-1 text-[12.5px] text-ink-3">实际费用 {money(c.actual, c.currency)} · 官方估算 {money(c.estimated, c.currency)}</p>
          </div>
        )) : <p className="text-[14px]">暂无可计费用</p>}
        <p className="mt-2 text-[12.5px] text-ink-3">按所选时段汇总所有用途和重试。各币种分别合计，包含回执实际费用与 DeepSeek 官方调用估算；代理通道的参考估值不计入。</p>
        {m.costs.unpricedCalls > 0 && <p className="mt-2 text-[12.5px] text-hot">另有 {num(m.costs.unpricedCalls)} 次请求费用待核对，未计入合计。</p>}
      </Card>
      <Card title="DeepSeek 官方调用合计">
        <p className="text-[14px]" title={m.deepseek.amount === null ? undefined : `估算原值：¥${m.deepseek.amount}`}>{m.deepseek.amount === null ? "费用待核对" : `≈ ¥${num(m.deepseek.amount, 2)}（人民币官方估算）`} · {num(m.deepseek.calls)} 次调用 · {num(m.deepseek.tokensIn + m.deepseek.tokensOut)} tokens</p>
        <p className="mt-2 text-[12.5px] text-ink-3">北京时间 {bj(m.since, true)} 至 {bj(m.until, true)}。仅统计 deepseek 通道的 deepseek-flash，包含重试及所有用途。对账时请在 DeepSeek 后台选择本站使用的 API Key 和相同日期；官方数据最多延迟 5 分钟。估算不是账户账单。</p>
        {m.deepseek.estimatedCalls < m.deepseek.calls && <p className="mt-2 text-[12.5px] text-hot">{num(m.deepseek.calls - m.deepseek.estimatedCalls)} 次请求缺少用量，尚未计入估算费用。</p>}
      </Card>
      </div>
      <div className="mt-5 grid gap-5">
        {m.capabilities.map((c) => {
          const total = c.usage.reduce((a, u) => a + u.calls, 0);
          return (
            <Card
              key={c.key}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {c.label}
                  <span className="font-mono text-[12px] font-normal text-ink-3">{c.current.model}</span>
                  <Badge tone={c.current.source === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.current.source]}</Badge>
                </span>
              }
              right={
                <Button
                  size="sm"
                  onClick={() => {
                    setTarget(c);
                    setChoice(c.current.model);
                  }}
                >
                  切换
                </Button>
              }
              pad={false}
            >
              {c.usage.length ? (
                <DataTable
                  dense
                  rows={c.usage}
                  rowKey={(u) => `${u.service}|${u.purpose}|${u.model}|${u.promptVersion}|${u.currency}`}
                  columns={[
                    { key: "m", label: "模型", render: (u) => <span className="whitespace-nowrap font-mono text-[12px]">{u.model}</span> },
                    { key: "s", label: "通道", render: (u) => <span className="whitespace-nowrap text-[12px]">{u.service === "deepseek" ? "DeepSeek" : u.service}</span> },
                    { key: "v", label: "提示版本", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.promptVersion ?? "—"}</span> },
                    { key: "p", label: "用途", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.purpose}</span> },
                    { key: "c", label: "调用", align: "right", render: (u) => num(u.calls) },
                    {
                      key: "ok",
                      label: "成功率",
                      align: "right",
                      render: (u) => {
                        const rate = u.calls ? u.ok / u.calls : 0;
                        return <span className={rate < 0.95 ? "text-hot" : ""} title={`失败 ${u.failed} · 结果未知 ${u.unknown}`}>{`${Math.round(rate * 1000) / 10}%`}</span>;
                      },
                    },
                    { key: "l", label: "耗时 p50 / p95", align: "right", render: (u) => <span className="whitespace-nowrap">{`${secs(u.p50)} / ${secs(u.p95)}`}</span> },
                    { key: "t", label: "输入 / 输出 token", align: "right", render: (u) => <span className="whitespace-nowrap">{`${num(u.tokensIn)} / ${num(u.tokensOut)}`}</span> },
                    {
                      key: "$",
                      label: "费用",
                      align: "right",
                      render: (u) =>
                        u.actualCost !== null ? (
                          `${money(u.actualCost, u.currency ?? "CNY")}${u.currency && u.currency !== "CNY" ? ` ${u.currency}` : ""}`
                        ) : u.estimate ? (
                          <span title={u.estimate.note}>≈ {money(u.estimate.amount, u.estimate.currency)}{u.estimate.currency !== "CNY" ? ` ${u.estimate.currency}` : ""}{u.estimate.sourceUrl ? u.service === "deepseek" ? "（官方估算）" : "（通道估值）" : ""}{u.estimate.sourceUrl && u.unestimatedCalls > 0 ? ` · ${num(u.unestimatedCalls)} 次未计入` : ""}</span>
                        ) : (
                          <span className="whitespace-nowrap text-ink-4" title="服务商没有返回费用，按 token 数和你的模型单价自己估算">未定价</span>
                        ),
                    },
                  ]}
                />
              ) : (
                <Empty>{m.period === "rolling" ? `${m.days} 天内` : "该时段"}没有调用{total === 0 && c.vision ? "（只在有图片时使用）" : ""}</Empty>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="切换记录" pad={false}>
          {m.history.length ? (
            <DataTable
              dense
              rows={m.history}
              rowKey={(h) => `${h.at}|${h.subject}`}
              columns={[
                { key: "at", label: "时间", render: (h) => <span className="num whitespace-nowrap">{bj(h.at)}</span> },
                { key: "c", label: "能力", render: (h) => labelOf(h.subject) },
                { key: "m", label: "变化", render: (h) => <span className="font-mono text-[12px]">{h.before?.model ?? "—"} → {h.after?.model ?? "—"}</span> },
                { key: "r", label: "原因", render: (h) => <span className="text-ink-3">{h.reason}</span> },
                { key: "a", label: "操作人", render: (h) => h.actor },
              ]}
            />
          ) : (
            <Empty>还没有在后台切换过模型</Empty>
          )}
        </Card>
        <Card title="同批样本对比（SelectBench）" right={<Link to="/admin/selectbench" className="text-accent">全部运行</Link>} pad={false}>
          {m.benches.length ? (
            <DataTable
              dense
              rows={m.benches}
              rowKey={(b) => b.id}
              columns={[
                { key: "l", label: "运行", render: (b) => <Link to={`/admin/selectbench/${b.id}`} className="text-ink hover:text-accent">{b.label}</Link> },
                { key: "m", label: "模型", render: (b) => <span className="font-mono text-[11.5px] text-ink-3">{b.models.join("、")}</span> },
                { key: "n", label: "样本", align: "right", render: (b) => num(b.sample_size) },
                { key: "at", label: "时间", render: (b) => <span className="num whitespace-nowrap">{bj(b.created_at)}</span> },
              ]}
            />
          ) : (
            <Empty>还没有导入对比运行</Empty>
          )}
        </Card>
      </div>

      <ReasonDialog
        open={!!target}
        title={`切换模型：${target?.label ?? ""}`}
        description="只影响之后的新任务。选“恢复默认”会回到环境变量或代码默认。"
        confirmLabel="切换"
        busy={pending === "switch"}
        onClose={() => setTarget(null)}
        onSubmit={async (reason) =>
          (await run("POST", `/api/admin/models/${target!.key}`, { model: choice === "__default" ? null : choice, reason }, { label: "switch", success: "已切换，下一次调用生效" })) !== null
        }
      >
        <Field label="模型">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {m.choices
              .filter((x) => x.vision === !!target?.vision)
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {x.key}（{x.service}）
                </option>
              ))}
            <option value="__default">恢复默认（{target?.env} 或 {target?.defaultModel}）</option>
          </Select>
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
