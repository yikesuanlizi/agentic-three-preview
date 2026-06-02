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
} from "@agentic-three/shared";
import { resolveModelConfig } from "./settings.js";

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
  const text = `${request.userGoal}\n${request.quality.issues.join("\n")}\n${request.quality.revisionHints.join("\n")}`.toLowerCase();
  const scene = structuredClone(request.scene);
  scene.renderStyle = "technical_lines";
  scene.lightingPreset = "engineering_white";
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

async function inspectWithVisionModel(
  request: QualityInspectionRequest,
  settings: AppSettings,
): Promise<QualityInspectionResult | undefined> {
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
  const text = `${request.userGoal} ${request.scene.renderStyle} ${request.scene.cameraPreset} ${request.scene.objects
    .map((item) => item.primitive)
    .join(" ")}`.toLowerCase();
  const issues: string[] = [];
  const revisionHints: string[] = [];
  let score = 0.66;
  if (request.screenshotDataUrl.length < 8_000) {
    issues.push("预览截图数据过小，疑似空白或渲染失败。");
    revisionHints.push("检查 renderer 是否完成渲染，并提高主体可见性。");
    score -= 0.35;
  }
  if (/黑线|白图|线稿|technical_lines/.test(text)) score += 0.08;
  else {
    issues.push("目标偏向黑线白图，但 Scene DSL 还不是 technical_lines。");
    revisionHints.push("切换 renderStyle 为 technical_lines。");
  }
  if (/正面|front/.test(text)) score += 0.08;
  else {
    issues.push("目标需要正面图，当前相机预设不够明确。");
    revisionHints.push("把 cameraPreset 调整为 front。");
  }
  if (/发动机|engine|turbofan|fan|叶片/.test(text)) score += 0.08;
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
