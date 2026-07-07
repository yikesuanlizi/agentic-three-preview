import type { VisionReviewModelConfig } from "@agentic-three/shared";

export type ModelLike = {
  model: string;
  baseURL: string;
  apiKeyEnvName: string;
  temperature: number;
  maxTokens: number;
};

export function supportsImageInput(model: ModelLike): boolean {
  if (/doubao-seed-2-0-code-preview/i.test(model.model)) return true;
  if (/mimo|deepseek|doubao/i.test(model.model)) return false;
  if (/glm-?5v|glm.*vision|minimax|qwen.*vl|qwen3\.[56]|kimi-k2\.6/i.test(model.model)) return true;
  return false;
}

export function doubaoCodePreviewFallback(reference?: Partial<ModelLike>): VisionReviewModelConfig {
  return {
    model: "doubao-seed-2-0-code-preview-260215",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnvName: "ARK_API_KEY",
    temperature: reference?.temperature ?? 0.2,
    maxTokens: Math.max(reference?.maxTokens ?? 8192, 8192),
  };
}

export function dedupeModels<T extends ModelLike>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.baseURL}:${model.apiKeyEnvName}:${model.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function appendExpensiveVisionFallback<T extends ModelLike>(models: T[]): Array<T | VisionReviewModelConfig> {
  const reference = models[0];
  return dedupeModels([
    ...models,
    doubaoCodePreviewFallback(reference),
  ]);
}
