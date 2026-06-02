import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import {
  ALLOWED_FILE_PATHS,
  type AgentTurnRequest,
  type AllowedFilePath,
  type AppSettings,
  type CompactSummary,
  type PatchEvent,
  type StreamEvent,
  agentTurnRequestSchema,
  compactSummarySchema,
  defaultFiles,
  sanitizePatch,
} from "@agentic-three/shared";
import { selectSkillContextDynamic } from "./skills.js";
import { getAppSettings, resolveModelConfig } from "./settings.js";

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
const MULTIMODAL_REASONING_TOKEN_CAP = 2048;

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
    const generated = await generateWithOpenAI(state);
    return generated;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      error: `Coder 生成失败，已保留当前代码，没有应用通用 fallback。原因: ${reason}`,
      assistantMessage:
        "这轮没有应用补丁，因为 coder 输出没有通过结构化解析。请直接重试一次，或补充更明确的局部结构要求；系统会保留当前稳定快照。",
      reasoningSummary: `${state.reasoningSummary}\n编码: coder 输出解析失败，已拒绝通用 fallback，避免生成与参考图无关的默认场景。`,
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
    nextCompactSummary: undefined,
    reasoningSummary: "",
    assistantMessage: "",
    error: undefined,
    usage: undefined,
  };
  const result = await graph.invoke(initialState, {
    configurable: { thread_id: request.sessionId },
  });
  const finalPromptLength = buildModelPrompt(result).length;
  const events: StreamEvent[] = [
    { type: "run_id", runId: initialState.runId },
    {
      type: "coder_input_summary",
      message: `coder 收到 ${result.request.images.length} 张图片，coder prompt ${finalPromptLength} 字符，skills ${result.skillContext.length} 字符。`,
    },
    { type: "reasoning_summary", message: result.reasoningSummary || "Agent 图执行完成。" },
  ];
  if (result.patch) {
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

async function generateWithOpenAI(state: AgentStateType): Promise<{
  patch: PatchEvent;
  assistantMessage: string;
  usage?: Usage;
}> {
  const modelConfig = resolveModelConfig("coder_agent", state.settings);
  const client = createModelClient(modelConfig);
  const prompt = buildModelPrompt(state);
  const imageCount = state.request.images.length;
  logAgent("coder_agent.multimodal_input", {
    runId: state.runId,
    model: modelConfig.model,
    imageCount,
    promptLength: prompt.length,
    images: state.request.images.map((image) => ({
      name: image.name,
      dimension: image.dimension,
      dataUrlLength: image.dataUrl.length,
      mime: image.dataUrl.slice(0, image.dataUrl.indexOf(";base64,") > 0 ? image.dataUrl.indexOf(";base64,") : 40),
    })),
  });

  // 构造多模态 messages
  const messages: Array<{ role: "system" | "user"; content: ChatMessageContent }> = [
    {
      role: "system",
      content:
        "你是 three.js 编程 Agent。根据用户文本和参考图信息生成场景代码。使用 SUMMARY/ASSISTANT/FILE 文件块格式输出，代码块内直接写源码。",
    },
  ];

  let text = "";
  let usage: Usage | undefined;

  if (imageCount > 0) {
    // 多模态调用：text + image_url
    const userContent: Exclude<ChatMessageContent, string> = [
      { type: "text", text: prompt },
    ];
    for (const image of state.request.images) {
      userContent.push({
        type: "text",
        text: `参考图: ${image.name}${image.dimension ? ` (${image.dimension})` : ""}`,
      });
      userContent.push({
        type: "image_url",
        image_url: { url: image.dataUrl },
      });
    }
    const result = await tryChatCompletion(
      client,
      { ...modelConfig, maxTokens: Math.min(modelConfig.maxTokens, MULTIMODAL_REASONING_TOKEN_CAP) },
      messages,
      userContent,
      {
      runId: state.runId,
      phase: "multimodal",
      },
    );
    text = result.text;
    usage = result.usage;
    logAgent("coder_agent.stream_done", {
      runId: state.runId,
      phase: "multimodal",
      ...result.diagnostics,
    });

    if (!text.trim()) {
      logAgent("coder_agent.multimodal_empty", {
        runId: state.runId,
        reasoningLength: result.reasoning.length,
        reasoningPreview: previewText(result.reasoning, 400),
        hint: "多模态调用返回空 content，尝试用 reasoning 进入文本 finalizer 生成文件块。",
      });
      const finalized = await finalizeFromMultimodalReasoning(state, result.reasoning);
      text = finalized.text;
      usage = mergeUsage(usage, finalized.usage);
    }
  }

  // 无图时走同一个 coder 的纯文本输入；有图时绝不回退成无图生成。
  if (!text.trim()) {
    const result = await tryChatCompletion(client, modelConfig, messages, prompt, {
      runId: state.runId,
      phase: "text",
    });
    text = result.text;
    usage = result.usage ?? usage;
    logAgent("coder_agent.stream_done", {
      runId: state.runId,
      phase: "text",
      ...result.diagnostics,
    });
  }

  logAgent("coder_agent.raw_output", {
    runId: state.runId,
    outputLength: text.length,
    outputPreview: previewText(text, 1200),
  });

  let parsed: { summary: string; assistantMessage: string; operations: PatchEvent["operations"] };
  try {
    parsed = parseModelFileBlocks(text);
    logAgent("coder_agent.file_blocks_parsed", {
      runId: state.runId,
      blockCount: parsed.operations.length,
      paths: parsed.operations.map((op) => op.path),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logAgent("coder_agent.file_block_parse_failed", {
      runId: state.runId,
      reason,
      rawPreview: previewText(text, 600),
    });
    throw error;
  }
  const patch = sanitizePatch({
    type: "patch",
    summary: parsed.summary,
    operations: parsed.operations,
  });
  return {
    patch,
    assistantMessage: parsed.assistantMessage,
    usage,
  };
}

export function parseModelFileBlocks(rawText: string): {
  summary: string;
  assistantMessage: string;
  operations: PatchEvent["operations"];
} {
  const text = rawText.trim();
  if (!text) throw new Error("模型输出为空，没有文件块");

  const summaryIdx = text.indexOf("SUMMARY:");
  const assistantIdx = text.indexOf("ASSISTANT:");
  const firstFileIdx = text.indexOf("FILE:");

  let summary = "";
  let assistantMessage = "";

  if (summaryIdx >= 0) {
    const end = assistantIdx > summaryIdx
      ? assistantIdx
      : firstFileIdx > summaryIdx
        ? firstFileIdx
        : text.length;
    summary = text.slice(summaryIdx + "SUMMARY:".length, end).trim();
  }

  if (assistantIdx >= 0) {
    const end = firstFileIdx > assistantIdx ? firstFileIdx : text.length;
    assistantMessage = text.slice(assistantIdx + "ASSISTANT:".length, end).trim();
  }

  // 提取 FILE: 路径 + fenced code block；路径允许写在 FILE: 同行或下一行。
  const filePattern = /FILE:\s*(?:\r?\n\s*)?([^\s`]+)\s*\r?\n+```(?![^\r\n]*CODE_EDIT_BLOCK)[^\r\n]*\r?\n([\s\S]*?)```/g;
  const allowedPaths = new Set<string>(ALLOWED_FILE_PATHS);
  const operations: PatchEvent["operations"] = [];
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(text)) !== null) {
    const rawPath = match[1];
    const content = match[2];
    if (!rawPath || content === undefined) continue;
    const path = rawPath.trim();
    if (!allowedPaths.has(path)) {
      throw new Error(`模型输出包含非白名单文件路径: ${path}`);
    }
    operations.push({ type: "replace_file" as const, path: path as AllowedFilePath, content });
  }

  // 兼容部分模型输出的编辑器内部块:
  // ```tsx|CODE_EDIT_BLOCK|/src/App.tsx|import ...\n...
  // 这种格式会把源码放在 fence info 后面，并把换行写成字面量 \n。
  const codeEditPattern = /FILE:\s*(?:\r?\n\s*)?([^\s`]+)\s*\r?\n```[^\r\n`|]*\|CODE_EDIT_BLOCK\|\/?[^|]*\|([^\r\n]*)/g;
  while ((match = codeEditPattern.exec(text)) !== null) {
    const rawPath = match[1];
    const rawContent = match[2];
    if (!rawPath || rawContent === undefined) continue;
    const path = rawPath.trim();
    if (!allowedPaths.has(path)) {
      throw new Error(`模型输出包含非白名单文件路径: ${path}`);
    }
    if (operations.some((operation) => operation.path === path)) continue;
    operations.push({
      type: "replace_file" as const,
      path: path as AllowedFilePath,
      content: decodeCodeEditBlockContent(rawContent),
    });
  }

  if (!summary && !assistantMessage) {
    throw new Error("模型输出缺少 SUMMARY 或 ASSISTANT 标记");
  }
  if (operations.length === 0) {
    throw new Error(
      "模型输出没有有效的 FILE 文件块（期望格式: FILE: 路径\\n```\\n内容\\n```）",
    );
  }
  if (!operations.some((operation) => operation.path === "src/App.tsx")) {
    throw new Error("模型输出必须至少包含 FILE: src/App.tsx");
  }

  return {
    summary: summary || "未提供摘要",
    assistantMessage: assistantMessage || "未提供说明",
    operations,
  };
}

function decodeCodeEditBlockContent(rawContent: string): string {
  return rawContent
    .replace(/```.*$/s, "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .trim();
}

function buildModelPrompt(state: AgentStateType): string {
  return `用户目标:
${state.normalizedGoal}

长期压缩记忆:
1. 用户长期目标: ${state.compactSummary.userGoal || "暂无"}
2. 当前代码状态: ${state.compactSummary.codeState || "暂无"}
3. 下一步计划/约束: ${state.compactSummary.nextSteps || "暂无"}

最近少量原文:
${formatRecentHistory(state.recentHistory)}

执行计划:
${state.plan}

可用本地技能:
${state.skillContext || "未选择额外技能。"}

可编辑文件:
${JSON.stringify(state.request.files, null, 2)}

运行错误:
${JSON.stringify(state.request.runtimeErrors, null, 2)}

只返回以下格式，不要输出额外内容：

SUMMARY:
中文补丁摘要

ASSISTANT:
中文用户可读说明

FILE: src/App.tsx
\`\`\`tsx
完整文件内容
\`\`\`

FILE: src/styles.css
\`\`\`css
完整文件内容
\`\`\`

规则:
- FILE: 后的路径只能是白名单文件（src/App.tsx, src/main.tsx, src/styles.css, package.json）。
- 每个文件必须用 fenced code block（\`\`\`），代码块内不用 JSON 转义，直接写源码。
- 禁止输出 CODE_EDIT_BLOCK、diff、patch、JSON、复制按钮文本或编辑器内部标记。
- 至少输出 FILE: src/App.tsx。
- 你会直接收到参考图片（image_url），必须根据图片像素中的结构建模，不要依赖二次文字描述。
- 禁止使用 window.THREE，必须使用 ESM import: \`import * as THREE from "three"\`。
- 禁止使用 @ts-nocheck。
- 禁止因为依赖不存在而静默 return（如 \`if (!THREE) return\`），这会导致空白 canvas。
- 必须使用 \`import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"\`。
- React 组件必须直接导出 \`export default function App\`。
- renderer 必须 append 到 mountRef.current。
- 只能替换白名单文件: src/App.tsx, src/main.tsx, src/styles.css, package.json。
- 优先只修改 src/App.tsx 和 src/styles.css。
- 场景必须自包含；不使用外部资源、网络请求、Worker、eval。
- React cleanup 中必须释放 geometry、material、renderer 和事件监听。
- 需要优先使用 OrbitControls 支持用户 360° 拖拽旋转。
- WebGLRenderer 需要开启 preserveDrawingBuffer，便于截图到 PPT。
- 建议暴露 window.__AGENTIC_THREE_VIEW__，包含 scene、camera、renderer、controls、grid、target。
- 如果显示坐标方格或地面网格，主体模型最低点必须贴在网格平面上方。
- 如果用户要求黑线白图/线稿/工程草图，必须使用白色或近白背景、黑色线条、EdgesGeometry/LineSegments/曲线轮廓，不要输出默认彩色晶体、球体或装饰圆环。
- 禁止输出默认晶体、球体或圆环占位场景。
- canvas 必须填满容器。
- 不要让场景默认自动旋转；只有用户明确要求动画时才做对象动画。
`;
}

async function finalizeFromMultimodalReasoning(
  state: AgentStateType,
  reasoning: string,
): Promise<{ text: string; usage?: Usage }> {
  if (!reasoning.trim()) {
    throw new Error("多模态 coder 返回空 content，且 reasoning 也为空，无法生成文件块。");
  }
  const modelConfig = resolveModelConfig("default", state.settings);
  const client = createModelClient(modelConfig);
  const finalizerPrompt = buildFinalizerPrompt(state, reasoning);
  logAgent("coder_agent.reasoning_finalizer_input", {
    runId: state.runId,
    model: modelConfig.model,
    reasoningLength: reasoning.length,
    promptLength: finalizerPrompt.length,
  });
  const result = await streamChatCompletion(client, {
    model: modelConfig.model,
    messages: [
      {
        role: "system",
        content:
          "你是 three.js 文件块生成器。直接输出最终文件块，不要解释推理过程。必须使用 SUMMARY/ASSISTANT/FILE 格式。",
      },
      {
        role: "user",
        content: finalizerPrompt,
      },
    ],
    temperature: Math.min(modelConfig.temperature, 0.2),
    maxTokens: Math.max(modelConfig.maxTokens, 4096),
  });
  logAgent("coder_agent.reasoning_finalizer_done", {
    runId: state.runId,
    ...result.diagnostics,
    outputPreview: previewText(result.text, 800),
  });
  if (!result.text.trim()) {
    throw new Error(
      `reasoning finalizer 未返回 content。reasoningLength=${result.reasoning.length}, finish=${result.diagnostics.finishReasons.join(",") || "unknown"}`,
    );
  }
  return {
    text: result.text,
    usage: result.usage,
  };
}

function buildFinalizerPrompt(state: AgentStateType, reasoning: string): string {
  return `多模态 coder 已经看过参考图，但模型把视觉分析写在 reasoning_content 中，没有输出正式 content。请根据下面的视觉建模草稿，生成可直接应用的 three.js 文件块。

用户目标:
${state.normalizedGoal}

视觉建模草稿:
${previewText(reasoning, 9000)}

当前可编辑文件:
${JSON.stringify(state.request.files, null, 2)}

运行错误:
${JSON.stringify(state.request.runtimeErrors, null, 2)}

只返回以下格式，不要输出其它内容:

SUMMARY:
中文补丁摘要

ASSISTANT:
中文说明

FILE: src/App.tsx
\`\`\`tsx
完整文件内容
\`\`\`

FILE: src/styles.css
\`\`\`css
完整文件内容
\`\`\`

硬性规则:
- 必须使用 three.js，不允许用纯 SVG、Canvas 2D 或 HTML 图形代替。
- 必须包含 \`import * as THREE from "three"\`。
- 必须包含 \`import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"\`。
- React 组件必须是 \`export default function App\`。
- renderer 必须 append 到 mountRef.current，并调用 renderer.render。
- WebGLRenderer 必须开启 preserveDrawingBuffer，便于截图。
- 如果用户要求黑线白图，使用白色背景、黑色 LineSegments/EdgesGeometry/曲线轮廓，尽量少用填充色。
- 不要生成默认晶体、默认球体、默认圆环占位。
- 不要自动旋转；保留 OrbitControls 让用户手动旋转。
- 只修改白名单文件: src/App.tsx, src/main.tsx, src/styles.css, package.json。
- 不要输出 JSON、diff、CODE_EDIT_BLOCK 或 Markdown 复制提示。`;
}

function mergeUsage(first?: Usage, second?: Usage): Usage | undefined {
  if (!first && !second) return undefined;
  return {
    inputTokens: (first?.inputTokens ?? 0) + (second?.inputTokens ?? 0) || undefined,
    outputTokens: (first?.outputTokens ?? 0) + (second?.outputTokens ?? 0) || undefined,
  };
}

function formatCompactSummary(summary: CompactSummary): string {
  return [
    `用户长期目标: ${summary.userGoal || "暂无"}`,
    `当前代码状态: ${summary.codeState || "暂无"}`,
    `下一步计划/约束: ${summary.nextSteps || "暂无"}`,
  ].join("\n");
}

function formatRecentHistory(history: Array<{ role: "user" | "assistant"; content: string }>): string {
  if (!history.length) return "暂无";
  return history
    .slice(-4)
    .map((item) => `${item.role === "user" ? "用户" : "助手"}: ${item.content.slice(0, 600)}`)
    .join("\n");
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

async function tryChatCompletion(
  client: OpenAI,
  modelConfig: { model: string; temperature: number; maxTokens: number },
  baseMessages: Array<{ role: "system" | "user"; content: ChatMessageContent }>,
  userContent: ChatMessageContent,
  meta: { runId: string; phase: "multimodal" | "text" | "summary" },
): Promise<{ text: string; reasoning: string; usage?: Usage; diagnostics: ChatCompletionDiagnostics }> {
  try {
    const result = await streamChatCompletion(client, {
      model: modelConfig.model,
      messages: [...baseMessages, { role: "user", content: userContent }],
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
    });
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logAgent("coder_agent.api_error", {
      runId: meta.runId,
      phase: meta.phase,
      reason,
    });
    throw new Error(`模型 API 调用失败（${meta.phase}）: ${reason}`);
  }
}
