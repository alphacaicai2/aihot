/** Append transport diagnostics without serializing request objects, headers or cause messages. */
export function errorDetails(error: unknown): string {
  const details: string[] = [];
  const seen = new Set<object>();
  function visit(value: unknown, path: string, depth: number) {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 4 || seen.size >= 12) return;
    seen.add(value);
    const e = value as Record<string, unknown>;
    const fields: string[] = [];
    if (typeof e.name === "string" && /^[A-Za-z]{1,48}Error$/.test(e.name)) fields.push(e.name);
    if (typeof e.code === "string" && /^(?:E[A-Z0-9_]{1,40}|UND_ERR_[A-Z0-9_]{1,40})$/.test(e.code)) fields.push(`code=${e.code}`);
    if (typeof e.syscall === "string" && /^(connect|read|write|getaddrinfo|recv|send)$/.test(e.syscall)) fields.push(`syscall=${e.syscall}`);
    if (fields.length) details.push(`${path}: ${fields.join(" ")}`);
    visit(e.cause, `${path}.cause`, depth + 1);
    if (Array.isArray(e.errors)) e.errors.slice(0, 4).forEach((item, i) => visit(item, `${path}.errors[${i}]`, depth + 1));
  }
  visit(error, "error", 0);
  const summary = String(error).slice(0, 800);
  return (summary + (details.length ? ` | ${details.join("; ")}` : "")).slice(0, 2000);
}
