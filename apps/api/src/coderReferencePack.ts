import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type AgentTurnRequest,
  type AircraftAssetMetadata,
  type PatchEvent,
  type RetrievalSearchResult,
  type SceneDsl,
  type VisualIntent,
  aircraftAssetMetadataSchema,
} from "@agentic-three/shared";
import { projectRoot } from "./memory.js";

export type CoderReferencePackInput = {
  request: AgentTurnRequest;
  retrievalResults: RetrievalSearchResult[];
  fallbackScene?: SceneDsl;
  fallbackPatch?: PatchEvent;
  visualIntent?: VisualIntent;
};

export type CoderReferencePack = {
  markdown: string;
  itemCount: number;
  sourceAssetCount: number;
  modelAssetCount: number;
  templateCount: number;
};

type NormalizedReference = {
  priority: number;
  kind: string;
  title: string;
  score: number;
  sourcePath?: string;
  lines: string[];
};

const PACK_LIMIT = 14000;
const ITEM_LIMIT = 2400;
const SNIPPET_LIMIT = 900;

export function buildCoderReferencePack(input: CoderReferencePackInput): CoderReferencePack {
  const normalized = input.retrievalResults
    .map((result, index) => normalizeReference(result, index))
    .sort((a, b) => b.priority - a.priority);
  const items = selectReferenceItems(normalized, 8);

  const fallbackScene = input.fallbackScene
    ? clip(
        [
          `Runtime Composer 骨架建议: ${input.fallbackScene.sceneType} / ${input.fallbackScene.cameraPreset} / ${input.fallbackScene.renderStyle}`,
          `对象: ${input.fallbackScene.objects.map((object) => `${object.objectId ?? object.id}:${object.primitive}`).join(", ")}`,
          input.fallbackScene.annotations.length ? `约束: ${input.fallbackScene.annotations.join("；")}` : "",
        ].filter(Boolean).join("\n"),
        1600,
      )
    : "";

  const fallbackPatchSummary = input.fallbackPatch
    ? clip(
        [
          `Runtime fallback patch: ${input.fallbackPatch.summary}`,
          ...input.fallbackPatch.operations.map((operation) => {
            if (operation.type === "parameter_patch") {
              return `${operation.path}: 参数补丁 ${Object.keys(operation.parameters).join(", ") || "(empty)"}`;
            }
            return `${operation.path}: ${operation.content.split(/\r?\n/).length} 行`;
          }),
        ].join("\n"),
        900,
      )
    : "";

  const header = [
    "# Coder Reference Pack",
    `用户文字: ${input.request.message || "(空，依赖上传图片和上下文)"}`,
    `上传图片数量: ${input.request.images.length}`,
    "使用规则: 命中 GLB 时优先把它作为可加载基底资产，用 GLTFLoader 加载到 wrapper，再通过约束/缩放/旋转/材质/边线/程序化补件微调；不要把 GLB 当源码复制，也不要整段复制不可控源码；输出可运行 Sandpack 代码。",
    input.visualIntent ? formatVisualIntent(input.visualIntent) : "",
    fallbackScene,
    fallbackPatchSummary,
  ].filter(Boolean).join("\n");

  const body = items.map((item, index) => formatReferenceItem(item, index + 1)).join("\n\n");
  const markdown = clip([header, body || "没有命中可用 RAG 参考，按用户需求和 Runtime 骨架生成。"].join("\n\n"), PACK_LIMIT);
  return {
    markdown,
    itemCount: items.length,
    sourceAssetCount: items.filter((item) => item.kind === "source").length,
    modelAssetCount: items.filter((item) => item.kind === "model").length,
    templateCount: items.filter((item) => item.kind === "template" || item.kind === "wiki").length,
  };
}

function selectReferenceItems(items: NormalizedReference[], limit: number): NormalizedReference[] {
  const selected: NormalizedReference[] = [];
  const add = (item: NormalizedReference) => {
    if (selected.length >= limit) return;
    if (selected.some((existing) => existing.title === item.title && existing.sourcePath === item.sourcePath)) return;
    selected.push(item);
  };
  for (const item of items.filter((item) => item.kind === "source").slice(0, 2)) add(item);
  for (const item of items.filter((item) => item.kind === "model").slice(0, 5)) add(item);
  for (const item of items.filter((item) => item.kind === "template" || item.kind === "wiki").slice(0, 2)) add(item);
  for (const item of items) add(item);
  return selected.sort((a, b) => b.priority - a.priority);
}

