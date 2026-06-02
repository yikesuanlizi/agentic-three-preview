import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import {
  type AgentTurnRequest,
  type AppSettings,
  type CompactSummary,
  type PatchEvent,
  type SceneDsl,
  type StreamEvent,
  agentTurnRequestSchema,
  compactSummarySchema,
  sanitizePatch,
} from "@agentic-three/shared";
import { selectSkillContextDynamic } from "./skills.js";
import { getAppSettings, resolveModelConfig } from "./settings.js";
import { createRuntimePatchWithRag } from "./sceneRuntime.js";

type Usage = { inputTokens?: number; outputTokens?: number };
type ChatMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;
type ChatCompletionDiagnostics = {
  chunkCount: number;
  contentLength: number;
  reasoningLength: number;
  finishReasons: string[];
  firstChunkPreview: string;
  lastChunkPreview: string;
};
function logAgent(stage: string, payload: Record<string, unknown>): void {
  console.log(`[agentic-three:agent] ${stage}`, payload);
}

function previewText(value: string, limit = 900): string {
  return value.length > limit ? `${value.slice(0, limit)}...<truncated ${value.length - limit}>` : value;
}

const AgentState = Annotation.Root({
  request: Annotation<AgentTurnRequest>(),
  runId: Annotation<string>(),
  settings: Annotation<AppSettings>(),
  compactSummary: Annotation<CompactSummary>(),
  recentHistory: Annotation<Array<{ role: "user" | "assistant"; content: string }>>(),
  normalizedGoal: Annotation<string>(),
  skillContext: Annotation<string>(),
  plan: Annotation<string>(),
  patch: Annotation<PatchEvent | undefined>(),
  scene: Annotation<SceneDsl | undefined>(),
  nextCompactSummary: Annotation<CompactSummary | undefined>(),
  reasoningSummary: Annotation<string>(),
  assistantMessage: Annotation<string>(),
  error: Annotation<string | undefined>(),
  usage: Annotation<Usage | undefined>(),
});

type AgentStateType = typeof AgentState.State;

