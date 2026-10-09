// Local process supervisor. All reader exits bind to loopback; children restart after a crash.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";

const children = new Set<ChildProcess>();
let stopping = false;
const roles = ["apps/api/src/main.ts", "apps/worker/src/main.ts", "apps/web/server.ts"];
function start(role: string) {
  if (stopping) return;
  const child = spawn(process.execPath, ["--env-file=.env", role], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", WEB_HOST: "127.0.0.1" },
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${path.basename(role)} exited (${code}); retrying in 5 seconds`);
      setTimeout(() => start(role), 5000);
    }
  });
}
for (const role of roles) start(role);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  stopping = true;
  for (const child of children) child.kill(signal);
});
