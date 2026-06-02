import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import {
  type AppSettings,
  type ModelConfig,
  type ModelNode,
  modelNodeSchema,
  appSettingsSchema,
} from "@agentic-three/shared";
import { projectRoot, readSettings, writeSettings } from "./memory.js";

dotenv.config({ path: resolve(projectRoot, ".env") });

export const defaultSettings: AppSettings = appSettingsSchema.parse({
  screenshotMode: "download",
  enabledSkillIds: ["three-scene", "camera-light", "material-animation", "performance-safety", "webgpu"],
  runtimeComposer: {
    enabled: true,
    maxRevisionRounds: 3,
    minQualityScore: 0.75,
    autoCaptureAfterPatch: true,
    requireVisualInspection: true,
    captureDelayMs: 1200,
    nonBlankPixelThreshold: 0.02,
  },
  models: [
    nodeConfig("coder_agent", "Qwen3.5-122B-A10B", 0.2, 8192),
    nodeConfig("planner_agent", "DeepSeek-V4-Flash", 0.2, 1024),
    nodeConfig("review_agent", "DeepSeek-V4-Flash", 0.2, 1024),
    nodeConfig("summary", "DeepSeek-V4-Flash", 0.2, 2048),
    nodeConfig("default", "DeepSeek-V4-Flash", 0.7, 2048),
  ],
});

export function getAppSettings(): AppSettings {
  return normalizeSettings(readSettings(defaultSettings));
}

export function saveAppSettings(settings: AppSettings, secrets?: Record<string, string>): AppSettings {
  const saved = writeSettings(normalizeSettings(appSettingsSchema.parse(settings)));
  for (const [key, value] of Object.entries(secrets ?? {})) {
    if (value.trim()) {
      writeProjectEnvValue(key, value.trim());
      process.env[key] = value.trim();
    }
  }
  return saved;
}

function normalizeSettings(settings: AppSettings): AppSettings {
  const allowedNodes = new Set(modelNodeSchema.options);
  return appSettingsSchema.parse({
    ...settings,
    runtimeComposer: {
      ...defaultSettings.runtimeComposer,
      ...settings.runtimeComposer,
    },
    models: settings.models
      .filter((model) => allowedNodes.has(model.node))
      .map((model) =>
        model.node === "coder_agent"
          ? { ...model, model: "Qwen3.5-122B-A10B", maxTokens: Math.max(model.maxTokens, 8192) }
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
  const names = Array.from(new Set(settings.models.map((item) => item.apiKeyEnvName)));
  return Object.fromEntries(names.map((name) => [name, Boolean(process.env[name])]));
}

function nodeConfig(node: ModelNode, model: string, temperature: number, maxTokens: number): ModelConfig {
  return {
    node,
    model,
    baseURL: "https://ai.gitee.com/v1",
    apiKeyEnvName: "GITEE_API_KEY",
    temperature,
    maxTokens,
  };
}

function writeProjectEnvValue(key: string, value: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
    throw new Error(`环境变量名不合法: ${key}`);
  }
  const envPath = resolve(projectRoot, ".env");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = existing.split(/\r?\n/).filter((line, index, arr) => index < arr.length - 1 || line.length > 0);
  const nextLine = `${key}=${escapeEnvValue(value)}`;
  let replaced = false;
  const next = lines.map((line) => {
    if (line.match(new RegExp(`^\\s*${key}\\s*=`))) {
      replaced = true;
      return nextLine;
    }
    return line;
  });
  if (!replaced) next.push(nextLine);
  writeFileSync(envPath, `${next.join("\n")}\n`, "utf8");
}

function escapeEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value);
}
