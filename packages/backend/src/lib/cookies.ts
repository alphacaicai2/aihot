export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (seen.has(name)) {
      delete out[name];
      continue;
    }
    seen.add(name);
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Ignore malformed cookies from other applications on the same host.
    }
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean, path = "/"): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
