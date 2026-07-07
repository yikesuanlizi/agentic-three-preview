import {
  type AgentTurnRequest,
  type AppSettings,
  type VisionReviewModelConfig,
  type VisualIntent,
  visualIntentSchema,
} from "@agentic-three/shared";
import { appendExpensiveVisionFallback, dedupeModels, supportsImageInput } from "./modelCapabilities.js";
import { streamModelCompletion, type ChatMessageContent } from "./modelRuntime.js";

const VISUAL_INTENT_TIMEOUT_MS = 18_000;

export type VisualIntentModelCaller = (input: {
  modelConfig: VisionReviewModelConfig;
  request: AgentTurnRequest;
  normalizedGoal: string;
}) => Promise<unknown>;

export async function extractVisualIntent(input: {
  request: AgentTurnRequest;
  normalizedGoal: string;
  settings: AppSettings;
  skipExternal?: boolean;
  caller?: VisualIntentModelCaller;
}): Promise<VisualIntent> {
  const rules = inferVisualIntentByRules(input.request, input.normalizedGoal);
  if (!input.request.images.length) return rules;

  const models = selectVisualIntentModelConfigs(input.settings);
  const shouldSkip = input.skipExternal ?? shouldSkipExternalModelCall();
  if (!shouldSkip) {
    const failures: string[] = [];
    for (const modelConfig of models) {
      try {
        const raw = await withTimeout(
          (input.caller ?? callVisualIntentModel)({
            modelConfig,
            request: input.request,
            normalizedGoal: input.normalizedGoal,
          }),
          VISUAL_INTENT_TIMEOUT_MS,
          `visualIntent ${modelConfig.model} 超过 ${Math.round(VISUAL_INTENT_TIMEOUT_MS / 1000)} 秒`,
        );
        const parsed = normalizeVisualIntent(raw, modelConfig.model);
        return mergeVisualIntent(rules, parsed);
      } catch (error) {
        failures.push(`${modelConfig.model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return visualIntentSchema.parse({
      ...rules,
      fallbackReason: `视觉模型不可用，已退回规则解析: ${failures.join(" | ")}`,
    });
  }

  return visualIntentSchema.parse({
    ...rules,
    fallbackReason: "测试环境或禁用外部模型，已使用规则解析。",
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function selectVisualIntentModelConfigs(settings: AppSettings): VisionReviewModelConfig[] {
  const configured = settings.visionReview.models.length ? settings.visionReview.models : [];
  const priority = (model: VisionReviewModelConfig) =>
    /doubao-seed-2-0-code-preview/i.test(model.model)
      ? 0
      : /kimi-k2\.6/i.test(model.model)
        ? 1
        : /qwen3\.6/i.test(model.model)
          ? 2
          : /glm-?5v/i.test(model.model)
            ? 3
            : 5;
  const ordered = configured
    .filter(supportsImageInput)
    .sort((a, b) => priority(a) - priority(b));
  const defaults: VisionReviewModelConfig[] = [
    {
      model: "doubao-seed-2-0-code-preview-260215",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyEnvName: "ARK_API_KEY",
      temperature: 0.2,
      maxTokens: 2000,
    },
  ];
  return dedupeModels(appendExpensiveVisionFallback(ordered.length ? ordered : defaults) as VisionReviewModelConfig[]);
}

export function inferVisualIntentByRules(request: AgentTurnRequest, normalizedGoal = request.message): VisualIntent {
  const text = `${request.message}\n${normalizedGoal}`.toLowerCase();
  const isDecorative = /heart|love|爱心|心形|桃心|粉色|pink|星星|star|礼物|gift|球|sphere|抽象|装饰|logo|图标/.test(text);
  const isEngine = /engine|turbofan|fan|发动机|涡扇|进气口|叶片|blade/.test(text);
  const isWing = /wing|airfoil|机翼|翼型/.test(text);
  const isFuselage = /fuselage|机身|机体/.test(text);
  const isGear = /gear|wheel|起落架|轮胎/.test(text);
  const category = isEngine ? "engine" : isWing ? "wing" : isFuselage ? "fuselage" : isGear ? "landing_gear" : undefined;
  const view = /侧面|side/.test(text) ? "side" : /俯视|top/.test(text) ? "top" : /三分|three.?quarter|斜/.test(text) ? "three_quarter" : "front";
  const renderStyle = /黑线|白图|线稿|工程|technical/.test(text) ? "technical_lines" : isDecorative ? "realistic" : "engineering_white";
  const subject = isDecorative
    ? "general decorative 3D scene"
    : isEngine
      ? "turbofan engine"
      : isWing
        ? "aircraft wing"
        : isFuselage
          ? "aircraft fuselage"
          : isGear
            ? "aircraft landing gear"
            : "aircraft component";
  const visualFeatures = [
    category ? `文字规则识别类别: ${category}` : "",
    request.images.length ? "存在上传图片，但规则解析不读取图片像素。" : "",
  ].filter(Boolean);
  return visualIntentSchema.parse({
    subject,
    category,
    view,
    renderStyle,
    retrievalQuery: [request.message, subject, category, renderStyle, view].filter(Boolean).join(" "),
    visualFeatures,
    geometryHints: categoryGeometryHints(category),
    materialHints: renderStyle === "technical_lines" ? ["白底黑线", "线框/边线优先", "弱化实体材质"] : [],
    codeHints: categoryCodeHints(category),
    confidence: category ? 0.55 : 0.25,
    modelUsed: "local-rules",
  });
}

export function normalizeVisualIntent(input: unknown, modelUsed: string): VisualIntent {
  const object = typeof input === "string" ? parseJsonObject(input) : input;
  const record = object && typeof object === "object" && !Array.isArray(object) ? object as Record<string, unknown> : {};
  return visualIntentSchema.parse({
    subject: stringValue(record.subject, "aircraft component"),
    category: normalizeCategory(record.category),
    view: normalizeView(record.view),
    renderStyle: normalizeRenderStyle(record.renderStyle),
    referenceView: normalizeOptionalQualityView(record.referenceView ?? record.view),
    referenceFeatures: normalizeFeaturePoints(record.referenceFeatures),
    featureExpectations: normalizeFeatureExpectations(record.featureExpectations),
    retrievalQuery: stringValue(record.retrievalQuery, ""),
    visualFeatures: stringArray(record.visualFeatures),
    geometryHints: stringArray(record.geometryHints),
    materialHints: stringArray(record.materialHints),
    codeHints: stringArray(record.codeHints),
    confidence: numberValue(record.confidence, 0.6),
    modelUsed,
    fallbackReason: stringValue(record.fallbackReason, ""),
  });
}

function mergeVisualIntent(rules: VisualIntent, model: VisualIntent): VisualIntent {
  return visualIntentSchema.parse({
    ...rules,
    ...model,
    retrievalQuery: model.retrievalQuery || rules.retrievalQuery,
    visualFeatures: Array.from(new Set([...model.visualFeatures, ...rules.visualFeatures])).slice(0, 12),
    geometryHints: Array.from(new Set([...model.geometryHints, ...rules.geometryHints])).slice(0, 12),
    materialHints: Array.from(new Set([...model.materialHints, ...rules.materialHints])).slice(0, 12),
    codeHints: Array.from(new Set([...model.codeHints, ...rules.codeHints])).slice(0, 12),
  });
}

async function callVisualIntentModel(input: {
  modelConfig: VisionReviewModelConfig;
  request: AgentTurnRequest;
  normalizedGoal: string;
}): Promise<unknown> {
  const messages: Array<{ role: "system" | "user"; content: ChatMessageContent }> = [
    {
      role: "system",
      content:
        "你是 3D 航空建模 visualIntent 解析器。看用户图片和文字，只输出 JSON，不输出 Markdown。字段: subject, category, view, renderStyle, retrievalQuery, visualFeatures, geometryHints, materialHints, codeHints, confidence。",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `用户目标:\n${input.normalizedGoal}\n\n要求:\n- category 只能是 engine/wing/fuselage/landing_gear/cockpit/material/environment 之一，无法判断可省略。\n- view 只能是 front/side/top/three_quarter/cinematic_closeup。\n- referenceView 必须是 front/side/top/three_quarter，表示用户参考图主要应比较的视角。\n- renderStyle 只能是 technical_lines/realistic/engineering_white/ppt_clean。\n- retrievalQuery 要适合检索相似 GLB 和 three.js 源码。\n- referenceFeatures 标注参考图关键部位，坐标 x/y 用 0-1 归一化，优先标注中心孔、轮毂、螺栓孔、叶片根部、叶尖轮廓、前缘/后缘、外轮廓包络、弯曲方向。\n- featureExpectations 描述这些特征映射到 3D 建模时应满足的参数或形态。\n- codeHints 要给 coder 可转译为 three.js primitive/函数的提示。`,
        },
        ...input.request.images.map((image) => ({
          type: "image_url" as const,
          image_url: { url: image.dataUrl },
        })),
      ],
    },
  ];
  const { text, reasoning } = await streamModelCompletion(
    { ...input.modelConfig, maxTokens: Math.min(input.modelConfig.maxTokens, 1200) },
    messages,
  );
  const content = text.trim() ? text : reasoning;
  if (!content) throw new Error("视觉模型返回为空");
  return content;
}

function normalizeOptionalQualityView(value: unknown): VisualIntent["referenceView"] {
  if (value === "front" || value === "side" || value === "top" || value === "three_quarter") return value;
  if (value === "cinematic_closeup") return "three_quarter";
  return undefined;
}

function normalizeFeaturePoints(value: unknown): VisualIntent["referenceFeatures"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      const label = stringValue(record.label, "");
      if (!label) return undefined;
      return {
        id: stringValue(record.id, `feature-${index + 1}`),
        label,
        part: stringValue(record.part, ""),
        view: normalizeOptionalQualityView(record.view),
        x: numberValue(record.x, 0.5),
        y: numberValue(record.y, 0.5),
        confidence: numberValue(record.confidence, 0.6),
        kind: normalizeFeatureKind(record.kind),
        parameterHint: stringValue(record.parameterHint, ""),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 24);
}

function normalizeFeatureExpectations(value: unknown): VisualIntent["featureExpectations"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      const label = stringValue(record.label, "");
      if (!label) return undefined;
      return {
        id: stringValue(record.id, `expectation-${index + 1}`),
        label,
        part: stringValue(record.part, ""),
        view: normalizeOptionalQualityView(record.view),
        expected: stringValue(record.expected, ""),
        parameterHint: stringValue(record.parameterHint, ""),
        priority: normalizeExpectationPriority(record.priority),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 24);
}

function normalizeFeatureKind(value: unknown): NonNullable<VisualIntent["referenceFeatures"]>[number]["kind"] {
  if (
    value === "center" ||
    value === "edge" ||
    value === "contour" ||
    value === "axis" ||
    value === "hole" ||
    value === "bolt" ||
    value === "blade_root" ||
    value === "blade_tip"
  ) return value;
  return "point";
}

function normalizeExpectationPriority(value: unknown): NonNullable<VisualIntent["featureExpectations"]>[number]["priority"] {
  if (value === "critical" || value === "high") return value;
  return "normal";
}

function categoryGeometryHints(category: VisualIntent["category"]): string[] {
  if (category === "engine") return ["外涵道圆环", "内涵道圆环", "放射状风扇叶片", "中心整流锥"];
  if (category === "wing") return ["翼型截面", "后掠平面轮廓", "翼肋/分段结构线"];
  if (category === "fuselage") return ["长筒机身", "椭圆截面", "机鼻和尾部收缩"];
  if (category === "landing_gear") return ["轮胎圆环", "支柱圆柱", "斜撑连杆"];
  return [];
}

function categoryCodeHints(category: VisualIntent["category"]): string[] {
  if (category === "engine") return ["TorusGeometry 表达外环/内环", "BoxGeometry 或 Shape 做扭转叶片", "SphereGeometry 缩放为中心锥", "EdgesGeometry/LineSegments 输出工程线稿"];
  if (category === "wing") return ["Shape/ExtrudeGeometry 表达翼型面", "LineSegments 绘制翼肋和蒙皮分割线"];
  if (category === "fuselage") return ["CylinderGeometry/LatheGeometry 表达机身", "曲线或缩放圆柱表达机鼻尾锥"];
  if (category === "landing_gear") return ["TorusGeometry 做轮胎", "CylinderGeometry 做支柱和连杆"];
  return [];
}

function normalizeCategory(value: unknown): VisualIntent["category"] | undefined {
  if (value === "engine" || value === "wing" || value === "fuselage" || value === "landing_gear" || value === "cockpit" || value === "material" || value === "environment") return value;
  return undefined;
}

function normalizeView(value: unknown): VisualIntent["view"] {
  if (value === "side" || value === "top" || value === "three_quarter" || value === "cinematic_closeup") return value;
  return "front";
}

function normalizeRenderStyle(value: unknown): VisualIntent["renderStyle"] {
  if (value === "realistic" || value === "engineering_white" || value === "ppt_clean") return value;
  return "technical_lines";
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("视觉模型没有返回 JSON 对象");
  const objectText = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(objectText);
  } catch (error) {
    return JSON.parse(repairJsonObjectText(objectText));
  }
}

function repairJsonObjectText(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, value: string) => JSON.stringify(value));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 12) : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function shouldSkipExternalModelCall(): boolean {
  return Boolean(process.env.VITEST) && process.env.ENABLE_LLM_TESTS !== "1";
}
