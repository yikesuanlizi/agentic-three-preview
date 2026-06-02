import OpenAI from "openai";

const FALLBACK_DIMENSION = 384;

export async function embedText(text: string): Promise<number[]> {
  const model = process.env.RAG_EMBEDDING_MODEL;
  const apiKey = process.env.GITEE_API_KEY;
  if (model && apiKey) {
    try {
      const client = new OpenAI({
        baseURL: process.env.RAG_EMBEDDING_BASE_URL ?? "https://ai.gitee.com/v1",
        apiKey,
        defaultHeaders: { "X-Failover-Enabled": "true" },
      });
      const response = await client.embeddings.create({
        model,
        input: text.slice(0, 8000),
      });
      const embedding = response.data[0]?.embedding;
      if (embedding?.length) return normalizeVector(embedding);
    } catch (error) {
      console.warn("[agentic-three:rag] embedding fallback", error instanceof Error ? error.message : String(error));
    }
  }
  return hashEmbedding(text);
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.map((value) => Number(value.toFixed(6))).join(",")}]`;
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
  const chinese = ["发动机", "涡扇", "机翼", "机身", "起落架", "驾驶舱", "黑线", "白图", "线稿", "正面", "侧面", "俯视", "六视图", "截图"].filter((word) =>
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
