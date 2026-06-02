import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  type ImageInput,
  type ScreenshotSaveRequest,
  imageInputSchema,
  screenshotSaveRequestSchema,
} from "@agentic-three/shared";
import { type ArtifactRecord, getSession, listInputImageArtifacts, projectRoot, saveArtifact } from "./memory.js";

const outputsRoot = resolve(projectRoot, "outputs");
const screenshotsRoot = resolve(outputsRoot, "screenshots");
const inputImagesRoot = resolve(outputsRoot, "artifacts/input-images");

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