const inputNormalizer = async (state: AgentStateType) => {
  const request = agentTurnRequestSchema.parse(state.request);
  const runtime = request.runtimeErrors.map((item) => item.message).join("\n");
  const normalizedGoal = [
    request.message.trim() ||
      (request.images.length ? "请根据上传图片生成或修改 three.js 场景。" : "请优化当前 three.js 场景。"),
    request.images.length
      ? `用户上传了 ${request.images.length} 张参考图片，需要按多角度/多维度参考理解主体、材质、构图、光照、视角和截图用途。`
      : "",
    runtime ? `需要处理的运行错误:\n${runtime}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  logAgent("input_normalizer", {
    runId: state.runId,
    imageCount: request.images.length,
    normalizedGoal: previewText(normalizedGoal, 500),
  });
  return { request, normalizedGoal };
};

// coder_agent 直接接收多模态输入（图片 + 文本），不经过图片转文字中间层。

const contextBuilder = async (state: AgentStateType) => {
  const selection = await selectSkillContextDynamic({
    message: `${state.normalizedGoal}\n${state.compactSummary.codeState}\n${state.compactSummary.nextSteps}`,
    enabledSkillIds: state.settings.enabledSkillIds,
    images: state.request.images,
    settings: state.settings,
  });
  logAgent("context_builder", {
    runId: state.runId,
    skillContextLength: selection.context.length,
    enabledSkillIds: state.settings.enabledSkillIds,
    selectedSkillIds: selection.selectedSkillIds,
    skillSelectionSource: selection.source,
    skillSelectionReason: selection.reason,
  });
  const skillSourceLabel = {
    none: "未加载",
    direct: "按前端选择直接加载",
    llm: "LLM 动态选择",
    heuristic: "规则选择",
  }[selection.source];
  return {
    skillContext: selection.context,
    reasoningSummary: `${state.reasoningSummary}\nskills: ${skillSourceLabel} ${selection.selectedSkillIds.join(", ") || "无"}。`,
  };
};

const plannerAgent = async (state: AgentStateType) => {
  const hasErrors = state.request.runtimeErrors.length > 0;
  const plan = hasErrors
    ? "先修复当前场景的运行错误，再尽量保留用户的视觉目标。"
    : "生成一个小而完整的 three.js React 场景补丁，确保可以在浏览器沙箱中安全预览。";
  return {
    plan,
    reasoningSummary: `${state.reasoningSummary}\n意图: ${hasErrors ? "修复场景" : "修改场景"}。文件修改被限制在 Sandpack 白名单内。`,
  };
};

const coderAgent = async (state: AgentStateType) => {
  try {
    const runtime = await createRuntimePatchWithRag(state.request);
    logAgent("runtime_renderer.patch_created", {
      runId: state.runId,
      intent: runtime.intent,
      sceneType: runtime.scene.sceneType,
      renderStyle: runtime.scene.renderStyle,
      retrievalMode: runtime.retrievalMode,
      retrievalIds: runtime.retrievalResults.map((item) => `${item.kind}:${item.id}`),
      paths: runtime.patch.operations.map((operation) => operation.path),
    });
    return {
      patch: runtime.patch,
      scene: runtime.scene,
      assistantMessage:
        "已使用 Runtime Composer 生成 Scene DSL，并通过程序化 three.js renderer 输出可预览场景。",
      reasoningSummary: `${state.reasoningSummary}\n语义解析: ${runtime.intent.subject} / ${runtime.intent.renderStyle}。\n检索: ${runtime.retrievalMode} 命中 ${runtime.retrievalResults.map((item) => item.id).join(", ") || "无"}。\n场景编排: ${runtime.scene.sceneType} DSL 已渲染为 Sandpack 文件。`,
    };
  } catch (runtimeError) {
    const reason = runtimeError instanceof Error ? runtimeError.message : String(runtimeError);
    logAgent("runtime_renderer.failed", {
      runId: state.runId,
      error: reason,
    });
    return {
      error: `Runtime Composer 生成失败，已保留当前代码。原因: ${reason}`,
      assistantMessage:
        "这轮没有应用补丁，因为 Runtime Composer 没有生成有效 Scene DSL 或渲染补丁。请补充结构要求，或先检查 RAG/资产/模板配置。",
      reasoningSummary: `${state.reasoningSummary}\nRuntime Composer: 生成失败。已按全新架构停止，不再回退到旧 coder 从零写代码。`,
    };
  }
};

const reviewAgent = async (state: AgentStateType) => {
  if (state.error) return {};
  if (!state.patch) {
    return { error: "Agent 没有生成补丁。" };
  }
  try {
    const patch = sanitizePatch(state.patch);
    return {
      patch,
      reasoningSummary: `${state.reasoningSummary}\n审查: 补丁通过了路径白名单和危险 API 检查。`,
    };
  } catch (error) {
    return {
      patch: undefined,
      assistantMessage:
        "这轮没有应用补丁，因为生成结果没有通过安全审查。当前代码已保留，避免用无关默认场景覆盖你的需求。",
      reasoningSummary: `${state.reasoningSummary}\n审查: 已拒绝不安全补丁，未输出通用 fallback。`,
      error: `补丁安全审查失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const patchEmitter = async (state: AgentStateType) => {
  return {
    assistantMessage:
      state.assistantMessage ||
      "我准备了一个安全的 three.js 场景补丁，它只会更新浏览器 Sandpack 中的文件。",
  };
};

const contextCompactor = async (state: AgentStateType) => {
  const nextCompactSummary = await compactContext(state);
  return {
    nextCompactSummary,
    reasoningSummary: `${state.reasoningSummary}\n上下文摘要: 已更新三段式摘要，下一轮将注入压缩上下文。`,
  };
};

export const graph = new StateGraph(AgentState)
  .addNode("input_normalizer", inputNormalizer)
  .addNode("context_builder", contextBuilder)
  .addNode("planner_agent", plannerAgent)
  .addNode("coder_agent", coderAgent)
  .addNode("review_agent", reviewAgent)
  .addNode("patch_emitter", patchEmitter)
  .addNode("context_compactor", contextCompactor)
  .addEdge(START, "input_normalizer")
  .addEdge("input_normalizer", "context_builder")
  .addEdge("context_builder", "planner_agent")
  .addEdge("planner_agent", "coder_agent")
  .addEdge("coder_agent", "review_agent")
  .addEdge("review_agent", "patch_emitter")
  .addEdge("patch_emitter", "context_compactor")
  .addEdge("context_compactor", END)
  .compile();

export type AgentRunInput = {
  request: AgentTurnRequest;
  runId: string;
  compactSummary?: CompactSummary;
  recentHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  settings?: AppSettings;
};

export type AgentRunResult = {
  events: StreamEvent[];
  nextCompactSummary: CompactSummary;
};

export async function runAgent(input: AgentTurnRequest | AgentRunInput): Promise<AgentRunResult> {
  const request = "request" in input ? input.request : input;
  const initialState: AgentStateType = {
    request,
    runId: "request" in input ? input.runId : randomUUID(),
    settings: "request" in input && input.settings ? input.settings : getAppSettings(),
    compactSummary: compactSummarySchema.parse("request" in input ? (input.compactSummary ?? {}) : {}),
    recentHistory: "request" in input ? (input.recentHistory ?? []) : [],
    normalizedGoal: "",
    skillContext: "",
    plan: "",
    patch: undefined,
    scene: undefined,
    nextCompactSummary: undefined,
    reasoningSummary: "",
    assistantMessage: "",
    error: undefined,
    usage: undefined,
  };
  const result = await graph.invoke(initialState, {
    configurable: { thread_id: request.sessionId },
  });
  const runtimeContextLength = buildRuntimeContextSummary(result).length;
  const events: StreamEvent[] = [
    { type: "run_id", runId: initialState.runId },
    { type: "workflow_config", config: result.settings.runtimeComposer },
    {
      type: "coder_input_summary",
      message: `Runtime Composer 收到 ${result.request.images.length} 张图片，上下文 ${runtimeContextLength} 字符，skills ${result.skillContext.length} 字符。`,
    },
    { type: "reasoning_summary", message: result.reasoningSummary || "Agent 图执行完成。" },
  ];
  if (result.patch) {
    if (result.scene) {
      events.push({ type: "scene_dsl", scene: result.scene });
    }
    events.push(result.patch);
  }
  if (result.assistantMessage) {
    events.push({ type: "assistant_message", message: result.assistantMessage });
  }
  if (result.error) {
    events.push({ type: "error", message: result.error });
  }
  if (result.usage) {
    events.push({ type: "usage", ...result.usage });
  }
  return {
    events,
    nextCompactSummary: result.nextCompactSummary ?? initialState.compactSummary,
  };
}

function buildRuntimeContextSummary(state: AgentStateType): string {
  return [
    `用户目标: ${state.normalizedGoal}`,
    `压缩记忆: ${formatCompactSummary(state.compactSummary)}`,
    `执行计划: ${state.plan}`,
    `技能上下文字符数: ${state.skillContext.length}`,
    `运行错误数: ${state.request.runtimeErrors.length}`,
    `文件摘要:\n${summarizeFiles(state.request.files)}`,
  ].join("\n\n");
}

function formatCompactSummary(summary: CompactSummary): string {
  return [
    `用户长期目标: ${summary.userGoal || "暂无"}`,
    `当前代码状态: ${summary.codeState || "暂无"}`,
    `下一步计划/约束: ${summary.nextSteps || "暂无"}`,
  ].join("\n");
}

function summarizeFiles(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, content]) => {
      const lines = content.split(/\r?\n/).length;
      const hints = [
        content.includes("OrbitControls") ? "OrbitControls" : "",
        content.includes("preserveDrawingBuffer") ? "可截图 renderer" : "",
        content.includes("__AGENTIC_THREE_VIEW__") ? "预览控制桥" : "",
      ]
        .filter(Boolean)
        .join(", ");
      return `${path}: ${lines} 行${hints ? `, ${hints}` : ""}`;
    })
    .join("\n");
}

