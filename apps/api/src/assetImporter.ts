import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { ZodError } from "zod";
import {
  type AircraftAssetCategory,
  type AircraftAssetMetadata,
  type AircraftView,
  type AssetImportItem,
  type AssetImportJob,
  type AssetImportResult,
  assetImportRequestSchema,
  assetImportResultSchema,
  aircraftAssetMetadataSchema,
} from "@agentic-three/shared";
import {
  appendAssetImportJobItem,
  createAssetImportJob,
  findImportedAssetByHash,
  findImportedAssetBySourcePath,
  getActiveAssetImportJob,
  getAssetImportJob,
  type ImportedAssetRecord,
  projectRoot,
  saveImportedAsset,
  updateAssetImportJob,
} from "./memory.js";
import { analyzeGlbStructure } from "./glbAnalyzer.js";
import { ingestAircraftRag } from "./rag.js";

const require = createRequire(import.meta.url);
const importableExtensions = new Set([".glb", ".gltf", ".html", ".js", ".mjs", ".ts", ".tsx"]);
const modelExtensions = new Set([".glb", ".gltf"]);
const sourceExtensions = new Set([".html", ".js", ".mjs", ".ts", ".tsx"]);
const views: AircraftView[] = ["front", "back", "left", "right", "top", "bottom"];

type ImportCandidate = {
  fullPath: string;
  ext: string;
};

export async function importAircraftAssets(input: unknown): Promise<AssetImportResult> {
  const request = assetImportRequestSchema.parse(input);
  return runImportPipeline({
    sourceDirectory: request.sourceDirectory,
    uploadDirectory: request.uploadDirectory,
  });
}

