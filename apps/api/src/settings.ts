import {
  type AppSettings,
  type ModelConfig,
  type ModelNode,
  modelNodeSchema,
  appSettingsSchema,
} from "@agentic-three/shared";
import { readSettings, writeSettings } from "./memory.js";
import { supportsImageInput } from "./modelCapabilities.js";
import { readEnvValue } from "./env.js";

const legacyFlashModel = "DeepSeek-V4-Flash";
const primaryCoderModel = "GLM-5V-Turbo";
const bigModelBaseURL = "https://open.bigmodel.cn/api/paas/v4";
const arkBaseURL = "https://ark.cn-beijing.volces.com/api/v3";
const doubaoCodeModel = "doubao-seed-2-0-code-preview-260215";

export const defaultSettings: AppSettings = appSettingsSchema.parse({
  screenshotMode: "download",
  enabledSkillIds: [
    "aircraft-parametric-modeling",
    "three-scene",
    "camera-light",
    "material-animation",
    "performance-safety",
    "threejs-fundamentals",
    "threejs-geometry",
    "threejs-materials",
    "threejs-lighting",
    "webgpu",
  ],
  runtimeComposer: {
    enabled: true,
    maxRevisionRounds: 3,
    minQualityScore: 0.75,
    autoCaptureAfterPatch: true,
    requireVisualInspection: true,
    captureDelayMs: 1200,
    nonBlankPixelThreshold: 0.02,
  },
  assetImport: {
    sourceDirectory: "",
    uploadDirectory: "assets/aircraft/imported",
  },
  visionReview: {
    models: [
      visionReviewModel(doubaoCodeModel, arkBaseURL, "ARK_API_KEY", 2000),
    ],
  },
  models: [
    nodeConfig("coder_agent", primaryCoderModel, 0.2, 16384, bigModelBaseURL, "ZHIPU_API_KEY"),
    nodeConfig("planner_agent", doubaoCodeModel, 0.2, 4096, arkBaseURL, "ARK_API_KEY"),
    nodeConfig("review_agent", doubaoCodeModel, 0.2, 2048, arkBaseURL, "ARK_API_KEY"),
    nodeConfig("summary", doubaoCodeModel, 0.2, 2048, arkBaseURL, "ARK_API_KEY"),
    nodeConfig("default", doubaoCodeModel, 0.7, 4096, arkBaseURL, "ARK_API_KEY"),
  ],
});

export function getAppSettings(): AppSettings {
  return normalizeSettings(readSettings(defaultSettings));
}

export function saveAppSettings(settings: AppSettings, secrets?: Record<string, string>): AppSettings {
  const saved = writeSettings(normalizeSettings(appSettingsSchema.parse(settings)));
  const secretNames = Object.entries(secrets ?? {}).filter(([, value]) => value.trim()).map(([key]) => key);
  if (secretNames.length) {
    console.warn(
      `[agentic-three:settings] 已忽略前端提交的密钥值: ${secretNames.join(", ")}。密钥只允许通过系统环境变量提供，不写入 .env。`,
    );
  }
  return saved;
}

function normalizeSettings(settings: AppSettings): AppSettings {
  const allowedNodes = new Set(modelNodeSchema.options);
  const visionModels = normalizeVisionReviewModels(settings.visionReview?.models ?? []);
  return appSettingsSchema.parse({
    ...settings,
    runtimeComposer: {
      ...defaultSettings.runtimeComposer,
      ...settings.runtimeComposer,
    },
    assetImport: {
      ...defaultSettings.assetImport,
      ...settings.assetImport,
    },
    visionReview: {
      ...defaultSettings.visionReview,
      ...settings.visionReview,
      models: visionModels,
    },
    models: settings.models
      .filter((model) => allowedNodes.has(model.node))
      .map((model) =>
        model.node === "coder_agent"
          ? { ...defaultModelForNode("coder_agent"), maxTokens: Math.max(model.maxTokens, 16384) }
          : model.model === legacyFlashModel || shouldMigrateModel(model)
            ? { ...model, ...defaultSettings.models.find((item) => item.node === model.node) }
            : model,
      ),
  });
}

export function resolveModelConfig(node: ModelNode, settings = getAppSettings()): ModelConfig {
  return (
    settings.models.find((item) => item.node === node) ??
    settings.models.find((item) => item.node === "default") ??
    defaultSettings.models.find((item) => item.node === "default")!
  );
}

export function envStatus(settings = getAppSettings()): Record<string, boolean> {
  const names = Array.from(new Set([
    ...settings.models.map((item) => item.apiKeyEnvName),
    ...settings.visionReview.models.map((item) => item.apiKeyEnvName),
  ]));
  return Object.fromEntries(names.map((name) => [name, Boolean(readEnvValue(name))]));
}

function normalizeVisionReviewModels(models: AppSettings["visionReview"]["models"]): AppSettings["visionReview"]["models"] {
  const doubaoModels = models.filter((model) => supportsImageInput(model) && /doubao-seed-2-0-code-preview/i.test(model.model));
  return doubaoModels.length ? doubaoModels : defaultSettings.visionReview.models;
}

function shouldMigrateModel(model: ModelConfig): boolean {
  if (model.node === "coder_agent") {
    return !(/glm-?5v/i.test(model.model) && /open\.bigmodel\.cn/i.test(model.baseURL));
  }
  if (/doubao-seed-2-0-code-preview/i.test(model.model) && /ark\.cn-beijing\.volces\.com/i.test(model.baseURL)) return false;
  if (model.node === "visionReview") return true;
  if (/mimo/i.test(model.model)) return true;
  if (/minimax/i.test(model.model)) return true;
  if (/deepseek/i.test(model.model)) return true;
  if (/kimi|qwen|glm/i.test(model.model)) return true;
  if (/ai\.gitee\.com/i.test(model.baseURL)) return true;
  if (/open\.bigmodel\.cn/i.test(model.baseURL)) return true;
  return false;
}

function defaultModelForNode(node: ModelNode): ModelConfig {
  return defaultSettings.models.find((item) => item.node === node) ?? defaultSettings.models.find((item) => item.node === "default")!;
}

function nodeConfig(
  node: ModelNode,
  model: string,
  temperature: number,
  maxTokens: number,
  baseURL = arkBaseURL,
  apiKeyEnvName = "ARK_API_KEY",
): ModelConfig {
  return {
    node,
    model,
    baseURL,
    apiKeyEnvName,
    temperature,
    maxTokens,
  };
}

function visionReviewModel(
  model: string,
  baseURL = arkBaseURL,
  apiKeyEnvName = "ARK_API_KEY",
  maxTokens = 1600,
): Omit<ModelConfig, "node"> {
  return {
    model,
    baseURL,
    apiKeyEnvName,
    temperature: 0.2,
    maxTokens,
  };
}
