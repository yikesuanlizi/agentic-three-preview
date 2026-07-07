import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import OpenAI from "openai";
import type { RetrievalSearchResult } from "@agentic-three/shared";
import { projectRoot } from "./memory.js";
import { readEnvValue } from "./env.js";

const FALLBACK_DIMENSION = 384;
const DEFAULT_EMBEDDING_MODEL = "Qwen3-VL-Embedding-8B";
const DEFAULT_RERANK_MODEL = "Qwen3-VL-Reranker-8B";

type RagEmbeddingInput = {
  text: string;
  imagePath?: string;
};

export async function embedText(text: string): Promise<number[]> {
  return embedRagInput({ text });
}

export async function embedRagInput(input: RagEmbeddingInput): Promise<number[]> {
  const model = process.env.RAG_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const apiKey = readEnvValue("GITEE_API_KEY");
  if (apiKey) {
    try {
      const client = new OpenAI({
        baseURL: process.env.RAG_EMBEDDING_BASE_URL ?? "https://ai.gitee.com/v1",
        apiKey,
        defaultHeaders: { "X-Failover-Enabled": "true" },
      });
      const textInput = [
        input.text.slice(0, 7600),
        input.imagePath ? `\n[image_path] ${input.imagePath}` : "",
      ].filter(Boolean).join("");
      const payload = shouldAttemptImageEmbedding() && input.imagePath && existsSync(resolveProjectPath(input.imagePath))
        ? { image: imageToDataUrl(input.imagePath), text: input.text.slice(0, 4000) }
        : textInput;
      const response = await client.embeddings.create({
        model,
        input: [payload],
      } as never);
      const embedding = response.data[0]?.embedding;
      if (embedding?.length) return normalizeVector(embedding);
    } catch (error) {
      console.warn("[agentic-three:rag] Gitee 多模态 embedding fallback", error instanceof Error ? error.message : String(error));
    }
  }
  return hashEmbedding([input.text, input.imagePath ?? ""].join("\n"));
}

function shouldAttemptImageEmbedding(): boolean {
  return process.env.RAG_ENABLE_IMAGE_EMBEDDING === "1";
}

export async function rerankRagResults(query: string, results: RetrievalSearchResult[]): Promise<RetrievalSearchResult[]> {
  const apiKey = readEnvValue("GITEE_API_KEY");
  if (!apiKey || !results.length) return results;
  try {
    const response = await fetch(process.env.RAG_RERANK_URL ?? "https://ai.gitee.com/v1/rerank/multimodal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: { text: query },
        documents: results.map((result) => buildRerankDocument(result)),
        model: process.env.RAG_RERANK_MODEL ?? DEFAULT_RERANK_MODEL,
        return_documents: false,
      }),
    });
    if (!response.ok) throw new Error(`rerank ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as { results?: Array<{ index?: number; relevance_score?: number; score?: number }> };
    const ranked = (data.results ?? [])
      .map((item) => ({
        index: Number(item.index),
        score: Number(item.relevance_score ?? item.score ?? 0),
      }))
      .filter((item) => Number.isInteger(item.index) && item.index >= 0 && item.index < results.length);
    if (!ranked.length) return results;
    const used = new Set<number>();
    const reranked = ranked.map((item) => {
      used.add(item.index);
      return { ...results[item.index]!, score: Math.max(results[item.index]!.score, item.score) };
    });
    return [...reranked, ...results.filter((_result, index) => !used.has(index))];
  } catch (error) {
    console.warn("[agentic-three:rag] Gitee 多模态 rerank fallback", error instanceof Error ? error.message : String(error));
    return results;
  }
}

function buildRerankDocument(result: RetrievalSearchResult): { text: string } | { image: string } {
  if (result.imagePath) {
    const fullPath = resolveProjectPath(result.imagePath);
    if (existsSync(fullPath)) {
      return { image: imageToBase64(result.imagePath) };
    }
  }
  return {
    text: [result.title, result.description, result.tags.join(" "), result.view ? `视角: ${result.view}` : ""].filter(Boolean).join("\n"),
  };
}

function imageToDataUrl(relativePath: string): string {
  return `data:${mimeType(relativePath)};base64,${imageToBase64(relativePath)}`;
}

function imageToBase64(relativePath: string): string {
  return readFileSync(resolveProjectPath(relativePath)).toString("base64");
}

function resolveProjectPath(relativePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    throw new Error(`RAG 路径必须在项目内: ${relativePath}`);
  }
  if (relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`RAG 路径不能逃逸项目目录: ${relativePath}`);
  }
  return resolve(projectRoot, relativePath);
}

function mimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function hashEmbedding(text: string): number[] {
  const vector = new Array<number>(FALLBACK_DIMENSION).fill(0);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const index = Math.abs(hash) % FALLBACK_DIMENSION;
    vector[index] = (vector[index] ?? 0) + (hash > 0 ? 1 : -1);
  }
  return normalizeVector(vector);
}

function normalizeVector(values: number[]): number[] {
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / length);
}

function tokenize(text: string): string[] {
  const english = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const chinese = ["发动机", "涡扇", "机翼", "机身", "起落架", "驾驶舱", "黑线", "白图", "线稿", "正面", "侧面", "俯视", "六视图", "截图", "glb", "gltf"].filter((word) =>
    text.includes(word),
  );
  return [...english, ...chinese];
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}
