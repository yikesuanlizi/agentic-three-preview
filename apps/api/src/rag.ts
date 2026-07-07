import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type AircraftAssetCategory,
  type RagIngestResult,
  type RagSearchRequest,
  type RetrievalSearchResult,
  type SceneDsl,
  ragIngestResultSchema,
  ragSearchRequestSchema,
  ragSourceResolveRequestSchema,
} from "@agentic-three/shared";
import { listAircraftAssets } from "./aircraftAssets.js";
import { SCENE_TEMPLATES, searchAircraftKnowledge } from "./aircraftRetrieval.js";
import { ensureRagCollection, getRagClient, isRagDatabaseReady, RAG_COLLECTION } from "./ragDb.js";
import { embedRagInput, embedText, rerankRagResults } from "./ragEmbedding.js";
import { projectRoot } from "./memory.js";

type RagDocument = {
  id: string;
  kind: "asset" | "asset_view" | "template" | "wiki" | "generated_scene";
  sourceKind: "asset" | "renderer" | "wiki";
  sourceId: string;
  sourcePath: string;
  view?: string;
  imagePath?: string;
  title: string;
  body: string;
  tags: string[];
  metadata: Record<string, unknown>;
};

type RagMilvusRow = Record<string, string | number[]>;

let aircraftRagSyncPromise: Promise<RagIngestResult> | undefined;

export function resetAircraftRagSyncState(): void {
  aircraftRagSyncPromise = undefined;
}

export async function ingestAircraftRag(): Promise<RagIngestResult> {
  if (shouldUseFallbackRag() || !(await isRagDatabaseReady())) {
    return ragIngestResultSchema.parse({
      ok: false,
      documentCount: 0,
      mode: "fallback",
      message: "Milvus 未连接，当前只能使用本地词法 fallback 检索。",
    });
  }
  try {
    const documents = buildRagDocuments();
    const embedded = [];
    for (const document of documents) {
      const embedding = await embedRagInput({
        text: [document.title, document.body, document.tags.join(" ")].join("\n"),
        imagePath: document.imagePath,
      });
      embedded.push({ document, embedding });
    }
    if (!embedded.length) {
      return ragIngestResultSchema.parse({
        ok: true,
        documentCount: 0,
        mode: "milvus",
        message: "没有发现可入库的资产、视图或 wiki 文档。",
      });
    }
    await ensureRagCollection(embedded[0]!.embedding.length);
    await getRagClient().upsert({
      collection_name: RAG_COLLECTION,
      data: embedded.map(({ document, embedding }) => toMilvusRow(document, embedding)),
    });
    return ragIngestResultSchema.parse({
      ok: true,
      documentCount: documents.length,
      mode: "milvus",
      message: "已入库资产元数据、六视图图片 embedding、模板指针和 wiki 规则；源码与 GLB 均只保存项目内相对路径指针。",
    });
  } catch (error) {
    throw error;
  }
}

