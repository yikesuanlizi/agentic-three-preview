import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  type ImageInput,
  type ScreenshotSaveRequest,
  imageInputSchema,
  screenshotSaveRequestSchema,
} from "@agentic-three/shared";
import {
  type ArtifactCleanupCandidate,
  type ArtifactRecord,
  getSession,
  listAllArtifactRecords,
  listInputImageArtifacts,
  listOrphanArtifactRecords,
  listSessionArtifacts,
  projectRoot,
  saveArtifact,
} from "./memory.js";

const outputsRoot = resolve(projectRoot, "outputs");
const screenshotsRoot = resolve(outputsRoot, "screenshots");
const inputImagesRoot = resolve(outputsRoot, "artifacts/input-images");
const assetsRoot = resolve(projectRoot, "assets");

export function saveScreenshotArtifact(input: ScreenshotSaveRequest): ArtifactRecord {
  const request = screenshotSaveRequestSchema.parse(input);
  const session = getSession(request.sessionId);
  const sessionSlug = slugify(session?.title || request.sessionId);
  const directory = resolve(screenshotsRoot, sessionSlug);
  ensureInside(screenshotsRoot, directory);
  mkdirSync(directory, { recursive: true });

  const fileName = `${timestamp()}_${slugify(request.view || "free")}_${(request.runId || "manual").slice(0, 8)}.png`;
  const fullPath = resolve(directory, fileName);
  ensureInside(screenshotsRoot, fullPath);

  const base64 = request.dataUrl.replace(/^data:image\/png;base64,/, "");
  writeFileSync(fullPath, Buffer.from(base64, "base64"));
  const relativePath = relative(projectRoot, fullPath).replace(/\\/g, "/");
  return saveArtifact({
    sessionId: request.sessionId,
    runId: request.runId,
    kind: "screenshot",
    path: fullPath,
    fileName,
    url: `/api/artifacts/file?path=${encodeURIComponent(relativePath)}`,
  });
}

export function readOutputFile(relativePath: string): { bytes: Buffer; fileName: string } {
  const fullPath = resolve(projectRoot, relativePath);
  ensureInside(outputsRoot, fullPath);
  return {
    bytes: readFileSync(fullPath),
    fileName: fullPath.split(/[\\/]/).at(-1) || "artifact.png",
  };
}

export function readProjectAssetFile(relativePath: string): { bytes: Buffer; fileName: string; mimeType: string } {
  const fullPath = resolve(projectRoot, relativePath);
  ensureInside(assetsRoot, fullPath);
  return {
    bytes: readFileSync(fullPath),
    fileName: fullPath.split(/[\\/]/).at(-1) || "asset.bin",
    mimeType: mimeForFileName(fullPath),
  };
}

export function saveInputImageArtifacts(input: { sessionId: string; runId?: string; images: ImageInput[] }): ImageInput[] {
  const session = getSession(input.sessionId);
  const sessionSlug = slugify(session?.title || input.sessionId);
  const directory = resolve(inputImagesRoot, sessionSlug);
  ensureInside(inputImagesRoot, directory);
  mkdirSync(directory, { recursive: true });

  return input.images.map((image, index) => {
    const parsed = imageInputSchema.parse(image);
    const data = parseImageDataUrl(parsed.dataUrl);
    const fileName = `${timestamp()}_${String(index + 1).padStart(2, "0")}_${slugify(parsed.name)}.${extensionForMime(data.mimeType)}`;
    const fullPath = resolve(directory, fileName);
    ensureInside(inputImagesRoot, fullPath);
    writeFileSync(fullPath, Buffer.from(data.base64, "base64"));
    const relativePath = relative(projectRoot, fullPath).replace(/\\/g, "/");
    saveArtifact({
      sessionId: input.sessionId,
      runId: input.runId,
      kind: "input_image",
      path: fullPath,
      fileName,
      url: `/api/artifacts/file?path=${encodeURIComponent(relativePath)}`,
    });
    return { ...parsed, mimeType: data.mimeType, name: parsed.name || fileName };
  });
}

export function listRecentInputImages(sessionId: string, limit = 4): ImageInput[] {
  return listInputImageArtifacts(sessionId, limit).map((artifact) => {
    const bytes = readFileSync(artifact.path);
    const mimeType = mimeForFileName(artifact.fileName);
    return imageInputSchema.parse({
      name: artifact.fileName,
      mimeType,
      dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
      note: "从本会话上一轮参考图自动复用",
    });
  });
}

export function deleteSessionArtifactFiles(sessionId: string): { deletedFiles: number; deletedDirectories: number; failed: string[] } {
  const artifacts = listSessionArtifacts(sessionId).map((artifact) => ({
    ...artifact,
    reason: "session_deleted" as const,
  }));
  return deleteArtifactFiles(artifacts);
}

