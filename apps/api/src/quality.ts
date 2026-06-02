import OpenAI from "openai";
import {
  type AppSettings,
  type QualityInspectionRequest,
  type QualityInspectionResult,
  type RuntimeComposerConfig,
  type SceneRevisionRequest,
  type SceneRevisionResult,
  qualityInspectionRequestSchema,
  qualityInspectionResultSchema,
  runtimeComposerConfigSchema,
  sceneRevisionRequestSchema,
  sceneRevisionResultSchema,
  sceneDslSchema,
} from "@agentic-three/shared";
import { getAppSettings, resolveModelConfig } from "./settings.js";

export async function inspectQuality(input: unknown, settings: AppSettings): Promise<QualityInspectionResult> {
  const request = qualityInspectionRequestSchema.parse(input);
  const config = runtimeComposerConfigSchema.parse(settings.runtimeComposer);
  const modelResult = await inspectWithVisionModel(request, settings).catch((error) => {
    console.warn("[agentic-three:quality] vision inspection fallback", error instanceof Error ? error.message : error);
    return undefined;
  });
  const inspected = modelResult ?? inspectWithHeuristics(request);
  return superviseQuality(inspected, config);
}

export function superviseQuality(result: QualityInspectionResult, config: RuntimeComposerConfig): QualityInspectionResult {
  const parsed = qualityInspectionResultSchema.parse(result);
  if (parsed.status === "ask_user" || parsed.status === "fallback") return parsed;
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
  if (parsed.score >= config.minQualityScore) {
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
  const scene = structuredClone(request.scene);
  const isHeart = /爱心|心形|桃心|heart|love|pink|粉色/.test(text);
  if (isHeart) {
    scene.sceneType = "component_detail";
    scene.renderStyle = "realistic";
    scene.lightingPreset = "studio_soft";
    scene.cameraPreset = "front";
    scene.objects = scene.objects.map((object, index) =>
      index === 0
        ? {
            ...object,
            primitive: "heart_3d",
            scale: Math.min((object.scale ?? 1) * 1.12, 1.55),
          }
        : object,
    );
    scene.animations = Array.from(new Set([...scene.animations, "heart_pulse"]));
  } else {
    scene.renderStyle = "technical_lines";
    scene.lightingPreset = "engineering_white";
  }
  if (/front|正面|白底|黑线|工程图|ppt/.test(text)) {
    scene.cameraPreset = "front";
  }
  if (/发动机|engine|涡扇|风扇|fan|叶片|blade/.test(text)) {
    scene.sceneType = "engine_showcase";
    scene.objects = scene.objects.map((object, index) =>
      index === 0
        ? {
            ...object,
            primitive: "turbofan_front",
            scale: Math.min((object.scale ?? 1) * 1.08, 1.45),
          }
        : object,
    );
  }
  if (/太小|占比|放大|主体/.test(text)) {
    scene.objects = scene.objects.map((object) => ({ ...object, scale: Math.min((object.scale ?? 1) * 1.12, 1.6) }));
  }
  scene.annotations = Array.from(
    new Set([
      ...scene.annotations,
      `第 ${request.round} 轮质检修订: ${request.quality.revisionHints.slice(0, 3).join("；") || "提高截图可用性"}`,
    ]),
  );
  return sceneRevisionResultSchema.parse({
    scene,
    summary: `已根据第 ${request.round} 轮质检结果修订 Scene DSL。`,
  });
}

async function reviseSceneWithModel(request: SceneRevisionRequest): Promise<SceneRevisionResult | undefined> {
  if (shouldSkipExternalModelCall()) return undefined;
  const settings = getAppSettings();
  const modelConfig = resolveModelConfig("summary", settings);
  const apiKey = process.env[modelConfig.apiKeyEnvName];
  if (!apiKey) return undefined;
  const client = new OpenAI({
    baseURL: modelConfig.baseURL,
    apiKey,
    defaultHeaders: { "X-Failover-Enabled": "true" },
  });
  const response = await client.chat.completions.create({
    model: modelConfig.model,
    stream: false,
    temperature: 0.2,
    max_tokens: Math.min(modelConfig.maxTokens, 1800),
    messages: [
      {
        role: "system",
        content:
          "你是 Scene DSL 修订 Agent。只输出 JSON 对象，不要 Markdown。你只能修改 Scene DSL，不写 three.js 源码。输出字段: scene, summary。",
      },
      {
        role: "user",
        content: `用户目标:\n${request.userGoal}\n\n当前 Scene DSL:\n${JSON.stringify(request.scene, null, 2)}\n\n质检报告:\n${JSON.stringify(request.quality, null, 2)}\n\n修订要求:\n- 保持 schema 合法。\n- 黑线白图/PPT 场景优先 renderStyle=technical_lines、lightingPreset=engineering_white。\n- 正面图优先 cameraPreset=front。\n- 发动机/螺旋桨/叶片相关优先 engine_showcase + turbofan_front。\n- 爱心/粉色/heart 相关优先 primitive=heart_3d、renderStyle=realistic、animations 包含 heart_pulse。\n- 输出 JSON: { "scene": ..., "summary": "..." }`,
      },
    ],
  });
  const content = response.choices[0]?.message?.content;
  if (!content) return undefined;
  const parsed = parseJsonObject(content) as { scene?: unknown; summary?: unknown };
  return sceneRevisionResultSchema.parse({
    scene: sceneDslSchema.parse(parsed.scene),
    summary: typeof parsed.summary === "string" ? parsed.summary : `已由模型修订第 ${request.round} 轮 Scene DSL。`,
  });
}

async function inspectWithVisionModel(
  request: QualityInspectionRequest,
  settings: AppSettings,
): Promise<QualityInspectionResult | undefined> {
  if (shouldSkipExternalModelCall()) return undefined;
  const modelConfig = resolveModelConfig("coder_agent", settings);
  const apiKey = process.env[modelConfig.apiKeyEnvName];
  if (!apiKey) return undefined;
  const client = new OpenAI({
    baseURL: modelConfig.baseURL,
    apiKey,
    defaultHeaders: { "X-Failover-Enabled": "true" },
  });
  const response = await client.chat.completions.create({
    model: modelConfig.model,
    stream: false,
    temperature: 0.2,
    max_tokens: 1200,
    messages: [
      {
        role: "system",
        content:
          "你是 three.js 预览质检 Agent。只输出 JSON，不要 Markdown。检查截图是否符合用户目标和参考图，字段为 status、score、issues、revisionHints、bestEffortReason。",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `用户目标:\n${request.userGoal}\n\nScene DSL:\n${JSON.stringify(request.scene, null, 2)}\n\n运行错误:\n${request.runtimeErrors.map((item) => item.message).join("\n") || "无"}\n\n请比较参考图和当前预览截图，判断是否通过。`,
          },
          ...request.referenceImages.flatMap((image) => [
            { type: "text" as const, text: `原始参考图: ${image.name}` },
            { type: "image_url" as const, image_url: { url: image.dataUrl } },
          ]),
          { type: "text", text: "当前 Sandpack 预览截图:" },
          { type: "image_url", image_url: { url: request.screenshotDataUrl } },
        ],
      },
    ],
  });
  const content = response.choices[0]?.message?.content;
  if (!content) return undefined;
  return qualityInspectionResultSchema.parse(parseJsonObject(content));
}