export async function ensureAircraftRagSynced(): Promise<RagIngestResult | undefined> {
  if (shouldUseFallbackRag()) return undefined;
  if (!(await isRagDatabaseReady())) return undefined;
  aircraftRagSyncPromise ??= ingestAircraftRag().catch((error) => {
    aircraftRagSyncPromise = undefined;
    throw error;
  });
  try {
    return await aircraftRagSyncPromise;
  } catch (error) {
    console.warn("[agentic-three:rag] 自动同步基础索引失败", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export async function ingestGeneratedSceneRag(input: {
  sessionId: string;
  runId?: string;
  label: string;
  userGoal?: string;
  scene?: SceneDsl;
  screenshotPath?: string;
  round?: number;
  score?: number;
}): Promise<RagIngestResult> {
  if (!input.screenshotPath) {
    return ragIngestResultSchema.parse({
      ok: false,
      documentCount: 0,
      mode: "fallback",
      message: "没有可入库的自动截图。",
    });
  }
  if (!(await isRagDatabaseReady())) {
    return ragIngestResultSchema.parse({
      ok: false,
      documentCount: 0,
      mode: "fallback",
      message: "Milvus 未连接，自动截图已保存但未写入 RAG。",
    });
  }

  const imagePath = toProjectRelativePath(input.screenshotPath);
  if (!existsSync(resolve(projectRoot, imagePath))) {
    return ragIngestResultSchema.parse({
      ok: false,
      documentCount: 0,
      mode: "fallback",
      message: `自动截图不存在，跳过 RAG 回写: ${imagePath}`,
    });
  }

  const sceneTags = input.scene
    ? [
        input.scene.sceneType,
        input.scene.cameraPreset,
        input.scene.renderStyle,
        ...input.scene.objects.map((object) => object.primitive),
      ]
    : [];
  const document: RagDocument = {
    id: `generated-scene:${input.runId ?? input.sessionId}:${input.round ?? "final"}`,
    kind: "generated_scene",
    sourceKind: "renderer",
    sourceId: input.runId ?? input.sessionId,
    sourcePath: imagePath,
    imagePath,
    title: `自动生成截图: ${input.label}`,
    body: [
      input.userGoal ? `用户目标: ${input.userGoal}` : "",
      input.scene ? `Scene DSL: ${input.scene.sceneType} / ${input.scene.cameraPreset} / ${input.scene.renderStyle}` : "",
      input.scene ? `对象: ${input.scene.objects.map((object) => `${object.id}:${object.primitive}`).join(", ")}` : "",
      typeof input.score === "number" ? `质检分数: ${input.score.toFixed(2)}` : "",
    ].filter(Boolean).join("\n"),
    tags: Array.from(new Set(["generated", "自动截图", "runtime-renderer", ...sceneTags])),
    metadata: {
      sessionId: input.sessionId,
      runId: input.runId,
      label: input.label,
      round: input.round,
      score: input.score,
      scene: input.scene,
    },
  };
  const embedding = await embedRagInput({
    text: [document.title, document.body, document.tags.join(" ")].join("\n"),
    imagePath: document.imagePath,
  });
  await ensureRagCollection(embedding.length);
  await getRagClient().upsert({
    collection_name: RAG_COLLECTION,
    data: [toMilvusRow(document, embedding)],
  });
  return ragIngestResultSchema.parse({
    ok: true,
    documentCount: 1,
    mode: "milvus",
    message: "自动生成截图已写入 RAG，后续文字检索会把它作为视觉参考。",
  });
}

export async function searchAircraftRag(input: unknown): Promise<{ results: RetrievalSearchResult[]; mode: "milvus" | "fallback" }> {
  const request = ragSearchRequestSchema.parse(input);
  if (shouldUseFallbackRag() || !(await isRagDatabaseReady())) {
    return { ...searchAircraftKnowledge(request), mode: "fallback" };
  }
  if (request.scope !== "imported") await ensureAircraftRagSynced();
  const queryEmbedding = await embedText(request.query);
  await ensureRagCollection(queryEmbedding.length);
  const search = await getRagClient().search({
    collection_name: RAG_COLLECTION,
    data: queryEmbedding,
    anns_field: "embedding",
    limit: Math.min(Math.max(request.topK * 4, request.topK), 40),
    metric_type: "COSINE",
    params: { ef: 64 },
    filter: request.categories.length ? `category in [${request.categories.map((item) => `"${item}"`).join(",")}]` : undefined,
    output_fields: ["id", "kind", "source_kind", "source_id", "source_path", "view", "image_path", "title", "body", "tags_text", "category", "metadata_json"],
  });
  const candidates = filterByKnowledgeScope(
    normalizeSearchRows(search.results)
    .map((row) => toRetrievalResult(row, request.query))
    .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(request.topK * 4, request.topK), 40)),
    request.scope,
  );
  const reranked = await rerankRagResults(request.query, candidates);
  return { results: reranked.slice(0, request.topK), mode: "milvus" };
}

function filterByKnowledgeScope(results: RetrievalSearchResult[], scope: RagSearchRequest["scope"]): RetrievalSearchResult[] {
  if (scope === "all") return results;
  return results.filter((result) => {
    if (result.kind === "generated_scene") return true;
    if (result.kind !== "asset" && result.kind !== "asset_view") return false;
    const path = result.sourcePath ?? result.imagePath ?? "";
    return path.startsWith("assets/aircraft/imported/") || result.tags.includes("imported");
  });
}

export function resolveRagSource(input: unknown): { kind: string; id: string; sourcePath: string; source: unknown } {
  const request = ragSourceResolveRequestSchema.parse(input);
  const normalizedId = request.id.replace(/^(asset|asset-view|template|wiki):/, "");
  if (request.kind === "template") {
    const template = SCENE_TEMPLATES.find((item) => item.id === normalizedId || item.sourceId === normalizedId);
    if (!template) throw new Error(`模板不存在: ${request.id}`);
    return {
      kind: "template",
      id: request.id,
      sourcePath: template.sourcePath ?? "apps/api/src/sceneRuntime.ts",
      source: {
        template,
        rendererEntry: template.sourceId,
        note: "向量库只存模板指针；源码由 Runtime Renderer 根据 Scene DSL 生成。",
      },
    };
  }
  if (request.kind === "generated_scene") {
    return {
      kind: "generated_scene",
      id: request.id,
      sourcePath: "outputs/screenshots",
      source: {
        note: "这是运行时自动截图回写到 RAG 的视觉参考；向量库保存图片路径和 Scene DSL 摘要，不保存源码正文。",
      },
    };
  }
  if (request.kind === "asset" || request.kind === "asset_view") {
    const assetId = request.kind === "asset_view" ? request.id.replace(/^asset-view:/, "").split(":")[0] : normalizedId;
    const asset = listAircraftAssets().find((item) => item.id === assetId);
    if (!asset) throw new Error(`资产不存在: ${assetId}`);
    return {
      kind: request.kind,
      id: request.id,
      sourcePath: asset.assetPath,
      source: {
        asset,
        note: "向量库只存资产/视图元数据；GLB 或程序化 fallback 由本地资产层解析。",
      },
    };
  }
  const wikiPath = resolve(projectRoot, "knowledge", "aircraft-wiki.md");
  return {
    kind: "wiki",
    id: request.id,
    sourcePath: "knowledge/aircraft-wiki.md",
    source: existsSync(wikiPath) ? readFileSync(wikiPath, "utf8") : "",
  };
}

function toMilvusRow(document: RagDocument, embedding: number[]): RagMilvusRow {
  return {
    id: clip(document.id, 256),
    kind: document.kind,
    source_kind: document.sourceKind,
    source_id: clip(document.sourceId, 128),
    source_path: clip(document.sourcePath, 512),
    view: document.view ?? "",
    image_path: document.imagePath ?? "",
    title: clip(document.title, 512),
    body: clip(document.body, 4096),
    tags_text: clip(document.tags.join(","), 1024),
    category: String(document.metadata.category ?? ""),
    metadata_json: clip(JSON.stringify(document.metadata), 4096),
    embedding,
  };
}

function normalizeSearchRows(results: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(results)) return [];
  if (Array.isArray(results[0])) return (results as Array<Array<Record<string, unknown>>>).flat();
  return results as Array<Record<string, unknown>>;
}

