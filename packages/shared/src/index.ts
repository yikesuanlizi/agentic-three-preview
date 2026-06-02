import { z } from "zod";

export const ALLOWED_FILE_PATHS = [
  "src/App.tsx",
  "src/main.tsx",
  "src/styles.css",
  "package.json",
] as const;

export type AllowedFilePath = (typeof ALLOWED_FILE_PATHS)[number];

export const allowedFilePathSchema = z.enum(ALLOWED_FILE_PATHS);

export const imageInputSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().min(1),
  dataUrl: z.string().startsWith("data:"),
  note: z.string().optional(),
  dimension: z.string().optional(),
});

export const runtimeErrorSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
  source: z.string().optional(),
});

export const compactSummarySchema = z.object({
  userGoal: z.string().default(""),
  codeState: z.string().default(""),
  nextSteps: z.string().default(""),
  updatedAt: z.string().optional(),
});

export const modelNodeSchema = z.enum([
  "planner_agent",
  "coder_agent",
  "review_agent",
  "summary",
  "default",
]);

export const modelConfigSchema = z.object({
  node: modelNodeSchema,
  model: z.string().min(1),
  baseURL: z.string().url(),
  apiKeyEnvName: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(128).max(32768),
});

export const screenshotModeSchema = z.enum(["download", "save", "both"]);

export const runtimeComposerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRevisionRounds: z.number().int().min(1).max(8).default(3),
  minQualityScore: z.number().min(0).max(1).default(0.75),
  autoCaptureAfterPatch: z.boolean().default(true),
  requireVisualInspection: z.boolean().default(true),
  fallbackToCoder: z.boolean().default(true),
  captureDelayMs: z.number().int().min(0).max(10000).default(1200),
  nonBlankPixelThreshold: z.number().min(0).max(1).default(0.02),
});

export const appSettingsSchema = z.object({
  models: z.array(modelConfigSchema),
  screenshotMode: screenshotModeSchema.default("download"),
  enabledSkillIds: z.array(z.string()).default([]),
  runtimeComposer: runtimeComposerConfigSchema.default({}),
});

export const skillCreateRequestSchema = z.object({
  id: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  content: z.string().min(1).max(12000),
});

export const skillInferRequestSchema = z.object({
  content: z.string().min(1).max(12000),
});

export const skillInstallRequestSchema = z.object({
  url: z.string().url(),
});

export const aircraftAssetCategorySchema = z.enum([
  "engine",
  "wing",
  "fuselage",
  "landing_gear",
  "cockpit",
  "material",
  "environment",
]);

export const aircraftAssetMetadataSchema = z.object({
  id: z.string().min(2).max(96).regex(/^[a-z0-9-]+$/),
  category: aircraftAssetCategorySchema,
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  tags: z.array(z.string()).default([]),
  assetPath: z.string().min(1),
  previewPath: z.string().min(1),
  scale: z.number().positive().default(1),
  pivot: z.enum(["center", "origin", "bottom"]).default("center"),
  forward: z.enum(["+Z", "-Z", "+X", "-X"]).default("+Z"),
  polycount: z.number().int().nonnegative().optional(),
  animations: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  compatibleWith: z.array(z.string()).default([]),
});

export const renderStyleSchema = z.enum(["technical_lines", "realistic", "engineering_white", "ppt_clean"]);
export const sceneTypeSchema = z.enum(["engine_showcase", "front_technical_view", "exploded_view", "component_detail"]);
export const cameraPresetSchema = z.enum(["front", "three_quarter", "top", "side", "cinematic_closeup"]);
export const lightingPresetSchema = z.enum(["engineering_white", "studio_soft", "hangar_dark"]);

export const semanticIntentSchema = z.object({
  domain: z.literal("aircraft").default("aircraft"),
  subject: z.string().default("aircraft component"),
  category: aircraftAssetCategorySchema.optional(),
  view: cameraPresetSchema.default("front"),
  renderStyle: renderStyleSchema.default("technical_lines"),
  requestedOutputs: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  ocrText: z.string().default(""),
});

export const sceneDslObjectSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1).optional(),
  primitive: z.enum(["turbofan_front", "wing_panel", "fuselage_section", "landing_gear", "generic_part"]).default("generic_part"),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  scale: z.number().positive().default(1),
  animation: z.string().optional(),
});