function inspectWithHeuristics(request: QualityInspectionRequest): QualityInspectionResult {
  const goal = request.userGoal.toLowerCase();
  const sceneText = `${request.scene.renderStyle} ${request.scene.cameraPreset} ${request.scene.animations.join(" ")} ${request.scene.objects
    .map((item) => item.primitive)
    .join(" ")}`.toLowerCase();
  const issues: string[] = [];
  const revisionHints: string[] = [];
  let score = 0.62;
  if (request.screenshotDataUrl.length < 8_000) {
    issues.push("预览截图数据过小，疑似空白或渲染失败。");
    revisionHints.push("检查 renderer 是否完成渲染，并提高主体可见性。");
    score -= 0.35;
  }
  const wantsTechnical = /黑线|白图|线稿|工程图|technical/.test(goal);
  if (wantsTechnical) {
    if (/technical_lines/.test(sceneText)) score += 0.08;
    else {
      issues.push("目标偏向黑线白图，但 Scene DSL 还不是 technical_lines。");
      revisionHints.push("切换 renderStyle 为 technical_lines。");
    }
  }
  const wantsFront = /正面|front/.test(goal);
  if (wantsFront) {
    if (/front/.test(sceneText)) score += 0.08;
    else {
      issues.push("目标需要正面图，当前相机预设不够明确。");
      revisionHints.push("把 cameraPreset 调整为 front。");
    }
  }
  if (/发动机|engine|turbofan|fan|叶片/.test(goal) && /turbofan_front/.test(sceneText)) score += 0.1;
  const wantsHeart = /爱心|心形|桃心|heart|love|pink|粉色/.test(goal);
  if (wantsHeart) {
    if (/heart_3d/.test(sceneText)) score += 0.14;
    else {
      issues.push("目标是粉色爱心，但 Scene DSL 没有使用 heart_3d。");
      revisionHints.push("把主对象 primitive 调整为 heart_3d。");
    }
    if (/heart_pulse/.test(sceneText)) score += 0.08;
    else {
      issues.push("目标需要动图效果，但 Scene DSL 没有 heart_pulse 动画。");
      revisionHints.push("在 animations 中加入 heart_pulse。");
    }
  }
  if (request.runtimeErrors.length) {
    issues.push("预览存在运行错误，需要先修复。");
    revisionHints.push("优先消除 runtime errors。");
    score -= 0.2;
  }
  const boundedScore = Math.max(0, Math.min(0.92, score));
  return qualityInspectionResultSchema.parse({
    status: boundedScore >= 0.75 ? "pass" : "revise",
    score: boundedScore,
    issues,
    revisionHints,
    bestEffortReason: issues.length ? "本地启发式质检无法完全替代多模态视觉判断。" : "",
  });
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("质检模型没有返回 JSON 对象。");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function shouldSkipExternalModelCall(): boolean {
  return Boolean(process.env.VITEST) && process.env.ENABLE_LLM_TESTS !== "1";
}
