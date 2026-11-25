import { useState } from "react";
import { CopyButton } from "../../components/CodeBlock";
import { SITE } from "@aihot/industry/site";
import type { Route } from "./+types/memberships";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Button, Card, Input, ReasonDialog, Time } from "../../features/admin/ui";
import { adminGet } from "../../lib/admin.server";

const path = "/api/admin/memberships";

interface Grant {
  email: string;
  createdAt: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<{ members: Grant[] }>(request, path);
}

export const meta: Route.MetaFunction = () => [{ title: `会员授权 · ${SITE.name} 后台` }];
export const headers = () => ({ "Cache-Control": "private, no-store" });

export default function MemberGrants({ loaderData }: Route.ComponentProps) {
  const { run, busy } = useAdminAction();
  const [revoking,setRevoking] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [codeEmail, setCodeEmail] = useState("");
  const [issued, setIssued] = useState<{ email: string; code: string; expiresAt: string } | null>(null);
  return (
    <AdminPage title="会员授权" subtitle="按 Google 账号邮箱授予 Agent 接入和融资数据库访问权限。">
      <Card title="添加授权">
        <form className="flex flex-wrap items-end gap-3" onSubmit={async event => {
          event.preventDefault();
          const address = email.trim();
          const ok = await run("POST", path, { email: address }, { label: `grant-${address}`, success: "会员权限已授予" });
          if (ok) { setEmail(""); setCodeEmail(address); setIssued(null); }
        }}>
          <div className="w-full max-w-md"><label htmlFor="grant-email" className="mb-1 block text-sm font-medium text-ink-2">读者邮箱</label><Input id="grant-email" className="w-full" type="email" required maxLength={254} autoComplete="off" value={email} placeholder="reader@example.com" onChange={e => setEmail(e.target.value)} /></div>
          <Button type="submit" tone="primary" disabled={busy || !email.trim()}>授予权限</Button>
        </form>
      </Card>
      <Card title="邮箱确认码">
        <p className="mb-3 text-sm text-ink-3">使用第三方邮箱登录的已授权读者可能需要确认码。请将确认码发到对应邮箱，24 小时内有效。再次生成会使旧码失效。</p>
        <form className="flex flex-wrap items-end gap-3" onSubmit={async event => {
          event.preventDefault();
          const address = codeEmail.trim();
          const result = await run<{ code: string; expiresAt: string }>("POST", path + "/code", { email: address },
            { label: `code-${address}`, revalidate: false });
          if (result) setIssued({ email: address, code: result.code, expiresAt: result.expiresAt });
        }}>
          <div className="w-full max-w-md"><label htmlFor="code-email" className="mb-1 block text-sm font-medium text-ink-2">已授权邮箱或管理员邮箱</label>
            <Input id="code-email" className="w-full" type="email" required maxLength={254} autoComplete="off" value={codeEmail} onChange={event => setCodeEmail(event.target.value)} /></div>
          <Button type="submit" disabled={busy || !codeEmail.trim()}>生成确认码</Button>
        </form>
        {issued && <div className="mt-3 rounded-control bg-bg-sunk p-3">
          <p role="status" className="break-all text-sm">请发送至 {issued.email}，有效期至 <Time at={issued.expiresAt} />。离开页面后无法再查看。</p>
          <div className="mt-2 flex items-center gap-2"><code className="break-all font-mono">{issued.code}</code><CopyButton text={issued.code} label="复制确认码" /></div>
        </div>}
      </Card>
      <Card title={`已手工授权（${loaderData.members.length}）`}>
        {loaderData.members.length === 0 ? <p className="text-sm text-ink-3">暂无手工授权的邮箱。</p> :
          <ul className="divide-y divide-line-soft">
            {loaderData.members.map(member => <li key={member.email} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0"><p className="break-all text-sm font-medium">{member.email}</p><div className="mt-1 text-xs text-ink-3"><Time at={member.createdAt} /></div></div>
              <Button disabled={busy} onClick={() => setRevoking(member.email)}>撤销授权</Button>
            </li>)}
          </ul>}
      </Card>
      <ReasonDialog open={revoking !== null} title="撤销手工授权" description={`撤销 ${revoking ?? ""} 的手工授权？有效订阅仍可使用会员功能。`}
        requireReason={false} danger confirmLabel="确认撤销" busy={busy} onClose={() => setRevoking(null)}
        onSubmit={async () => {
          if (!revoking) return false;
          const result = await run("DELETE", path, {email:revoking}, {label:`revoke-${revoking}`,success:"手工授权已撤销"});
          if (result && issued?.email.toLowerCase() === revoking.toLowerCase()) setIssued(null);
          return result !== null;
        }} />
    </AdminPage>
  );
}