export const sceneDslSchema = z.object({
  sceneType: sceneTypeSchema.default("engine_showcase"),
  cameraPreset: cameraPresetSchema.default("front"),
  lightingPreset: lightingPresetSchema.default("engineering_white"),
  renderStyle: renderStyleSchema.default("technical_lines"),
  objects: z.array(sceneDslObjectSchema).min(1),
  annotations: z.array(z.string()).default([]),
  animations: z.array(z.string()).default([]),
});

export const retrievalSearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).default(5),
  categories: z.array(aircraftAssetCategorySchema).default([]),
});

export const retrievalSearchResultSchema = z.object({
  kind: z.enum(["asset", "template", "wiki"]),
  id: z.string(),
  title: z.string(),
  description: z.string(),
  score: z.number(),
  tags: z.array(z.string()).default([]),
});

export const sceneComposeRequestSchema = z.object({
  intent: semanticIntentSchema,
  retrievalResults: z.array(retrievalSearchResultSchema).default([]),
});

export const sceneRenderRequestSchema = z.object({
  scene: sceneDslSchema,
});

export const qualityInspectionRequestSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().optional(),
  round: z.number().int().min(1),
  userGoal: z.string().default(""),
  referenceImages: z.array(imageInputSchema).default([]),
  screenshotDataUrl: z.string().startsWith("data:image/png;base64,"),
  scene: sceneDslSchema,
  runtimeErrors: z.array(runtimeErrorSchema).default([]),
});

export const qualityInspectionStatusSchema = z.enum(["pass", "revise", "ask_user", "fallback"]);

export const qualityInspectionResultSchema = z.object({
  status: qualityInspectionStatusSchema,
  score: z.number().min(0).max(1),
  issues: z.array(z.string()).default([]),
  revisionHints: z.array(z.string()).default([]),
  bestEffortReason: z.string().default(""),
});

export const sceneRevisionRequestSchema = z.object({
  scene: sceneDslSchema,
  quality: qualityInspectionResultSchema,
  userGoal: z.string().default(""),
  round: z.number().int().min(1),
});

export const sceneRevisionResultSchema = z.object({
  scene: sceneDslSchema,
  summary: z.string(),
});

export const workflowRevisionEventSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().optional(),
  round: z.number().int().min(1),
  screenshotPath: z.string().optional(),
  score: z.number().min(0).max(1).optional(),
  status: qualityInspectionStatusSchema.optional(),
  issues: z.array(z.string()).default([]),
  selectedBest: z.boolean().default(false),
});

export const fileMapSchema = z.record(z.string()).superRefine((files, ctx) => {
  for (const path of Object.keys(files)) {
    if (!ALLOWED_FILE_PATHS.includes(path as AllowedFilePath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `该文件不允许被 Agent 修改: ${path}`,
      });
    }
  }
});

export const agentTurnRequestSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().default(""),
  images: z.array(imageInputSchema).default([]),
  files: fileMapSchema,
  runtimeErrors: z.array(runtimeErrorSchema).default([]),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
});

export const patchOperationSchema = z.object({
  type: z.literal("replace_file"),
  path: allowedFilePathSchema,
  content: z.string(),
});

export const patchEventSchema = z.object({
  type: z.literal("patch"),
  operations: z.array(patchOperationSchema).min(1),
  summary: z.string(),
});

export const streamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), message: z.string() }),
  z.object({ type: z.literal("run_id"), runId: z.string() }),
  z.object({ type: z.literal("run_status"), runId: z.string(), status: z.string(), message: z.string().optional() }),
  z.object({ type: z.literal("snapshot_saved"), runId: z.string(), label: z.string(), stable: z.boolean() }),
  z.object({ type: z.literal("reasoning_summary"), message: z.string() }),
  z.object({ type: z.literal("coder_input_summary"), message: z.string() }),
  z.object({ type: z.literal("workflow_config"), config: runtimeComposerConfigSchema }),
  z.object({ type: z.literal("scene_dsl"), scene: sceneDslSchema }),
  patchEventSchema,
  z.object({ type: z.literal("assistant_message"), message: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
  }),
]);

