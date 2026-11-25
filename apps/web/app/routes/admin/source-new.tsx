import { SITE } from "@aihot/industry/site";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/source-new";
import { useAdminAction } from "../../features/admin/action";
import { bj } from "../../features/admin/format";
import { KIND_LABEL, MODE_LABEL, TIER_LABEL } from "../../features/admin/labels";
import { AdminPage, Button, Card, Empty, Field, Input, Select, Textarea } from "../../features/admin/ui";

export const meta: Route.MetaFunction = () => [{ title: `新建信源 · ${SITE.name} 后台` }];

const TEMPLATES: Record<string, Record<string, unknown>> = {
  rss: { feedUrl: "" },
  web_list: { url: "https://example.com/blog", baseUrl: "https://example.com", itemSelector: "article", linkSelector: "a", titleSelector: "h2", allowUrlPrefixes: ["https://example.com/blog/"] },
  json_list: { url: "https://example.com/api/posts", mode: "json_api", method: "GET", itemsPath: "data.items", titlePaths: ["title"], urlTemplate: "{raw:url}", summaryPaths: ["summary"] },
  x_search: { query: "from:handle -filter:replies", searchType: "Latest" },
  mp_account: { biz: "", name: "" },
  external: {},
};

interface Preview {
  ms: number;
  count: number;
  items: Array<{ title: string; url: string; publishedAt: string | null; excerpt: string }>;
}

