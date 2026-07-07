import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { ImageInput, QualityReviewView, QualityScreenshot, VisualEmbeddingMatch } from "@agentic-three/shared";
import { readEnvValue } from "./env.js";
import { readVisualEmbeddingCache, writeVisualEmbeddingCache } from "./memory.js";

const DEFAULT_VISUAL_EMBEDDING_MODEL = "Qwen3-VL-Embedding-8B";
const DEFAULT_VISUAL_EMBEDDING_DIMENSION = 2048;
const MIN_VISUAL_EMBEDDING_DIMENSION = 64;
const MAX_VISUAL_EMBEDDING_DIMENSION = 4096;
const DEFAULT_VISUAL_EMBEDDING_BASE_URL = "https://ai.gitee.com/v1";

export type VisualEmbeddingConfig = {
  model: string;
  baseURL: string;
  apiKeyEnvName: string;
  dimension: number;
};

export type VisualEmbeddingResult = {
  embedding: number[];
  model: string;
  dimension: number;
  fallbackReason?: string;
  cached: boolean;
};

export type VisualEmbeddingComparison = {
  matches: VisualEmbeddingMatch[];
  score: number;
  matchedView?: QualityReviewView;
  model: string;
  dimension: number;
  fallbackReason?: string;
};

type EmbeddingRunner = (input: {
  config: VisualEmbeddingConfig;
  text: string;
  imageDataUrl: string;
}) => Promise<number[]>;

export function resolveVisualEmbeddingConfig(): VisualEmbeddingConfig {
  return {
    model: process.env.VISUAL_EMBEDDING_MODEL ?? process.env.RAG_EMBEDDING_MODEL ?? DEFAULT_VISUAL_EMBEDDING_MODEL,
    baseURL: process.env.VISUAL_EMBEDDING_BASE_URL ?? process.env.RAG_EMBEDDING_BASE_URL ?? DEFAULT_VISUAL_EMBEDDING_BASE_URL,
    apiKeyEnvName: process.env.VISUAL_EMBEDDING_API_KEY_ENV ?? "GITEE_API_KEY",
    dimension: resolveVisualEmbeddingDimension(),
  };
}

export async function compareReferenceAndScreenshots(input: {
  userGoal: string;
  referenceImages: ImageInput[];
  screenshots: Array<Pick<QualityScreenshot, "view" | "dataUrl">>;
  preferredView?: QualityReviewView;
  runner?: EmbeddingRunner;
}): Promise<VisualEmbeddingComparison | undefined> {
  if (!input.referenceImages.length || !input.screenshots.length) return undefined;
  const config = resolveVisualEmbeddingConfig();
  const referenceEmbeddings = await Promise.all(input.referenceImages.map((image, index) =>
    embedImageText({
      config,
      text: `用户参考图 ${index + 1}: ${image.name}\n${input.userGoal}`,
      imageDataUrl: image.dataUrl,
      runner: input.runner,
    }),
  ));
  const screenshotEmbeddings = await Promise.all(input.screenshots.map((screenshot) =>
    embedImageText({
      config,
      text: `当前 Sandpack 生成模型截图: ${screenshot.view}\n${input.userGoal}`,
      imageDataUrl: screenshot.dataUrl,
      runner: input.runner,
    }),
  ));
  const matches: VisualEmbeddingMatch[] = [];
  for (let refIndex = 0; refIndex < input.referenceImages.length; refIndex += 1) {
    const reference = referenceEmbeddings[refIndex]!;
    for (let shotIndex = 0; shotIndex < input.screenshots.length; shotIndex += 1) {
      const screenshot = input.screenshots[shotIndex]!;
      const current = screenshotEmbeddings[shotIndex]!;
      matches.push({
        referenceName: input.referenceImages[refIndex]?.name ?? `reference-${refIndex + 1}`,
        referenceIndex: refIndex,
        screenshotView: screenshot.view,
        similarity: cosineSimilarity(reference.embedding, current.embedding),
        model: current.model || reference.model,
        dimension: current.dimension,
        matched: false,
        fallbackReason: [reference.fallbackReason, current.fallbackReason].filter(Boolean).join(" | "),
      });
    }
  }
  const selected = selectMatchedEmbeddingRows(matches, input.referenceImages.length, input.preferredView);
  const selectedKeys = new Set(selected.map((item) => `${item.referenceIndex}:${item.screenshotView}`));
  const marked = matches.map((match) => ({ ...match, matched: selectedKeys.has(`${match.referenceIndex}:${match.screenshotView}`) }));
  const score = selected.length
    ? selected.reduce((sum, match) => sum + normalizeSimilarity(match.similarity), 0) / selected.length
    : 0;
  return {
    matches: marked,
    score: clamp01(score),
    matchedView: input.referenceImages.length === 1 ? selected[0]?.screenshotView : undefined,
    model: config.model,
    dimension: config.dimension,
    fallbackReason: Array.from(new Set(marked.map((match) => match.fallbackReason).filter(Boolean))).join(" | "),
  };
}

