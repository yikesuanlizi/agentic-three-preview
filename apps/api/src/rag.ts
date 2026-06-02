import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AircraftAssetCategory,
  type RagIngestResult,
  type RetrievalSearchResult,
  ragIngestResultSchema,
  ragSearchRequestSchema,
  ragSourceResolveRequestSchema,
} from "@agentic-three/shared";
import { listAircraftAssets } from "./aircraftAssets.js";
import { SCENE_TEMPLATES, searchAircraftKnowledge } from "./aircraftRetrieval.js";
import { getRagPool, isRagDatabaseReady } from "./ragDb.js";
import { embedText, toVectorLiteral } from "./ragEmbedding.js";
import { projectRoot } from "./memory.js";

type RagDocument = {
  id: string;
  kind: "asset" | "asset_view" | "template" | "wiki";
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

export async function ingestAircraftRag(): Promise<RagIngestResult> {
  if (!(await isRagDatabaseReady())) {
    return ragIngestResultSchema.parse({
      ok: false,
      documentCount: 0,
      mode: "fallback",
      message: "PostgreSQL/pgvector 未连接，当前只能使用本地词法 fallback 检索。",
    });
  }
  const pool = getRagPool();
  const run = await pool.query("INSERT INTO rag_ingest_runs(status) VALUES ('running') RETURNING id");
  const runId = run.rows[0]?.id as number;
  try {
    const documents = buildRagDocuments();
    for (const document of documents) {
      const embedding = await embedText([document.title, document.body, document.tags.join(" ")].join("\n"));
      await pool.query(
        `
          INSERT INTO rag_documents
            (id, kind, source_kind, source_id, source_path, view, image_path, title, body, tags, metadata, embedding, updated_at)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, now())
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            source_kind = excluded.source_kind,
            source_id = excluded.source_id,
            source_path = excluded.source_path,
            view = excluded.view,
            image_path = excluded.image_path,
            title = excluded.title,
            body = excluded.body,
            tags = excluded.tags,
            metadata = excluded.metadata,
            embedding = excluded.embedding,
            updated_at = now()
        `,
        [
          document.id,
          document.kind,
          document.sourceKind,
          document.sourceId,
          document.sourcePath,
          document.view ?? "",
          document.imagePath ?? "",
          document.title,
          document.body,
          document.tags,
          JSON.stringify(document.metadata),
          toVectorLiteral(embedding),
        ],
      );
      if (document.kind === "asset_view" && document.imagePath) {
        await pool.query(
          `
            INSERT INTO aircraft_asset_views (id, asset_id, view, image_path, title, description, tags, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT(id) DO UPDATE SET
              view = excluded.view,
              image_path = excluded.image_path,
              title = excluded.title,
              description = excluded.description,
              tags = excluded.tags,
              metadata = excluded.metadata
          `,
          [
            document.id,
            document.sourceId,
            document.view ?? "",
            document.imagePath,
            document.title,
            document.body,
            document.tags,
            JSON.stringify(document.metadata),
          ],
        );
      }
    }
    await pool.query("UPDATE rag_ingest_runs SET status = 'success', document_count = $1, finished_at = now() WHERE id = $2", [
      documents.length,
      runId,
    ]);
    return ragIngestResultSchema.parse({
      ok: true,
      documentCount: documents.length,
      mode: "pgvector",
      message: "已入库资产元数据、六视图图片说明、模板指针和 wiki 规则；源码未写入向量库。",
    });
  } catch (error) {
    await pool.query("UPDATE rag_ingest_runs SET status = 'error', error = $1, finished_at = now() WHERE id = $2", [
      error instanceof Error ? error.message : String(error),
      runId,
    ]);
    throw error;
  }
}

export async function searchAircraftRag(input: unknown): Promise<{ results: RetrievalSearchResult[]; mode: "pgvector" | "fallback" }> {
  const request = ragSearchRequestSchema.parse(input);
  if (!(await isRagDatabaseReady())) {
    return { ...searchAircraftKnowledge(request), mode: "fallback" };
  }
  const queryEmbedding = await embedText(request.query);
  const rows = await getRagPool().query(
    `
      SELECT id, kind, source_kind AS "sourceKind", source_id AS "sourceId", source_path AS "sourcePath",
             view, image_path AS "imagePath", title, body, tags, metadata,
             (
               0.62 * (1 / (1 + (embedding <=> $2::vector))) +
               0.30 * ts_rank_cd(search_vector, plainto_tsquery('simple', $1)) +
               0.08 * similarity(title || ' ' || body, $1)
             ) AS score
      FROM rag_documents
      WHERE ($3::text[] IS NULL OR metadata->>'category' = ANY($3::text[]))
      ORDER BY score DESC
      LIMIT $4
    `,
    [
      request.query,
      toVectorLiteral(queryEmbedding),
      request.categories.length ? request.categories : null,
      request.topK,
    ],
  );
  const results = rows.rows.map((row) =>
    ({
      kind: row.kind,
      id: row.id,
      title: row.title,
      description: row.body,
      score: Number(row.score ?? 0),
      tags: row.tags ?? [],
      sourceKind: row.sourceKind === "renderer" ? "renderer" : row.sourceKind,
      sourceId: row.sourceId,
      sourcePath: row.sourcePath,
      view: row.view || undefined,
      imagePath: row.imagePath || undefined,
      metadata: row.metadata ?? {},
    } satisfies RetrievalSearchResult),
  );
  return { results, mode: "pgvector" };
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
    sourcePath: wikiPath,
    source: existsSync(wikiPath) ? readFileSync(wikiPath, "utf8") : "",
  };
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
      body: buildAssetBody(asset.description, asset.tags, asset.viewImages.map((view) => `${view.view}: ${view.description}`)),
      tags: asset.tags,
      metadata: {
        category: asset.category,
        assetPath: asset.assetPath,
        previewPath: asset.previewPath,
        hasModel: asset.hasModel,
        hasPreview: asset.hasPreview,
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
        assetPath: asset.assetPath,
        imagePath: view.imagePath,
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

function buildAssetBody(description: string, tags: string[], viewDescriptions: string[]): string {
  return [description, `标签: ${tags.join(", ")}`, viewDescriptions.length ? `多方向视图: ${viewDescriptions.join("；")}` : ""]
    .filter(Boolean)
    .join("\n");
}