export function startAssetImportJob(input: unknown): AssetImportJob {
  const request = assetImportRequestSchema.parse(input);
  const active = getActiveAssetImportJob();
  if (active) return active;
  const job = createAssetImportJob({
    sourceDirectory: request.sourceDirectory,
    uploadDirectory: request.uploadDirectory,
  });
  void runImportPipeline({
    sourceDirectory: request.sourceDirectory,
    uploadDirectory: request.uploadDirectory,
    jobId: job.jobId,
  }).catch((error) => {
    updateAssetImportJob(job.jobId, {
      status: "error",
      phase: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
  return job;
}

export function readAssetImportJob(jobId: string): AssetImportJob | undefined {
  return getAssetImportJob(jobId);
}

export function readActiveAssetImportJob(): AssetImportJob | undefined {
  return getActiveAssetImportJob();
}

async function runImportPipeline(input: {
  sourceDirectory: string;
  uploadDirectory: string;
  jobId?: string;
}): Promise<AssetImportResult> {
  const request = assetImportRequestSchema.parse(input);
  const sourceRoot = resolve(request.sourceDirectory);
  if (!existsSync(sourceRoot)) {
    throw new Error(`导入来源目录不存在: ${request.sourceDirectory}`);
  }
  const uploadRoot = resolveProjectPath(request.uploadDirectory);
  mkdirSync(uploadRoot, { recursive: true });

  updateJob(input.jobId, {
    status: "running",
    phase: "scanning",
    message: "正在扫描资源目录...",
  });
  const candidates = findCandidates(sourceRoot);
  updateJob(input.jobId, {
    total: candidates.length,
    phase: "processing",
    message: `发现 ${candidates.length} 个候选资源。`,
  });
  const items: AssetImportItem[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const currentFile = relative(sourceRoot, candidate.fullPath).replace(/\\/g, "/");
    updateJob(input.jobId, {
      currentFile,
      phase: "prefiltering",
      message: `正在检查是否变更: ${currentFile}`,
    });
    try {
      const sourceStats = statSync(candidate.fullPath);
      const unchanged = findImportedAssetBySourcePath(candidate.fullPath);
      if (unchanged && unchanged.sourceMtimeMs === sourceStats.mtimeMs && unchanged.sourceSize === sourceStats.size && isImportedRecordUsable(unchanged)) {
        skipped += 1;
        const item = importItemFromRecord(unchanged, candidate.fullPath, "文件未变更，已跳过截图和 RAG 重写。");
        items.push(item);
        appendJobItem(input.jobId, item);
        updateJob(input.jobId, {
          processed: items.length,
          imported,
          skipped,
          failed,
          phase: "processing",
          message: `已处理 ${items.length}/${candidates.length} 个资源。`,
        });
        continue;
      }

      updateJob(input.jobId, {
        currentFile,
        phase: "hashing",
        message: `正在计算内容指纹: ${currentFile}`,
      });
      const contentHash = hashFile(candidate.fullPath);
      const duplicate = findImportedAssetByHash(contentHash);
      let item: AssetImportItem;
      if (duplicate && isImportedRecordUsable(duplicate)) {
        skipped += 1;
        item = importItemFromRecord(duplicate, candidate.fullPath, `内容指纹重复，已跳过截图和 RAG 重写: ${duplicate.sourcePath}`);
        if (duplicate.sourcePath === candidate.fullPath) {
          saveImportedAsset({
            contentHash,
            sourcePath: candidate.fullPath,
            assetId: item.id,
            metadataPath: item.metadataPath,
            previewPath: item.previewPath,
            viewCount: item.viewCount,
            sourceMtimeMs: sourceStats.mtimeMs,
            sourceSize: sourceStats.size,
          });
        }
      } else {
        updateJob(input.jobId, {
          phase: "rendering",
          message: `正在提取 metadata 并截图: ${currentFile}`,
        });
        item = await importCandidate(candidate, sourceRoot, uploadRoot);
        if (item.ok) {
          saveImportedAsset({
            contentHash,
            sourcePath: candidate.fullPath,
            assetId: item.id,
            metadataPath: item.metadataPath,
            previewPath: item.previewPath,
            viewCount: item.viewCount,
            sourceMtimeMs: sourceStats.mtimeMs,
            sourceSize: sourceStats.size,
          });
          imported += 1;
        } else {
          failed += 1;
        }
      }
      items.push(item);
      appendJobItem(input.jobId, item);
    } catch (error) {
      failed += 1;
      const item: AssetImportItem = {
        id: uniqueAssetId(candidate.fullPath, sourceRoot),
        sourcePath: candidate.fullPath,
        viewCount: 0,
        ok: false,
        message: formatImportError(error),
      };
      items.push(item);
      appendJobItem(input.jobId, item);
    }
    updateJob(input.jobId, {
      processed: items.length,
      imported,
      skipped,
      failed,
      phase: "processing",
      message: `已处理 ${items.length}/${candidates.length} 个资源。`,
    });
  }
  updateJob(input.jobId, {
    phase: "ingesting",
    message: "正在写入 Milvus/RAG 索引...",
  });
  const ingest = await ingestAircraftRag();
  const extractionOk = items.every((item) => item.ok);
  const finalStatus = extractionOk ? "success" : imported > 0 || skipped > 0 ? "success" : "error";
  const result = assetImportResultSchema.parse({
    ok: extractionOk,
    scannedCount: candidates.length,
    importedCount: imported,
    ingestedCount: ingest.documentCount,
    items,
    message: `${imported} 个新增/变更资产已提取，${skipped} 个未变更/重复资产已跳过，${failed} 个提取失败；RAG: ${ingest.message}`,
  });
  updateJob(input.jobId, {
    status: finalStatus,
    phase: extractionOk ? "done" : finalStatus === "success" ? "done_with_warnings" : "error",
    currentFile: "",
    total: candidates.length,
    processed: candidates.length,
    imported,
    skipped,
    failed,
    percent: 100,
    message: result.message,
    items,
  });
  return result;
}

function findCandidates(root: string): ImportCandidate[] {
  const candidates: ImportCandidate[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (importableExtensions.has(ext)) candidates.push({ fullPath, ext });
    }
  };
  visit(root);
  return candidates.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

async function importCandidate(candidate: ImportCandidate, sourceRoot: string, uploadRoot: string): Promise<AssetImportItem> {
  const id = uniqueAssetId(candidate.fullPath, sourceRoot);
  const assetDir = resolve(uploadRoot, id);
  ensureInsideProject(assetDir);
  mkdirSync(resolve(assetDir, "views"), { recursive: true });

  const copiedFileName = modelExtensions.has(candidate.ext) ? `model${candidate.ext}` : `source${candidate.ext}`;
  const copiedPath = resolve(assetDir, copiedFileName);
  copyFileSync(candidate.fullPath, copiedPath);

  const sourceText = sourceExtensions.has(candidate.ext) ? safeReadText(candidate.fullPath) : "";
  const metadata: AircraftAssetMetadata = aircraftAssetMetadataSchema.parse(buildMetadata({
    id,
    candidate,
    sourceRoot,
    assetDir,
    copiedPath,
    sourceText,
  }));
  if (modelExtensions.has(candidate.ext)) {
    const analysis = await analyzeGlbStructure(copiedPath);
    metadata.structureAnalysis = analysis.structureAnalysis;
    metadata.templateParams = analysis.templateParams;
    metadata.constraintHints = analysis.constraintHints;
    metadata.materials = Array.from(new Set([
      ...metadata.materials,
      ...metadata.structureAnalysis.meshStats.flatMap((stat) => stat.materials),
    ])).slice(0, 24);
  }

  let message = "metadata 已生成。";
  try {
    const shotResult = modelExtensions.has(candidate.ext)
      ? await renderModelViews(copiedPath, assetDir)
      : await renderSourceViews(copiedPath, candidate.ext, assetDir);
    metadata.previewPath = shotResult.previewPath ?? metadata.previewPath;
    metadata.viewImages = shotResult.viewImages;
    metadata.viewFeatures = buildViewFeatures(shotResult.viewImages);
    if (modelExtensions.has(candidate.ext)) {
      metadata.shapeSummary = buildShapeSummary(metadata, inputFileLabel(candidate.fullPath));
      metadata.skeletonHints = buildSkeletonHints(metadata);
    }
    message = shotResult.message;
  } catch (error) {
    if (sourceExtensions.has(candidate.ext)) {
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = await renderSourceSummaryViews(copiedPath, assetDir, `源码真实运行截图失败，已生成源码摘要六视图。原因: ${reason}`);
      metadata.previewPath = fallback.previewPath ?? metadata.previewPath;
      metadata.viewImages = fallback.viewImages;
      metadata.viewFeatures = buildViewFeatures(fallback.viewImages);
      message = fallback.message;
    } else {
      metadata.shapeSummary = buildShapeSummary(metadata, inputFileLabel(candidate.fullPath));
      metadata.skeletonHints = buildSkeletonHints(metadata);
      message = `截图失败，仅生成 metadata: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const metadataPath = resolve(assetDir, "metadata.json");
  const parsed = aircraftAssetMetadataSchema.parse(metadata);
  writeFileSync(metadataPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return {
    id,
    sourcePath: candidate.fullPath,
    metadataPath: toProjectRelativePath(metadataPath),
    previewPath: parsed.previewPath,
    viewCount: parsed.viewImages.length,
    ok: parsed.viewImages.length === 6,
    message,
  };
}

function buildMetadata(input: {
  id: string;
  candidate: ImportCandidate;
  sourceRoot: string;
  assetDir: string;
  copiedPath: string;
  sourceText: string;
}): AircraftAssetMetadata {
  const folderText = collectNearbyDescription(input.candidate.fullPath);
  const title = titleFromPath(input.candidate.fullPath);
  const description = [
    extractDescription(input.sourceText),
    folderText,
    `自动从 ${relative(input.sourceRoot, input.candidate.fullPath).replace(/\\/g, "/")} 导入。`,
  ].filter(Boolean).join("\n").slice(0, 1000);
  const category = inferCategory(`${input.candidate.fullPath}\n${input.sourceText}\n${folderText}`);
  const codeReference = sourceExtensions.has(input.candidate.ext) ? extractCodeReference(input.sourceText) : undefined;
  const tags = Array.from(new Set([
    "imported",
    "aircraft",
    category,
    ...tokenizeName(input.candidate.fullPath),
    modelExtensions.has(input.candidate.ext) ? "glb" : "threejs-source",
  ])).slice(0, 16);
  const relativeAssetPath = toProjectRelativePath(input.copiedPath);
  const previewPath = toProjectRelativePath(resolve(input.assetDir, "preview.png"));
  return aircraftAssetMetadataSchema.parse({
    id: input.id,
    category,
    title,
    description: description || `${title} 自动导入资产。`,
    tags,
    assetPath: relativeAssetPath,
    previewPath,
    scale: 1,
    pivot: "center",
    forward: "+Z",
    animations: [],
    materials: [],
    compatibleWith: ["runtime_renderer", "rag_import"],
    viewImages: [],
    codeSummary: codeReference?.summary ?? "",
    keySnippets: codeReference?.snippets ?? [],
    detectedPatterns: codeReference?.patterns ?? [],
    shapeSummary: modelExtensions.has(input.candidate.ext)
      ? buildShapeSummary(
          {
            category,
            title,
            description: description || `${title} 自动导入资产。`,
            tags,
            viewImages: [],
            skeletonHints: [],
          },
          inputFileLabel(input.candidate.fullPath),
        )
      : "",
    viewFeatures: [],
    skeletonHints: modelExtensions.has(input.candidate.ext)
      ? buildSkeletonHints({
          category,
          title,
          description: description || `${title} 自动导入资产。`,
          tags,
        })
      : [],
  });
}

function extractCodeReference(sourceText: string): { summary: string; snippets: string[]; patterns: string[] } {
  const patterns = detectSourcePatterns(sourceText);
  const snippets = extractKeySnippets(sourceText);
  const geometryHints = patterns.filter((pattern) => /Geometry|Curve|Shape|Line|Edges/i.test(pattern));
  const materialHints = patterns.filter((pattern) => /Material|Texture|color|metal|rough/i.test(pattern));
  const cameraHints = patterns.filter((pattern) => /Camera|OrbitControls|Light/i.test(pattern));
  const summary = [
    "自动源码摘要：该 three.js 源码可作为 coder 的结构参考，不应整段复制。",
    geometryHints.length ? `几何/线框模式: ${geometryHints.join(", ")}` : "",
    materialHints.length ? `材质/贴图模式: ${materialHints.join(", ")}` : "",
    cameraHints.length ? `相机/灯光模式: ${cameraHints.join(", ")}` : "",
    snippets.length ? `已提取 ${snippets.length} 个可复用片段。` : "未识别到稳定函数片段，仅保留文件级摘要。",
  ].filter(Boolean).join("\n");
  return {
    summary: clipText(summary, 3000),
    snippets,
    patterns,
  };
}

function detectSourcePatterns(sourceText: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/GLTFLoader/i, "GLTFLoader"],
    [/OrbitControls/i, "OrbitControls"],
    [/PerspectiveCamera/i, "PerspectiveCamera"],
    [/OrthographicCamera/i, "OrthographicCamera"],
    [/DirectionalLight/i, "DirectionalLight"],
    [/AmbientLight/i, "AmbientLight"],
    [/MeshStandardMaterial/i, "MeshStandardMaterial"],
    [/MeshPhysicalMaterial/i, "MeshPhysicalMaterial"],
    [/LineBasicMaterial/i, "LineBasicMaterial"],
    [/EdgesGeometry/i, "EdgesGeometry"],
    [/LineSegments/i, "LineSegments"],
    [/TorusGeometry/i, "TorusGeometry"],
    [/SphereGeometry/i, "SphereGeometry"],
    [/CylinderGeometry/i, "CylinderGeometry"],
    [/BoxGeometry/i, "BoxGeometry"],
    [/LatheGeometry/i, "LatheGeometry"],
    [/ExtrudeGeometry/i, "ExtrudeGeometry"],
    [/BufferGeometry/i, "BufferGeometry"],
    [/CatmullRomCurve3/i, "CatmullRomCurve3"],
    [/Shape\(/i, "Shape"],
    [/TextureLoader/i, "TextureLoader"],
    [/AnimationMixer/i, "AnimationMixer"],
    [/preserveDrawingBuffer/i, "preserveDrawingBuffer"],
    [/__AGENTIC_THREE_VIEW__/i, "__AGENTIC_THREE_VIEW__"],
  ];
  return checks.filter(([pattern]) => pattern.test(sourceText)).map(([, label]) => label);
}

function extractKeySnippets(sourceText: string): string[] {
  if (!sourceText.trim()) return [];
  const snippets: string[] = [];
  const functionPattern = /(?:export\s+)?(?:default\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = functionPattern.exec(sourceText)) && snippets.length < 4) {
    const start = match.index;
    const extracted = extractBalancedBlock(sourceText, start);
    if (extracted && isUsefulSnippet(extracted)) snippets.push(clipText(extracted, 1400));
  }
  if (snippets.length < 4) {
    const importantLines = sourceText
      .split(/\r?\n/)
      .filter((line) => /(Geometry|Material|Camera|Light|LineSegments|EdgesGeometry|OrbitControls|GLTFLoader|renderer|scene\.add)/.test(line))
      .slice(0, 24)
      .join("\n");
    if (importantLines.trim()) snippets.push(clipText(importantLines, 1400));
  }
  return Array.from(new Set(snippets)).slice(0, 4);
}

function extractBalancedBlock(sourceText: string, start: number): string {
  const open = sourceText.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
    if (index - start > 5000) break;
  }
  return sourceText.slice(start, Math.min(sourceText.length, start + 1600));
}

function isUsefulSnippet(snippet: string): boolean {
  return /(THREE|Geometry|Material|Camera|Light|LineSegments|EdgesGeometry|renderer|scene\.add|OrbitControls|GLTFLoader)/.test(snippet);
}

function buildViewFeatures(viewImages: AircraftAssetMetadata["viewImages"]): string[] {
  return viewImages.map((view) => `${viewLabel(view.view)}: ${view.description}`).slice(0, 8);
}

function buildShapeSummary(
  asset: Pick<AircraftAssetMetadata, "category" | "title" | "description" | "tags"> & {
    viewImages?: AircraftAssetMetadata["viewImages"];
    skeletonHints?: string[];
    structureAnalysis?: AircraftAssetMetadata["structureAnalysis"];
    templateParams?: AircraftAssetMetadata["templateParams"];
    constraintHints?: AircraftAssetMetadata["constraintHints"];
  },
  sourceLabel: string,
): string {
  const hints = buildSkeletonHints(asset).join("；");
  const viewText = asset.viewImages?.length ? `六视图数量 ${asset.viewImages.length}，可用于判断正面/侧面/俯视比例。` : "等待自动六视图截图补充。";
  const structure = asset.structureAnalysis?.status === "success"
    ? [
        `结构分析: node=${asset.structureAnalysis.nodeCount}, mesh=${asset.structureAnalysis.meshCount}, material=${asset.structureAnalysis.materialCount}。`,
        asset.structureAnalysis.dominantAxis ? `候选主轴: ${asset.structureAnalysis.dominantAxis}。` : "",
        asset.structureAnalysis.bounds ? `整体尺寸: ${asset.structureAnalysis.bounds.size.map((value) => value.toFixed(3)).join(" x ")}。` : "",
        asset.structureAnalysis.radialPatterns.length
          ? `径向重复: ${asset.structureAnalysis.radialPatterns.map((pattern) => `${pattern.count} 个/${pattern.axis}/conf ${pattern.confidence.toFixed(2)}`).join("；")}。`
          : "",
      ].filter(Boolean).join(" ")
    : asset.structureAnalysis?.status === "error"
      ? `结构分析失败: ${asset.structureAnalysis.error}`
      : "";
  const template = asset.templateParams?.template
    ? `模板参数: ${asset.templateParams.template}, confidence=${(asset.templateParams.confidence ?? 0).toFixed(2)}, turbofan=${JSON.stringify(asset.templateParams.turbofan ?? {})}。`
    : "";
  const constraints = asset.constraintHints?.length
    ? `约束提示: ${asset.constraintHints.map((hint) => `${hint.type}/${hint.priority}/${hint.confidence.toFixed(2)}`).join("；")}。`
    : "";
  return clipText([
    `GLB 形体摘要: ${asset.title} (${sourceLabel})。`,
    `类别: ${asset.category}; 标签: ${asset.tags.join(", ")}。`,
    asset.description,
    hints ? `结构要点: ${hints}` : "",
    structure,
    template,
    constraints,
    viewText,
  ].filter(Boolean).join("\n"), 3000);
}

function buildSkeletonHints(asset: Pick<AircraftAssetMetadata, "category" | "title" | "description" | "tags"> & {
  structureAnalysis?: AircraftAssetMetadata["structureAnalysis"];
  templateParams?: AircraftAssetMetadata["templateParams"];
  constraintHints?: AircraftAssetMetadata["constraintHints"];
}): string[] {
  const text = `${asset.category} ${asset.title} ${asset.description} ${asset.tags.join(" ")}`.toLowerCase();
  const structuralHints = [
    asset.structureAnalysis?.radialPatterns[0] ? `GLB 结构分析检测到 ${asset.structureAnalysis.radialPatterns[0].count} 个候选径向重复部件，可映射为 bladeArray。` : "",
    asset.templateParams?.turbofan?.hubRadius ? `模板 hubRadius≈${asset.templateParams.turbofan.hubRadius.toFixed(3)}。` : "",
    asset.templateParams?.turbofan?.outerRingInnerRadius ? `模板 outerRingInnerRadius≈${asset.templateParams.turbofan.outerRingInnerRadius.toFixed(3)}。` : "",
    asset.constraintHints?.length ? `硬约束优先: ${asset.constraintHints.map((hint) => hint.type).join(", ")}。` : "",
  ].filter(Boolean);
  if (/engine|turbofan|fan|发动机|涡扇|叶片|进气/.test(text)) {
    return [
      ...structuralHints,
      "正面应有外涵道/机匣大圆环和内涵道圆环。",
      "中心应有整流锥或轮毂，周围放射状风扇叶片。",
      "侧面可用短圆筒机匣、唇口厚度和后部收缩表达发动机体积。",
      "工程黑线白图优先使用 Torus/Cylinder/Sphere/EdgesGeometry/LineSegments 组合。",
    ];
  }
  if (/wing|airfoil|机翼|翼型/.test(text)) {
    return [
      "机翼应有翼型厚度、前缘圆滑、后缘较薄。",
      "平面轮廓需要展弦比和轻微后掠。",
      "工程线稿可用 Box/Shape/ExtrudeGeometry 加分段结构线表达翼肋和蒙皮。",
    ];
  }
  if (/fuselage|机身/.test(text)) {
    return [
      "机身主体应为长筒/流线体，截面近圆或椭圆。",
      "可用 Cylinder/Lathe/Curve 组合表达机鼻、舱段和尾部收缩。",
    ];
  }
  if (/gear|wheel|起落架/.test(text)) {
    return [
      "起落架应包含轮胎、轮毂、支柱和斜撑。",
      "黑线白图可用圆环、圆柱和线段强调机械连接关系。",
    ];
  }
  return [
    ...structuralHints,
    "提取主体外轮廓、主轴方向、对称关系和重复结构。",
    "优先把 GLB 作为真实几何基底，再用模板参数和程序化补件做可控微调。",
  ];
}

function inputFileLabel(path: string): string {
  return basename(path);
}

function clipText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function importItemFromRecord(record: ImportedAssetRecord, sourcePath: string, message: string): AssetImportItem {
  const metadata = readImportedMetadata(record.metadataPath);
  return {
    id: record.assetId,
    sourcePath,
    metadataPath: record.metadataPath,
    previewPath: record.previewPath ?? metadata?.previewPath,
    viewCount: record.viewCount || metadata?.viewImages.length || 0,
    ok: true,
    message,
  };
}

function readImportedMetadata(metadataPath: string | undefined): AircraftAssetMetadata | undefined {
  if (!metadataPath) return undefined;
  try {
    const fullPath = resolve(projectRoot, metadataPath);
    if (!existsSync(fullPath)) return undefined;
    return aircraftAssetMetadataSchema.parse(JSON.parse(readFileSync(fullPath, "utf8")));
  } catch {
    return undefined;
  }
}

function isImportedRecordUsable(record: ImportedAssetRecord): boolean {
  const metadata = readImportedMetadata(record.metadataPath);
  if (!metadata || metadata.viewImages.length !== 6) return false;
  const paths = [metadata.previewPath, ...metadata.viewImages.map((view) => view.imagePath)];
  return paths.every((path) => existsSync(resolve(projectRoot, path)));
}

async function renderModelViews(modelPath: string, assetDir: string): Promise<{
  previewPath?: string;
  viewImages: AircraftAssetMetadata["viewImages"];
  message: string;
}> {
  const modelFileName = extname(modelPath).toLowerCase() === ".gltf" ? "model.gltf" : "model.glb";
  const viewer = await startStreamingViewerServer((baseUrl) => modelViewerHtml(baseUrl, modelFileName), {
    [modelFileName]: modelPath,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
    const diagnostics = collectPageDiagnostics(page);
    await page.goto(`${viewer.baseUrl}/viewer.html`);
    await waitForAssetReady(page).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}${diagnostics.length ? `；浏览器诊断: ${diagnostics.slice(-8).join(" | ")}` : ""}`);
    });

    const viewImages = [];
    for (const view of views) {
      await page.evaluate((nextView) => {
        const browserWindow = globalThis as unknown as { __setAssetView?: (view: string) => void };
        browserWindow.__setAssetView?.(nextView);
      }, view);
      await page.waitForTimeout(120);
      const fullPath = resolve(assetDir, "views", `${view}.png`);
      await page.screenshot({ path: fullPath, type: "png" });
      viewImages.push({
        view,
        imagePath: toProjectRelativePath(fullPath),
        title: `${viewLabel(view)}六视图参考`,
        description: `自动渲染的 ${viewLabel(view)}，用于 RAG 视觉检索和结构参考。`,
        tags: [view, "auto-screenshot", "six-view"],
      });
    }
    const previewFullPath = resolve(assetDir, "preview.png");
    copyFileSync(resolve(assetDir, "views", "front.png"), previewFullPath);
    return {
      previewPath: toProjectRelativePath(previewFullPath),
      viewImages,
      message: "GLB 已自动渲染六面图并生成 metadata。",
    };
  } finally {
    await browser.close();
    await viewer.close();
  }
}

async function renderSourceViews(sourcePath: string, ext: string, assetDir: string): Promise<{
  previewPath?: string;
  viewImages: AircraftAssetMetadata["viewImages"];
  message: string;
}> {
  if (ext === ".tsx") {
    return renderSourceSummaryViews(sourcePath, assetDir, "TSX 源码需要项目 bundler 上下文，已自动生成源码六视图检索图。");
  }
  const runnablePath = ext === ".ts" ? await transpileTypeScriptSource(sourcePath) : sourcePath;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
    if (ext === ".html") {
      await page.goto(pathToFileURL(sourcePath).href);
    } else {
      await routeViewer(page, sourceViewerHtml(), { "source-module.js": runnablePath });
      await page.goto("http://asset-import.local/viewer.html");
    }
    await page.waitForFunction(() => Boolean(document.querySelector("canvas")), undefined, { timeout: 5000 });
    await page.evaluate(() => {
      const browserWindow = globalThis as unknown as { __installGenericAssetView?: () => void };
      browserWindow.__installGenericAssetView?.();
    });
    const canSetView = await page.evaluate(() => {
      const browserWindow = globalThis as unknown as { __setAssetView?: (view: string) => void };
      return Boolean(browserWindow.__setAssetView);
    });
    if (!canSetView) {
      return renderSourceSummaryViews(sourcePath, assetDir, "three.js 源码已运行，但未暴露可控相机，已自动生成源码六视图检索图。");
    }
    const sourceViews = views;
    const viewImages = [];
    for (const view of sourceViews) {
      if (canSetView) {
        await page.evaluate((nextView) => {
          const browserWindow = globalThis as unknown as { __setAssetView?: (view: string) => void };
          browserWindow.__setAssetView?.(nextView);
        }, view);
      }
      await page.waitForTimeout(120);
      const fullPath = resolve(assetDir, "views", `${view}.png`);
      await page.screenshot({ path: fullPath, type: "png" });
      viewImages.push({
        view,
        imagePath: toProjectRelativePath(fullPath),
        title: `${viewLabel(view)}源码运行截图`,
        description: `自动运行 three.js 源码后截取的 ${viewLabel(view)}。`,
        tags: [view, "source", "auto-screenshot"],
      });
    }
    const previewFullPath = resolve(assetDir, "preview.png");
    copyFileSync(resolve(assetDir, "views", `${sourceViews[0]}.png`), previewFullPath);
    return {
      previewPath: toProjectRelativePath(previewFullPath),
      viewImages,
      message: "three.js 源码已运行并自动渲染六面图。",
    };
  } finally {
    await browser.close();
  }
}

async function renderSourceSummaryViews(sourcePath: string, assetDir: string, message: string): Promise<{
  previewPath?: string;
  viewImages: AircraftAssetMetadata["viewImages"];
  message: string;
}> {
  const source = safeReadText(sourcePath);
  const title = titleFromPath(sourcePath);
  const description = extractDescription(source) || "自动提取的 three.js/React 源码资产。";
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
    await page.setContent(sourceSummaryHtml(), { waitUntil: "domcontentloaded" });
    const viewImages = [];
    for (const view of views) {
      await page.evaluate(
        ({ nextView, nextTitle, nextDescription, nextSource }) => {
          const browserWindow = globalThis as unknown as {
            __drawSourceSummaryView?: (input: { view: string; title: string; description: string; source: string }) => void;
          };
          browserWindow.__drawSourceSummaryView?.({
            view: nextView,
            title: nextTitle,
            description: nextDescription,
            source: nextSource,
          });
        },
        {
          nextView: view,
          nextTitle: title,
          nextDescription: description,
          nextSource: source.slice(0, 1800),
        },
      );
      await page.waitForTimeout(80);
      const fullPath = resolve(assetDir, "views", `${view}.png`);
      await page.screenshot({ path: fullPath, type: "png" });
      viewImages.push({
        view,
        imagePath: toProjectRelativePath(fullPath),
        title: `${viewLabel(view)}源码摘要图`,
        description: `自动从源码内容生成的 ${viewLabel(view)}检索图，用于 RAG metadata 和视觉记忆。`,
        tags: [view, "source-summary", "auto-screenshot", "six-view"],
      });
    }
    const previewFullPath = resolve(assetDir, "preview.png");
    copyFileSync(resolve(assetDir, "views", "front.png"), previewFullPath);
    return {
      previewPath: toProjectRelativePath(previewFullPath),
      viewImages,
      message,
    };
  } finally {
    await browser.close();
  }
}