async function compactContext(state: AgentStateType): Promise<CompactSummary> {
  try {
    const generated = await generateSummaryWithModel(state);
    return mergeCompactSummary(state.compactSummary, generated);
  } catch {
    return mergeCompactSummary(state.compactSummary, {
      userGoal: state.normalizedGoal,
      codeState: summarizeFiles(state.request.files),
      nextSteps: state.patch
        ? `已生成补丁: ${state.patch.summary}。下一步预览结果，若有运行错误则继续修复。`
        : "下一步继续根据用户反馈修改 three.js 场景。",
    });
  }
}

async function generateSummaryWithModel(state: AgentStateType): Promise<CompactSummary> {
  const modelConfig = resolveModelConfig("summary", state.settings);
  const client = createModelClient(modelConfig);
  const prompt = `请把本轮 three.js 编程会话压缩成三段式记忆，只返回 JSON。

旧摘要:
${formatCompactSummary(state.compactSummary)}

用户本轮目标:
${state.normalizedGoal}

运行计划:
${state.plan}

补丁摘要:
${state.patch?.summary ?? "无"}

当前文件状态:
${summarizeFiles(state.request.files)}

JSON schema:
{"userGoal":"用户长期目标","codeState":"当前代码状态","nextSteps":"下一步计划/约束"}`;
  const { text } = await streamChatCompletion(client, {
    model: modelConfig.model,
    messages: [
      { role: "system", content: "你是上下文压缩模块。只输出合法 JSON，不输出解释。" },
      { role: "user", content: prompt },
    ],
    temperature: modelConfig.temperature,
    maxTokens: modelConfig.maxTokens,
  });
  return compactSummarySchema.parse(parseJsonObject(text));
}