function toRetrievalResult(row: Record<string, unknown>, query: string): RetrievalSearchResult {
  const metadata = parseJsonObject(String(row.metadata_json ?? "{}"));
  const tags = String(row.tags_text ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const title = String(row.title ?? "");
  const description = String(row.body ?? "");
  const vectorScore = Number(row.score ?? 0);
  const keywordScore = scoreKeywords(query, [title, description, tags.join(" ")].join(" "));
  return {
    kind: String(row.kind) as RetrievalSearchResult["kind"],
    id: String(row.id ?? ""),
    title,
    description,
    score: 0.72 * vectorScore + 0.28 * keywordScore,
    tags,
    sourceKind: optionalString(row.source_kind) as RetrievalSearchResult["sourceKind"],
    sourceId: optionalString(row.source_id),
    sourcePath: optionalString(row.source_path),
    view: (String(row.view || "") || undefined) as RetrievalSearchResult["view"],
    imagePath: String(row.image_path || "") || undefined,
    metadata,
  };
}

function optionalString(value: unknown): string | undefined {
  const text = String(value || "");
  return text || undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function scoreKeywords(query: string, text: string): number {
  const queryTokens = tokenizeForScore(query);
  if (!queryTokens.length) return 0;
  const normalizedText = text.toLowerCase();
  const hits = queryTokens.filter((token) => normalizedText.includes(token.toLowerCase())).length;
  return hits / queryTokens.length;
}

function tokenizeForScore(text: string): string[] {
  const english = text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
  const chinese = ["发动机", "涡扇", "机翼", "机身", "起落架", "驾驶舱", "正面", "背面", "侧面", "俯视", "仰视", "黑线", "白图", "六视图", "glb", "gltf"].filter((word) =>
    text.includes(word),
  );
  return Array.from(new Set([...english, ...chinese]));
}

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function toProjectRelativePath(path: string): string {
  if (path.split(/[\\/]+/).includes("..")) {
    throw new Error(`RAG 路径不能逃逸项目目录: ${path}`);
  }
  const fullPath = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  const relativePath = relative(projectRoot, fullPath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("../") || relativePath === ".." || isAbsolute(relativePath)) {
    throw new Error(`RAG 路径必须在项目内: ${path}`);
  }
  return relativePath;
}

function shouldUseFallbackRag(): boolean {
  return process.env.RAG_FORCE_FALLBACK === "1" || process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

function buildRagDocuments(): RagDocument[] {
  const assets = listAircraftAssets();
  const assetDocuments: RagDocument[] = assets.flatMap((asset) => {
    const base: RagDocument = {
      id: `asset:${asset.id}`,
      kind: "asset",
      sourceKind: "asset",
      sourceId: asset.id,
      sourcePath: asset.assetPath,
      imagePath: asset.previewPath,
      title: asset.title,
      body: buildAssetBody(asset),
      tags: asset.tags,
      metadata: {
        category: asset.category,
        metadataPath: asset.metadataPath,
        assetPath: asset.assetPath,
        previewPath: asset.previewPath,
        hasModel: asset.hasModel,
        hasPreview: asset.hasPreview,
        codeSummary: asset.codeSummary,
        keySnippets: asset.keySnippets,
        detectedPatterns: asset.detectedPatterns,
        shapeSummary: asset.shapeSummary,
        viewFeatures: asset.viewFeatures,
        skeletonHints: asset.skeletonHints,
        structureAnalysis: asset.structureAnalysis,
        templateParams: asset.templateParams,
        constraintHints: asset.constraintHints,
        viewImages: asset.viewImages,
      },
    };
    const views: RagDocument[] = asset.viewImages.map((view) => ({
      id: `asset-view:${asset.id}:${view.view}`,
      kind: "asset_view",
      sourceKind: "asset",
      sourceId: asset.id,
      sourcePath: asset.assetPath,
      view: view.view,
      imagePath: view.imagePath,
      title: view.title,
      body: view.description,
      tags: Array.from(new Set([...asset.tags, ...view.tags, view.view])),
      metadata: {
        category: asset.category,
        assetId: asset.id,
        view: view.view,
        metadataPath: asset.metadataPath,
        assetPath: asset.assetPath,
        imagePath: view.imagePath,
        viewFeatures: asset.viewFeatures,
        skeletonHints: asset.skeletonHints,
        shapeSummary: asset.shapeSummary,
        structureAnalysis: asset.structureAnalysis,
        templateParams: asset.templateParams,
        constraintHints: asset.constraintHints,
      },
    }));
    return [base, ...views];
  });

  const templates: RagDocument[] = SCENE_TEMPLATES.map((template) => ({
    id: `template:${template.id}`,
    kind: "template",
    sourceKind: "renderer",
    sourceId: template.id,
    sourcePath: template.sourcePath ?? "apps/api/src/sceneRuntime.ts",
    title: template.title,
    body: template.description,
    tags: template.tags,
    metadata: {
      sourceId: template.sourceId,
      sourcePath: template.sourcePath,
    },
  }));

  const wiki = readWikiDocuments();
  return [...assetDocuments, ...templates, ...wiki];
}

function readWikiDocuments(): RagDocument[] {
  const wikiPath = resolve(projectRoot, "knowledge", "aircraft-wiki.md");
  if (!existsSync(wikiPath)) return [];
  return readFileSync(wikiPath, "utf8")
    .split(/\n(?=## )/g)
    .map((chunk, index) => ({
      id: `wiki:aircraft:${index + 1}`,
      kind: "wiki" as const,
      sourceKind: "wiki" as const,
      sourceId: `aircraft-wiki-${index + 1}`,
      sourcePath: "knowledge/aircraft-wiki.md",
      title: chunk.match(/^##\s+(.+)$/m)?.[1] ?? "Aircraft Wiki",
      body: chunk.replace(/^#.+$/m, "").trim().slice(0, 1200),
      tags: ["wiki", "aircraft"],
      metadata: {},
    }))
    .filter((document) => document.body);
}

function buildAssetBody(asset: {
  description: string;
  tags: string[];
  viewImages: Array<{ view: string; description: string }>;
  codeSummary?: string;
  keySnippets?: string[];
  detectedPatterns?: string[];
  shapeSummary?: string;
  viewFeatures?: string[];
  skeletonHints?: string[];
  structureAnalysis?: unknown;
  templateParams?: unknown;
  constraintHints?: unknown[];
}): string {
  const viewDescriptions = asset.viewImages.map((view) => `${view.view}: ${view.description}`);
  const templateParams = summarizeTemplateParams(asset.templateParams);
  const constraintHints = summarizeConstraintHints(asset.constraintHints);
  const structureAnalysis = summarizeStructureAnalysis(asset.structureAnalysis);
  return [
    asset.description,
    `标签: ${asset.tags.join(", ")}`,
    asset.shapeSummary ? `形体摘要: ${asset.shapeSummary}` : "",
    asset.viewFeatures?.length ? `六视图特征: ${asset.viewFeatures.join("；")}` : "",
    asset.skeletonHints?.length ? `骨架建议: ${asset.skeletonHints.join("；")}` : "",
    structureAnalysis ? `GLB结构分析: ${structureAnalysis}` : "",
    templateParams ? `模板参数: ${templateParams}` : "",
    constraintHints ? `约束提示: ${constraintHints}` : "",
    asset.codeSummary ? `源码摘要: ${asset.codeSummary}` : "",
    asset.detectedPatterns?.length ? `源码模式: ${asset.detectedPatterns.join(", ")}` : "",
    asset.keySnippets?.length ? `关键源码片段摘要: ${asset.keySnippets.map((item) => clip(item, 500)).join("\n---\n")}` : "",
    viewDescriptions.length ? `多方向视图: ${viewDescriptions.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeStructureAnalysis(value: unknown): string {
  const analysis = value as {
    status?: string;
    nodeCount?: number;
    meshCount?: number;
    materialCount?: number;
    dominantAxis?: string;
    radialPatterns?: Array<{ count?: number; axis?: string; confidence?: number }>;
  };
  if (!analysis || analysis.status !== "success") return "";
  return [
    `node=${analysis.nodeCount ?? 0}`,
    `mesh=${analysis.meshCount ?? 0}`,
    `material=${analysis.materialCount ?? 0}`,
    analysis.dominantAxis ? `axis=${analysis.dominantAxis}` : "",
    analysis.radialPatterns?.length
      ? `radial=${analysis.radialPatterns.map((pattern) => `${pattern.count ?? 0}/${pattern.axis ?? "?"}/conf${typeof pattern.confidence === "number" ? pattern.confidence.toFixed(2) : "?"}`).join(",")}`
      : "",
  ].filter(Boolean).join("; ");
}

function summarizeTemplateParams(value: unknown): string {
  const params = value as {
    template?: string;
    confidence?: number;
    turbofan?: Record<string, unknown>;
  };
  if (!params?.template) return "";
  return [
    `${params.template}${typeof params.confidence === "number" ? ` conf=${params.confidence.toFixed(2)}` : ""}`,
    params.turbofan ? `turbofan=${JSON.stringify(params.turbofan).slice(0, 500)}` : "",
  ].filter(Boolean).join("; ");
}

function summarizeConstraintHints(value: unknown[] | undefined): string {
  if (!Array.isArray(value) || !value.length) return "";
  return value
    .map((hint) => {
      const item = hint as { type?: string; priority?: string; confidence?: number; reason?: string };
      return `${item.type ?? "unknown"}/${item.priority ?? "normal"}/conf${typeof item.confidence === "number" ? item.confidence.toFixed(2) : "?"}${item.reason ? `: ${clip(item.reason, 120)}` : ""}`;
    })
    .join("；");
}
