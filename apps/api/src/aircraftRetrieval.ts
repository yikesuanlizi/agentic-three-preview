import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AircraftAssetCategory,
  type RetrievalSearchRequest,
  type RetrievalSearchResult,
  retrievalSearchRequestSchema,
} from "@agentic-three/shared";
import { projectRoot } from "./memory.js";
import { listAircraftAssets } from "./aircraftAssets.js";

const WIKI_PATH = resolve(projectRoot, "knowledge", "aircraft-wiki.md");

export const SCENE_TEMPLATES: RetrievalSearchResult[] = [
  {
    kind: "template",
    id: "engine_showcase",
    title: "发动机展示模板",
    description: "用于涡扇发动机正面或三分之四视图展示，支持黑线白图和PPT截图。",
    score: 0,
    tags: ["engine", "turbofan", "front-view", "technical-lines"],
    sourceKind: "renderer",
    sourceId: "engine_showcase",
    sourcePath: "apps/api/src/sceneRuntime.ts",
    metadata: { source: "runtime_renderer" },
  },
  {
    kind: "template",
    id: "front_technical_view",
    title: "正面工程线稿模板",
    description: "白底黑线、隐藏网格、正交感相机，适合截图贴入PPT。",
    score: 0,
    tags: ["technical-lines", "front-view", "ppt"],
    sourceKind: "renderer",
    sourceId: "front_technical_view",
    sourcePath: "apps/api/src/sceneRuntime.ts",
    metadata: { source: "runtime_renderer" },
  },
  {
    kind: "template",
    id: "component_detail",
    title: "局部组件详情模板",
    description: "用于机翼、机身、起落架等局部部件的近景结构展示。",
    score: 0,
    tags: ["component", "detail", "aircraft"],
    sourceKind: "renderer",
    sourceId: "component_detail",
    sourcePath: "apps/api/src/sceneRuntime.ts",
    metadata: { source: "runtime_renderer" },
  },
];

export function searchAircraftKnowledge(input: unknown): { results: RetrievalSearchResult[] } {
  const request = retrievalSearchRequestSchema.parse(input);
  const query = request.query.toLowerCase();
  const categories = new Set<AircraftAssetCategory>(request.categories);
  const assetResults: RetrievalSearchResult[] = listAircraftAssets()
    .filter((asset) => categories.size === 0 || categories.has(asset.category))
    .map((asset) => ({
      kind: "asset" as const,
      id: asset.id,
      title: asset.title,
      description: asset.description,
      score: scoreText(query, [asset.id, asset.title, asset.description, asset.category, ...asset.tags]),
      tags: asset.tags,
      sourceKind: "asset" as const,
      sourceId: asset.id,
      sourcePath: asset.assetPath,
      imagePath: asset.previewPath,
      metadata: { category: asset.category, previewPath: asset.previewPath, hasModel: asset.hasModel },
    }));

  const templateResults = SCENE_TEMPLATES.map((template) => ({
    ...template,
    score: scoreText(query, [template.id, template.title, template.description, ...template.tags]),
  }));

  const wikiResults = readWikiChunks().map((chunk, index) => ({
    kind: "wiki" as const,
    id: `aircraft-wiki-${index + 1}`,
    title: chunk.title,
    description: chunk.body,
    score: scoreText(query, [chunk.title, chunk.body]),
    tags: ["wiki", "aircraft"],
    sourceKind: "wiki" as const,
    sourceId: `aircraft-wiki-${index + 1}`,
    sourcePath: WIKI_PATH,
    metadata: {},
  }));

  const results = [...assetResults, ...templateResults, ...wikiResults]
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, request.topK);

  return { results };
}

export function defaultRetrievalForIntent(query: string, category?: AircraftAssetCategory): RetrievalSearchResult[] {
  return searchAircraftKnowledge({
    query,
    categories: category ? [category] : [],
    topK: 6,
  } satisfies RetrievalSearchRequest).results;
}

function readWikiChunks(): Array<{ title: string; body: string }> {
  if (!existsSync(WIKI_PATH)) return [];
  const text = readFileSync(WIKI_PATH, "utf8");
  return text
    .split(/\n(?=## )/g)
    .map((chunk) => {
      const title = chunk.match(/^##\s+(.+)$/m)?.[1] ?? "Aircraft Wiki";
      const body = chunk.replace(/^#.+$/m, "").trim().slice(0, 800);
      return { title, body };
    })
    .filter((chunk) => chunk.body);
}

function scoreText(query: string, fields: string[]): number {
  const normalized = normalizeQuery(query);
  const haystack = fields.join(" ").toLowerCase();
  let score = 0;
  for (const token of normalized) {
    if (haystack.includes(token)) score += token.length > 2 ? 3 : 1;
  }
  if ((query.includes("发动机") || query.includes("涡扇") || query.includes("engine")) && haystack.includes("engine")) score += 8;
  if ((query.includes("黑线") || query.includes("白图") || query.includes("线稿")) && haystack.includes("technical")) score += 6;
  if ((query.includes("正面") || query.includes("front")) && haystack.includes("front")) score += 5;
  return score;
}

function normalizeQuery(query: string): string[] {
  const english = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const chineseHints = ["发动机", "涡扇", "机翼", "机身", "起落架", "驾驶舱", "黑线", "白图", "线稿", "正面", "截图"].filter((word) =>
    query.includes(word),
  );
  return Array.from(new Set([...english, ...chineseHints]));
}