export type AgentTurnRequest = z.infer<typeof agentTurnRequestSchema>;
export type ImageInput = z.infer<typeof imageInputSchema>;
export type PatchOperation = z.infer<typeof patchOperationSchema>;
export type PatchEvent = z.infer<typeof patchEventSchema>;
export type StreamEvent = z.infer<typeof streamEventSchema>;
export type FileMap = z.infer<typeof fileMapSchema>;
export type CompactSummary = z.infer<typeof compactSummarySchema>;
export type ModelNode = z.infer<typeof modelNodeSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ScreenshotMode = z.infer<typeof screenshotModeSchema>;
export type RuntimeComposerConfig = z.infer<typeof runtimeComposerConfigSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type SkillCreateRequest = z.infer<typeof skillCreateRequestSchema>;
export type SkillInferRequest = z.infer<typeof skillInferRequestSchema>;
export type SkillInstallRequest = z.infer<typeof skillInstallRequestSchema>;
export type AircraftAssetCategory = z.infer<typeof aircraftAssetCategorySchema>;
export type AircraftAssetMetadata = z.infer<typeof aircraftAssetMetadataSchema>;
export type SemanticIntent = z.infer<typeof semanticIntentSchema>;
export type SceneDsl = z.infer<typeof sceneDslSchema>;
export type RetrievalSearchRequest = z.infer<typeof retrievalSearchRequestSchema>;
export type RetrievalSearchResult = z.infer<typeof retrievalSearchResultSchema>;
export type SceneComposeRequest = z.infer<typeof sceneComposeRequestSchema>;
export type SceneRenderRequest = z.infer<typeof sceneRenderRequestSchema>;
export type QualityInspectionRequest = z.infer<typeof qualityInspectionRequestSchema>;
export type QualityInspectionStatus = z.infer<typeof qualityInspectionStatusSchema>;
export type QualityInspectionResult = z.infer<typeof qualityInspectionResultSchema>;
export type SceneRevisionRequest = z.infer<typeof sceneRevisionRequestSchema>;
export type SceneRevisionResult = z.infer<typeof sceneRevisionResultSchema>;
export type WorkflowRevisionEvent = z.infer<typeof workflowRevisionEventSchema>;

export const screenshotSaveRequestSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().optional(),
  dataUrl: z.string().startsWith("data:image/png;base64,"),
  view: z.string().default("free"),
  mode: screenshotModeSchema.default("save"),
});

export const screenshotArtifactSchema = z.object({
  id: z.number().optional(),
  sessionId: z.string(),
  runId: z.string().optional(),
  kind: z.literal("screenshot"),
  path: z.string(),
  fileName: z.string(),
  url: z.string(),
  createdAt: z.string().optional(),
});

export type ScreenshotSaveRequest = z.infer<typeof screenshotSaveRequestSchema>;
export type ScreenshotArtifact = z.infer<typeof screenshotArtifactSchema>;

export const defaultFiles: Record<AllowedFilePath, string> = {
  "package.json": JSON.stringify(
    {
      main: "/index.tsx",
      dependencies: {
        react: "18.3.1",
        "react-dom": "18.3.1",
        "react-scripts": "5.0.1",
        three: "0.168.0",
      },
      devDependencies: {
        "@types/react": "18.3.3",
        "@types/react-dom": "18.3.0",
        "@types/three": "0.168.0",
        typescript: "5.5.4",
      },
    },
    null,
    2,
  ),
  "src/main.tsx": `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
  "src/App.tsx": `import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#111827");

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 100);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const gridY = -1.25;

    const geometry = new THREE.TorusKnotGeometry(0.9, 0.28, 160, 24);
    const material = new THREE.MeshStandardMaterial({
      color: "#38bdf8",
      metalness: 0.35,
      roughness: 0.28,
    });
    const mesh = new THREE.Mesh(geometry, material);
    const meshBounds = new THREE.Box3().setFromObject(mesh);
    mesh.position.y += gridY - meshBounds.min.y;
    scene.add(mesh);

    const subjectBounds = new THREE.Box3().setFromObject(mesh);
    const subjectCenter = subjectBounds.getCenter(new THREE.Vector3());
    controls.target.copy(subjectCenter);
    camera.position.set(subjectCenter.x, subjectCenter.y + 0.6, subjectCenter.z + 5.1);
    camera.lookAt(subjectCenter);
    controls.update();

    const keyLight = new THREE.DirectionalLight("#ffffff", 3);
    keyLight.position.set(3, 4, 5);
    scene.add(keyLight);
    scene.add(new THREE.AmbientLight("#7dd3fc", 0.9));

    const grid = new THREE.GridHelper(8, 24, "#334155", "#1f2937");
    grid.position.y = gridY;
    scene.add(grid);

    (window as any).__AGENTIC_THREE_VIEW__ = { scene, camera, renderer, controls, grid, target: controls.target };

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      camera.lookAt(subjectCenter);
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      delete (window as any).__AGENTIC_THREE_VIEW__;
      controls.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className="scene-root" ref={mountRef} />;
}
`,
  "src/styles.css": `html,
