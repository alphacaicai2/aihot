import { MODELS } from "../providers/llm.ts";

const channelNames: Record<string, string> = {
  LLM_BASE_URL: "自定义 / OpenAI 兼容",
  OPENROUTER_BASE_URL: "OpenRouter",
  DEEPSEEK_BASE_URL: "DeepSeek 官方",
  OPENCODE_GO_BASE_URL: "OpenCode Go",
  CPA_BASE_URL: "CPA",
  ZHIPU_BASE_URL: "智谱 GLM",
  DASHSCOPE_BASE_URL: "阿里云千问",
  XIAOMI_MIMO_BASE_URL: "小米 MiMo",
};

/** Only public display metadata. Credentials and endpoint URLs stay on the server. */
export function modelDisplayOptions() {
  return Object.values(MODELS).map(spec => ({
    key: spec.key, service: spec.service, model: spec.model,
    channel: channelNames[spec.baseUrlEnv] ?? spec.service, vision: !!spec.vision,
  }));
}
