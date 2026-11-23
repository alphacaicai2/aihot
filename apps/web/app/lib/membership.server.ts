import { data, redirect } from "react-router";
import { ApiError, apiGet } from "./api.server";

export interface Membership {
  email: string | null;
  emailConfirmed: boolean;
  access: boolean;
  admin: boolean;
  source: "admin" | "grant" | "subscription" | null;
  customer: boolean;
  billingReady: boolean;
  hasToken: boolean;
}

export const privateHeaders = { "Cache-Control": "private, no-store", "Vary": "Cookie" };

export async function memberGet<T>(request: Request, path: string): Promise<T> {
  return apiGet<T>(path, {
    signal: request.signal,
    headers: { cookie: request.headers.get("cookie") ?? "", "user-agent": request.headers.get("user-agent") ?? "" },
  });
}

export async function getMembership(request: Request): Promise<Membership> {
  try {
    return await memberGet<Membership>(request, "/api/reader/membership");
  } catch (error) {
    if (request.signal.aborted) throw error;
    throw data({ message: "会员状态暂时无法加载" }, { status: 503, headers: privateHeaders });
  }
}

export function offerMembership(feature: "agent" | "financing", company?: string) {
  const params = new URLSearchParams({ feature });
  if (company) params.set("company", company);
  return redirect(`/membership?${params}`, { headers: privateHeaders });
}

export async function requireMembership(request: Request, feature: "agent" | "financing") {
  const membership = await getMembership(request);
  if (!membership.access) throw offerMembership(feature);
  return membership;
}

export async function financingData<T>(request: Request, path: string) {
  try {
    return await memberGet<T>(request, path);
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw offerMembership("financing");
    const status = error instanceof ApiError && error.status === 400 ? 400 : 503;
    throw data({ message: "融资查询暂时不可用" }, { status, headers: privateHeaders });
  }
}
