import { useState } from "react";
import type { Route } from "./+types/model-config";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import type { ModelDisplay } from "../../features/admin/model-usage";
import { AdminPage, Button, Card, ReasonDialog, Select } from "../../features/admin/ui";

type Task = { key: string; label: string; vision: boolean; current: { model: string; source: string } };
type Choice = ModelDisplay & { vision: boolean };

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<{ capabilities: Task[]; choices: Choice[] }>(request, "/api/admin/model-config");
}

function TaskSetting({ task, choices }: { task: Task; choices: Choice[] }) {
  const [selected, setSelected] = useState(task.current.model);
  const [confirm, setConfirm] = useState(false);
  const { run, busy } = useAdminAction();
  return <Card title={task.label}>
    {task.key === "financing" && <p className="mb-2 text-sm text-ink-3">
      从报道中提取融资公司、轮次、金额和投资机构。{task.current.source === "inherited" ? "当前沿用「分类与事实抽取」的模型。" : "当前使用独立选择的模型。"}
    </p>}
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label={task.label} value={selected} onChange={e => setSelected(e.target.value)}>
        {choices.filter(c => c.vision === task.vision).map(c =>
          <option key={c.key} value={c.key}>{c.channel} · {c.model || "未配置模型"}（{c.key}）</option>)}
        <option value="__default">{task.key === "financing" ? "沿用分类与事实抽取" : "恢复默认设置"}</option>
      </Select>
      <Button disabled={busy || (selected === task.current.model && task.current.source === "admin")} onClick={() => setConfirm(true)}>保存任务模型</Button>
    </div>
    <ReasonDialog open={confirm} title={`修改${task.label}的模型`} confirmLabel="保存" busy={busy}
      onClose={() => setConfirm(false)} onSubmit={async reason =>
        (await run("POST", `/api/admin/models/${task.key}`, { model: selected === "__default" ? null : selected, reason }, { success: "任务模型已保存" })) !== null} />
  </Card>;
}

export default function ModelConfig({ loaderData }: Route.ComponentProps) {
  return <AdminPage title="模型配置" subtitle="为各项任务选择模型。保存后对新请求生效。">
    <div className="grid gap-4">{loaderData.capabilities.map(task =>
      <TaskSetting key={`${task.key}:${task.current.model}:${task.current.source}`} task={task} choices={loaderData.choices} />)}</div>
  </AdminPage>;
}
