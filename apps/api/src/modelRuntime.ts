import OpenAI from "openai";
import { readEnvValue } from "./env.js";

export type ChatMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export type ModelRuntimeConfig = {
  model: string;
  baseURL: string;
  apiKeyEnvName: string;
  temperature: number;
  maxTokens: number;
};

export type ModelUsage = { inputTokens?: number; outputTokens?: number };

export type ModelCompletionDiagnostics = {
  chunkCount: number;
  contentLength: number;
  reasoningLength: number;
  finishReasons: string[];
  firstChunkPreview: string;
  lastChunkPreview: string;
};

export async function streamModelCompletion(
  config: ModelRuntimeConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }>,
): Promise<{ text: string; reasoning: string; usage?: ModelUsage; diagnostics: ModelCompletionDiagnostics }> {
  const client = createOpenAIClient(config);
  if (usesResponsesApi(config)) {
    return completeWithResponsesApi(client, config, messages);
  }
  return streamChatCompletions(client, config, normalizeMessagesForProvider(config, messages));
}

export function createOpenAIClient(config: Pick<ModelRuntimeConfig, "apiKeyEnvName" | "baseURL">): OpenAI {
  const apiKey = readEnvValue(config.apiKeyEnvName);
  if (!apiKey) {
    throw new Error(`未配置 ${config.apiKeyEnvName}`);
  }
  return new OpenAI({
    apiKey,
    baseURL: config.baseURL,
    defaultHeaders: { "X-Failover-Enabled": "true" },
  });
}

export function usesResponsesApi(config: Pick<ModelRuntimeConfig, "baseURL" | "model">): boolean {
  return /ark\.cn-beijing\.volces\.com\/api\/v3/i.test(config.baseURL) || /^doubao-/i.test(config.model);
}

function isGiteeProvider(config: Pick<ModelRuntimeConfig, "baseURL">): boolean {
  return /ai\.gitee\.com\/v1/i.test(config.baseURL);
}

function isBigModelProvider(config: Pick<ModelRuntimeConfig, "baseURL">): boolean {
  return /open\.bigmodel\.cn\/api\/paas\/v4/i.test(config.baseURL);
}

function normalizeMessagesForProvider(
  config: Pick<ModelRuntimeConfig, "baseURL">,
  messages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }>,
): Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }> {
  if (!isBigModelProvider(config)) return messages;
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "image_url") return part;
        return {
          ...part,
          image_url: {
            url: stripDataUrlPrefix(part.image_url.url),
          },
        };
      }),
    };
  });
}

function stripDataUrlPrefix(url: string): string {
  return url.replace(/^data:[^;]+;base64,/i, "");
}

async function streamChatCompletions(
  client: OpenAI,
  config: ModelRuntimeConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }>,
): Promise<{ text: string; reasoning: string; usage?: ModelUsage; diagnostics: ModelCompletionDiagnostics }> {
  let text = "";
  let reasoning = "";
  let usage: ModelUsage | undefined;
  let chunkCount = 0;
  let firstChunkPreview = "";
  let lastChunkPreview = "";
  const finishReasons = new Set<string>();
  const sampling = samplingForModel(config);
  const stream = (await client.chat.completions.create({
    model: config.model,
    messages,
    stream: true,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    ...sampling,
    stream_options: isGiteeProvider(config) ? { include_usage: true } : undefined,
    thinking: isBigModelProvider(config) && /glm-?5v/i.test(config.model) ? { type: "enabled" } : undefined,
  } as never)) as unknown as AsyncIterable<{
    choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>;

  for await (const chunk of stream) {
    chunkCount += 1;
    const chunkPreview = previewText(JSON.stringify(chunk), 400);
    if (!firstChunkPreview) firstChunkPreview = chunkPreview;
    lastChunkPreview = chunkPreview;
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning_content) reasoning += delta.reasoning_content;
    if (delta?.content) text += delta.content;
    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) finishReasons.add(choice.finish_reason);
    }
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      };
    }
  }

  return {
    text,
    reasoning,
    usage,
    diagnostics: {
      chunkCount,
      contentLength: text.length,
      reasoningLength: reasoning.length,
      finishReasons: Array.from(finishReasons),
      firstChunkPreview,
      lastChunkPreview,
    },
  };
}

async function completeWithResponsesApi(
  client: OpenAI,
  config: ModelRuntimeConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }>,
): Promise<{ text: string; reasoning: string; usage?: ModelUsage; diagnostics: ModelCompletionDiagnostics }> {
  const response = await client.responses.create({
    model: config.model,
    input: messagesToResponsesInput(messages),
    max_output_tokens: config.maxTokens,
    temperature: config.temperature,
  } as never);
  const raw = response as unknown as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
      summary?: Array<{ type?: string; text?: string }>;
    }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = raw.output_text || raw.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") || "";
  const reasoning = raw.output?.flatMap((item) => item.summary ?? []).map((item) => item.text ?? "").join("") || "";
  return {
    text,
    reasoning,
    usage: raw.usage
      ? {
          inputTokens: raw.usage.input_tokens,
          outputTokens: raw.usage.output_tokens,
        }
      : undefined,
    diagnostics: {
      chunkCount: 1,
      contentLength: text.length,
      reasoningLength: reasoning.length,
      finishReasons: [],
      firstChunkPreview: previewText(JSON.stringify(raw), 400),
      lastChunkPreview: previewText(JSON.stringify(raw), 400),
    },
  };
}

function messagesToResponsesInput(messages: Array<{ role: string; content: ChatMessageContent }>) {
  return messages.map((message) => ({
    role: normalizeResponsesRole(message.role),
    content: Array.isArray(message.content)
      ? message.content.map((part) =>
          part.type === "text"
            ? { type: "input_text", text: part.text }
            : { type: "input_image", image_url: part.image_url.url },
        )
      : [{ type: "input_text", text: message.content }],
  }));
}

function normalizeResponsesRole(role: string): "system" | "user" | "assistant" {
  if (role === "system" || role === "assistant") return role;
  return "user";
}

function samplingForModel(config: Pick<ModelRuntimeConfig, "model" | "baseURL">): Record<string, number | undefined> {
  if (!isGiteeProvider(config)) return {};
  if (/deepseek|mimo/i.test(config.model)) {
    return { top_p: 0.7, top_k: 50, frequency_penalty: 1 };
  }
  if (/kimi|qwen/i.test(config.model)) {
    return { top_k: 50, frequency_penalty: 0 };
  }
  return { top_p: 1, top_k: 1, frequency_penalty: 0 };
}

function previewText(value: string, limit = 900): string {
  return value.length > limit ? `${value.slice(0, limit)}...<truncated ${value.length - limit}>` : value;
}