function formatVisualIntent(intent: VisualIntent): string {
  const referenceFeatures = intent.referenceFeatures ?? [];
  const featureExpectations = intent.featureExpectations ?? [];
  return [
    "## Visual Intent",
    `模型: ${intent.modelUsed}; confidence: ${intent.confidence.toFixed(2)}${intent.fallbackReason ? `; fallback: ${intent.fallbackReason}` : ""}`,
    `主体: ${intent.subject}`,
    `类别/视角/风格: ${intent.category ?? "unknown"} / ${intent.view} / ${intent.renderStyle}`,
    `检索 query: ${intent.retrievalQuery || "(empty)"}`,
    intent.visualFeatures.length ? `视觉特征: ${intent.visualFeatures.join("；")}` : "",
    intent.geometryHints.length ? `几何提示: ${intent.geometryHints.join("；")}` : "",
    intent.materialHints.length ? `材质提示: ${intent.materialHints.join("；")}` : "",
    intent.codeHints.length ? `代码提示: ${intent.codeHints.join("；")}` : "",
    intent.referenceView ? `参考图主视角: ${intent.referenceView}` : "",
    referenceFeatures.length
      ? `参考图特征点: ${referenceFeatures.map((feature) => `${feature.id}:${feature.label}/${feature.part}@(${feature.x.toFixed(2)},${feature.y.toFixed(2)}) -> ${feature.parameterHint || "visual"}`).join("；")}`
      : "",
    featureExpectations.length
      ? `建模特征期望: ${featureExpectations.map((item) => `${item.priority}:${item.label}/${item.part}=${item.expected}${item.parameterHint ? ` -> ${item.parameterHint}` : ""}`).join("；")}`
      : "",
  ].filter(Boolean).join("\n");
}

function normalizeReference(result: RetrievalSearchResult, index: number): NormalizedReference {
  const metadata = readMetadata(result) ?? metadataFromResult(result);
  const sourcePath = result.sourcePath ?? result.imagePath;
  const sourceKind = classifyReference(result, metadata);
  const importedBoost = result.tags.includes("imported") ? 3 : 0;
  const sourceBoost = sourceKind === "source" ? 2 : sourceKind === "model" ? 1.5 : 0;
  const priority = result.score * 10 + importedBoost + sourceBoost - index * 0.1;
  const lines = buildReferenceLines(result, metadata, sourceKind);
  return {
    priority,
    kind: sourceKind,
    title: result.title,
    score: result.score,
    sourcePath,
    lines,
  };
}

function buildReferenceLines(result: RetrievalSearchResult, metadata: Partial<AircraftAssetMetadata>, kind: string): string[] {
  const lines: string[] = [
    `类型: ${result.kind}${kind !== result.kind ? ` / ${kind}` : ""}`,
    `score: ${result.score.toFixed(3)}`,
    result.sourcePath ? `路径指针: ${result.sourcePath}` : "",
    result.imagePath ? `图片指针: ${result.imagePath}` : "",
    result.tags.length ? `标签: ${result.tags.join(", ")}` : "",
    result.description ? `检索摘要: ${clip(result.description, 900)}` : "",
  ];

  if (metadata.shapeSummary) lines.push(`GLB 形体摘要: ${metadata.shapeSummary}`);
  if (kind === "model" && result.sourcePath && /\.(glb|gltf)$/i.test(result.sourcePath)) {
    lines.push("GLB 使用方式: 这是可直接加载的模型资产，不需要也不能“转成源码”才能用；优先作为真实几何基底，coder 负责外层 wrapper、材质边线和局部参数化补件。");
  }
  const structureSummary = formatStructureAnalysis(metadata.structureAnalysis);
  if (structureSummary) lines.push(`GLB 结构分析: ${structureSummary}`);
  const templateSummary = formatTemplateParams(metadata.templateParams);
  if (templateSummary) lines.push(`模板参数建议: ${templateSummary}`);
  if (metadata.constraintHints?.length) {
    lines.push(`约束提示: ${metadata.constraintHints.map((hint) => `${hint.type}/${hint.priority}/conf ${hint.confidence.toFixed(2)}: ${hint.reason}`).join("；")}`);
  }
  if (metadata.viewFeatures?.length) lines.push(`六视图特征: ${metadata.viewFeatures.slice(0, 8).join("；")}`);
  if (metadata.skeletonHints?.length) lines.push(`可复用骨架建议: ${metadata.skeletonHints.slice(0, 8).join("；")}`);
  if (metadata.codeSummary) lines.push(`源码摘要: ${metadata.codeSummary}`);
  if (metadata.detectedPatterns?.length) lines.push(`源码模式: ${metadata.detectedPatterns.join(", ")}`);
  if (metadata.keySnippets?.length) {
    lines.push(`关键源码片段:\n${metadata.keySnippets.slice(0, 4).map((snippet, i) => `片段 ${i + 1}:\n${clip(snippet, SNIPPET_LIMIT)}`).join("\n---\n")}`);
  }
  if (!metadata.keySnippets?.length && kind === "source" && result.sourcePath) {
    const snippet = readSourceSnippet(result.sourcePath);
    if (snippet) lines.push(`本地源码关键行:\n${snippet}`);
  }
  if (result.kind === "template") {
    lines.push("模板约束: 可借用构图和 renderer 安全结构，但 coder 应直接写最终 Sandpack 文件。");
  }
  if (result.kind === "wiki") {
    lines.push("wiki 规则: 作为领域术语和建模约束参考，不是代码。");
  }
  return lines.filter(Boolean).map((line) => clip(line, ITEM_LIMIT));
}

