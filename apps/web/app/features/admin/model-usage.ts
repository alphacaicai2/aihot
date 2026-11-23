// Several presets can send the same model ID, and OpenRouter shares the "llm" receipt service
// with the site's custom endpoint. Only identify a channel when the receipt is unambiguous.
export interface ModelDisplay {
  key: string;
  service: string;
  model: string;
  channel: string;
}

export function receiptChannel(models: ModelDisplay[], service: string, model: string | null) {
  const choices = models.filter(choice => choice.service === service);
  const channelNames = new Set(choices.map(choice => choice.channel));
  if (channelNames.size === 1 && service !== "llm") return choices[0]!.channel;
  const matches = new Set(choices.filter(choice => choice.model === model).map(choice => choice.channel));
  return matches.size === 1 ? [...matches][0]! : null;
}
