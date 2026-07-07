import {
  type AppSettings,
  type AircraftAssetCategory,
  type AssemblyConstraintCheck,
  type QualityCheckItem,
  type QualityIssue,
  type QualityInspectionRequest,
  type QualityInspectionResult,
  type QualityReviewView,
  type QualityScores,
  type QualityViewResult,
  type RuntimeComposerConfig,
  type SceneDsl,
  type ScenePatch,
  type SceneRevisionRequest,
  type SceneRevisionResult,
  type VisionReviewModelConfig,
  qualityInspectionRequestSchema,
  qualityInspectionResultSchema,
  qualityCheckItemSchema,
  visualFeatureMatchSchema,
  visualFeaturePointSchema,
  runtimeComposerConfigSchema,
  sceneRevisionRequestSchema,
  sceneRevisionResultSchema,
  sceneDslSchema,
  scenePatchSchema,
} from "@agentic-three/shared";
import { getAppSettings, resolveModelConfig } from "./settings.js";
import { appendExpensiveVisionFallback, dedupeModels, supportsImageInput } from "./modelCapabilities.js";
import {
  buildAircraftReviewChecklistInstruction,
  inferEngineModelingVariant,
  inferAircraftTargetFunctionFromText,
} from "./aircraftModelingTargets.js";
import { verifyAssemblyConstraints } from "./assembly.js";
import { streamModelCompletion, type ChatMessageContent } from "./modelRuntime.js";
import { compareReferenceAndScreenshots } from "./visualEmbedding.js";

export async function inspectQuality(input: unknown, settings: AppSettings): Promise<QualityInspectionResult> {
  const request = qualityInspectionRequestSchema.parse(input);
  const config = runtimeComposerConfigSchema.parse(settings.runtimeComposer);
  const modelResult = await inspectWithVisionModel(request, settings).catch((error) => {
    console.warn("[agentic-three:quality] vision inspection fallback", error instanceof Error ? error.message : error);
    return undefined;
  });
  const inspected = modelResult ?? downgradeHeuristicWhenVisionRequired(request, inspectWithHeuristics(request));
  const embeddingEnhanced = await addEmbeddingSimilarity(request, inspected).catch((error) => {
    console.warn("[agentic-three:quality] visual embedding similarity fallback", error instanceof Error ? error.message : error);
    return inspected;
  });
  const verified = addConstraintVerification(request, addRuleVerification(request, embeddingEnhanced));
  return superviseQuality(verified, config, request);
}

function downgradeHeuristicWhenVisionRequired(
  request: QualityInspectionRequest,
  result: QualityInspectionResult,
): QualityInspectionResult {
  if (!request.referenceImages.length) return result;
  const problem = "有参考图时视觉模型未完成质检，本地启发式不能判断是否像参考图。";
  const scores = withOverall({
    ...result.scores,
    referenceSimilarity: Math.min(result.scores.referenceSimilarity, 0.35),
    geometry: Math.min(result.scores.geometry, 0.55),
    viewMatch: Math.min(result.scores.viewMatch, 0.55),
    material: Math.min(result.scores.material, 0.55),
    renderHealth: result.scores.renderHealth,
  });
  const check: QualityCheckItem = {
    dimension: "referenceSimilarity",
    item: "参考图视觉相似度必须由多模态模型判断",
    pass: false,
    confidence: 1,
    note: problem,
    severity: "critical",
    suggestedFix: "恢复视觉模型质检后再决定是否通过；当前只能继续 coder 修正或标记 fallback。",
    targetFunction: "createScene",
  };
  return qualityInspectionResultSchema.parse({
    ...result,
    status: "revise",
    score: Math.min(scores.overall, 0.58),
    scores,
    checks: [check, ...result.checks],
    embeddingMatches: result.embeddingMatches,
    issues: [problem, ...result.issues],
    structuredIssues: [
      {
        severity: "major",
        problem,
        suggestedPatch: {
          summary: "用 coder 根据参考图和当前截图继续细化",
          operations: [],
        },
      },
      ...result.structuredIssues,
    ],
    revisionHints: [
      "重新调用多模态 coder，根据参考图和当前预览差异细化几何结构。",
      ...result.revisionHints,
    ],
    bestEffortReason: "视觉模型调用失败或无有效返回，已阻止 local-heuristic 直接通过。",
    modelUsed: result.modelUsed ?? "local-heuristic",
  });
}

export function superviseQuality(
  result: QualityInspectionResult,
  config: RuntimeComposerConfig,
  request?: Pick<QualityInspectionRequest, "referenceImages">,
): QualityInspectionResult {
  const parsed = qualityInspectionResultSchema.parse(result);
  if (
    parsed.status === "fallback" &&
    !request?.referenceImages.length &&
    !parsed.checks.some((check) => !check.pass && check.severity === "critical")
  ) {
    return {
      ...parsed,
      status: parsed.score >= config.minQualityScore ? "pass" : "revise",
      revisionHints: parsed.revisionHints.length
        ? parsed.revisionHints
        : ["没有参考图时 fallback 不能直接中止；继续按文字目标微调当前模型。"],
      bestEffortReason: parsed.bestEffortReason || "无参考图时视觉 fallback 已降级为可继续修正。",
    };
  }
  if (parsed.status === "ask_user" || parsed.status === "fallback") return parsed;
  const hasCriticalCheckFailure = parsed.checks.some((check) => !check.pass && check.severity === "critical");
  const threshold = request?.referenceImages.length ? Math.max(config.minQualityScore, 0.88) : config.minQualityScore;
  if (hasCriticalCheckFailure) {
    return {
      ...parsed,
      status: "revise",
      revisionHints: parsed.revisionHints.length ? parsed.revisionHints : ["先修复 critical 视觉检查项。"],
    };
  }
  const hasBlockingIssues = parsed.issues.some((issue) => !/轻微|建议|可选/.test(issue));
  if (hasBlockingIssues && parsed.score < 0.9) {
    return {
      ...parsed,
      status: "revise",
      revisionHints: parsed.revisionHints.length
        ? parsed.revisionHints
        : ["根据质检问题修正 Scene DSL 后重新截图。"],
    };
  }
  if (parsed.score >= threshold) {
    return { ...parsed, status: "pass" };
  }
  return {
    ...parsed,
    status: "revise",
    revisionHints: parsed.revisionHints.length
      ? parsed.revisionHints
      : ["提高主体占比", "保持正面视角", "使用白底黑线工程图风格"],
  };
}

export async function reviseScene(input: unknown): Promise<SceneRevisionResult> {
  const request = sceneRevisionRequestSchema.parse(input);
  const modelResult = await reviseSceneWithModel(request).catch((error) => {
    console.warn("[agentic-three:quality] scene revise fallback", error instanceof Error ? error.message : String(error));
    return undefined;
  });
  if (modelResult) return modelResult;
  return reviseSceneWithHeuristics(request);
}