function formatReferenceItem(item: NormalizedReference, index: number): string {
  return clip([`## ${index}. ${item.title}`, `参考类型: ${item.kind}`, item.sourcePath ? `来源: ${item.sourcePath}` : "", ...item.lines].filter(Boolean).join("\n"), ITEM_LIMIT);
}

function classifyReference(result: RetrievalSearchResult, metadata: Partial<AircraftAssetMetadata>): string {
  const path = `${result.sourcePath ?? ""} ${metadata.assetPath ?? ""}`.toLowerCase();
  if (/\.(tsx|ts|jsx|js|mjs|html)$/.test(path) || metadata.codeSummary || metadata.keySnippets?.length) return "source";
  if (/\.(glb|gltf)$/.test(path) || result.kind === "asset" || result.kind === "asset_view") return "model";
  if (result.kind === "template") return "template";
  if (result.kind === "wiki") return "wiki";
  return result.kind;
}

function readMetadata(result: RetrievalSearchResult): Partial<AircraftAssetMetadata> | undefined {
  const metadataPath = typeof result.metadata.metadataPath === "string" ? result.metadata.metadataPath : undefined;
  if (!metadataPath) return undefined;
  try {
    const fullPath = resolveInsideProject(metadataPath);
    if (!existsSync(fullPath)) return undefined;
    return aircraftAssetMetadataSchema.parse(JSON.parse(readFileSync(fullPath, "utf8")));
  } catch {
    return undefined;
  }
}

function metadataFromResult(result: RetrievalSearchResult): Partial<AircraftAssetMetadata> {
  const metadata = result.metadata as Record<string, unknown>;
  return {
    category: typeof metadata.category === "string" ? metadata.category as AircraftAssetMetadata["category"] : undefined,
    title: result.title,
    description: result.description,
    tags: result.tags,
    assetPath: typeof metadata.assetPath === "string" ? metadata.assetPath : result.sourcePath,
    previewPath: typeof metadata.previewPath === "string" ? metadata.previewPath : result.imagePath,
    codeSummary: typeof metadata.codeSummary === "string" ? metadata.codeSummary : "",
    keySnippets: stringArray(metadata.keySnippets),
    detectedPatterns: stringArray(metadata.detectedPatterns),
    shapeSummary: typeof metadata.shapeSummary === "string" ? metadata.shapeSummary : "",
    viewFeatures: stringArray(metadata.viewFeatures),
    skeletonHints: stringArray(metadata.skeletonHints),
    structureAnalysis: typeof metadata.structureAnalysis === "object" && metadata.structureAnalysis ? metadata.structureAnalysis as AircraftAssetMetadata["structureAnalysis"] : undefined,
    templateParams: typeof metadata.templateParams === "object" && metadata.templateParams ? metadata.templateParams as AircraftAssetMetadata["templateParams"] : undefined,
    constraintHints: Array.isArray(metadata.constraintHints) ? metadata.constraintHints as AircraftAssetMetadata["constraintHints"] : [],
  };
}

function formatStructureAnalysis(analysis: Partial<AircraftAssetMetadata>["structureAnalysis"]): string {
  if (!analysis || analysis.status !== "success") return analysis?.status === "error" ? `分析失败: ${analysis.error ?? "unknown"}` : "";
  return [
    `nodes=${analysis.nodeCount}`,
    `meshes=${analysis.meshCount}`,
    `materials=${analysis.materialCount}`,
    analysis.dominantAxis ? `axis=${analysis.dominantAxis}` : "",
    analysis.bounds ? `size=${analysis.bounds.size.map((value) => value.toFixed(3)).join("x")}` : "",
    analysis.radialPatterns.length
      ? `radialPatterns=${analysis.radialPatterns.map((pattern) => `${pattern.count}个/${pattern.axis}/conf${pattern.confidence.toFixed(2)}`).join(",")}`
      : "",
  ].filter(Boolean).join("; ");
}

function formatTemplateParams(params: Partial<AircraftAssetMetadata>["templateParams"]): string {
  if (!params?.template) return "";
  return [
    `${params.template}${typeof params.confidence === "number" ? ` conf=${params.confidence.toFixed(2)}` : ""}`,
    params.turbofan ? `turbofan=${JSON.stringify(params.turbofan)}` : "",
  ].filter(Boolean).join("; ");
}

function readSourceSnippet(sourcePath: string): string {
  try {
    const fullPath = resolveInsideProject(sourcePath);
    if (!existsSync(fullPath)) return "";
    const source = readFileSync(fullPath, "utf8");
    return clip(
      source
        .split(/\r?\n/)
        .filter((line) => /(Geometry|Material|Camera|Light|LineSegments|EdgesGeometry|OrbitControls|renderer|scene\.add|function|const\s+[A-Z_a-z0-9]+ *=)/.test(line))
        .slice(0, 28)
        .join("\n"),
      1600,
    );
  } catch {
    return "";
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function resolveInsideProject(path: string): string {
  const fullPath = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  const project = resolve(projectRoot);
  if (fullPath !== project && !fullPath.startsWith(`${project}\\`) && !fullPath.startsWith(`${project}/`)) {
    throw new Error(`路径必须在项目内: ${path}`);
  }
  return fullPath;
}

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]` : value;
}