body,
#root {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: #0f172a;
}

.scene-root {
  width: 100%;
  height: 100%;
}
`,
};

const dangerousPatterns: Array<[RegExp, string]> = [
  [/\beval\s*\(/i, "不允许使用 eval"],
  [/\bnew\s+Function\s*\(/i, "不允许使用 new Function"],
  [/\bfetch\s*\(/i, "生成场景代码不允许发起网络请求"],
  [/\bXMLHttpRequest\b/i, "不允许使用 XMLHttpRequest"],
  [/\bWebSocket\b/i, "不允许使用 WebSocket"],
  [/\bWorker\s*\(/i, "不允许创建 Worker"],
  [/\bSharedWorker\s*\(/i, "不允许创建 SharedWorker"],
  [/\bimportScripts\s*\(/i, "不允许使用 importScripts"],
  [/\bnavigator\.serviceWorker\b/i, "不允许注册 Service Worker"],
  [/<script\b/i, "不允许脚本注入"],
  [/window\.THREE\b/i, "禁止使用 window.THREE，必须使用 ESM import * as THREE from 'three'"],
  [/@ts-nocheck\b/i, "禁止使用 @ts-nocheck 跳过类型检查"],
  [/\bif\s*\(\s*!THREE\s*\)\s*return\b/i, "禁止静默 return 导致空白 canvas，必须 ESM import three"],
];

export function sanitizePatch(event: PatchEvent): PatchEvent {
  const parsed = patchEventSchema.parse(event);
  for (const operation of parsed.operations) {
    for (const [pattern, message] of dangerousPatterns) {
      if (pattern.test(operation.content)) {
        throw new Error(`${message}，位置: ${operation.path}`);
      }
    }
    if (operation.path === "package.json") {
      sanitizePackageJson(operation.content);
    }
    if (operation.path === "src/App.tsx") {
      sanitizeAppTsx(operation.content);
    }
  }
  return parsed;
}

export function applyPatch(files: FileMap, patch: PatchEvent): FileMap {
  const sanitized = sanitizePatch(patch);
  const next = { ...files };
  for (const operation of sanitized.operations) {
    next[operation.path] = operation.content;
  }
  return fileMapSchema.parse(next);
}

function sanitizeAppTsx(content: string): void {
  // Must use ESM import for three
  if (!/import\s+\*\s+as\s+THREE\s+from\s+["']three["']/.test(content)) {
    throw new Error("src/App.tsx 必须包含 'import * as THREE from \"three\"'");
  }
  // Must create WebGLRenderer
  if (!/new\s+THREE\.WebGLRenderer\b/.test(content)) {
    throw new Error("src/App.tsx 必须包含 new THREE.WebGLRenderer 初始化");
  }
  // Must appendChild renderer.domElement
  if (!/\.appendChild\s*\(\s*\w+\.renderer\s*\.\s*domElement\s*\)/.test(content) &&
      !/\.appendChild\s*\(\s*renderer\s*\.\s*domElement\s*\)/.test(content)) {
    throw new Error("src/App.tsx 必须将 renderer.domElement appendChild 到 DOM 容器");
  }
  // Must call renderer.render
  if (!/\.render\s*\(\s*scene\s*,/.test(content) && !/renderer\s*\.\s*render\s*\(/.test(content)) {
    throw new Error("src/App.tsx 必须包含 renderer.render(scene, camera) 渲染调用");
  }
  // Must export default function App
  if (!/export\s+default\s+function\s+App\b/.test(content)) {
    throw new Error("src/App.tsx 必须包含 'export default function App'");
  }
}

function sanitizePackageJson(content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("package.json 补丁必须是合法 JSON");
  }
  const pkg = parsed as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  for (const value of Object.values(scripts)) {
    if (/[;&|`$<>]/.test(value)) {
      throw new Error("package.json scripts 不允许包含 shell 控制字符");
    }
  }
  const dependencyNames = Object.keys(pkg.dependencies ?? {});
  const allowedDependencies = new Set(["react", "react-dom", "react-scripts", "three"]);
  for (const dependency of dependencyNames) {
    if (!allowedDependencies.has(dependency)) {
      throw new Error(`依赖不在允许列表中: ${dependency}`);
    }
  }
}

export function ndjson(event: StreamEvent): string {
  return `${JSON.stringify(streamEventSchema.parse(event))}\n`;
}