function reviseSceneWithHeuristics(request: SceneRevisionRequest): SceneRevisionResult {
  const text = `${request.userGoal}\n${request.quality.issues.join("\n")}\n${request.quality.revisionHints.join("\n")}`.toLowerCase();
  const patch: ScenePatch = { summary: `第 ${request.round} 轮增量修正`, operations: [] };
  const targetObjectId = request.quality.structuredIssues.find((issue) => issue.objectId)?.objectId ?? getObjectId(request.scene.objects[0]);
  const isDecorative = /爱心|心形|桃心|heart|love|pink|粉色|星星|star|礼物|gift|球|sphere|抽象|装饰|logo|图标/.test(text);
  if (isDecorative) {
    const shape = /爱心|心形|桃心|heart|love/.test(text) ? "heart" : /星星|star/.test(text) ? "star" : /球|sphere/.test(text) ? "sphere" : "abstract";
    const color = /粉色|pink/.test(text) ? "#ff5ca8" : /红色|red/.test(text) ? "#ef4444" : /蓝色|blue/.test(text) ? "#38bdf8" : "#a78bfa";
    patch.operations.push(
      { op: "set_scene", path: "sceneType", value: "component_detail", reason: "用户目标是通用装饰/图标场景" },
      { op: "set_scene", path: "renderStyle", value: "realistic", reason: "装饰场景需要真实材质和颜色" },
      { op: "set_scene", path: "lightingPreset", value: "studio_soft", reason: "装饰场景使用柔光" },
      { op: "set_scene", path: "cameraPreset", value: "front", reason: "保证主体正面可见" },
      { op: "set_object", objectId: targetObjectId, path: "primitive", value: "decorative_shape", reason: "切换到装饰形状 primitive" },
      { op: "merge_object_params", objectId: targetObjectId, path: "params", value: { shape, color }, reason: "写入形状和颜色" },
      { op: "set_object", objectId: targetObjectId, path: "scale", value: 1.12, reason: "提高主体占比" },
      { op: "set_scene", path: "animations", value: Array.from(new Set([...request.scene.animations, "gentle_loop"])), reason: "补齐动图效果" },
    );
  } else {
    patch.operations.push(
      { op: "set_scene", path: "renderStyle", value: "technical_lines", reason: "默认修正为黑线工程图风格" },
      { op: "set_scene", path: "lightingPreset", value: "engineering_white", reason: "工程图使用白底高亮" },
    );
  }
  if (/front|正面|白底|黑线|工程图|ppt/.test(text)) {
    patch.operations.push({ op: "set_scene", path: "cameraPreset", value: "front", reason: "质检要求正面/白底工程图" });
  }
  if (/发动机|engine|涡扇|风扇|fan|叶片|blade/.test(text)) {
    patch.operations.push(
      { op: "set_scene", path: "sceneType", value: "engine_showcase", reason: "用户目标/质检指向发动机展示" },
      { op: "set_object", objectId: targetObjectId, path: "primitive", value: "turbofan_front", reason: "补齐涡扇正面结构" },
      { op: "set_object", objectId: targetObjectId, path: "scale", value: 1.08, reason: "提升发动机主体占比" },
    );
  }
  if (/太小|占比|放大|主体/.test(text)) {
    patch.operations.push({ op: "set_object", objectId: targetObjectId, path: "scale", value: 1.12, reason: "主体过小，增量放大目标对象" });
  }
  patch.operations.push({
    op: "add_annotation",
    path: "annotations",
    value: `第 ${request.round} 轮质检修订: ${request.quality.revisionHints.slice(0, 3).join("；") || "提高截图可用性"}`,
    reason: "记录质检修订历史",
  });
  const scene = applyScenePatch(request.scene, patch);
  return sceneRevisionResultSchema.parse({
    scene,
    patch,
    summary: `已根据第 ${request.round} 轮质检结果修订 Scene DSL。`,
  });
}

async function reviseSceneWithModel(request: SceneRevisionRequest): Promise<SceneRevisionResult | undefined> {
  if (shouldSkipExternalModelCall()) return undefined;
  const settings = getAppSettings();
  const modelConfig = resolveModelConfig("summary", settings);
  const { text, reasoning } = await streamModelCompletion(
    { ...modelConfig, temperature: 0.2, maxTokens: Math.min(modelConfig.maxTokens, 1800) },
    [
      {
        role: "system",
        content:
          "你是 Scene DSL 增量修订 Agent。只输出 JSON 对象，不要 Markdown。你只能输出 Scene Patch，不写 three.js 源码。输出字段: patch, summary。",
      },
      {
        role: "user",
        content: `用户目标:\n${request.userGoal}\n\n当前 Scene DSL:\n${JSON.stringify(request.scene, null, 2)}\n\n质检报告:\n${JSON.stringify(request.quality, null, 2)}\n\n修订要求:\n- 保持 schema 合法。\n- 黑线白图/PPT 场景优先 renderStyle=technical_lines、lightingPreset=engineering_white。\n- 正面图优先 cameraPreset=front。\n- 发动机/螺旋桨/叶片相关优先 engine_showcase + turbofan_front。\n- 通用装饰/图标/爱心/星星/球体等非飞机场景优先 primitive=decorative_shape，并用 params.shape/params.color 表达具体对象，animations 可包含 gentle_loop。\n- 输出 JSON: { "scene": ..., "summary": "..." }`,
      },
    ],
  );
  const content = text.trim() ? text : reasoning;
  if (!content) return undefined;
  const parsed = parseJsonObject(content) as { patch?: unknown; scene?: unknown; summary?: unknown };
  const patch = parsed.patch ? scenePatchFromUnknown(parsed.patch) : undefined;
  const scene = patch ? applyScenePatch(request.scene, patch) : sceneDslSchema.parse(parsed.scene);
  return sceneRevisionResultSchema.parse({
    scene,
    patch: patch ?? { summary: "模型返回全量 Scene DSL，已兼容应用。", operations: [] },
    summary: typeof parsed.summary === "string" ? parsed.summary : `已由模型修订第 ${request.round} 轮 Scene DSL。`,
  });
}

async function inspectWithVisionModel(
  request: QualityInspectionRequest,
  settings: AppSettings,
): Promise<QualityInspectionResult | undefined> {
  if (shouldSkipExternalModelCall()) return undefined;
  const screenshots = normalizeScreenshots(request);
  const viewResults = await Promise.all(screenshots.map((screenshot) => inspectViewWithVisionModel(request, screenshot, settings)));
  if (!viewResults.some((result) => result.modelUsed && result.modelUsed !== "vision-error")) {
    throw new Error(viewResults.flatMap((result) => result.issues).join(" | ") || "视觉质检模型未返回有效视角结果");
  }
  return aggregateViewResults(request, viewResults);
}

