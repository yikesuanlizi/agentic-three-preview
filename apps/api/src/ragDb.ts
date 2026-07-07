import { DataType, MetricType, MilvusClient } from "@zilliz/milvus2-sdk-node";

export const RAG_COLLECTION = process.env.RAG_MILVUS_COLLECTION ?? "agentic_three_rag";
export const ragDatabaseUrl = process.env.RAG_MILVUS_ADDRESS ?? "127.0.0.1:19530";

let client: MilvusClient | undefined;
let lastHealthError = "";

export function getRagClient(): MilvusClient {
  client ??= new MilvusClient({
    address: ragDatabaseUrl,
    token: process.env.RAG_MILVUS_TOKEN,
    username: process.env.RAG_MILVUS_USERNAME,
    password: process.env.RAG_MILVUS_PASSWORD,
  });
  return client;
}

export function resetRagClient(): void {
  try {
    const closable = client as unknown as { close?: () => void | Promise<void> } | undefined;
    void closable?.close?.();
  } catch {
    // Some SDK versions do not expose close; dropping the cached client is enough for reconnect.
  } finally {
    client = undefined;
  }
}

export function getRagHealthError(): string {
  return lastHealthError;
}

export function isRagFallbackForced(): boolean {
  return process.env.RAG_FORCE_FALLBACK === "1";
}

export async function isRagDatabaseReady(): Promise<boolean> {
  if (isRagFallbackForced()) {
    lastHealthError = "RAG_FORCE_FALLBACK=1，已强制使用本地 fallback。";
    return false;
  }
  try {
    await getRagClient().checkHealth();
    lastHealthError = "";
    return true;
  } catch (error) {
    lastHealthError = error instanceof Error ? error.message : String(error);
    resetRagClient();
    return false;
  }
}

export async function ensureRagCollection(dimension: number): Promise<void> {
  const milvus = getRagClient();
  const existing = await milvus.hasCollection({ collection_name: RAG_COLLECTION });
  if (!existing.value) {
    await milvus.createCollection({
      collection_name: RAG_COLLECTION,
      fields: [
        { name: "id", data_type: DataType.VarChar, is_primary_key: true, max_length: 256 },
        { name: "kind", data_type: DataType.VarChar, max_length: 32 },
        { name: "source_kind", data_type: DataType.VarChar, max_length: 32 },
        { name: "source_id", data_type: DataType.VarChar, max_length: 128 },
        { name: "source_path", data_type: DataType.VarChar, max_length: 512 },
        { name: "view", data_type: DataType.VarChar, max_length: 32 },
        { name: "image_path", data_type: DataType.VarChar, max_length: 512 },
        { name: "title", data_type: DataType.VarChar, max_length: 512 },
        { name: "body", data_type: DataType.VarChar, max_length: 4096 },
        { name: "tags_text", data_type: DataType.VarChar, max_length: 1024 },
        { name: "category", data_type: DataType.VarChar, max_length: 64 },
        { name: "metadata_json", data_type: DataType.VarChar, max_length: 4096 },
        { name: "embedding", data_type: DataType.FloatVector, dim: dimension },
      ],
      enable_dynamic_field: false,
    });
    await milvus.createIndex({
      collection_name: RAG_COLLECTION,
      field_name: "embedding",
      index_type: "HNSW",
      metric_type: MetricType.COSINE,
      params: { M: 16, efConstruction: 128 },
    });
  }
  await milvus.loadCollection({ collection_name: RAG_COLLECTION });
}

export async function dropRagCollectionIfExists(): Promise<boolean> {
  if (!(await isRagDatabaseReady())) return false;
  const milvus = getRagClient();
  const existing = await milvus.hasCollection({ collection_name: RAG_COLLECTION });
  if (!existing.value) return false;
  await milvus.dropCollection({ collection_name: RAG_COLLECTION });
  await waitForRagCollectionDropped();
  resetRagClient();
  return true;
}

async function waitForRagCollectionDropped(): Promise<void> {
  const milvus = getRagClient();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const existing = await milvus.hasCollection({ collection_name: RAG_COLLECTION });
    if (!existing.value) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Milvus collection 删除后仍可见: ${RAG_COLLECTION}`);
}