export function mergeCompactSummary(previous: CompactSummary, next: Partial<CompactSummary>): CompactSummary {
  return compactSummarySchema.parse({
    userGoal: (next.userGoal || previous.userGoal || "").trim(),
    codeState: (next.codeState || previous.codeState || "").trim(),
    nextSteps: (next.nextSteps || previous.nextSteps || "").trim(),
    updatedAt: new Date().toISOString(),
  });
}

function parseJsonObject<T>(text: string): T {
  const json = extractJsonObject(text);
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    try {
      return JSON.parse(escapeControlCharactersInJsonStrings(json)) as T;
    } catch {
      throw error;
    }
  }
}

function escapeControlCharactersInJsonStrings(json: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (const char of json) {
    if (!inString) {
      output += char;
      if (char === "\"") inString = true;
      continue;
    }

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      output += char;
      inString = false;
      continue;
    }

    const code = char.charCodeAt(0);
    if (code <= 0x1f) {
      if (char === "\n") output += "\\n";
      else if (char === "\r") output += "\\r";
      else if (char === "\t") output += "\\t";
      else if (char === "\b") output += "\\b";
      else if (char === "\f") output += "\\f";
      else output += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }

    output += char;
  }

  return output;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error("模型没有返回可解析 JSON");
}

function createModelClient(config: { apiKeyEnvName: string; baseURL: string }): OpenAI {
  const apiKey = process.env[config.apiKeyEnvName];
  if (!apiKey) {
    throw new Error(`未配置 ${config.apiKeyEnvName}`);
  }
  return new OpenAI({
    apiKey,
    baseURL: config.baseURL,
    defaultHeaders: { "X-Failover-Enabled": "true" },
  });
}

async function streamChatCompletion(
  client: OpenAI,
  input: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }>;
    temperature: number;
    maxTokens: number;
  },
): Promise<{ text: string; reasoning: string; usage?: Usage; diagnostics: ChatCompletionDiagnostics }> {
  let text = "";
  let reasoning = "";
  let usage: Usage | undefined;
  let chunkCount = 0;
  let firstChunkPreview = "";
  let lastChunkPreview = "";
  const finishReasons = new Set<string>();
  const stream = (await client.chat.completions.create({
    model: input.model,
    messages: input.messages,
    stream: true,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
    top_p: Number(process.env.MODEL_TOP_P || 0.7),
    top_k: Number(process.env.MODEL_TOP_K || 50),
    frequency_penalty: Number(process.env.MODEL_FREQUENCY_PENALTY || 1),
    stream_options: { include_usage: true },
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
