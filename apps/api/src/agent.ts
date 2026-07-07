import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import {
  type AgentTurnRequest,
  type AppSettings,
  type CoderRevisionRequest,
  type CompactSummary,
  type PatchEvent,
  type SceneDsl,
  type StreamEvent,
  type VisualIntent,
  agentTurnRequestSchema,
  compactSummarySchema,
  patchEventSchema,
  sanitizePatch,
} from "@agentic-three/shared";
import { selectSkillContextDynamic } from "./skills.js";
import { getAppSettings, resolveModelConfig } from "./settings.js";
import { createRuntimePatchWithRag } from "./sceneRuntime.js";
import { buildCoderReferencePack, type CoderReferencePack } from "./coderReferencePack.js";
import { extractVisualIntent } from "./visualIntent.js";
import { dedupeModels, doubaoCodePreviewFallback, supportsImageInput } from "./modelCapabilities.js";
import { buildAircraftReviewChecklistInstruction, buildAircraftTargetFunctionCatalog, inferEngineModelingVariant } from "./aircraftModelingTargets.js";
import {
  streamModelCompletion,
  type ChatMessageContent,
  type ModelCompletionDiagnostics as ChatCompletionDiagnostics,
} from "./modelRuntime.js";

type Usage = { inputTokens?: number; outputTokens?: number };
function logAgent(stage: string, payload: Record<string, unknown>): void {
  console.log(`[agentic-three:agent] ${stage}`, payload);
}

function previewText(value: string, limit = 900): string {
  return value.length > limit ? `${value.slice(0, limit)}...<truncated ${value.length - limit}>` : value;
}

function isRetryLikeMessage(message: string): boolean {
  const text = message.trim();
  return !text || /^(重试|再试|继续|重新来|再来|retry|continue)$/i.test(text);
}

function recoverPreviousUserGoal(history: Array<{ role: "user" | "assistant"; content: string }>): string {
  for (const turn of [...history].reverse()) {
    if (turn.role !== "user") continue;
    const text = turn.content
      .replace(/\n?\[参考图[^\]]+\]\s*$/g, "")
      .trim();
    if (!text || isRetryLikeMessage(text)) continue;
    return text;
  }
  return "";
}

const AgentState = Annotation.Root({
  request: Annotation<AgentTurnRequest>(),
  runId: Annotation<string>(),
  settings: Annotation<AppSettings>(),
  compactSummary: Annotation<CompactSummary>(),
  recentHistory: Annotation<Array<{ role: "user" | "assistant"; content: string }>>(),
  normalizedGoal: Annotation<string>(),
  visualIntent: Annotation<VisualIntent | undefined>(),
  skillContext: Annotation<string>(),
  plan: Annotation<string>(),
  patch: Annotation<PatchEvent | undefined>(),
  scene: Annotation<SceneDsl | undefined>(),
  nextCompactSummary: Annotation<CompactSummary | undefined>(),
  reasoningSummary: Annotation<string>(),
  assistantMessage: Annotation<string>(),
  error: Annotation<string | undefined>(),
  usage: Annotation<Usage | undefined>(),
  referencePackSummary: Annotation<string>(),
});

type AgentStateType = typeof AgentState.State;