export default function NewSource() {
  const navigate = useNavigate();
  const { run, pending } = useAdminAction();
  const [form, setForm] = useState({ id: "", name: "", kind: "rss", tier: "T2", participation_mode: "editorial", interval_minutes: 30, first_party: false, site_fulltext: false, syndicate_fulltext: false, tags: "" });
  const [configs, setConfigs] = useState<Record<string,string>>({});
  const config = configs[form.kind] ?? JSON.stringify(TEMPLATES[form.kind] ?? {}, null, 2);
  const [advancedRss, setAdvancedRss] = useState(false);
  const generatedId = useRef("");
  const setConfig = (value: string) => {
    setConfigs(previous => ({ ...previous, [form.kind]: value }));
    setError(null);
  };
  const [error, setError] = useState<string | null>(null);
  const [previewResult, setPreview] = useState<{ key: string; result: Preview } | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string; key: string } | null>(null);

  const sourceKey = JSON.stringify([form.kind, form.id, config]);
  const preview = previewResult?.key === sourceKey ? previewResult.result : null;
  let feedUrl = "";
  try { feedUrl = JSON.parse(config)?.feedUrl ?? ""; } catch { /* The advanced editor reports invalid JSON on submit. */ }

  const parsed = () => {
    try {
      setError(null);
      const value = JSON.parse(config);
      if (!value || Array.isArray(value) || typeof value !== "object") {
        setError("采集配置需要是一个 JSON 对象。");
        return null;
      }
      if (form.kind === "rss" && !value.minifluxFeedId) {
        let valid = false;
        try { valid = ["https:", "http:"].includes(new URL(value.feedUrl).protocol); } catch { /* Show the field error below. */ }
        if (!valid) { setError("请输入完整的 RSS 订阅地址，例如 https://example.com/feed.xml。"); return null; }
      }
      return value as Record<string, unknown>;
    } catch (e) {
      setError(`配置不是合法 JSON：${(e as Error).message}`);
      return null;
    }
  };

  return (
    <AdminPage title="新建信源" subtitle="可以先预览采集结果。创建时会自动检查重复地址。">
      <div className={`grid gap-5 ${preview ? "xl:grid-cols-[1fr_420px]" : "max-w-4xl"}`}>
        <Card title="信源定义">
          <fieldset disabled={pending === "create"} className="min-w-0">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="名称">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenAI 博客" />
            </Field>
            <Field label="类型">
              <Select
                value={form.kind}
                onChange={(e) => {
                  setForm({ ...form, kind: e.target.value });
                  setError(null);
                  setPreview(null);
                }}
              >
                {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="采集间隔（分钟）">
              <Input type="number" min={1} max={1440} value={form.interval_minutes} onChange={(e) => setForm({ ...form, interval_minutes: Number(e.target.value) })} />
            </Field>
            <Field label="参与方式">
              <Select value={form.participation_mode} onChange={(e) => setForm({ ...form, participation_mode: e.target.value })}>
                {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="等级">
              <Select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
                {Object.entries(TIER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="标签（逗号分隔）">
              <Input value={form.tags} onChange={(e) => setForm({ ...form, tags:e.target.value })} />
            </Field>
            <div className="flex flex-col justify-end gap-2 text-[13px] text-ink-2">
              {([
                ["first_party", "一手信源"],
                ["site_fulltext", "站内可展示全文"],
                ["syndicate_fulltext", "对外接口可带全文"],
              ] as const).map(([k, label]) => (
                <label key={k} className="inline-flex items-center gap-2">
                  <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
                  {label}
                </label>
              ))}
              {form.first_party && <p className="text-xs text-ink-3">请确认运营主体或官网链接能证明该信源为第一方。</p>}
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {form.kind === "rss" && !advancedRss ? <Field label="RSS 订阅地址">
              <Input type="url" value={feedUrl} placeholder="https://example.com/feed.xml"
                onChange={event => setConfig(JSON.stringify({ ...JSON.parse(config), feedUrl:event.target.value }, null, 2))} />
            </Field> : <Field label="采集配置（JSON）">
              <Textarea className="font-mono !text-[12px]" rows={10} value={config} onChange={(e) => setConfig(e.target.value)} spellCheck={false} />
            </Field>}
            {form.kind === "rss" && <Button size="sm" tone="ghost" onClick={() => {
              if (advancedRss) {
                try {
                  const c = JSON.parse(config);
                  if (!c || typeof c !== "object" || Array.isArray(c) || (c.feedUrl !== undefined && typeof c.feedUrl !== "string")) throw Error();
                } catch { setError("请先修正 JSON 配置，再切回地址输入。"); return; }
              }
              setError(null);
              setAdvancedRss(!advancedRss);
            }}>{advancedRss ? "返回地址输入" : "编辑高级采集配置"}</Button>}
            <details><summary className="cursor-pointer text-[13px] text-ink-3">自定义信源 ID（可选）</summary>
              <Field label="信源 ID" hint="留空自动生成；自定义 ID 使用 3 至 80 位小写字母、数字和连字符，创建后不可改。">
                <Input value={form.id} onChange={e => setForm({...form,id:e.target.value.toLowerCase()})} />
              </Field>
            </details>
            {error && <div className="mt-1 text-[12.5px] text-hot">{error}</div>}
          </div>
          {duplicate?.key === sourceKey && (
            <div className="mt-4 rounded-card bg-amber/10 px-4 py-3 text-[13px] text-ink-2 ring-1 ring-amber/25">
              这个地址已经在监控：<Link className="font-medium text-accent" to={`/admin/sources/${encodeURIComponent(duplicate.id)}`}>{duplicate.name}</Link>（{duplicate.id}）。没有新建。
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              busy={pending === "preview"} disabled={!!pending}
              onClick={async () => {
                const c = parsed();
                if (!c) return;
                const r = await run<Preview>("POST", "/api/admin/sources/preview", { id: form.id || "draft", kind: form.kind, config: c }, { label: "preview", revalidate: false });
                if (r) setPreview({key:sourceKey,result:r});
              }}
            >
              预览抓取
            </Button>
            <Button
              tone="primary"
              busy={pending === "create"}
              disabled={!form.name.trim() || !!pending}
              onClick={async () => {
                const c = parsed();
                if (!c) return;
                if (form.id && !/^[a-z0-9][a-z0-9-]{2,79}$/.test(form.id)) {
                  setError("自定义 ID 需要 3 至 80 位小写字母、数字和连字符，并以字母或数字开头。"); return;
                }
                if (!form.id && !generatedId.current) {
                  const bytes = crypto.getRandomValues(new Uint8Array(12));
                  generatedId.current = "source-" + Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
                }
                const r = await run<{ created: boolean; duplicate?: { id: string; name: string }; source?: { id: string } }>(
                  "POST",
                  "/api/admin/sources",
                  { ...form, id:form.id || generatedId.current, name:form.name.trim(), tags: form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean), config: c },
                  { label: "create", revalidate: false },
                );
                if (!r) return;
                if (!r.created && r.duplicate) setDuplicate({...r.duplicate,key:sourceKey});
                else if (r.source) navigate(`/admin/sources/${encodeURIComponent(r.source.id)}`);
              }}
            >
              创建
            </Button>
          </div>
          </fieldset>
        </Card>
        {preview && <Card title={`预览：${preview.count} 条（${preview.ms}ms）`} right={<Button size="sm" tone="ghost" onClick={() => setPreview(null)}>收起</Button>}>
          {preview.items.length ? (
            <ul className="space-y-3">
              {preview.items.map((i) => (
                <li key={i.url} className="text-[13px]">
                  <a href={i.url} target="_blank" rel="noreferrer" className="font-medium text-ink hover:text-accent">{i.title}</a>
                  <div className="text-[12px] text-ink-4">{i.publishedAt ? bj(i.publishedAt, true) : "无发布时间"}</div>
                  {i.excerpt && <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{i.excerpt}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>没有抓到条目。</Empty>
          )}
        </Card>}
      </div>
    </AdminPage>
  );
}