export async function embedImageText(input: {
  config?: VisualEmbeddingConfig;
  text: string;
  imageDataUrl: string;
  runner?: EmbeddingRunner;
}): Promise<VisualEmbeddingResult> {
  const config = input.config ?? resolveVisualEmbeddingConfig();
  const cacheKey = visualEmbeddingCacheKey(config, input.text, input.imageDataUrl);
  const cached = readVisualEmbeddingCache(cacheKey);
  if (cached && cached.dimension === config.dimension && cached.embedding.length === config.dimension) {
    return {
      embedding: normalizeVector(cached.embedding),
      model: cached.model,
      dimension: cached.dimension,
      fallbackReason: cached.fallbackReason,
      cached: true,
    };
  }
  let embedding: number[];
  let fallbackReason = "";
  try {
    if (!input.runner && shouldSkipExternalEmbedding()) throw new Error("当前环境跳过外部视觉 embedding 调用");
    embedding = input.runner
      ? await input.runner({ config, text: input.text, imageDataUrl: input.imageDataUrl })
      : await callEmbeddingProvider({ config, text: input.text, imageDataUrl: input.imageDataUrl });
    if (embedding.length !== config.dimension) {
      throw new Error(`embedding 维度不匹配: expected ${config.dimension}, got ${embedding.length}`);
    }
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error);
    embedding = hashImageTextEmbedding(`${input.text}\n${input.imageDataUrl}`, config.dimension);
  }
  const normalized = normalizeVector(embedding);
  writeVisualEmbeddingCache({
    cacheKey,
    model: fallbackReason ? `${config.model}:local-hash-fallback` : config.model,
    dimension: config.dimension,
    embedding: normalized,
    fallbackReason,
  });
  return {
    embedding: normalized,
    model: fallbackReason ? `${config.model}:local-hash-fallback` : config.model,
    dimension: config.dimension,
    fallbackReason,
    cached: false,
  };
}

async function callEmbeddingProvider(input: {
  config: VisualEmbeddingConfig;
  text: string;
  imageDataUrl: string;
}): Promise<number[]> {
  const apiKey = readEnvValue(input.config.apiKeyEnvName);
  if (!apiKey) throw new Error(`未配置 ${input.config.apiKeyEnvName}`);
  const client = new OpenAI({
    apiKey,
    baseURL: input.config.baseURL,
    defaultHeaders: { "X-Failover-Enabled": "true" },
  });
  const payloads: unknown[] = [
    [{ type: "text", text: input.text.slice(0, 2000) }, { type: "image_url", image_url: { url: input.imageDataUrl } }],
    [{ text: input.text.slice(0, 2000), image_url: input.imageDataUrl }],
    [{ text: input.text.slice(0, 2000), image: input.imageDataUrl }],
  ];
  const failures: string[] = [];
  for (const payload of payloads) {
    try {
      const response = await client.embeddings.create({
        model: input.config.model,
        input: payload,
        dimensions: input.config.dimension,
      } as never);
      const embedding = response.data[0]?.embedding;
      if (embedding?.length) return embedding;
      throw new Error("embedding 响应为空");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`视觉 embedding 调用失败: ${failures.join(" | ")}`);
}

function selectMatchedEmbeddingRows(
  matches: VisualEmbeddingMatch[],
  referenceCount: number,
  preferredView?: QualityReviewView,
): VisualEmbeddingMatch[] {
  if (!matches.length) return [];
  if (referenceCount === 1 && preferredView) {
    const preferred = matches.find((match) => match.referenceIndex === 0 && match.screenshotView === preferredView);
    if (preferred) return [preferred];
  }
  const selected: VisualEmbeddingMatch[] = [];
  for (let index = 0; index < referenceCount; index += 1) {
    const best = matches
      .filter((match) => match.referenceIndex === index)
      .sort((a, b) => b.similarity - a.similarity)[0];
    if (best) selected.push(best);
  }
  return selected;
}

function resolveVisualEmbeddingDimension(): number {
  const raw = Number(process.env.VISUAL_EMBEDDING_DIM ?? process.env.RAG_EMBEDDING_DIM ?? DEFAULT_VISUAL_EMBEDDING_DIMENSION);
  if (!Number.isFinite(raw)) return DEFAULT_VISUAL_EMBEDDING_DIMENSION;
  return Math.max(MIN_VISUAL_EMBEDDING_DIMENSION, Math.min(MAX_VISUAL_EMBEDDING_DIMENSION, Math.trunc(raw)));
}

function visualEmbeddingCacheKey(config: VisualEmbeddingConfig, text: string, imageDataUrl: string): string {
  return createHash("sha256")
    .update("visual-quality-embedding-v1")
    .update(config.model)
    .update(String(config.dimension))
    .update(text)
    .update(dataUrlDigest(imageDataUrl))
    .digest("hex");
}

function dataUrlDigest(dataUrl: string): string {
  const base64 = dataUrl.replace(/^data:[^;]+;base64,/i, "");
  return createHash("sha256").update(base64).digest("hex");
}

function shouldSkipExternalEmbedding(): boolean {
  return Boolean(process.env.VITEST) && process.env.ENABLE_EMBEDDING_TESTS !== "1";
}

function hashImageTextEmbedding(value: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (let index = 0; index < value.length; index += 1) {
    const chunk = `${index}:${value.charCodeAt(index)}:${value.slice(Math.max(0, index - 8), index + 8)}`;
    const hash = createHash("sha256").update(chunk).digest();
    const bucket = hash.readUInt32BE(0) % dimension;
    vector[bucket] = (vector[bucket] ?? 0) + (hash[4]! > 127 ? 1 : -1);
  }
  return normalizeVector(vector);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  const denominator = Math.sqrt(aNorm) * Math.sqrt(bNorm);
  return denominator > 0 ? dot / denominator : 0;
}

function normalizeSimilarity(value: number): number {
  return clamp01((value + 1) / 2);
}

function normalizeVector(values: number[]): number[] {
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / length);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