const inputNormalizer = async (state: AgentStateType) => {
  const request = agentTurnRequestSchema.parse(state.request);
  const runtime = request.runtimeErrors.map((item) => item.message).join("\n");
  const previousGoal = isRetryLikeMessage(request.message) ? recoverPreviousUserGoal(state.recentHistory) : "";
  const goalText = previousGoal
    ? `${previousGoal}\n\n本轮用户输入为“${request.message.trim() || "继续"}”，应视为基于上一轮目标和参考图重试/继续，不要把主体降级为 unknown。`
    : request.message.trim() ||
      (request.images.length ? "请根据上传图片生成或修改 three.js 场景。" : "请优化当前 three.js 场景。");
  const normalizedGoal = [
    goalText,
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

const visualIntentExtractor = async (state: AgentStateType) => {
  const visualIntent = await extractVisualIntent({
    request: state.request,
    normalizedGoal: state.normalizedGoal,
    settings: state.settings,
  });
  logAgent("visual_intent", {
    runId: state.runId,
    imageCount: state.request.images.length,
    subject: visualIntent.subject,
    category: visualIntent.category,
    view: visualIntent.view,
    renderStyle: visualIntent.renderStyle,
    confidence: visualIntent.confidence,
    modelUsed: visualIntent.modelUsed,
    fallbackReason: visualIntent.fallbackReason,
  });
  return {
    visualIntent,
    reasoningSummary: `${state.reasoningSummary}\nvisualIntent: ${visualIntent.subject} / ${visualIntent.category ?? "unknown"} / ${visualIntent.view} / ${visualIntent.renderStyle}，model=${visualIntent.modelUsed}，confidence=${visualIntent.confidence.toFixed(2)}${visualIntent.fallbackReason ? `，fallback=${visualIntent.fallbackReason}` : ""}。`,
  };
};

const contextBuilder = async (state: AgentStateType) => {
  const selection = await selectSkillContextDynamic({
    message: `${state.normalizedGoal}\n${formatVisualIntentForPrompt(state.visualIntent)}\n${state.compactSummary.codeState}\n${state.compactSummary.nextSteps}`,
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
  let runtime: Awaited<ReturnType<typeof createRuntimePatchWithRag>> | undefined;
  try {
    runtime = await createRuntimePatchWithRag(state.request, state.visualIntent);
    logAgent("runtime_renderer.patch_created", {
      runId: state.runId,
      intent: runtime.intent,
      sceneType: runtime.scene.sceneType,
      renderStyle: runtime.scene.renderStyle,
      retrievalMode: runtime.retrievalMode,
      retrievalIds: runtime.retrievalResults.map((item) => `${item.kind}:${item.id}`),
      paths: runtime.patch.operations.map((operation) => operation.path),
    });
    const referencePack = buildCoderReferencePack({
      request: state.request,
      retrievalResults: runtime.retrievalResults,
      fallbackScene: runtime.scene,
      fallbackPatch: runtime.patch,
      visualIntent: state.visualIntent,
    });
    if (shouldUseConstraintTemplateFirst(runtime)) {
      return {
        patch: { ...runtime.patch, generator: "llm_coder" as const },
        scene: runtime.scene,
        assistantMessage:
          "已使用约束驱动的 TurbofanTemplate 生成首轮 Sandpack 代码；GLB/RAG 仅作为视觉参考，核心同轴、半径、间隙关系由 AssemblyGraph/Solver 保证。",
        referencePackSummary: summarizeReferencePack(referencePack),
        reasoningSummary: `${state.reasoningSummary}\n语义解析: ${runtime.intent.subject} / ${runtime.intent.renderStyle}。\n检索: ${runtime.retrievalMode} 命中 ${runtime.retrievalResults.map((item) => item.id).join(", ") || "无"}。\nreference_pack: ${summarizeReferencePack(referencePack)}。\nconstraint_template: ${runtime.scene.assemblyGraph?.templateId ?? "assembly"} 已优先生成，跳过首轮自由 LLM coder，避免核心装配关系被写歪。`,
      };
    }
    const modelResult = await generateCoderPatchWithModel(state, runtime, referencePack).catch((error) => {
      logAgent("coder_agent.llm_failed", {
        runId: state.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
    if (modelResult) {
      return {
        patch: { ...modelResult.patch, generator: "llm_coder" as const },
        scene: runtime.scene,
        usage: modelResult.usage,
        assistantMessage:
          "已根据 RAG 命中的 GLB/源码/模板参考资料包调用 coder_agent 生成 Sandpack 代码；Runtime Composer 仅作为骨架建议和失败兜底。",
        referencePackSummary: summarizeReferencePack(referencePack),
        reasoningSummary: `${state.reasoningSummary}\n语义解析: ${runtime.intent.subject} / ${runtime.intent.renderStyle}。\n检索: ${runtime.retrievalMode} 命中 ${runtime.retrievalResults.map((item) => item.id).join(", ") || "无"}。\nreference_pack: ${summarizeReferencePack(referencePack)}。\ncoder_agent: 使用 ${modelResult.modelUsed} 生成代码 patch${modelResult.fallbackReason ? `；前序失败: ${modelResult.fallbackReason}` : ""}。`,
      };
    }
    return {
      patch: { ...runtime.patch, generator: "runtime_composer" as const },
      scene: runtime.scene,
      assistantMessage:
        "coder_agent 未能产出可用 patch，已回退到 Runtime Composer 生成的基础可预览场景。",
      referencePackSummary: summarizeReferencePack(referencePack),
      reasoningSummary: `${state.reasoningSummary}\n语义解析: ${runtime.intent.subject} / ${runtime.intent.renderStyle}。\n检索: ${runtime.retrievalMode} 命中 ${runtime.retrievalResults.map((item) => item.id).join(", ") || "无"}。\nreference_pack: ${summarizeReferencePack(referencePack)}。\nRuntime Composer fallback: ${runtime.scene.sceneType} DSL 已渲染为 Sandpack 文件。`,
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

function shouldUseConstraintTemplateFirst(runtime: RuntimeComposerResult): boolean {
  return Boolean(runtime.scene.assemblyGraph?.templateId === "turbofan_v1" && runtime.scene.solverResult?.ok);
}

type RuntimeComposerResult = Awaited<ReturnType<typeof createRuntimePatchWithRag>>;

type CoderModelResult = {
  patch: PatchEvent;
  usage?: Usage;
  modelUsed: string;
  fallbackReason?: string;
  dualCoderUsed?: boolean;
  discussionModels?: string[];
  discussionSummary?: string;
};

type CoderModelConfig = {
  model: string;
  baseURL: string;
  apiKeyEnvName: string;
  temperature: number;
  maxTokens: number;
};

type CoderCompletionRunner = (
  config: CoderModelConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }>,
) => Promise<{ text: string; reasoning: string; usage?: Usage; diagnostics?: ChatCompletionDiagnostics }>;

async function generateCoderPatchWithModel(
  state: AgentStateType,
  runtime: RuntimeComposerResult,
  referencePack: CoderReferencePack,
): Promise<CoderModelResult | undefined> {
  if (shouldSkipExternalCoderCall()) return undefined;
  const messages = buildCoderMessages(state, runtime, referencePack);
  const configs = resolveCoderModelFallbackConfigs(state.settings);
  return generateCoderPatchFromConfigs({
    runId: state.runId,
    configs,
    messages,
  });
}

export async function generateCoderPatchFromConfigs(input: {
  runId?: string;
  configs: CoderModelConfig[];
  messages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }>;
  runner?: CoderCompletionRunner;
}): Promise<CoderModelResult | undefined> {
  const failures: string[] = [];
  const runner = input.runner ?? defaultCoderCompletionRunner;
  for (const modelConfig of input.configs) {
    try {
      logAgent("coder_agent.llm_request", {
        runId: input.runId,
        model: modelConfig.model,
        baseURL: modelConfig.baseURL,
      });
      const { text, reasoning, usage, diagnostics } = await runner(modelConfig, input.messages);
      const outputText = text.trim() ? text : reasoning;
      if (!outputText.trim()) throw new Error("模型返回为空");
      logAgent("coder_agent.llm_response", {
        runId: input.runId,
        model: modelConfig.model,
        textLength: outputText.length,
        reasoningLength: reasoning.length,
        diagnostics,
      });
      const patch = sanitizePatch(parseCoderPatch(outputText));
      return {
        patch,
        usage,
        modelUsed: modelConfig.model,
        fallbackReason: failures.length ? failures.join(" | ") : undefined,
      };
    } catch (error) {
      const reason = `${modelConfig.model}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(reason);
      logAgent("coder_agent.model_failed", {
        runId: input.runId,
        model: modelConfig.model,
        error: reason,
      });
    }
  }
  return undefined;
}

export async function reviseCoderPatchWithModel(input: {
  request: CoderRevisionRequest;
  settings: AppSettings;
}): Promise<CoderModelResult | undefined> {
  if (shouldSkipExternalCoderCall()) return undefined;
  if (shouldUseDualCoder(input.request)) {
    return reviseCoderPatchWithDualCoder(input);
  }
  const configs = resolveCoderModelFallbackConfigs(input.settings);
  const result = await generateCoderPatchFromConfigs({
    runId: input.request.runId,
    configs,
    messages: buildCoderRevisionMessages(input.request),
  });
  if (!result) return undefined;
  try {
    validateRevisionPatchPolicy(input.request, result.patch);
    return result;
  } catch (error) {
    return reviseCoderPatchWithDualCoder({
      request: {
        ...input.request,
        dualCoderRequested: true,
        dualCoderReason: `普通 coder 违反微调策略: ${error instanceof Error ? error.message : String(error)}`,
      },
      settings: input.settings,
    });
  }
}

function shouldUseDualCoder(request: CoderRevisionRequest): boolean {
  if (request.dualCoderRequested) return true;
  if (request.repairAttempt >= 2) return true;
  return hasThreeConsecutiveCandidateScoreDrops(request.qualityHistory);
}

export function hasThreeConsecutiveCandidateScoreDrops(history: CoderRevisionRequest["qualityHistory"]): boolean {
  const scored = history
    .filter((entry) => typeof (entry.candidateScore ?? entry.score) === "number")
    .map((entry) => entry.candidateScore ?? entry.score ?? 0);
  if (scored.length < 4) return false;
  const recent = scored.slice(-4);
  return recent[1]! < recent[0]! && recent[2]! < recent[1]! && recent[3]! < recent[2]!;
}

async function reviseCoderPatchWithDualCoder(input: {
  request: CoderRevisionRequest;
  settings: AppSettings;
}): Promise<CoderModelResult | undefined> {
  const primary = resolveModelConfig("coder_agent", input.settings);
  const primaryResult = await generateCoderPatchFromConfigs({
    runId: input.request.runId,
    configs: [primary],
    messages: buildCoderRevisionMessages(input.request),
  });
  const doubao = doubaoCodePreviewFallback(primary);
  const discussionReason =
    input.request.dualCoderReason ||
    (input.request.repairAttempt >= 2
      ? `连续 ${input.request.repairAttempt} 次运行错误修复未稳定`
      : hasThreeConsecutiveCandidateScoreDrops(input.request.qualityHistory)
        ? "连续 3 个有效质检轮候选分下降"
        : "显式请求双 coder 会诊");
  const discussionMessages = buildDualCoderRevisionMessages(input.request, primaryResult, discussionReason);
  const doubaoResult = await generateCoderPatchFromConfigs({
    runId: input.request.runId,
    configs: [doubao],
    messages: discussionMessages,
  });
  const result = selectPolicyValidCoderResult(input.request, [doubaoResult, primaryResult]);
  if (!result) return undefined;
  return {
    ...result,
    dualCoderUsed: true,
    discussionModels: [primary.model, doubao.model],
    discussionSummary: [
      `触发原因: ${discussionReason}`,
      primaryResult ? `主 coder 草案: ${primaryResult.patch.summary}` : "主 coder 未产出可解析草案",
      doubaoResult ? `Doubao 会诊采用: ${doubaoResult.patch.summary}` : "Doubao 未产出可解析 patch，回退采用主 coder 草案",
    ].join("；"),
    fallbackReason: [result.fallbackReason, primaryResult?.fallbackReason, doubaoResult?.fallbackReason].filter(Boolean).join(" | ") || undefined,
  };
}

function selectPolicyValidCoderResult(
  request: CoderRevisionRequest,
  candidates: Array<CoderModelResult | undefined>,
): CoderModelResult | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      validateRevisionPatchPolicy(request, candidate.patch);
      return candidate;
    } catch (error) {
      logAgent("coder_agent.patch_policy_rejected", {
        runId: request.runId,
        model: candidate.modelUsed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return undefined;
}

function validateRevisionPatchPolicy(request: CoderRevisionRequest, patch: PatchEvent): void {
  if (!requiresParameterPatchOnly(request)) return;
  const illegal = patch.operations.find((operation) => operation.type !== "parameter_patch");
  if (illegal) {
    throw new Error(
      `当前模型已有可渲染雏形，本轮只允许 parameter_patch 微调参数，拒绝 ${illegal.type}，避免越改越不像。`,
    );
  }
}

function requiresParameterPatchOnly(request: CoderRevisionRequest): boolean {
  if (request.runtimeErrors.length) return false;
  if (request.repairAttempt > 0) return false;
  if (request.quality.modelUsed === "render-health-guard") return false;
  if (request.quality.scores.renderHealth < 0.7) return false;
  const candidate = request.quality.candidateScore ?? request.quality.score;
  if (candidate < 0.45) return false;
  const text = [
    ...request.quality.issues,
    ...request.quality.revisionHints,
    ...request.quality.checks.filter((check) => !check.pass).map((check) => `${check.item} ${check.note} ${check.suggestedFix}`),
  ].join("\n");
  if (/空白|未渲染|运行错误|截图失败|主体.*缺失|核心.*缺失|无法看到|不存在性|完整性.*0/i.test(text)) return false;
  return true;
}

export function resolveCoderModelFallbackConfigs(settings: AppSettings): CoderModelConfig[] {
  const primary = resolveModelConfig("coder_agent", settings);
  const fallbackMaxTokens = primary.maxTokens;
  const coderModels = [primary, doubaoCodePreviewFallback(primary)].map((model) => ({
    ...model,
    maxTokens: Math.max(fallbackMaxTokens, model.maxTokens),
    temperature: primary.temperature,
  }));
  return dedupeModels(coderModels);
}

function buildCoderRevisionMessages(request: CoderRevisionRequest): Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }> {
  const failedChecks = request.quality.checks.filter((check) => !check.pass);
  const targetFunctions = summarizeFailedChecksByFunction(failedChecks);
  const engineVariant = inferEngineModelingVariant(`${request.userGoal}\n${request.quality.issues.join("\n")}\n${request.quality.revisionHints.join("\n")}`);
  const engineTargetInstruction = buildAircraftReviewChecklistInstruction("engine", request.userGoal);
  const text = [
    "# Task",
    "继续修正当前 Sandpack three.js 代码。不要回退到 Runtime Composer，不要生成示例模型。",
    "",
    "# User Goal",
    request.userGoal || "按参考图改进当前 3D 模型。",
    "",
    "# Quality Report",
    `round=${request.round}`,
    `status=${request.quality.status}`,
    `score=${request.quality.score}`,
    `candidateScore=${request.quality.candidateScore ?? "unknown"}`,
    `matchedReferenceView=${request.quality.matchedReferenceView ?? "unknown"}`,
    `scores=${JSON.stringify(request.quality.scores, null, 2)}`,
    `modelUsed=${request.quality.modelUsed ?? "unknown"}`,
    `issues=${request.quality.issues.join("；") || "无"}`,
    `failedChecks=${JSON.stringify(failedChecks, null, 2)}`,
    `featureMatches=${JSON.stringify(request.quality.featureMatches, null, 2)}`,
    `constraintStatus=${request.quality.constraintStatus}`,
    `constraintResiduals=${JSON.stringify(request.quality.constraintResiduals, null, 2)}`,
    `constraintChecks=${JSON.stringify(request.quality.constraintChecks, null, 2)}`,
    `targetFunctions=${JSON.stringify(targetFunctions, null, 2)}`,
    `viewResults=${JSON.stringify(request.quality.viewResults.map((view) => ({
      view: view.view,
      scores: view.scores,
      featurePoints: view.featurePoints,
      featureMatches: view.featureMatches,
      failedChecks: view.checks.filter((check) => !check.pass),
      issues: view.issues,
    })), null, 2)}`,
    `structuredIssues=${JSON.stringify(request.quality.structuredIssues, null, 2)}`,
    `revisionHints=${request.quality.revisionHints.join("；") || "无"}`,
    `qualityHistory=${JSON.stringify(request.qualityHistory, null, 2)}`,
    `bestRound=${JSON.stringify(request.bestRound ?? null, null, 2)}`,
    `repairAttempt=${request.repairAttempt}`,
    `dualCoderRequested=${request.dualCoderRequested}`,
    `dualCoderReason=${request.dualCoderReason || "无"}`,
    "",
    "# Required Fix Strategy",
    "- 保留当前可运行结构，优先只改参数，不要一上来重写构造函数。",
    "- 如果 Runtime Errors 非空，必须先修复运行错误，再谈视觉相似度。",
    "- 如果 modelUsed=render-health-guard，本轮是运行健康修复模式：只修编译/运行/截图钩子错误，禁止顺手重构叶片、材质、相机审美或整体模型。",
    "- 运行健康修复模式优先输出最小 replace_function；只有全局初始化被破坏且无法定位函数时才允许 replace_file。",
    "- 修复 ReferenceError/TypeError 时必须保留当前视觉结构，不能把用户模型换成新的示例实现。",
    "- 若出现 Cannot access 'x' before initialization / ReferenceError，说明变量在 const/let 初始化前被使用；必须重排声明顺序或改成先声明后使用。",
    "- 禁止生成会导致截图超时的代码；必须保证 renderer 初始化、appendChild、render loop 和 __AGENTIC_THREE_VIEW__ 都稳定存在。",
    "- 优先逐条修复 failedChecks；每个 failedCheck 都代表视觉 review 的具体扣分点。",
    "- 如果 featureMatches 里某些关键点未匹配或 distance 高，优先按 suggestedParameter 输出 parameter_patch 微调，不要重写整体构造。",
    "- 首选输出 parameter_patch 调整 bladeCount/hubRadius/tipRadius/bladeThickness/bladeTwist/bladeSweep/bladePitch/metalness/roughness/cameraDistance/cameraFov 等参数。",
    "- 如果 constraintStatus=revise 或 constraintChecks 有失败，必须先修 assembly/template 参数、ports/features 或对应局部 mesh 函数；不要通过自由改 position/rotation 硬凑。",
    "- 必须优先参考 targetFunctions；如果某个 failedCheck 带 targetFunction，默认只替换该函数。",
    "- 如果多个 failedChecks 指向同一个 targetFunction，把这些问题合并到一个 replace_function 中修复。",
    "- 输出 replace_function 前必须确认 Current Files 中真的存在同名函数；不存在时禁止输出 replace_function，必须改用 replace_file 重构一次。",
    "- 不要为了修正 buildFanBlades 去重写 setupLighting；除非对应失败项明确指向该函数。",
    "- 修改时必须说明本轮 summary 对应哪些失败维度，例如 geometry/viewMatch/referenceSimilarity。",
    "- 默认使用 parameter_patch；如果参数补丁无法表达，再使用函数级补丁 replace_function，只替换出问题的构建函数，例如 buildFanBlades/buildSpinner/buildOuterRing/setupLighting。",
    "- 只有当前代码结构已经无法定位目标函数、或 Runtime Errors 指向全局初始化问题时，才允许 replace_file 全文替换。",
    "- 如果当前代码没有可替换函数，本轮可以 replace_file 重构一次，但必须按下面的航空函数目录拆出稳定函数，后续轮次用于函数级修正。",
    "",
    "# Aircraft Target Function Catalog",
    buildAircraftTargetFunctionCatalog(),
    "",
    "# Engine-Specific Constraints",
    `- engineVariant=${engineVariant}。必须按该目标类型修正，不要把开放式叶盘和带涵道涡扇混为一类。`,
    engineTargetInstruction,
    "- 如果目标是 open_blisk/叶盘/叶轮/扇叶盘：禁止为了“像发动机”而强行增加大外环、笼状圆圈或完整 nacelle；优先修中心轮毂/中心孔/螺栓孔、曲面叶片、叶片金属材质和三维厚度。",
    "- 如果目标是 ducted_turbofan/整机/进气口：才需要表现中心圆锥 spinner、轮毂、外圈/机匣、沿径向排布的曲面叶片。",
    "- 叶片不能只是薄黑三角片；应有宽度、厚度、弯曲/扭转、前后缘，并能从侧面看出曲形截面。",
    "- 参考图里若有侧面/背面，请用当前截图对比，调整叶片 pitch、sweep、twist、root/tip 宽度和金属高光。",
    "- 不要直接加载命中的 GLB/图片作为成品；用 three.js procedural geometry 表达结构。",
    "- 输出只允许合法 JSON patch，默认替换 src/App.tsx 和 src/styles.css。",
    "",
    "# Output JSON Schema",
    '{"summary":"说明本轮按质检修正了什么","operations":[{"type":"parameter_patch","path":"src/App.tsx","parameters":{"bladeThickness":0.09,"bladeTwist":1.1},"targetFunction":"buildTurbofanFront","reason":"按特征点匹配微调叶片厚度和扭转"}]}',
    "如果参数补丁不足，才输出: {\"type\":\"replace_function\",\"path\":\"src/App.tsx\",\"functionName\":\"buildFanBlades\",\"content\":\"完整函数代码\"}",
    "如果必须全文替换，才输出: {\"type\":\"replace_file\",\"path\":\"src/App.tsx\",\"content\":\"完整文件内容\"}",
    "",
    "# Current Files",
    `Existing src/App.tsx functions=${JSON.stringify(listFunctionsInSource(request.files["src/App.tsx"] ?? ""))}`,
    formatCurrentFilesForPrompt(request.files),
    "",
    "# Runtime Errors",
    request.runtimeErrors.length
      ? request.runtimeErrors.map((error) => `${error.message}\n${error.stack ?? ""}`).join("\n---\n")
      : "无",
    "",
    "# Images",
    `附带 ${request.referenceImages.length} 张用户参考图和 ${request.screenshots.length} 张当前预览截图。请直接比较它们并改代码。`,
  ].join("\n");
  const content: ChatMessageContent = [
    { type: "text", text },
    ...request.referenceImages.slice(0, 3).flatMap((image) => [
      { type: "text" as const, text: `用户参考图: ${image.name}` },
      { type: "image_url" as const, image_url: { url: image.dataUrl } },
    ]),
    ...request.screenshots.slice(0, 2).flatMap((screenshot) => [
      { type: "text" as const, text: `当前预览截图: ${screenshot.view}` },
      { type: "image_url" as const, image_url: { url: screenshot.dataUrl } },
    ]),
  ];
  return [
    {
      role: "system",
      content: [
        "你是 coder_agent 的代码修正模式。你必须根据参考图、当前截图和质检报告直接改 Sandpack three.js 代码。",
        "只输出 JSON，不要 Markdown，不要解释。禁止加载 GLB/外部图片作为成品。",
      ].join("\n"),
    },
    { role: "user", content },
  ];
}

function buildDualCoderRevisionMessages(
  request: CoderRevisionRequest,
  primaryResult: CoderModelResult | undefined,
  discussionReason: string,
): Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }> {
  const failedChecks = request.quality.checks.filter((check) => !check.pass);
  const text = [
    "# Dual Coder Review",
    "你是第二 coder（Doubao code reviewer + fixer）。当前单 coder 修正已经不稳定，你需要会诊而不是自由创作。",
    "",
    "# Trigger",
    discussionReason,
    "",
    "# Non-Negotiable Rules",
    "- 先保护 bestRound 和当前可运行结构；不要把模型重写成另一个示例。",
    "- 优先输出 parameter_patch，只改 bladeCount/hubRadius/tipRadius/bladeThickness/bladeTwist/bladeSweep/bladePitch/metalness/roughness/camera 参数。",
    "- 参数无法表达时才 replace_function；只替换目标函数。",
    "- 只有运行健康完全破坏或目标函数不存在时才 replace_file。",
    "- 如果主 coder 草案会造成截断函数、重复声明、孤立 `): THREE.Mesh {`、未闭合括号或全文振荡，必须拒绝并输出更小 patch。",
    "- 输出必须是最终可应用 JSON patch，不要 Markdown，不要解释。",
    "",
    "# User Goal",
    request.userGoal || "按参考图改进当前 3D 模型。",
    "",
    "# Current Quality",
    `round=${request.round}`,
    `score=${request.quality.score}`,
    `candidateScore=${request.quality.candidateScore ?? "unknown"}`,
    `scores=${JSON.stringify(request.quality.scores, null, 2)}`,
    `failedChecks=${JSON.stringify(failedChecks, null, 2)}`,
    `featureMatches=${JSON.stringify(request.quality.featureMatches, null, 2)}`,
    `constraintChecks=${JSON.stringify(request.quality.constraintChecks, null, 2)}`,
    `revisionHints=${request.quality.revisionHints.join("；") || "无"}`,
    "",
    "# Quality History",
    JSON.stringify(request.qualityHistory, null, 2),
    "",
    "# Best Round To Preserve",
    JSON.stringify(request.bestRound ?? null, null, 2),
    "",
    "# Runtime Errors",
    request.runtimeErrors.length
      ? request.runtimeErrors.map((error) => `${error.message}\n${error.stack ?? ""}`).join("\n---\n")
      : "无",
    "",
    "# Primary Coder Draft",
    primaryResult
      ? JSON.stringify({
          modelUsed: primaryResult.modelUsed,
          summary: primaryResult.patch.summary,
          operations: primaryResult.patch.operations.map((operation) => ({
            ...operation,
            content: "content" in operation && typeof operation.content === "string" ? clipPrompt(operation.content, 1800) : undefined,
          })),
        }, null, 2)
      : "主 coder 没有产出可解析 patch。你必须基于当前代码给出最小可运行修复。",
    "",
    "# Current Files",
    `Existing src/App.tsx functions=${JSON.stringify(listFunctionsInSource(request.files["src/App.tsx"] ?? ""))}`,
    formatCurrentFilesForPrompt(request.files),
    "",
    "# Output JSON Schema",
    '{"summary":"双 coder 会诊后采用的最小修正","operations":[{"type":"parameter_patch","path":"src/App.tsx","parameters":{"bladeThickness":0.1},"targetFunction":"buildFanBlades","reason":"避免全文重写，只修叶片厚度"}]}',
  ].join("\n");
  const content: ChatMessageContent = [
    { type: "text", text },
    ...request.referenceImages.slice(0, 3).flatMap((image) => [
      { type: "text" as const, text: `用户参考图: ${image.name}` },
      { type: "image_url" as const, image_url: { url: image.dataUrl } },
    ]),
    ...request.screenshots.slice(0, 2).flatMap((screenshot) => [
      { type: "text" as const, text: `当前预览截图: ${screenshot.view}` },
      { type: "image_url" as const, image_url: { url: screenshot.dataUrl } },
    ]),
  ];
  return [
    {
      role: "system",
      content: [
        "你是双 coder 会诊里的 Doubao 第二 coder。你的职责是阻止越修越坏，并输出最终可应用 JSON patch。",
        "只输出 JSON，不要 Markdown。优先参数级/函数级最小修改，避免全文振荡。",
      ].join("\n"),
    },
    { role: "user", content },
  ];
}

function listFunctionsInSource(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) {
    if (match[1]) names.add(match[1]);
  }
  return Array.from(names).sort();
}

function summarizeFailedChecksByFunction(checks: CoderRevisionRequest["quality"]["checks"]): Record<string, Array<Record<string, string>>> {
  const grouped: Record<string, Array<Record<string, string>>> = {};
  for (const check of checks) {
    const target = check.targetFunction;
    if (!target) continue;
    grouped[target] ??= [];
    grouped[target]!.push({
      view: check.view ?? "unknown",
      dimension: check.dimension,
      item: check.item,
      severity: check.severity,
      note: check.note,
      suggestedFix: check.suggestedFix,
    });
  }
  return grouped;
}

async function defaultCoderCompletionRunner(
  modelConfig: CoderModelConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }>,
): Promise<{ text: string; reasoning: string; usage?: Usage; diagnostics?: ChatCompletionDiagnostics }> {
  const effectiveMessages = supportsImageInput(modelConfig) ? messages : stripImageInputs(messages);
  try {
    return await streamModelCompletion(modelConfig, effectiveMessages);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!/support image input|image input|image_url/i.test(reason)) throw error;
    return streamModelCompletion(modelConfig, stripImageInputs(messages));
  }
}

export function buildCoderMessages(
  state: Pick<
    AgentStateType,
    "request" | "normalizedGoal" | "visualIntent" | "compactSummary" | "recentHistory" | "skillContext" | "plan"
  >,
  runtime: RuntimeComposerResult,
  referencePack: CoderReferencePack,
): Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }> {
  const userText = buildCoderPromptText(state, runtime, referencePack);
  const content: ChatMessageContent = [
    { type: "text", text: userText },
    ...state.request.images.map((image) => ({
      type: "image_url" as const,
      image_url: { url: image.dataUrl },
    })),
  ];
  return [
    {
      role: "system",
      content: [
        "你是 coder_agent，一个真正编写 Sandpack three.js/React 代码的工程师。",
        "你必须读取 RAG reference pack 中的相似 GLB/源码/模板特征，把它们转译为可运行代码。",
        "禁止直接加载命中的 GLB/图片作为成品；禁止整段复制外部源码；只能输出合法 JSON patch。",
        "输出必须是 JSON，不要 Markdown，不要解释。",
      ].join("\n"),
    },
    { role: "user", content },
  ];
}

export function buildCoderPromptText(
  state: Pick<
    AgentStateType,
    "request" | "normalizedGoal" | "visualIntent" | "compactSummary" | "recentHistory" | "skillContext" | "plan"
  >,
  runtime: RuntimeComposerResult,
  referencePack: CoderReferencePack,
): string {
  const engineVariant = inferEngineModelingVariant(`${state.normalizedGoal}\n${formatVisualIntentForPrompt(state.visualIntent)}`);
  return [
    "# Task",
    state.normalizedGoal,
    "",
    "# Planner",
    state.plan,
    "",
    "# Visual Intent",
    formatVisualIntentForPrompt(state.visualIntent),
    "",
    "# Hard Constraints",
    "- 只修改白名单文件: src/App.tsx, src/styles.css, src/main.tsx, package.json。",
    "- 默认修改 src/App.tsx 和 src/styles.css；package.json 只有确实需要 three/react 依赖时才改。",
    "- src/App.tsx 必须 export default function App，并创建 THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })。",
    "- 必须调用 renderer.render(scene, camera)，并设置 window.__AGENTIC_THREE_VIEW__ 供截图和多视角质检使用。",
    "- 参考 RAG 结果的结构/骨架/源码模式，但不要直接加载命中的 GLB，也不要修改 GLB。",
    "- 如果用户上传图片，要把图片当视觉需求来源；结合 reference pack 的相似领域资产写出接近图片的建模代码。",
    "- 如果 Scene DSL 带 assemblyGraph/solverResult，核心部件位置必须服从 solver 结果；不要自由摆放 spinner/hub/bladeArray/outerRing。",
    `- Engine target variant: ${engineVariant}。open_blisk 表示开放式叶盘/叶轮，不要强行生成大外环或完整涵道；ducted_turbofan 才需要外环/机匣/进气口。`,
    "- 工程黑线白图优先使用白底、黑色线框、EdgesGeometry/LineSegments/Torus/Cylinder/Sphere/Shape 等可控 primitive。",
    "- 航空部件代码必须拆成稳定构建函数，函数命名优先使用下面的 Aircraft Target Function Catalog，便于后续视觉 review 精确函数级修正。",
    "- 首轮完整代码必须至少包含 createScene/setupCamera/setupLighting/buildMaterials，以及当前部件相关的 build* 几何函数。",
    "",
    "# Aircraft Target Function Catalog",
    buildAircraftTargetFunctionCatalog(state.visualIntent?.category),
    "",
    "# Output JSON Schema",
    '{"summary":"一句话说明修改","operations":[{"path":"src/App.tsx","content":"完整文件内容"},{"path":"src/styles.css","content":"完整文件内容"}]}',
    "",
    "# Current Files",
    formatCurrentFilesForPrompt(state.request.files),
    "",
    "# Runtime Errors",
    state.request.runtimeErrors.length
      ? state.request.runtimeErrors.map((error) => `${error.message}\n${error.stack ?? ""}`).join("\n---\n")
      : "无",
    "",
    "# Compact Memory",
    formatCompactSummary(state.compactSummary),
    "",
    "# Recent History",
    state.recentHistory.slice(-6).map((item) => `${item.role}: ${clipPrompt(item.content, 600)}`).join("\n") || "无",
    "",
    "# Skill Context",
    clipPrompt(state.skillContext || "无", 5000),
    "",
    referencePack.markdown,
    "",
    "# Runtime Composer Fallback Context",
    `intent: ${runtime.intent.subject} / ${runtime.intent.renderStyle}`,
    `scene: ${runtime.scene.sceneType} / ${runtime.scene.cameraPreset}`,
    `retrieval: ${runtime.retrievalMode} ${runtime.retrievalResults.map((item) => `${item.kind}:${item.id}`).join(", ") || "none"}`,
    "Runtime fallback 只是兜底骨架。你应输出自己的可运行 Sandpack patch，并尽量体现 reference pack 的领域结构特征。",
  ].join("\n");
}

function parseCoderPatch(text: string): PatchEvent {
  try {
    const parsed = parseJsonObject<{
      type?: string;
      summary?: string;
      files?: Record<string, string>;
      operations?: Array<{
        type?: string;
        path?: string;
        content?: string;
        functionName?: string;
        targetFunction?: string;
        parameters?: Record<string, number | string | boolean>;
        reason?: string;
      }>;
    }>(text);
    const operations =
      parsed.operations?.map((operation) => {
        if (operation.type === "parameter_patch") {
          return {
            type: "parameter_patch" as const,
            path: operation.path,
            parameters: operation.parameters,
            targetFunction: operation.targetFunction,
            reason: operation.reason,
          };
        }
        return {
          type: operation.type === "replace_function" ? "replace_function" as const : "replace_file" as const,
          path: operation.path,
          functionName: operation.functionName,
          content: operation.content,
        };
      }) ??
      Object.entries(parsed.files ?? {}).map(([path, content]) => ({
        type: "replace_file" as const,
        path,
        content,
      }));
    return patchEventSchema.parse({
      type: "patch",
      summary: parsed.summary || "coder_agent 根据 RAG reference pack 生成 three.js 场景。",
      operations,
    });
  } catch (error) {
    const codePatch = parseCoderCodeFallback(text);
    if (codePatch) return codePatch;
    throw error;
  }
}

function parseCoderCodeFallback(text: string): PatchEvent | undefined {
  const app = extractCodeBlock(text, ["tsx", "ts", "jsx", "js"]) || (text.includes("export default function App") ? text : "");
  if (!app || !app.includes("export default function App")) return undefined;
  const css = extractCodeBlock(text, ["css"]) || `html, body, #root {
  width: 100%;
  height: 100%;
  margin: 0;
}

canvas {
  display: block;
}
`;
  return patchEventSchema.parse({
    type: "patch",
    summary: "coder_agent 返回了源码而非 JSON，已自动包装为 Sandpack patch。",
    operations: [
      { type: "replace_file", path: "src/App.tsx", content: app.trim() },
      { type: "replace_file", path: "src/styles.css", content: css.trim() },
    ],
  });
}

function extractCodeBlock(text: string, languages: string[]): string {
  const pattern = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const language = match[1]?.toLowerCase() ?? "";
    const content = match[2] ?? "";
    if (languages.includes(language) || (!language && content.includes("export default function App"))) return content;
  }
  return "";
}

function stripImageInputs(messages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }>) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content
        .filter((part) => part.type === "text")
        .concat([{ type: "text" as const, text: "\n[图片输入已因当前模型接口不支持而省略；请根据 Visual Intent 和 Reference Pack 继续写代码。]" }]),
    };
  });
}

function summarizeReferencePack(pack: CoderReferencePack): string {
  return `reference pack ${pack.itemCount} 项(model ${pack.modelAssetCount}, source ${pack.sourceAssetCount}, template/wiki ${pack.templateCount})，${pack.markdown.length} 字符`;
}

function formatCurrentFilesForPrompt(files: Record<string, string>): string {
  const preferred = ["src/App.tsx", "src/styles.css", "src/main.tsx", "package.json"];
  return preferred
    .filter((path) => typeof files[path] === "string")
    .map((path) => `## ${path}\n\`\`\`\n${clipPrompt(files[path] ?? "", path === "src/App.tsx" ? 6500 : 2200)}\n\`\`\``)
    .join("\n\n");
}

function clipPrompt(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]` : value;
}

function shouldSkipExternalCoderCall(): boolean {
  return (process.env.VITEST === "true" || process.env.NODE_ENV === "test") && process.env.ENABLE_LLM_TESTS !== "1";
}

const safetyReview = async (state: AgentStateType) => {
  if (state.error) return {};
  if (!state.patch) {
    return { error: "Agent 没有生成补丁。" };
  }
  try {
    const patch = sanitizePatch(state.patch);
    return {
      patch,
      reasoningSummary: `${state.reasoningSummary}\nsafety_review: 补丁通过了路径白名单和危险 API 检查。`,
    };
  } catch (error) {
    return {
      patch: undefined,
      assistantMessage:
        "这轮没有应用补丁，因为生成结果没有通过安全审查。当前代码已保留，避免用无关默认场景覆盖你的需求。",
      reasoningSummary: `${state.reasoningSummary}\nsafety_review: 已拒绝不安全补丁，未输出通用 fallback。`,
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
  .addNode("visual_intent_extractor", visualIntentExtractor)
  .addNode("context_builder", contextBuilder)
  .addNode("planner_agent", plannerAgent)
  .addNode("coder_agent", coderAgent)
  .addNode("safety_review", safetyReview)
  .addNode("patch_emitter", patchEmitter)
  .addNode("context_compactor", contextCompactor)
  .addEdge(START, "input_normalizer")
  .addEdge("input_normalizer", "visual_intent_extractor")
  .addEdge("visual_intent_extractor", "context_builder")
  .addEdge("context_builder", "planner_agent")
  .addEdge("planner_agent", "coder_agent")
  .addEdge("coder_agent", "safety_review")
  .addEdge("safety_review", "patch_emitter")
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
    visualIntent: undefined,
    skillContext: "",
    plan: "",
    patch: undefined,
    scene: undefined,
    nextCompactSummary: undefined,
    reasoningSummary: "",
    assistantMessage: "",
    error: undefined,
    usage: undefined,
    referencePackSummary: "",
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
      message: `coder_agent 收到 ${result.request.images.length} 张图片，上下文 ${runtimeContextLength} 字符，skills ${result.skillContext.length} 字符，visualIntent ${result.visualIntent?.modelUsed ?? "未生成"}:${result.visualIntent?.category ?? "unknown"}:${result.visualIntent?.confidence.toFixed(2) ?? "0.00"}，${result.referencePackSummary || "reference pack 未生成"}。`,
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
    `视觉意图: ${formatVisualIntentForPrompt(state.visualIntent)}`,
    `压缩记忆: ${formatCompactSummary(state.compactSummary)}`,
    `执行计划: ${state.plan}`,
    `技能上下文字符数: ${state.skillContext.length}`,
    `运行错误数: ${state.request.runtimeErrors.length}`,
    `文件摘要:\n${summarizeFiles(state.request.files)}`,
  ].join("\n\n");
}

function formatVisualIntentForPrompt(intent: VisualIntent | undefined): string {
  if (!intent) return "未生成";
  return [
    `subject=${intent.subject}`,
    `category=${intent.category ?? "unknown"}`,
    `view=${intent.view}`,
    `renderStyle=${intent.renderStyle}`,
    `retrievalQuery=${intent.retrievalQuery || "(empty)"}`,
    `visualFeatures=${intent.visualFeatures.join("；") || "无"}`,
    `geometryHints=${intent.geometryHints.join("；") || "无"}`,
    `materialHints=${intent.materialHints.join("；") || "无"}`,
    `codeHints=${intent.codeHints.join("；") || "无"}`,
    `modelUsed=${intent.modelUsed}`,
    `confidence=${intent.confidence.toFixed(2)}`,
    intent.fallbackReason ? `fallbackReason=${intent.fallbackReason}` : "",
  ].filter(Boolean).join("\n");
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
  const { text } = await streamModelCompletion(modelConfig, [
      { role: "system", content: "你是上下文压缩模块。只输出合法 JSON，不输出解释。" },
      { role: "user", content: prompt },
  ]);
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
