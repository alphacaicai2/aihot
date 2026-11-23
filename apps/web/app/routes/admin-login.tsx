// Admin sign-in: the admin password (ADMIN_PASSWORD), and Feishu when it is configured. The form posts
// straight to the API, which sets the session cookie and sends the browser on.
import { useLoaderData } from "react-router";
import type { Route } from "./+types/admin-login";
import { SITE } from "@aihot/industry/site";
import { apiGet } from "../lib/api.server";
import { Wordmark } from "../components/Logo";
import { Button } from "../components/coss/button";
import { Card, CardHeader, CardTitle } from "../components/coss/card";
import { Input } from "../components/coss/input";

const ERRORS: Record<string, string> = {
  wrong: "密码不对，再试一次。",
  unset: "还没有设置管理员密码：在 .env 里设置 ADMIN_PASSWORD（至少 12 位），重启后再登录。",
  "too-many": "尝试次数太多，请 15 分钟后再试。",
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return") ?? "/admin";
  const options = await apiGet<{ password: boolean; feishu: boolean }>("/api/auth/options", { signal: request.signal }).catch(() => ({ password: true, feishu: false }));
  return { returnTo: returnTo.startsWith("/admin") ? returnTo : "/admin", error: url.searchParams.get("error"), ...options };
}

export const meta: Route.MetaFunction = () => [{ title: `登录 · ${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

export default function AdminLogin() {
  const { returnTo, error, password, feishu } = useLoaderData<typeof loader>();
  const message = error ? (ERRORS[error] ?? ERRORS.wrong) : !password ? ERRORS.unset : null;
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <Card className="border-line">
          <CardHeader className="gap-5">
            <Wordmark size={24} className="text-ink" />
            <CardTitle render={<h1 />}>后台登录</CardTitle>
          </CardHeader>
          <form method="post" action="/api/auth/password" className="px-6 pb-6">
            <input type="hidden" name="return" value={returnTo} />
            <label htmlFor="password" className="mb-2 block text-sm font-medium text-ink-2">管理员密码</label>
            <Input
              nativeInput
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              aria-invalid={error === "wrong" || undefined}
              aria-describedby={message ? "login-error" : undefined}
              size="lg"
            />
            {message && <p id="login-error" role="alert" className="mt-3 text-sm leading-relaxed text-hot">{message}</p>}
            <Button type="submit" size="lg" className="mt-5 w-full">登录</Button>
            {feishu && (
              <Button variant="outline" size="lg" className="mt-3 w-full" render={<a href={`/api/auth/feishu?${new URLSearchParams({ return: returnTo })}`} />}>
                用飞书登录
              </Button>
            )}
          </form>
        </Card>
        <p className="mt-5 text-center">
          <Button render={<a href="/" />} variant="link" size="sm">回到 {SITE.name}</Button>
        </p>
      </div>
    </main>
  );
}
