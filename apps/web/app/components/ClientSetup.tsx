import { useState } from "react";
import { SITE } from "@aihot/industry/site";
import { IconChevronDown } from "./icons";
import { CodeBlock, CopyButton } from "./CodeBlock";
import { Select } from "./ui/Controls";

const shellInput = {
  unix: 'printf "粘贴令牌后按回车 > "; IFS= read -rs CAOLU_AGENT_TOKEN; printf "\\n"; export CAOLU_AGENT_TOKEN',
  powershell: '$env:CAOLU_AGENT_TOKEN = Read-Host "粘贴令牌后按回车" -MaskInput',
};

export function TokenEnvironment() {
  const [shell, setShell] = useState<keyof typeof shellInput>("unix");
  return <details className="disclosure group mt-3 rounded-control border border-line px-3.5 text-sm text-ink-2">
    <summary className="flex cursor-pointer items-center justify-between gap-2 py-2.5 font-semibold">如何设置 CAOLU_AGENT_TOKEN<IconChevronDown size={14} className="transition-transform group-open:rotate-180" /></summary>
    <Select aria-label="终端类型" value={shell} onChange={e => setShell(e.target.value as keyof typeof shellInput)}>
      <option value="unix">bash / zsh</option><option value="powershell">PowerShell 7.1+</option>
    </Select>
    <CodeBlock title="在当前终端输入令牌（隐藏输入）" code={shellInput[shell]} />
    <p className="mb-3 text-xs text-ink-3">复制命令运行，等提示出现后粘贴令牌。从这个终端启动客户端，关闭终端后需重新设置。</p>
  </details>;
}

export function ClientSetup({ url }: { url: string }) {
  const [client, setClient] = useState("codex");
  const name = SITE.mcpPrefix;
  const config = JSON.stringify({ mcpServers: { [name]: { type: "http", url, headers: { Authorization: "Bearer ${CAOLU_AGENT_TOKEN}" } } } }, null, 2);
  return <section className="mt-4">
    <label className="flex flex-wrap items-center gap-2 text-sm font-medium">选择 MCP 客户端
      <Select value={client} onChange={e => setClient(e.target.value)}>
        <option value="codex">Codex CLI</option><option value="claude">Claude Code</option><option value="http">其他 HTTP 客户端</option>
      </Select>
    </label>
    {client === "http" ? <div className="mt-3 space-y-2">
      <p className="text-sm text-ink-3">选择 Streamable HTTP，将地址粘贴到服务器 URL。使用客户端的凭据设置填写 Bearer 令牌。</p>
      <div className="flex items-center gap-2 rounded-control border border-line p-2"><code className="min-w-0 flex-1 break-all text-xs">{url}</code><CopyButton text={url} label="复制地址" /></div>
    </div> : <>
      <TokenEnvironment />
      {client === "codex" ? <>
        <CodeBlock title="添加服务器" code={`codex mcp add ${name} --url '${url}' --bearer-token-env-var CAOLU_AGENT_TOKEN`} />
        <p className="text-sm text-ink-3">在同一终端运行 codex，在会话里输入 /mcp 查看已连接的工具。</p>
      </> : <>
        <CodeBlock title="项目 .mcp.json · 合并到已有 mcpServers 配置" code={config} />
        <p className="text-sm text-ink-3">保留配置里的环境变量引用。在同一终端运行 claude，确认项目服务器，然后输入 /mcp 查看连接。</p>
      </>}
    </>}
  </section>;
}