export function cleanupOrphanArtifactFiles(input: { roots?: string[] } = {}): { deletedFiles: number; deletedDirectories: number; failed: string[] } {
  const scopedRoots = input.roots?.map((root) => resolve(root));
  scopedRoots?.forEach(ensureArtifactRootInsideOutputs);
  const databaseOrphans = scopedRoots?.length
    ? listOrphanArtifactRecords().filter((artifact) => isInsideAnyRoot(artifact.path, scopedRoots))
    : listOrphanArtifactRecords();
  const fileOrphans = listFilesystemOrphans(scopedRoots);
  return deleteArtifactFiles([...databaseOrphans, ...fileOrphans]);
}

function listFilesystemOrphans(roots = [screenshotsRoot, inputImagesRoot]): ArtifactCleanupCandidate[] {
  const livePaths = new Set(listAllKnownArtifactPaths().map((path) => resolve(path)));
  const candidates: ArtifactCleanupCandidate[] = [];
  for (const rootInput of roots) {
    const root = resolve(rootInput);
    ensureArtifactRootInsideOutputs(root);
    if (!existsSync(root)) continue;
    for (const path of walkFiles(root)) {
      const fullPath = resolve(path);
      if (livePaths.has(fullPath)) continue;
      candidates.push({
        sessionId: "",
        kind: root === screenshotsRoot ? "screenshot" : "input_image",
        path: fullPath,
        fileName: fullPath.split(/[\\/]/).at(-1) || "",
        url: "",
        reason: "db_orphan",
      });
    }
  }
  return candidates;
}

function listAllKnownArtifactPaths(): string[] {
  return listAllArtifactRecords().map((artifact) => artifact.path);
}

function deleteArtifactFiles(artifacts: ArtifactCleanupCandidate[]): { deletedFiles: number; deletedDirectories: number; failed: string[] } {
  let deletedFiles = 0;
  let deletedDirectories = 0;
  const failed: string[] = [];
  const directories = new Set<string>();
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    try {
      const fullPath = resolve(artifact.path);
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      ensureArtifactFileInsideOutputs(fullPath);
      if (existsSync(fullPath)) {
        rmSync(fullPath, { force: true });
        deletedFiles += 1;
      }
      directories.add(dirname(fullPath));
    } catch (error) {
      failed.push(`${artifact.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const directory of Array.from(directories).sort((a, b) => b.length - a.length)) {
    try {
      deletedDirectories += removeEmptyParents(directory);
    } catch (error) {
      failed.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { deletedFiles, deletedDirectories, failed };
}

function removeEmptyParents(directory: string): number {
  let current = resolve(directory);
  let removed = 0;
  const roots = [screenshotsRoot, inputImagesRoot].map((root) => resolve(root));
  while (roots.some((root) => current !== root && current.startsWith(`${root}\\`))) {
    if (!existsSync(current) || readdirSync(current).length) break;
    rmdirSync(current);
    removed += 1;
    current = dirname(current);
  }
  return removed;
}

function walkFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  };
  visit(root);
  return result.filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

function ensureArtifactFileInsideOutputs(path: string): void {
  const target = resolve(path);
  const roots = [screenshotsRoot, inputImagesRoot].map((root) => resolve(root));
  if (!roots.some((root) => target.startsWith(`${root}\\`) || target.startsWith(`${root}/`))) {
    throw new Error("只允许删除 outputs 下的截图和输入图产物。");
  }
}

function ensureArtifactRootInsideOutputs(path: string): void {
  const target = resolve(path);
  const roots = [screenshotsRoot, inputImagesRoot].map((root) => resolve(root));
  if (!roots.some((root) => target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`))) {
    throw new Error("只允许扫描 outputs 下的截图和输入图目录。");
  }
}

function isInsideAnyRoot(path: string, roots: string[]): boolean {
  const target = resolve(path);
  return roots.some((rootInput) => {
    const root = resolve(rootInput);
    return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`);
  });
}

function ensureInside(root: string, target: string): void {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}\\`) && !targetPath.startsWith(`${rootPath}/`)) {
    throw new Error("产物路径越界，已拒绝写入。");
  }
}

function slugify(value: string): string {
  const safe = value
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return safe || "session";
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    throw new Error("图片 dataUrl 必须是 base64 格式。");
  }
  return { mimeType: match[1], base64: match[2] };
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

function mimeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".glb")) return "model/gltf-binary";
  if (lower.endsWith(".gltf")) return "model/gltf+json";
  if (lower.endsWith(".bin")) return "application/octet-stream";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function timestamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`;
}