async function inspectViewWithVisionModel(
  request: QualityInspectionRequest,
  screenshot: { view: QualityReviewView; dataUrl: string; path?: string },
  settings: AppSettings,
): Promise<QualityViewResult> {
  const failures: string[] = [];
  for (const modelConfig of resolveVisionReviewModelSequence(request.round, settings)) {
    try {
      const content = await streamVisionReviewCompletion({
        modelConfig,
        messages: buildVisionReviewMessagesForView(request, screenshot),
      });
      if (!content) throw new Error("视觉质检模型返回为空");
      try {
        return parseAndNormalizeViewInspectionResult(screenshot.view, content, modelConfig.model, inferReviewCategory(request));
      } catch (validationError) {
        const repaired = await repairVisionReviewJson({
          modelConfig,
          screenshotView: screenshot.view,
          rawContent: content,
          validationError,
        });
        return parseAndNormalizeViewInspectionResult(screenshot.view, repaired, modelConfig.model, inferReviewCategory(request));
      }
    } catch (error) {
      failures.push(`${modelConfig.model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const problem = `${screenshot.view} 视角视觉质检失败: ${failures.join(" | ")}`;
  return {
    view: screenshot.view,
    scores: withOverall({
      geometry: 0.25,
      viewMatch: 0.25,
      material: 0.25,
      referenceSimilarity: request.referenceImages.length ? 0.1 : 0.35,
      renderHealth: 0.8,
    }),
    checks: [{
      view: screenshot.view,
      dimension: "referenceSimilarity",
      item: `${screenshot.view} 视角必须完成视觉对比`,
      pass: false,
      confidence: 1,
      note: problem,
      severity: request.referenceImages.length ? "critical" : "major",
      suggestedFix: "重试视觉 review；若仍失败则不能将参考图相似度判为通过。",
    }],
    featurePoints: [],
    featureMatches: [],
    issues: [problem],
    revisionHints: ["视觉质检失败时继续 coder 修正或标记 fallback，不能直接 pass。"],
    modelUsed: "vision-error",
  };
}

function parseAndNormalizeViewInspectionResult(
  view: QualityReviewView,
  content: string,
  modelUsed: string,
  category?: AircraftAssetCategory,
): QualityViewResult {
  return normalizeViewInspectionResult(
    view,
    parseJsonObject(content) as Record<string, unknown>,
    modelUsed,
    category,
  );
}

async function repairVisionReviewJson(input: {
  modelConfig: VisionReviewModelConfig;
  screenshotView: QualityReviewView;
  rawContent: string;
  validationError: unknown;
}): Promise<string> {
  const repairConfig = {
    ...input.modelConfig,
    temperature: 0,
    maxTokens: Math.min(Math.max(input.modelConfig.maxTokens, 1200), 2600),
  };
  const content = await streamVisionReviewCompletion({
    modelConfig: repairConfig,
    messages: [
      {
        role: "system",
        content: [
          "你是 JSON 协议修复器，不是视觉评审员。",
          "只允许修复 JSON 语法、字段类型、枚举同义词和缺省字段，不允许重新评价图片、不允许改分数含义。",
          "只输出一个 JSON 对象，不要 Markdown，不要解释。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `当前视角: ${input.screenshotView}`,
          `校验错误:\n${truncateForRepair(formatUnknownError(input.validationError), 3000)}`,
          "",
          "目标 JSON schema 摘要:",
          "- scores: object，必须包含 geometry/viewMatch/material/referenceSimilarity/renderHealth/overall，数值 0-1。",
          "- featurePoints: array，每项 id/label/x/y/confidence/kind；kind 只能是 point/center/edge/contour/axis/hole/bolt/blade_root/blade_tip。",
          "- featureMatches: array，每项 referenceId/screenshotId/label/distance/pass/confidence/note/suggestedParameter。",
          "- checks: array，每项 dimension/item/pass/confidence/note/severity/suggestedFix/targetFunction。",
          "- issues/revisionHints: string array。",
          "",
          "枚举归一化规则:",
          "- ring/region/area/outline/silhouette/circle/圆环/区域/外轮廓 -> contour",
          "- screw/螺钉/螺栓 -> bolt",
          "- center hole/中心孔 -> hole",
          "- blade root/根部 -> blade_root",
          "- blade tip/叶尖 -> blade_tip",
          "",
          `待修复内容:\n${truncateForRepair(input.rawContent, 12000)}`,
        ].join("\n"),
      },
    ],
  });
  if (!content.trim()) throw new Error("JSON repair 模型返回为空");
  return content;
}

export function buildVisionReviewMessages(request: QualityInspectionRequest) {
  const screenshots = normalizeScreenshots(request);
  const selectedReferenceImages = request.referenceImages.slice(0, Math.max(0, 5 - screenshots.length));
  const selectedScreenshots = screenshots.slice(0, 5 - selectedReferenceImages.length);
  return [
    {
      role: "system" as const,
      content:
        "你是 three.js 多视角预览质检 Agent。只输出 JSON，不要 Markdown。检查多张截图是否符合用户目标和参考图，字段为 status、score、issues、structuredIssues、revisionHints、bestEffortReason。structuredIssues 每项包含 view、objectId、severity、problem、suggestedPatch。",
    },
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `用户目标:\n${request.userGoal}\n\nScene DSL:\n${JSON.stringify(request.scene, null, 2)}\n\n运行错误:\n${request.runtimeErrors.map((item) => item.message).join("\n") || "无"}\n\n请逐视角比较参考图和当前预览截图。若发现问题，请尽量指出 objectId，并给出只修改相关对象/相机/灯光/材质的 suggestedPatch。本请求最多附带 5 张图: ${selectedReferenceImages.length} 张参考图 + ${selectedScreenshots.length} 张预览截图。`,
        },
        ...selectedReferenceImages.flatMap((image) => [
          { type: "text" as const, text: `原始参考图: ${image.name}` },
          { type: "image_url" as const, image_url: { url: image.dataUrl } },
        ]),
        ...selectedScreenshots.flatMap((screenshot) => [
          { type: "text" as const, text: `当前 Sandpack 预览截图: ${screenshot.view}` },
          { type: "image_url" as const, image_url: { url: screenshot.dataUrl } },
        ]),
      ],
    },
  ];
}

function buildVisionReviewMessagesForView(
  request: QualityInspectionRequest,
  screenshot: { view: QualityReviewView; dataUrl: string; path?: string },
) {
  const selectedReferenceImages = request.referenceImages.slice(0, 4);
  const category = inferReviewCategory(request);
  const reviewContext = [
    request.userGoal,
    request.scene.semanticSummary,
    request.scene.annotations.join("\n"),
    JSON.stringify(request.scene.objects.map((object) => ({
      primitive: object.primitive,
      role: object.semanticRole,
      purpose: object.purpose,
      params: object.params,
      constraints: object.constraints,
    }))),
  ].join("\n");
  return [
    {
      role: "system" as const,
      content: [
        "你是严格的 3D 视觉质检 Agent。只输出 JSON，不要 Markdown。",
        "你必须按多维检查表评估当前截图是否符合用户目标和参考图。",
        "不要给自由心证总分；必须输出 scores 与 checks，overall 可给但服务端会重新计算。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: [
            `用户目标:\n${request.userGoal}`,
            `当前检查视角: ${screenshot.view}`,
            `识别类别: ${category}`,
            `Scene DSL:\n${JSON.stringify(request.scene, null, 2)}`,
            `运行错误:\n${request.runtimeErrors.map((item) => item.message).join("\n") || "无"}`,
            "",
            "评分维度固定为:",
            "- geometry: 几何结构、比例、主体完整性是否匹配。",
            "- viewMatch: 相机角度、构图、视角是否匹配。",
            "- material: 材质、颜色、线稿/写实风格、高光是否匹配。",
            "- referenceSimilarity: 整体是否像参考图和用户目标。",
            "- renderHealth: 是否完整渲染、非空白、无遮挡严重。",
            "",
            "请同时输出 featurePoints 和 featureMatches:",
            "- featurePoints 标注当前截图中的关键部位，坐标 x/y 用 0-1 归一化。",
            "- featurePoints.kind 只能使用 point/center/edge/contour/axis/hole/bolt/blade_root/blade_tip；圆环/区域/外轮廓统一用 contour，不要输出 ring 或 region。",
            "- featureMatches 对齐参考图与当前截图的中心孔、轮毂、螺栓孔、叶片根部、叶尖、前缘/后缘、外轮廓和弯曲方向。",
            "- featureMatches 每项包含 referenceId、screenshotId、label、distance、pass、confidence、note、suggestedParameter。",
            "",
            "请先动态生成 checks。每个 check 必须包含 dimension、item、pass、confidence、note、severity、suggestedFix，并尽量填写 targetFunction。",
            "targetFunction 用于 coder 精确函数级修正。",
            "通用 checks 至少覆盖主体结构、比例、视角、材质/风格、整体相似度。",
            buildAircraftReviewChecklistInstruction(category, reviewContext),
            "",
            "输出 JSON 格式:",
            '{"scores":{"geometry":0-1,"viewMatch":0-1,"material":0-1,"referenceSimilarity":0-1,"renderHealth":0-1,"overall":0-1},"featurePoints":[{"id":"hub-center","label":"中心孔","part":"hub","x":0.5,"y":0.5,"confidence":0.9,"kind":"hole","parameterHint":"hubRadius"}],"featureMatches":[{"referenceId":"hub-center","screenshotId":"hub-center","label":"中心孔位置","distance":0.08,"pass":true,"confidence":0.9,"note":"...","suggestedParameter":"hubRadius"}],"checks":[{"dimension":"geometry","item":"...","pass":false,"confidence":0.9,"note":"...","severity":"major","suggestedFix":"...","targetFunction":"buildFanBlades"}],"issues":["..."],"revisionHints":["..."],"bestEffortReason":"..."}',
          ].join("\n"),
        },
        ...selectedReferenceImages.flatMap((image) => [
          { type: "text" as const, text: `用户参考图: ${image.name}` },
          { type: "image_url" as const, image_url: { url: image.dataUrl } },
        ]),
        { type: "text" as const, text: `当前 Sandpack 预览截图: ${screenshot.view}` },
        { type: "image_url" as const, image_url: { url: screenshot.dataUrl } },
      ],
    },
  ];
}

function inspectWithHeuristics(request: QualityInspectionRequest): QualityInspectionResult {
  const screenshots = normalizeScreenshots(request);
  const goal = request.userGoal.toLowerCase();
  const sceneText = `${request.scene.renderStyle} ${request.scene.cameraPreset} ${request.scene.animations.join(" ")} ${request.scene.objects
    .map((item) => item.primitive)
    .join(" ")}`.toLowerCase();
  const issues: string[] = [];
  const structuredIssues: QualityIssue[] = [];
  const revisionHints: string[] = [];
  let score = 0.62;
  const smallestScreenshot = screenshots.reduce((min, item) => Math.min(min, item.dataUrl.length), Number.POSITIVE_INFINITY);
  if (smallestScreenshot < 8_000) {
    const problem = "预览截图数据过小，疑似空白或渲染失败。";
    issues.push(problem);
    structuredIssues.push({ view: screenshots.find((item) => item.dataUrl.length === smallestScreenshot)?.view, severity: "critical", problem });
    revisionHints.push("检查 renderer 是否完成渲染，并提高主体可见性。");
    score -= 0.35;
  }
  const wantsTechnical = /黑线|白图|线稿|工程图|technical/.test(goal);
  if (wantsTechnical) {
    if (/technical_lines/.test(sceneText)) score += 0.08;
    else {
      const problem = "目标偏向黑线白图，但 Scene DSL 还不是 technical_lines。";
      issues.push(problem);
      structuredIssues.push({
        severity: "major",
        problem,
        suggestedPatch: {
          summary: "切换为技术线稿风格",
          operations: [{ op: "set_scene", path: "renderStyle", value: "technical_lines", reason: "匹配用户要求的黑线白图风格" }],
        },
      });
      revisionHints.push("切换 renderStyle 为 technical_lines。");
    }
  }
  const wantsFront = /正面|front/.test(goal);
  if (wantsFront) {
    if (/front/.test(sceneText)) score += 0.08;
    else {
      const problem = "目标需要正面图，当前相机预设不够明确。";
      issues.push(problem);
      structuredIssues.push({
        view: "front",
        severity: "major",
        problem,
        suggestedPatch: {
          summary: "切换为正面视角",
          operations: [{ op: "set_scene", path: "cameraPreset", value: "front", reason: "匹配用户要求的正面视角" }],
        },
      });
      revisionHints.push("把 cameraPreset 调整为 front。");
    }
  }
  if (/发动机|engine|turbofan|fan|叶片/.test(goal) && /turbofan_front/.test(sceneText)) score += 0.1;
  const wantsDecorative = /爱心|心形|桃心|heart|love|pink|粉色|星星|star|礼物|gift|球|sphere|抽象|装饰|logo|图标/.test(goal);
  if (wantsDecorative) {
    if (/decorative_shape/.test(sceneText)) score += 0.14;
    else {
      const problem = "目标是通用装饰/图标类场景，但 Scene DSL 没有使用 decorative_shape。";
      issues.push(problem);
      structuredIssues.push({ objectId: getObjectId(request.scene.objects[0]), severity: "major", problem });
      revisionHints.push("把主对象 primitive 调整为 decorative_shape，并通过 params 描述形状和颜色。");
    }
    if (/gentle_loop/.test(sceneText)) score += 0.08;
    else {
      const problem = "目标需要动图效果，但 Scene DSL 没有 gentle_loop 动画。";
      issues.push(problem);
      structuredIssues.push({ severity: "minor", problem });
      revisionHints.push("在 animations 中加入 gentle_loop。");
    }
  }
  if (request.runtimeErrors.length) {
    const problem = "预览存在运行错误，需要先修复。";
    issues.push(problem);
    structuredIssues.push({ severity: "critical", problem });
    revisionHints.push("优先消除 runtime errors。");
    score -= 0.2;
  }
  const boundedScore = Math.max(0, Math.min(0.92, score));
  return qualityInspectionResultSchema.parse({
    status: boundedScore >= 0.75 ? "pass" : "revise",
    score: boundedScore,
    issues,
    structuredIssues,
    revisionHints,
    bestEffortReason: issues.length ? "本地启发式质检无法完全替代多模态视觉判断。" : "",
    modelUsed: "local-heuristic",
  });
}

export function applyScenePatch(scene: SceneDsl, patch: ScenePatch): SceneDsl {
  const next = sceneDslSchema.parse(structuredClone(scene));
  for (const operation of patch.operations) {
    if (operation.op === "add_annotation") {
      next.annotations = Array.from(new Set([...next.annotations, String(operation.value)]));
      continue;
    }
    if (operation.op === "set_scene" || operation.op === "set_quality") {
      applySceneLevelValue(next, operation.path, operation.value);
      continue;
    }
    const object = findObject(next, operation.objectId);
    if (!object) continue;
    if (operation.op === "merge_object_params") {
      object.params = { ...object.params, ...(isRecord(operation.value) ? operation.value : {}) };
      continue;
    }
    if (operation.op === "set_object") {
      applyObjectLevelValue(object, operation.path, operation.value);
    }
  }
  return sceneDslSchema.parse({
    ...next,
    objects: next.objects.map((object) => ({
      ...object,
      objectId: getObjectId(object),
    })),
  });
}

export function resolveVisionReviewModel(round: number, settings: AppSettings): VisionReviewModelConfig {
  const configured = settings.visionReview.models.filter(supportsImageInput);
  const models = configured.length
    ? configured
    : [
        {
          model: "doubao-seed-2-0-code-preview-260215",
          baseURL: "https://ark.cn-beijing.volces.com/api/v3",
          apiKeyEnvName: "ARK_API_KEY",
          temperature: 0.2,
          maxTokens: 2000,
        },
      ];
  const index = Math.max(0, round - 1) % models.length;
  return models[index]!;
}

function resolveVisionReviewModelSequence(round: number, settings: AppSettings): VisionReviewModelConfig[] {
  const models = settings.visionReview.models.length
    ? settings.visionReview.models
    : [resolveVisionReviewModel(round, settings)];
  const start = Math.max(0, round - 1) % models.length;
  const preferred = [...models.slice(start), ...models.slice(0, start)];
  const imageCapable = preferred.filter(supportsImageInput);
  const defaults = [
    {
      model: "doubao-seed-2-0-code-preview-260215",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyEnvName: "ARK_API_KEY",
      temperature: 0.2,
      maxTokens: 2000,
    },
  ];
  return dedupeModels(appendExpensiveVisionFallback(imageCapable.length ? imageCapable : defaults) as VisionReviewModelConfig[]);
}

async function streamVisionReviewCompletion(
  input: {
    modelConfig: VisionReviewModelConfig;
    messages: Array<{
      role: "system" | "user" | "assistant";
      content: ChatMessageContent;
    }>;
  },
): Promise<string> {
  const { text, reasoning } = await streamModelCompletion(input.modelConfig, input.messages);
  return text.trim() ? text : reasoning;
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("质检模型没有返回 JSON 对象。");
  const objectText = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(objectText);
  } catch (error) {
    try {
      return JSON.parse(repairJsonObjectText(objectText));
    } catch {
      throw error;
    }
  }
}

function repairJsonObjectText(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, value: string) => JSON.stringify(value));
}

function shouldSkipExternalModelCall(): boolean {
  return Boolean(process.env.VITEST) && process.env.ENABLE_LLM_TESTS !== "1";
}

function normalizeScreenshots(request: QualityInspectionRequest): Array<{ view: "front" | "side" | "top" | "three_quarter"; dataUrl: string; path?: string }> {
  if (request.screenshots.length) return request.screenshots;
  if (request.screenshotDataUrl) return [{ view: "front", dataUrl: request.screenshotDataUrl }];
  return [{ view: "front", dataUrl: "data:image/png;base64," }];
}

function normalizeInspectionResult(input: Record<string, unknown>): QualityInspectionResult {
  const parsed = qualityInspectionResultSchema.parse(input);
  const issueTexts = parsed.issues.length
    ? parsed.issues
    : parsed.structuredIssues.map((issue) => [issue.view, issue.objectId, issue.problem].filter(Boolean).join(" / "));
  return qualityInspectionResultSchema.parse({
    ...parsed,
    issues: issueTexts,
  });
}

function normalizeViewInspectionResult(
  view: QualityReviewView,
  input: Record<string, unknown>,
  modelUsed: string,
  category?: AircraftAssetCategory,
): QualityViewResult {
  const rawScores = input.scores && typeof input.scores === "object" && !Array.isArray(input.scores)
    ? input.scores as Partial<QualityScores>
    : {};
  const scores = withOverall({
    geometry: numberOrDefault(rawScores.geometry, 0.5),
    viewMatch: numberOrDefault(rawScores.viewMatch, 0.5),
    material: numberOrDefault(rawScores.material, 0.5),
    referenceSimilarity: numberOrDefault(rawScores.referenceSimilarity, 0.5),
    embeddingSimilarity: numberOrDefault(rawScores.embeddingSimilarity, 0),
    renderHealth: numberOrDefault(rawScores.renderHealth, 0.8),
  });
  const checks = Array.isArray(input.checks)
    ? input.checks
        .map((check) => normalizeCheckTargetFunction({ ...(isRecord(check) ? check : {}), view }, category))
        .map((check) => qualityCheckItemSchema.parse(check))
    : [];
  const featurePoints = Array.isArray(input.featurePoints)
    ? input.featurePoints
        .map((item, index) => normalizeVisualFeaturePointForSchema({ ...(isRecord(item) ? item : {}), view }, index))
        .map((item) => visualFeaturePointSchema.safeParse(item))
        .filter((item): item is ReturnType<typeof visualFeaturePointSchema.safeParse> & { success: true } => item.success)
        .map((item) => item.data)
    : [];
  const featureMatches = Array.isArray(input.featureMatches)
    ? input.featureMatches
        .map((item, index) => normalizeVisualFeatureMatchForSchema({ ...(isRecord(item) ? item : {}), view }, index))
        .map((item) => visualFeatureMatchSchema.safeParse(item))
        .filter((item): item is ReturnType<typeof visualFeatureMatchSchema.safeParse> & { success: true } => item.success)
        .map((item) => item.data)
    : [];
  return {
    view,
    scores,
    checks,
    featurePoints,
    featureMatches,
    issues: Array.isArray(input.issues) ? input.issues.filter((item): item is string => typeof item === "string") : [],
    revisionHints: Array.isArray(input.revisionHints) ? input.revisionHints.filter((item): item is string => typeof item === "string") : [],
    modelUsed,
  };
}

function normalizeVisualFeaturePointForSchema(point: Record<string, unknown>, index: number): Record<string, unknown> {
  const label = typeof point.label === "string" && point.label.trim() ? point.label : `feature-${index + 1}`;
  return {
    ...point,
    id: typeof point.id === "string" && point.id.trim() ? point.id : `feature-${index + 1}`,
    label,
    x: clampCoordinate(point.x, 0.5),
    y: clampCoordinate(point.y, 0.5),
    confidence: numberOrDefault(point.confidence, 0.55),
    kind: normalizeVisualFeatureKind(point.kind, label, typeof point.part === "string" ? point.part : ""),
  };
}

function normalizeVisualFeatureMatchForSchema(match: Record<string, unknown>, index: number): Record<string, unknown> {
  const label = typeof match.label === "string" && match.label.trim() ? match.label : `feature-match-${index + 1}`;
  return {
    ...match,
    referenceId: typeof match.referenceId === "string" && match.referenceId.trim() ? match.referenceId : `reference-${index + 1}`,
    screenshotId: typeof match.screenshotId === "string" && match.screenshotId.trim() ? match.screenshotId : undefined,
    label,
    distance: typeof match.distance === "number" && Number.isFinite(match.distance) ? Math.max(0, match.distance) : 1,
    pass: typeof match.pass === "boolean" ? match.pass : false,
    confidence: numberOrDefault(match.confidence, 0.55),
  };
}

function normalizeVisualFeatureKind(kind: unknown, label: string, part: string): string {
  const raw = typeof kind === "string" ? kind.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (["point", "center", "edge", "contour", "axis", "hole", "bolt", "blade_root", "blade_tip"].includes(raw)) return raw;
  const text = `${raw} ${label} ${part}`.toLowerCase();
  if (/bolt|screw|螺栓|螺钉/.test(text)) return "bolt";
  if (/hole|孔|中心孔|开孔/.test(text)) return "hole";
  if (/axis|轴线|中心线/.test(text)) return "axis";
  if (/root|根部|榫头/.test(text)) return "blade_root";
  if (/tip|叶尖|尖端/.test(text)) return "blade_tip";
  if (/edge|leading|trailing|前缘|后缘|边缘/.test(text)) return "edge";
  if (/ring|region|area|outline|contour|silhouette|envelope|circle|圆环|区域|外轮廓|包络|轮廓|圆圈/.test(text)) return "contour";
  if (/center|centre|中心|圆心|轮毂/.test(text)) return "center";
  return "point";
}

function clampCoordinate(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp01(value);
}

function normalizeCheckTargetFunction(check: Record<string, unknown>, category?: AircraftAssetCategory): Record<string, unknown> {
  if (typeof check.targetFunction === "string" && /^[A-Za-z_$][\w$]*$/.test(check.targetFunction)) {
    return check;
  }
  const text = [
    typeof check.dimension === "string" ? check.dimension : "",
    typeof check.item === "string" ? check.item : "",
    typeof check.note === "string" ? check.note : "",
    typeof check.suggestedFix === "string" ? check.suggestedFix : "",
  ].join(" ").toLowerCase();
  const targetFunction = inferAircraftTargetFunctionFromText(text, category);
  return targetFunction ? { ...check, targetFunction } : check;
}

function aggregateViewResults(request: QualityInspectionRequest, viewResults: QualityViewResult[]): QualityInspectionResult {
  const health = calculateRenderHealth(request);
  const normalizedViewResults = normalizeViewResultsForTarget(request, viewResults);
  const matchedReferenceView = inferMatchedReferenceView(request, normalizedViewResults);
  const matchedViewResult = matchedReferenceView
    ? normalizedViewResults.find((result) => result.view === matchedReferenceView)
    : undefined;
  const featureMatches = normalizedViewResults.flatMap((result) => result.featureMatches);
  const featureMatchScore = calculateFeatureMatchScore(featureMatches);
  const referenceSimilarity = request.referenceImages.length === 1 && matchedViewResult
    ? matchedViewResult.scores.referenceSimilarity
    : request.referenceImages.length
      ? Math.min(...normalizedViewResults.map((result) => result.scores.referenceSimilarity))
      : averageScore(normalizedViewResults.map((result) => result.scores.referenceSimilarity));
  const scores = withOverall({
    geometry: averageScore(normalizedViewResults.map((result) => result.scores.geometry)),
    viewMatch: averageScore(normalizedViewResults.map((result) => result.scores.viewMatch)),
    material: averageScore(normalizedViewResults.map((result) => result.scores.material)),
    referenceSimilarity,
    embeddingSimilarity: 0,
    renderHealth: health.score,
  });
  const checks = normalizedViewResults.flatMap((result) => result.checks);
  const issues = Array.from(new Set([...normalizedViewResults.flatMap((result) => result.issues), ...health.issues]));
  const revisionHints = Array.from(new Set([
    ...normalizedViewResults.flatMap((result) => result.revisionHints),
    ...checks.filter((check) => !check.pass && check.suggestedFix).map((check) => `${check.view ?? "unknown"} / ${check.dimension}: ${check.suggestedFix}`),
    ...health.revisionHints,
  ]));
  const structuredIssues = checks
    .filter((check) => !check.pass && check.severity !== "info")
    .map((check): QualityIssue => ({
      view: check.view,
      severity: check.severity,
      problem: `${check.item}: ${check.note || "未通过检查"}`,
      suggestedPatch: check.suggestedFix
        ? { summary: check.suggestedFix, operations: [] }
        : undefined,
    }));
  return qualityInspectionResultSchema.parse({
    status: scores.overall >= 0.88 ? "pass" : "revise",
    score: scores.overall,
    scores,
    checks,
    viewResults: normalizedViewResults,
    featureMatches,
    embeddingMatches: [],
    matchedReferenceView,
    candidateScore: calculateQualityCandidateScore(scores, featureMatchScore),
    issues,
    structuredIssues,
    revisionHints,
    bestEffortReason: "",
    modelUsed: Array.from(new Set(viewResults.map((result) => result.modelUsed).filter(Boolean))).join(", "),
  });
}

function inferMatchedReferenceView(
  request: QualityInspectionRequest,
  viewResults: QualityViewResult[],
): QualityReviewView | undefined {
  if (request.referenceImages.length !== 1) return undefined;
  if (isQualityReviewView(request.scene.cameraPreset) && viewResults.some((result) => result.view === request.scene.cameraPreset)) {
    return request.scene.cameraPreset;
  }
  const text = `${request.userGoal} ${request.scene.semanticSummary}`.toLowerCase();
  const inferred: QualityReviewView = /侧面|side/.test(text)
    ? "side"
    : /俯视|top/.test(text)
      ? "top"
      : /三分|斜|three.?quarter/.test(text)
        ? "three_quarter"
        : "front";
  return viewResults.some((result) => result.view === inferred) ? inferred : viewResults[0]?.view;
}

function isQualityReviewView(value: unknown): value is QualityReviewView {
  return value === "front" || value === "side" || value === "top" || value === "three_quarter";
}

function calculateFeatureMatchScore(featureMatches: QualityViewResult["featureMatches"]): number | undefined {
  if (!featureMatches.length) return undefined;
  const weighted = featureMatches.map((match) => (match.pass ? 1 : Math.max(0, 1 - match.distance)) * match.confidence);
  const totalConfidence = featureMatches.reduce((sum, match) => sum + match.confidence, 0);
  return totalConfidence > 0 ? clamp01(weighted.reduce((sum, value) => sum + value, 0) / totalConfidence) : undefined;
}

function calculateQualityCandidateScore(scores: QualityScores, featureMatchScore?: number): number {
  const visualScore = scores.embeddingSimilarity > 0
    ? scores.embeddingSimilarity
    : scores.referenceSimilarity;
  const base = clamp01(
    scores.geometry * 0.32 +
      visualScore * 0.3 +
      scores.viewMatch * 0.12 +
      scores.material * 0.12 +
      scores.renderHealth * 0.14,
  );
  return featureMatchScore === undefined ? base : clamp01(base * 0.78 + featureMatchScore * 0.22);
}

async function addEmbeddingSimilarity(
  request: QualityInspectionRequest,
  result: QualityInspectionResult,
): Promise<QualityInspectionResult> {
  if (!request.referenceImages.length) {
    return qualityInspectionResultSchema.parse({
      ...result,
      scores: withOverall({ ...result.scores, embeddingSimilarity: 0 }),
    });
  }
  const comparison = await compareReferenceAndScreenshots({
    userGoal: request.userGoal,
    referenceImages: request.referenceImages,
    screenshots: normalizeScreenshots(request),
    preferredView: result.matchedReferenceView,
  });
  if (!comparison) return result;
  const scores = withOverall({
    ...result.scores,
    embeddingSimilarity: comparison.score,
  });
  const featureMatchScore = calculateFeatureMatchScore(result.featureMatches);
  const matchedReferenceView = result.matchedReferenceView ?? comparison.matchedView;
  const modelUsed = [result.modelUsed, `embedding:${comparison.model}:${comparison.dimension}`]
    .filter(Boolean)
    .join(", ");
  return qualityInspectionResultSchema.parse({
    ...result,
    score: scores.overall,
    scores,
    embeddingMatches: comparison.matches,
    matchedReferenceView,
    candidateScore: calculateQualityCandidateScore(scores, featureMatchScore),
    modelUsed,
    revisionHints: comparison.fallbackReason
      ? Array.from(new Set([...result.revisionHints, `视觉向量相似度使用 fallback: ${comparison.fallbackReason}`]))
      : result.revisionHints,
  });
}

function normalizeViewResultsForTarget(
  request: QualityInspectionRequest,
  viewResults: QualityViewResult[],
): QualityViewResult[] {
  if (inferReviewCategory(request) !== "engine") return viewResults;
  const context = [
    request.userGoal,
    request.scene.semanticSummary,
    request.scene.annotations.join("\n"),
    request.scene.objects.map((object) => `${object.semanticRole} ${object.purpose} ${JSON.stringify(object.params)} ${object.constraints.join(" ")}`).join("\n"),
  ].join("\n");
  const variant = inferEngineModelingVariant(context);
  if (variant !== "open_blisk") return viewResults;

  return viewResults.map((view) => {
    const checks = view.checks.map((check) => {
      if (!isDuctRequirementCheck(check) || isExtraDuctFailureCheck(check)) return check;
      return qualityCheckItemSchema.parse({
        ...check,
        pass: true,
        severity: "info",
        note: `${check.note || "外环/涵道检查"}。目标为开放式叶盘/blisk，缺少大外环/涵道/机匣不作为失败项。`,
        suggestedFix: "",
      });
    });
    return {
      ...view,
      checks,
      issues: view.issues.filter((issue) => !isDuctRequirementText(issue) || isExtraDuctFailureText(issue)),
      revisionHints: view.revisionHints.filter((hint) => !isDuctRequirementText(hint) || isExtraDuctFailureText(hint)),
    };
  });
}

function isDuctRequirementCheck(check: QualityCheckItem): boolean {
  return isDuctRequirementText(`${check.item}\n${check.note}\n${check.suggestedFix}`);
}

function isExtraDuctFailureCheck(check: QualityCheckItem): boolean {
  return isExtraDuctFailureText(`${check.item}\n${check.note}\n${check.suggestedFix}`);
}

function isDuctRequirementText(text: string): boolean {
  return /外环|外涵道|涵道|机匣|外圈|outer\s*ring|duct|casing|nacelle/i.test(text);
}

function isExtraDuctFailureText(text: string): boolean {
  return /多余|不应|不该|不要|无外环|移除|去掉|不需要|没有参考|extra|unwanted|remove|should\s+not/i.test(text);
}

function calculateRenderHealth(request: QualityInspectionRequest): { score: number; issues: string[]; revisionHints: string[] } {
  const screenshots = normalizeScreenshots(request);
  const issues: string[] = [];
  const revisionHints: string[] = [];
  let score = 1;
  if (request.runtimeErrors.length) {
    issues.push("预览存在运行错误。");
    revisionHints.push("优先修复 runtime errors 后再判断视觉质量。");
    score = Math.min(score, 0.45);
  }
  const smallestScreenshot = screenshots.reduce((min, item) => Math.min(min, item.dataUrl.length), Number.POSITIVE_INFINITY);
  if (smallestScreenshot < 8_000) {
    issues.push("至少一个截图数据过小，疑似空白或渲染失败。");
    revisionHints.push("确保 renderer 完成首帧渲染，主体占据足够画面。");
    score = Math.min(score, 0.25);
  }
  const requiredViews = new Set<QualityReviewView>(["front", "side", "top", "three_quarter"]);
  const capturedViews = new Set(screenshots.map((screenshot) => screenshot.view));
  const missingViews = [...requiredViews].filter((view) => !capturedViews.has(view));
  if (missingViews.length) {
    issues.push(`缺少多视角截图: ${missingViews.join(", ")}。`);
    revisionHints.push("补齐 front/side/top/three_quarter 四视角截图。");
    score = Math.min(score, 0.4);
  }
  return { score, issues, revisionHints };
}

function addRuleVerification(request: QualityInspectionRequest, result: QualityInspectionResult): QualityInspectionResult {
  const screenshots = normalizeScreenshots(request);
  const issues = [...result.issues];
  const structuredIssues = [...result.structuredIssues];
  const revisionHints = [...result.revisionHints];
  const checks = [...result.checks];
  let scores = result.scores;
  let score = result.score;

  const missingObjectIds = request.scene.objects.filter((object) => !getObjectId(object));
  if (missingObjectIds.length) {
    const problem = "Scene Graph 对象缺少稳定 objectId，无法做精确视觉修正。";
    issues.push(problem);
    structuredIssues.push({ severity: "major", problem });
    checks.push({
      dimension: "geometry",
      item: "Scene Graph 对象必须有稳定 objectId",
      pass: false,
      confidence: 1,
      note: problem,
      severity: "major",
      suggestedFix: "为每个对象补齐 objectId，便于后续按对象修正。",
      targetFunction: "createScene",
    });
    revisionHints.push("为每个对象补齐 objectId，并在后续 patch 中按 objectId 定位。");
    score = Math.min(score, 0.72);
    scores = withOverall({ ...scores, geometry: Math.min(scores.geometry, 0.72) });
  }

  const requiredViews = new Set(["front", "side", "top", "three_quarter"]);
  const capturedViews = new Set(screenshots.map((screenshot) => screenshot.view));
  const missingViews = [...requiredViews].filter((view) => !capturedViews.has(view as "front"));
  if (missingViews.length) {
    const problem = `多视角质检缺少视角: ${missingViews.join(", ")}。`;
    issues.push(problem);
    const severity = request.referenceImages.length ? "critical" : "minor";
    structuredIssues.push({ severity, problem });
    checks.push({
      dimension: "viewMatch",
      item: "必须提供 front/side/top/three_quarter 多视角截图",
      pass: false,
      confidence: 1,
      note: problem,
      severity,
      suggestedFix: "补齐缺失视角截图后重新 review。",
      targetFunction: "setupCamera",
    });
    revisionHints.push("补齐 front/side/top/three_quarter 四视角截图后再判断最终质量。");
    score = Math.min(score, request.referenceImages.length ? 0.4 : 0.82);
    scores = withOverall({ ...scores, viewMatch: Math.min(scores.viewMatch, request.referenceImages.length ? 0.3 : 0.82) });
  }

  if (!request.scene.objects.length) {
    const problem = "Scene DSL 没有任何对象，无法渲染有效场景。";
    issues.push(problem);
    structuredIssues.push({ severity: "critical", problem });
    checks.push({
      dimension: "geometry",
      item: "场景必须包含可见主体对象",
      pass: false,
      confidence: 1,
      note: problem,
      severity: "critical",
      suggestedFix: "至少生成一个与用户目标对应的主体对象。",
      targetFunction: "createScene",
    });
    revisionHints.push("至少生成一个主体对象。");
    score = Math.min(score, 0.2);
    scores = withOverall({ ...scores, geometry: Math.min(scores.geometry, 0.2) });
  }

  const health = calculateRenderHealth(request);
  if (health.score < 1) {
    scores = withOverall({ ...scores, renderHealth: Math.min(scores.renderHealth, health.score) });
    for (const issue of health.issues) {
      checks.push({
        dimension: "renderHealth",
        item: "渲染健康检查",
        pass: false,
        confidence: 1,
        note: issue,
        severity: health.score <= 0.4 ? "critical" : "major",
        suggestedFix: "修复运行错误、空白截图或截图缺失后重新 review。",
        targetFunction: "createScene",
      });
    }
  }
  score = Math.min(score, scores.overall);
  return qualityInspectionResultSchema.parse({
    ...result,
    score,
    scores: withOverall({ ...scores, overall: score }),
    checks,
    issues: Array.from(new Set(issues)),
    structuredIssues,
    revisionHints: Array.from(new Set(revisionHints)),
  });
}

function addConstraintVerification(request: QualityInspectionRequest, result: QualityInspectionResult): QualityInspectionResult {
  if (!request.scene.assemblyGraph) return result;
  const solverResult = verifyAssemblyConstraints(request.scene.assemblyGraph, request.scene.solverResult);
  const failed = solverResult.checks.filter((check) => !check.pass);
  if (!solverResult.checks.length) return result;
  const checks: QualityCheckItem[] = [
    ...result.checks,
    ...solverResult.checks.map((check) => constraintCheckToQualityCheck(check)),
  ];
  const criticalFailed = failed.some((check) => check.priority === "critical");
  const issues = [
    ...result.issues,
    ...failed.map((check) => `Assembly constraint ${check.constraintId} failed: ${check.message}`),
  ];
  const revisionHints = [
    ...result.revisionHints,
    ...failed.map((check) => `${check.constraintId}: ${check.message}。优先修 assembly template 参数或对应局部函数，不要凭空移动坐标。`),
  ];
  const scores = withOverall({
    ...result.scores,
    geometry: failed.length ? Math.min(result.scores.geometry, criticalFailed ? 0.35 : 0.72) : result.scores.geometry,
    renderHealth: result.scores.renderHealth,
  });
  return qualityInspectionResultSchema.parse({
    ...result,
    status: criticalFailed ? "revise" : result.status,
    score: criticalFailed ? Math.min(scores.overall, 0.5) : Math.min(result.score, scores.overall),
    scores,
    checks,
    issues: Array.from(new Set(issues)),
    structuredIssues: [
      ...result.structuredIssues,
      ...failed.map((check): QualityIssue => ({
        severity: check.priority === "critical" ? "critical" : check.priority === "high" ? "major" : "minor",
        problem: `Assembly constraint ${check.constraintId}: ${check.message}`,
      })),
    ],
    revisionHints: Array.from(new Set(revisionHints)),
    constraintStatus: criticalFailed ? "revise" : "pass",
    constraintResiduals: solverResult.residuals,
    constraintChecks: solverResult.checks,
  });
}

function constraintCheckToQualityCheck(check: AssemblyConstraintCheck): QualityCheckItem {
  return {
    dimension: "constraint",
    item: `Assembly ${check.type}: ${check.constraintId}`,
    pass: check.pass,
    confidence: 1,
    note: check.message,
    severity: check.priority === "critical" ? "critical" : check.priority === "high" ? "major" : "minor",
    suggestedFix: "修改 AssemblyGraph 模板参数、ports/features 或对应局部 mesh 函数，保持 solver/verifier 通过。",
    targetFunction: targetFunctionForConstraint(check),
  };
}

function targetFunctionForConstraint(check: AssemblyConstraintCheck): string {
  if (/blade/i.test(check.constraintId)) return "buildFanBlades";
  if (/ring/i.test(check.constraintId)) return "buildOuterRing";
  if (/spinner/i.test(check.constraintId)) return "buildSpinner";
  if (/hub/i.test(check.constraintId)) return "buildRearHub";
  return "createScene";
}

function scenePatchFromUnknown(input: unknown): ScenePatch {
  return scenePatchSchema.parse(input);
}

function withOverall(scores: Partial<QualityScores> & Omit<QualityScores, "overall" | "embeddingSimilarity">): QualityScores {
  const normalized = {
    geometry: clamp01(scores.geometry),
    viewMatch: clamp01(scores.viewMatch),
    material: clamp01(scores.material),
    referenceSimilarity: clamp01(scores.referenceSimilarity),
    embeddingSimilarity: clamp01(scores.embeddingSimilarity ?? 0),
    renderHealth: clamp01(scores.renderHealth),
  };
  return {
    ...normalized,
    overall: normalized.embeddingSimilarity > 0
      ? clamp01(
          normalized.geometry * 0.28 +
            normalized.referenceSimilarity * 0.2 +
            normalized.embeddingSimilarity * 0.24 +
            normalized.viewMatch * 0.15 +
            normalized.material * 0.07 +
            normalized.renderHealth * 0.06,
        )
      : clamp01(
          normalized.geometry * 0.3 +
            normalized.referenceSimilarity * 0.3 +
            normalized.viewMatch * 0.2 +
            normalized.material * 0.1 +
            normalized.renderHealth * 0.1,
        ),
  };
}

function averageScore(values: number[]): number {
  if (!values.length) return 0;
  return clamp01(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function truncateForRepair(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]` : value;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function inferReviewCategory(request: QualityInspectionRequest): AircraftAssetCategory | undefined {
  const text = `${request.userGoal} ${request.scene.sceneType} ${request.scene.objects.map((object) => `${object.primitive} ${object.semanticRole} ${object.purpose}`).join(" ")}`.toLowerCase();
  if (/engine|turbofan|fan|blade|发动机|涡扇|涡轮|扇叶|叶片|中心锥|机匣/.test(text)) return "engine";
  if (/wing|airfoil|机翼|翼型/.test(text)) return "wing";
  if (/fuselage|机身|机体|机鼻|尾锥/.test(text)) return "fuselage";
  if (/landing|gear|起落架/.test(text)) return "landing_gear";
  if (/cockpit|canopy|驾驶舱|座舱/.test(text)) return "cockpit";
  return undefined;
}

function findObject(scene: SceneDsl, objectId?: string) {
  if (!objectId) return scene.objects[0];
  return scene.objects.find((object) => getObjectId(object) === objectId || object.id === objectId);
}

function getObjectId(object: SceneDsl["objects"][number] | undefined): string | undefined {
  return object?.objectId ?? object?.id;
}

function applySceneLevelValue(scene: SceneDsl, path: string, value: unknown): void {
  if (path === "sceneType") scene.sceneType = sceneDslSchema.shape.sceneType.parse(value);
  else if (path === "cameraPreset") scene.cameraPreset = sceneDslSchema.shape.cameraPreset.parse(value);
  else if (path === "lightingPreset") scene.lightingPreset = sceneDslSchema.shape.lightingPreset.parse(value);
  else if (path === "renderStyle") scene.renderStyle = sceneDslSchema.shape.renderStyle.parse(value);
  else if (path === "animations") scene.animations = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : scene.animations;
  else if (path === "qualityState" && isRecord(value)) scene.qualityState = { ...scene.qualityState, ...value };
}

function applyObjectLevelValue(object: SceneDsl["objects"][number], path: string, value: unknown): void {
  if (path === "primitive") object.primitive = sceneDslSchema.shape.objects.element.shape.primitive.parse(value);
  else if (path === "scale") {
    const multiplier = typeof value === "number" ? value : 1;
    object.scale = Math.min(Math.max(object.scale * multiplier, 0.2), 1.8);
  } else if (path === "position") object.position = sceneDslSchema.shape.objects.element.shape.position.parse(value);
  else if (path === "rotation") object.rotation = sceneDslSchema.shape.objects.element.shape.rotation.parse(value);
  else if (path === "material" && isRecord(value)) object.material = { ...object.material, ...value };
  else if (path === "semanticRole" && typeof value === "string") object.semanticRole = value;
  else if (path === "purpose" && typeof value === "string") object.purpose = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