async function routeViewer(page: Page, html: string, files: Record<string, string>): Promise<void> {
  const threeModulePath = resolveThreeFile("build/three.module.js");
  const gltfLoaderPath = resolveThreeFile("examples/jsm/loaders/GLTFLoader.js");
  const bufferGeometryUtilsPath = resolveThreeFile("examples/jsm/utils/BufferGeometryUtils.js");
  await page.route("http://asset-import.local/viewer.html", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("http://asset-import.local/three.module.js", (route) => route.fulfill({ path: threeModulePath, contentType: "text/javascript" }));
  await page.route("http://asset-import.local/GLTFLoader.js", (route) => route.fulfill({ path: gltfLoaderPath, contentType: "text/javascript" }));
  await page.route("http://asset-import.local/utils/BufferGeometryUtils.js", (route) =>
    route.fulfill({ path: bufferGeometryUtilsPath, contentType: "text/javascript" }),
  );
  for (const [name, fullPath] of Object.entries(files)) {
    await page.route(`http://asset-import.local/${name}`, (route) => route.fulfill({ path: fullPath, contentType: mimeType(fullPath) }));
  }
}

async function startStreamingViewerServer(
  htmlFactory: (baseUrl: string) => string,
  files: Record<string, string>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const threeModulePath = resolveThreeFile("build/three.module.js");
  const gltfLoaderPath = resolveThreeFile("examples/jsm/loaders/GLTFLoader.js");
  const bufferGeometryUtilsPath = resolveThreeFile("examples/jsm/utils/BufferGeometryUtils.js");
  const servedFiles = new Map<string, string>([
    ["/three.module.js", threeModulePath],
    ["/GLTFLoader.js", gltfLoaderPath],
    ["/utils/BufferGeometryUtils.js", bufferGeometryUtilsPath],
    ...Object.entries(files).map(([name, fullPath]) => [`/${name}`, fullPath] as const),
  ]);
  let html = "";
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    const filePath = servedFiles.get(pathname);
    if (!filePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    streamFile(response, filePath);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("无法启动资产截图本地流式服务。");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  html = htmlFactory(baseUrl);
  return {
    baseUrl,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

function streamFile(response: ServerResponse, filePath: string): void {
  if (!existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const stats = statSync(filePath);
  response.writeHead(200, {
    "content-type": mimeType(filePath),
    "content-length": stats.size,
  });
  createReadStream(filePath).on("error", (error) => {
    if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }).pipe(response);
}

function collectPageDiagnostics(page: Page): string[] {
  const diagnostics: string[] = [];
  const push = (message: string) => {
    diagnostics.push(message);
    if (diagnostics.length > 30) diagnostics.shift();
  };
  page.on("console", (message) => push(`console:${message.type()} ${message.text()}`));
  page.on("pageerror", (error) => push(`pageerror ${error.message}`));
  page.on("requestfailed", (request) => push(`requestfailed ${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("response", (response) => {
    if (response.status() >= 400) push(`response ${response.status()} ${response.url()}`);
  });
  return diagnostics;
}

async function waitForAssetReady(page: import("playwright").Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const browserWindow = globalThis as unknown as { __ASSET_ERROR__?: string; __ASSET_READY__?: boolean };
      return browserWindow.__ASSET_READY__ === true || Boolean(browserWindow.__ASSET_ERROR__);
    },
    undefined,
    { timeout: 60000 },
  );
  const error = await page.evaluate(() => {
    const browserWindow = globalThis as unknown as { __ASSET_ERROR__?: string };
    return browserWindow.__ASSET_ERROR__ ?? "";
  });
  if (error) throw new Error(error);
}

async function transpileTypeScriptSource(sourcePath: string): Promise<string> {
  const ts = await import("typescript");
  const source = readFileSync(sourcePath, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const outputPath = resolve(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}.asset-import.mjs`);
  writeFileSync(outputPath, result.outputText, "utf8");
  return outputPath;
}

function modelViewerHtml(baseUrl: string, modelFileName: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}canvas{display:block}</style>
  <script type="importmap">{"imports":{"three":"${baseUrl}/three.module.js","three/addons/loaders/GLTFLoader.js":"${baseUrl}/GLTFLoader.js"}}</script>
</head>
<body>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const scene = new THREE.Scene();
scene.background = new THREE.Color("#ffffff");
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 10000);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
scene.add(new THREE.AmbientLight("#ffffff", 1.4));
const key = new THREE.DirectionalLight("#ffffff", 2.6);
key.position.set(3, 4, 5);
scene.add(key);
const root = new THREE.Group();
scene.add(root);
let bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

function frameObject() {
  bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  window.__setAssetView("front");
}

window.__setAssetView = (view) => {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z, 1);
  const distance = maxSize * 2.7;
  const positions = {
    front: [0, 0, distance],
    back: [0, 0, -distance],
    left: [-distance, 0, 0],
    right: [distance, 0, 0],
    top: [0, distance, 0],
    bottom: [0, -distance, 0],
  };
  const pos = positions[view] || positions.front;
  camera.position.set(center.x + pos[0], center.y + pos[1], center.z + pos[2]);
  camera.up.set(0, 1, 0);
  if (view === "top") camera.up.set(0, 0, -1);
  if (view === "bottom") camera.up.set(0, 0, 1);
  camera.near = Math.max(0.01, distance / 100);
  camera.far = distance * 100;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
};

const missingTexture =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => {
  if (/\\.(png|jpe?g|webp|ktx2?|basis)$/i.test(url)) {
    return missingTexture;
  }
  return new URL(url, "${baseUrl}/").href;
});

const loader = new GLTFLoader(manager);
loader.load(
  "${baseUrl}/${modelFileName}",
  (gltf) => {
    root.add(gltf.scene);
    frameObject();
    window.__ASSET_READY__ = true;
  },
  undefined,
  (error) => {
    window.__ASSET_ERROR__ = error?.message || String(error);
  },
);
</script>
</body>
</html>`;
}

function sourceViewerHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}canvas{display:block}</style>
  <script type="importmap">{"imports":{"three":"http://asset-import.local/three.module.js","three/addons/loaders/GLTFLoader.js":"http://asset-import.local/GLTFLoader.js","three/examples/jsm/loaders/GLTFLoader.js":"http://asset-import.local/GLTFLoader.js"}}</script>
</head>
<body>
<div id="root"></div>
<script type="module">
import * as THREE from "three";
window.__installGenericAssetView = () => {
  const view = window.__AGENTIC_THREE_VIEW__;
  if (!view?.scene || !view?.camera || !view?.renderer) return;
  window.__setAssetView = (nextView) => {
    const box = new THREE.Box3().setFromObject(view.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 1);
    const distance = maxSize * 2.7;
    const positions = { front:[0,0,distance], back:[0,0,-distance], left:[-distance,0,0], right:[distance,0,0], top:[0,distance,0], bottom:[0,-distance,0] };
    const pos = positions[nextView] || positions.front;
    view.camera.position.set(center.x + pos[0], center.y + pos[1], center.z + pos[2]);
    view.camera.up.set(0, 1, 0);
    if (nextView === "top") view.camera.up.set(0, 0, -1);
    if (nextView === "bottom") view.camera.up.set(0, 0, 1);
    view.camera.lookAt(center);
    view.camera.updateProjectionMatrix();
    view.renderer.render(view.scene, view.camera);
  };
};
import "http://asset-import.local/source-module.js";
</script>
</body>
</html>`;
}

function sourceSummaryHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f8fafc}canvas{display:block}</style>
</head>
<body>
<canvas width="960" height="720"></canvas>
<script>
const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");
function wrap(text, x, y, width, lineHeight, maxLines) {
  const words = String(text || "").replace(/\\s+/g, " ").trim().split(" ");
  let line = "";
  let lines = 0;
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > width && line) {
      ctx.fillText(line, x, y);
      y += lineHeight;
      lines += 1;
      line = word;
      if (lines >= maxLines) return y;
    } else {
      line = test;
    }
  }
  if (line && lines < maxLines) ctx.fillText(line, x, y);
  return y + lineHeight;
}
window.__drawSourceSummaryView = ({ view, title, description, source }) => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gradients = {
    front: ["#eef2ff", "#ffffff"],
    back: ["#f0fdf4", "#ffffff"],
    left: ["#fff7ed", "#ffffff"],
    right: ["#ecfeff", "#ffffff"],
    top: ["#fdf2f8", "#ffffff"],
    bottom: ["#f8fafc", "#e2e8f0"],
  };
  const [a, b] = gradients[view] || gradients.front;
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, a);
  gradient.addColorStop(1, b);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 4;
  ctx.strokeRect(46, 42, 868, 636);
  ctx.fillStyle = "#0f172a";
  ctx.font = "700 42px Georgia, serif";
  ctx.fillText(title || "three.js source asset", 84, 112);
  ctx.font = "600 24px Georgia, serif";
  ctx.fillText("view: " + view, 84, 156);
  ctx.font = "20px Consolas, monospace";
  ctx.fillStyle = "#334155";
  wrap(description || "auto extracted source metadata", 84, 212, 760, 28, 4);
  ctx.fillStyle = "#020617";
  ctx.fillRect(84, 344, 792, 236);
  ctx.fillStyle = "#dbeafe";
  ctx.font = "16px Consolas, monospace";
  wrap(String(source || "").slice(0, 900), 110, 382, 730, 22, 8);
  ctx.fillStyle = "#2563eb";
  ctx.beginPath();
  ctx.arc(820, 140, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 22px Georgia, serif";
  ctx.fillText("AI", 807, 148);
};
window.__drawSourceSummaryView({ view: "front", title: "three.js source asset", description: "", source: "" });
</script>
</body>
</html>`;
}

function inferCategory(text: string): AircraftAssetCategory {
  const lower = text.toLowerCase();
  if (/engine|turbofan|fan|发动机|涡扇/.test(lower)) return "engine";
  if (/wing|airfoil|机翼|翼型/.test(lower)) return "wing";
  if (/fuselage|机身/.test(lower)) return "fuselage";
  if (/gear|wheel|起落架/.test(lower)) return "landing_gear";
  if (/cockpit|驾驶舱/.test(lower)) return "cockpit";
  if (/material|材质/.test(lower)) return "material";
  return "environment";
}

function collectNearbyDescription(path: string): string {
  const dir = dirname(path);
  for (const name of ["metadata.json", "README.md", "readme.md", "description.txt"]) {
    const fullPath = resolve(dir, name);
    if (!existsSync(fullPath)) continue;
    const text = safeReadText(fullPath);
    if (name.endsWith(".json")) {
      try {
        const parsed = JSON.parse(text) as { description?: string; title?: string; tags?: string[] };
        return [parsed.title, parsed.description, parsed.tags?.join(", ")].filter(Boolean).join("\n").slice(0, 600);
      } catch {
        return "";
      }
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 600);
  }
  return "";
}

function extractDescription(sourceText: string): string {
  const block = sourceText.match(/\/\*\*?([\s\S]*?)\*\//)?.[1];
  const lineComments = sourceText.match(/(?:^|\n)\s*\/\/\s*(.{8,})/g)?.slice(0, 6).join("\n");
  return (block ?? lineComments ?? "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/^\s*\/\/\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function uniqueAssetId(path: string, sourceRoot: string): string {
  const relativePath = relative(sourceRoot, path).replace(/\\/g, "/");
  const base = slugify(relativePath.replace(/\.[^.]+$/, ""));
  return `${base}-${shortHash(relativePath)}`.slice(0, 96).replace(/-+$/g, "");
}

function titleFromPath(path: string): string {
  return basename(path, extname(path))
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .slice(0, 120);
}

function tokenizeName(path: string): string[] {
  return basename(path, extname(path)).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((item) => item.length > 1);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "asset";
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36).slice(0, 6);
}

function viewLabel(view: AircraftView): string {
  return {
    front: "正面",
    back: "背面",
    left: "左侧",
    right: "右侧",
    top: "俯视",
    bottom: "仰视",
    three_quarter: "三分之四",
    detail: "细节",
  }[view];
}

function resolveProjectPath(relativePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    throw new Error(`上传目录必须是项目内相对路径: ${relativePath}`);
  }
  if (relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`上传目录不能包含 ..: ${relativePath}`);
  }
  const fullPath = resolve(projectRoot, relativePath);
  ensureInsideProject(fullPath);
  return fullPath;
}

function resolveThreeFile(relativePath: string): string {
  return resolve(dirname(dirname(require.resolve("three"))), relativePath);
}

function toProjectRelativePath(path: string): string {
  const fullPath = resolve(path);
  ensureInsideProject(fullPath);
  return relative(projectRoot, fullPath).replace(/\\/g, "/");
}

function ensureInsideProject(path: string): void {
  const project = resolve(projectRoot);
  const target = resolve(path);
  if (target !== project && !target.startsWith(`${project}\\`) && !target.startsWith(`${project}/`)) {
    throw new Error(`路径必须在项目内: ${path}`);
  }
}

function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function mimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".glb") return "model/gltf-binary";
  if (ext === ".gltf") return "model/gltf+json";
  if (ext === ".js" || ext === ".mjs" || ext === ".ts") return "text/javascript";
  if (ext === ".html") return "text/html";
  return "application/octet-stream";
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function updateJob(jobId: string | undefined, patch: Partial<AssetImportJob>): void {
  if (!jobId) return;
  updateAssetImportJob(jobId, patch);
}

function appendJobItem(jobId: string | undefined, item: AssetImportItem): void {
  if (!jobId) return;
  appendAssetImportJobItem(jobId, item);
}

function formatImportError(error: unknown): string {
  if (error instanceof ZodError) {
    return `metadata 校验失败: ${error.issues.map((issue) => `${issue.path.join(".") || "root"} ${issue.message}`).join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}
