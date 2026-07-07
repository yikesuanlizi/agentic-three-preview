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
  "visionReview",
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

export const visionReviewModelConfigSchema = modelConfigSchema.omit({ node: true });

export const visionReviewConfigSchema = z.object({
  models: z.array(visionReviewModelConfigSchema).min(1).default([
    {
      model: "doubao-seed-2-0-code-preview-260215",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyEnvName: "ARK_API_KEY",
      temperature: 0.2,
      maxTokens: 2000,
    },
  ]),
});

export const screenshotModeSchema = z.enum(["download", "save", "both"]);

function projectRelativePathSchema() {
  return z
    .string()
    .min(1)
    .refine((value) => !/^[a-zA-Z]:[\\/]/.test(value) && !value.startsWith("/") && !value.startsWith("\\"), {
      message: "路径必须是项目内相对路径，不能使用绝对路径",
    })
    .refine((value) => !value.split(/[\\/]+/).includes(".."), {
      message: "路径不能包含 .. 逃逸项目目录",
    })
    .transform((value) => value.replace(/\\/g, "/"));
}

export const runtimeComposerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRevisionRounds: z.number().int().min(1).max(8).default(3),
  minQualityScore: z.number().min(0).max(1).default(0.75),
  autoCaptureAfterPatch: z.boolean().default(true),
  requireVisualInspection: z.boolean().default(true),
  captureDelayMs: z.number().int().min(0).max(10000).default(1200),
  nonBlankPixelThreshold: z.number().min(0).max(1).default(0.02),
});

export const assetImportConfigSchema = z.object({
  sourceDirectory: z.string().default(""),
  uploadDirectory: projectRelativePathSchema().default("assets/aircraft/imported"),
});

export const appSettingsSchema = z.object({
  models: z.array(modelConfigSchema),
  screenshotMode: screenshotModeSchema.default("download"),
  enabledSkillIds: z.array(z.string()).default([]),
  runtimeComposer: runtimeComposerConfigSchema.default({}),
  assetImport: assetImportConfigSchema.default({}),
  visionReview: visionReviewConfigSchema.default({}),
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

export const aircraftViewSchema = z.enum(["front", "back", "left", "right", "top", "bottom", "three_quarter", "detail"]);

export const aircraftAssetViewImageSchema = z.object({
  view: aircraftViewSchema,
  imagePath: projectRelativePathSchema(),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  tags: z.array(z.string()).default([]),
});

export const glbAnalysisAxisSchema = z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]);

export const glbAnalysisBoundsSchema = z.object({
  center: z.tuple([z.number(), z.number(), z.number()]),
  size: z.tuple([z.number(), z.number(), z.number()]),
});

export const glbMeshStatsSchema = z.object({
  name: z.string().default(""),
  vertexCount: z.number().int().nonnegative().default(0),
  triangleCount: z.number().int().nonnegative().default(0),
  center: z.tuple([z.number(), z.number(), z.number()]),
  size: z.tuple([z.number(), z.number(), z.number()]),
  radiusEstimate: z.number().nonnegative().default(0),
  materials: z.array(z.string()).default([]),
});

export const glbRadialPatternSchema = z.object({
  type: z.literal("radialArray"),
  count: z.number().int().positive(),
  axis: glbAnalysisAxisSchema,
  confidence: z.number().min(0).max(1),
  radiusRange: z.tuple([z.number(), z.number()]).optional(),
});

export const glbStructureAnalysisSchema = z.object({
  status: z.enum(["success", "error", "skipped"]).default("skipped"),
  error: z.string().max(1000).optional(),
  nodeCount: z.number().int().nonnegative().default(0),
  meshCount: z.number().int().nonnegative().default(0),
  materialCount: z.number().int().nonnegative().default(0),
  bounds: glbAnalysisBoundsSchema.optional(),
  dominantAxis: glbAnalysisAxisSchema.optional(),
  meshStats: z.array(glbMeshStatsSchema).default([]),
  radialPatterns: z.array(glbRadialPatternSchema).default([]),
});

export const glbTemplateParamsSchema = z.object({
  template: z.enum(["turbofan", "propeller", "impeller", "fan", "generic_model"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  turbofan: z
    .object({
      bladeCount: z.number().int().positive().optional(),
      hubRadius: z.number().positive().optional(),
      outerRingInnerRadius: z.number().positive().optional(),
      outerRingOuterRadius: z.number().positive().optional(),
      bladeThickness: z.number().positive().optional(),
      bladeTwist: z.number().positive().optional(),
      spinnerDirection: z.enum(["front", "back", "unknown"]).optional(),
    })
    .default({}),
});

export const glbConstraintHintSchema = z.object({
  type: z.enum(["coaxial", "insideRadius", "contact", "clearance", "radialArray"]),
  priority: z.enum(["critical", "high", "normal"]).default("normal"),
  confidence: z.number().min(0).max(1).default(0.5),
  reason: z.string().min(1).max(500),
});

export const aircraftAssetMetadataSchema = z.object({
  id: z.string().min(2).max(96).regex(/^[a-z0-9-]+$/),
  category: aircraftAssetCategorySchema,
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  tags: z.array(z.string()).default([]),
  assetPath: projectRelativePathSchema(),
  previewPath: projectRelativePathSchema(),
  scale: z.number().positive().default(1),
  pivot: z.enum(["center", "origin", "bottom"]).default("center"),
  forward: z.enum(["+Z", "-Z", "+X", "-X"]).default("+Z"),
  polycount: z.number().int().nonnegative().optional(),
  animations: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  compatibleWith: z.array(z.string()).default([]),
  viewImages: z.array(aircraftAssetViewImageSchema).default([]),
  codeSummary: z.string().max(3000).default(""),
  keySnippets: z.array(z.string().max(1600)).default([]),
  detectedPatterns: z.array(z.string().max(120)).default([]),
  shapeSummary: z.string().max(3000).default(""),
  viewFeatures: z.array(z.string().max(800)).default([]),
  skeletonHints: z.array(z.string().max(800)).default([]),
  structureAnalysis: glbStructureAnalysisSchema.default({}),
  templateParams: glbTemplateParamsSchema.default({}),
  constraintHints: z.array(glbConstraintHintSchema).default([]),
});

export const assetImportRequestSchema = z.object({
  sourceDirectory: z.string().min(1),
  uploadDirectory: projectRelativePathSchema().default("assets/aircraft/imported"),
});

export const assetImportItemSchema = z.object({
  id: z.string(),
  sourcePath: z.string(),
  metadataPath: z.string().optional(),
  previewPath: z.string().optional(),
  viewCount: z.number().int().nonnegative().default(0),
  ok: z.boolean(),
  message: z.string().default(""),
});

export const assetImportResultSchema = z.object({
  ok: z.boolean(),
  scannedCount: z.number().int().nonnegative(),
  importedCount: z.number().int().nonnegative(),
  ingestedCount: z.number().int().nonnegative(),
  items: z.array(assetImportItemSchema),
  message: z.string().default(""),
});

export const assetImportJobStatusSchema = z.enum(["queued", "running", "success", "error", "interrupted"]);

export const assetImportJobSchema = z.object({
  jobId: z.string(),
  status: assetImportJobStatusSchema,
  sourceDirectory: z.string(),
  uploadDirectory: z.string(),
  phase: z.string().default("queued"),
  currentFile: z.string().default(""),
  total: z.number().int().nonnegative().default(0),
  processed: z.number().int().nonnegative().default(0),
  imported: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  percent: z.number().min(0).max(100).default(0),
  message: z.string().default(""),
  items: z.array(assetImportItemSchema).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const renderStyleSchema = z.enum(["technical_lines", "realistic", "engineering_white", "ppt_clean"]);
export const sceneTypeSchema = z.enum(["engine_showcase", "front_technical_view", "exploded_view", "component_detail"]);
export const cameraPresetSchema = z.enum(["front", "three_quarter", "top", "side", "cinematic_closeup"]);
export const lightingPresetSchema = z.enum(["engineering_white", "studio_soft", "hangar_dark"]);
export const qualityReviewViewSchema = z.enum(["front", "side", "top", "three_quarter"]);

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

export const visualIntentSchema = z.object({
  subject: z.string().default("aircraft component"),
  category: aircraftAssetCategorySchema.optional(),
  view: cameraPresetSchema.default("front"),
  renderStyle: renderStyleSchema.default("technical_lines"),
  referenceView: qualityReviewViewSchema.optional(),
  referenceFeatures: z.array(z.lazy(() => visualFeaturePointSchema)).default([]),
  featureExpectations: z.array(z.lazy(() => visualFeatureExpectationSchema)).default([]),
  retrievalQuery: z.string().default(""),
  visualFeatures: z.array(z.string().max(800)).default([]),
  geometryHints: z.array(z.string().max(800)).default([]),
  materialHints: z.array(z.string().max(800)).default([]),
  codeHints: z.array(z.string().max(800)).default([]),
  confidence: z.number().min(0).max(1).default(0.4),
  modelUsed: z.string().default("local-rules"),
  fallbackReason: z.string().default(""),
});

export const assemblyVector3Schema = z.tuple([z.number(), z.number(), z.number()]);
export const assemblyTransformSchema = z.object({
  position: assemblyVector3Schema.default([0, 0, 0]),
  rotation: assemblyVector3Schema.default([0, 0, 0]),
  scale: z.number().positive().default(1),
});
export const assemblyPortKindSchema = z.enum(["axis", "face", "radius", "point", "edge"]);
export const assemblyConstraintPrioritySchema = z.enum(["critical", "high", "normal"]);
export const assemblyConstraintTypeSchema = z.enum(["coaxial", "insideRadius", "contact", "clearance"]);
export const assemblyGeneratorTypeSchema = z.enum(["radialArray"]);

export const assemblyPortSchema = z.object({
  id: z.string().min(1),
  partId: z.string().min(1),
  kind: assemblyPortKindSchema,
  localTransform: assemblyTransformSchema.default({}),
  axis: assemblyVector3Schema.optional(),
  normal: assemblyVector3Schema.optional(),
  radius: z.number().nonnegative().optional(),
  featureId: z.string().min(1).optional(),
});

export const assemblyFeatureSchema = z.object({
  id: z.string().min(1),
  partId: z.string().min(1),
  kind: z.string().min(1),
  value: z.unknown().optional(),
  params: z.record(z.unknown()).default({}),
  portIds: z.array(z.string().min(1)).default([]),
});

export const assemblyGeneratorSchema = z.object({
  id: z.string().min(1),
  type: assemblyGeneratorTypeSchema,
  partId: z.string().min(1),
  axisPortId: z.string().min(1),
  count: z.number().int().min(1).max(512).default(24),
  params: z.object({
    rootRadius: z.number().positive().default(0.42),
    tipRadius: z.number().positive().default(1.38),
    pitch: z.number().default(0.36),
    twist: z.number().default(0.85),
    sweep: z.number().default(0.18),
    thickness: z.number().positive().default(0.055),
    rootWidth: z.number().positive().default(0.24),
    tipWidth: z.number().positive().default(0.14),
  }).default({}),
});

export const assemblyPartSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  objectId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  params: z.record(z.unknown()).default({}),
  portIds: z.array(z.string().min(1)).default([]),
  featureIds: z.array(z.string().min(1)).default([]),
  generatorIds: z.array(z.string().min(1)).default([]),
  sourceAsset: z
    .object({
      assetId: z.string().min(1).optional(),
      sourcePath: z.string().optional(),
      metadataPath: z.string().optional(),
    })
    .default({}),
});

export const assemblyConstraintSchema = z.object({
  id: z.string().min(1),
  type: assemblyConstraintTypeSchema,
  a: z.string().min(1),
  b: z.string().min(1).optional(),
  partIds: z.array(z.string().min(1)).default([]),
  priority: assemblyConstraintPrioritySchema.default("normal"),
  tolerance: z.number().nonnegative().default(0.001),
  params: z.record(z.unknown()).default({}),
});

export const assemblyGraphSchema = z.object({
  id: z.string().min(1).default("assembly"),
  templateId: z.string().min(1).optional(),
  axis: assemblyVector3Schema.default([0, 0, 1]),
  parts: z.array(assemblyPartSchema).default([]),
  ports: z.array(assemblyPortSchema).default([]),
  features: z.array(assemblyFeatureSchema).default([]),
  generators: z.array(assemblyGeneratorSchema).default([]),
  constraints: z.array(assemblyConstraintSchema).default([]),
});

export const assemblyConstraintCheckSchema = z.object({
  constraintId: z.string().min(1),
  type: assemblyConstraintTypeSchema,
  priority: assemblyConstraintPrioritySchema,
  pass: z.boolean(),
  residual: z.number().nonnegative().default(0),
  tolerance: z.number().nonnegative().default(0),
  message: z.string().default(""),
});

export const assemblySolverResultSchema = z.object({
  graphId: z.string().min(1),
  transforms: z.record(assemblyTransformSchema).default({}),
  residuals: z.record(z.number()).default({}),
  checks: z.array(assemblyConstraintCheckSchema).default([]),
  ok: z.boolean().default(true),
  message: z.string().default(""),
});

export const sceneDslObjectSchema = z.object({
  id: z.string().min(1),
  objectId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  assetId: z.string().min(1).optional(),
  sourceAsset: z
    .object({
      assetId: z.string().min(1).optional(),
      sourcePath: z.string().optional(),
      metadataPath: z.string().optional(),
    })
    .default({}),
  primitive: z.enum(["turbofan_front", "wing_panel", "fuselage_section", "landing_gear", "decorative_shape", "generic_part"]).default("generic_part"),
  semanticRole: z.string().default("primary_subject"),
  purpose: z.string().default("visual_subject"),
  params: z.record(z.unknown()).default({}),
  material: z
    .object({
      name: z.string().optional(),
      color: z.string().optional(),
      metalness: z.number().min(0).max(1).optional(),
      roughness: z.number().min(0).max(1).optional(),
      style: z.enum(["linework", "realistic", "flat", "glass", "metal"]).optional(),
    })
    .default({}),
  constraints: z.array(z.string()).default([]),
  visibility: z.record(qualityReviewViewSchema, z.boolean()).default({
    front: true,
    side: true,
    top: true,
    three_quarter: true,
  }),
  qualityState: z
    .object({
      status: z.enum(["unknown", "ok", "needs_review", "needs_revision"]).default("unknown"),
      issues: z.array(z.string()).default([]),
      lastReviewedAt: z.string().optional(),
    })
    .default({}),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  scale: z.number().positive().default(1),
  animation: z.string().optional(),
});

export const sceneDslSchema = z.object({
  version: z.number().int().min(1).default(2),
  stateId: z.string().optional(),
  parentStateId: z.string().optional(),
  sceneType: sceneTypeSchema.default("engine_showcase"),
  cameraPreset: cameraPresetSchema.default("front"),
  lightingPreset: lightingPresetSchema.default("engineering_white"),
  renderStyle: renderStyleSchema.default("technical_lines"),
  objects: z.array(sceneDslObjectSchema).min(1),
  annotations: z.array(z.string()).default([]),
  animations: z.array(z.string()).default([]),
  semanticSummary: z.string().default(""),
  assetUsage: z
    .array(
      z.object({
        objectId: z.string().min(1),
        assetId: z.string().min(1).optional(),
        sourcePath: z.string().optional(),
        role: z.string().default("reference"),
      }),
    )
    .default([]),
  assemblyGraph: assemblyGraphSchema.optional(),
  solverResult: assemblySolverResultSchema.optional(),
  qualityState: z
    .object({
      status: z.enum(["unknown", "pass", "revise", "ask_user", "fallback"]).default("unknown"),
      score: z.number().min(0).max(1).optional(),
      lastRound: z.number().int().min(1).optional(),
      reviewedViews: z.array(qualityReviewViewSchema).default([]),
      issues: z.array(z.string()).default([]),
    })
    .default({}),
  visualMemoryIds: z.array(z.string()).default([]),
});

export const qualityScreenshotSchema = z.object({
  view: qualityReviewViewSchema,
  dataUrl: z.string().startsWith("data:image/png;base64,"),
  path: z.string().optional(),
});

export const scenePatchOperationSchema = z.object({
  op: z.enum(["set_scene", "set_object", "merge_object_params", "add_annotation", "set_quality"]),
  objectId: z.string().min(1).optional(),
  path: z.string().min(1),
  value: z.unknown(),
  reason: z.string().default(""),
});

export const scenePatchSchema = z.object({
  summary: z.string().default(""),
  operations: z.array(scenePatchOperationSchema).default([]),
});

export const qualityIssueSchema = z.object({
  view: qualityReviewViewSchema.optional(),
  objectId: z.string().min(1).optional(),
  severity: z.enum(["info", "minor", "major", "critical"]).default("major"),
  problem: z.string().min(1),
  suggestedPatch: scenePatchSchema.optional(),
});

export const qualityDimensionSchema = z.enum(["geometry", "viewMatch", "material", "referenceSimilarity", "embeddingSimilarity", "renderHealth", "constraint"]);

export const qualityScoresSchema = z.object({
  geometry: z.number().min(0).max(1).default(0),
  viewMatch: z.number().min(0).max(1).default(0),
  material: z.number().min(0).max(1).default(0),
  referenceSimilarity: z.number().min(0).max(1).default(0),
  embeddingSimilarity: z.number().min(0).max(1).default(0),
  renderHealth: z.number().min(0).max(1).default(0),
  overall: z.number().min(0).max(1).default(0),
});

export const qualityCheckItemSchema = z.object({
  view: qualityReviewViewSchema.optional(),
  dimension: qualityDimensionSchema,
  item: z.string().min(1),
  pass: z.boolean(),
  confidence: z.number().min(0).max(1).default(0.5),
  note: z.string().default(""),
  severity: z.enum(["info", "minor", "major", "critical"]).default("major"),
  suggestedFix: z.string().default(""),
  targetFunction: z.string().regex(/^[A-Za-z_$][\w$]*$/).optional(),
});

export const visualFeaturePointSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  part: z.string().default(""),
  view: qualityReviewViewSchema.optional(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).default(0.5),
  kind: z.enum(["point", "center", "edge", "contour", "axis", "hole", "bolt", "blade_root", "blade_tip"]).default("point"),
  parameterHint: z.string().default(""),
});

export const visualFeatureExpectationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  part: z.string().default(""),
  view: qualityReviewViewSchema.optional(),
  expected: z.string().default(""),
  parameterHint: z.string().default(""),
  priority: z.enum(["critical", "high", "normal"]).default("normal"),
});

export const visualFeatureMatchSchema = z.object({
  referenceId: z.string().min(1),
  screenshotId: z.string().min(1).optional(),
  label: z.string().default(""),
  view: qualityReviewViewSchema.optional(),
  distance: z.number().min(0).default(1),
  pass: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.5),
  note: z.string().default(""),
  suggestedParameter: z.string().default(""),
});

export const visualEmbeddingMatchSchema = z.object({
  referenceName: z.string().default(""),
  referenceIndex: z.number().int().nonnegative().default(0),
  screenshotView: qualityReviewViewSchema,
  similarity: z.number().min(-1).max(1),
  model: z.string().default(""),
  dimension: z.number().int().min(1).max(4096),
  matched: z.boolean().default(false),
  fallbackReason: z.string().default(""),
});

export const qualityViewResultSchema = z.object({
  view: qualityReviewViewSchema,
  scores: qualityScoresSchema,
  checks: z.array(qualityCheckItemSchema).default([]),
  featurePoints: z.array(visualFeaturePointSchema).default([]),
  featureMatches: z.array(visualFeatureMatchSchema).default([]),
  issues: z.array(z.string()).default([]),
  revisionHints: z.array(z.string()).default([]),
  modelUsed: z.string().optional(),
});

export const retrievalSearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).default(5),
  categories: z.array(aircraftAssetCategorySchema).default([]),
});

export const retrievalSearchResultSchema = z.object({
  kind: z.enum(["asset", "asset_view", "template", "wiki", "generated_scene"]),
  id: z.string(),
  title: z.string(),
  description: z.string(),
  score: z.number(),
  tags: z.array(z.string()).default([]),
  sourceKind: z.enum(["asset", "template", "wiki", "renderer"]).optional(),
  sourceId: z.string().optional(),
  sourcePath: z.string().optional(),
  view: aircraftViewSchema.optional(),
  imagePath: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const ragIngestResultSchema = z.object({
  ok: z.boolean(),
  documentCount: z.number().int().nonnegative(),
  mode: z.enum(["milvus", "fallback"]),
  message: z.string().default(""),
});

export const knowledgeClearRequestSchema = z.object({
  uploadDirectory: projectRelativePathSchema().default("assets/aircraft/imported"),
  clearImportedFiles: z.boolean().default(true),
  clearMilvus: z.boolean().default(true),
  clearSqlite: z.boolean().default(true),
});

export const knowledgeClearResultSchema = z.object({
  ok: z.boolean(),
  deletedFiles: z.number().int().nonnegative().default(0),
  clearedTables: z.array(z.string()).default([]),
  milvusDropped: z.boolean().default(false),
  message: z.string().default(""),
});

export const ragSearchRequestSchema = retrievalSearchRequestSchema.extend({
  useVector: z.boolean().default(true),
  scope: z.enum(["imported", "all"]).default("all"),
});

export const ragSourceResolveRequestSchema = z.object({
  kind: z.enum(["asset", "asset_view", "template", "wiki", "generated_scene"]),
  id: z.string().min(1),
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
  screenshotDataUrl: z.string().startsWith("data:image/png;base64,").optional(),
  screenshots: z.array(qualityScreenshotSchema).default([]),
  scene: sceneDslSchema,
  runtimeErrors: z.array(runtimeErrorSchema).default([]),
});

export const qualityInspectionStatusSchema = z.enum(["pass", "revise", "ask_user", "fallback"]);

export const qualityInspectionResultSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const score = typeof input.score === "number" ? input.score : undefined;
  const scores = input.scores && typeof input.scores === "object" && !Array.isArray(input.scores)
    ? input.scores
    : score === undefined
      ? undefined
      : {
          geometry: score,
          viewMatch: score,
          material: score,
          referenceSimilarity: score,
          embeddingSimilarity: 0,
          renderHealth: score,
          overall: score,
        };
  const overall = scores && typeof scores === "object" && !Array.isArray(scores) && typeof (scores as Record<string, unknown>).overall === "number"
    ? (scores as Record<string, number>).overall
    : score;
  return {
    ...input,
    score: typeof overall === "number" ? overall : score,
    scores,
  };
}, z.object({
  status: qualityInspectionStatusSchema,
  score: z.number().min(0).max(1),
  scores: qualityScoresSchema,
  checks: z.array(qualityCheckItemSchema).default([]),
  viewResults: z.array(qualityViewResultSchema).default([]),
  featureMatches: z.array(visualFeatureMatchSchema).default([]),
  embeddingMatches: z.array(visualEmbeddingMatchSchema).default([]),
  matchedReferenceView: qualityReviewViewSchema.optional(),
  candidateScore: z.number().min(0).max(1).optional(),
  issues: z.array(z.string()).default([]),
  structuredIssues: z.array(qualityIssueSchema).default([]),
  revisionHints: z.array(z.string()).default([]),
  bestEffortReason: z.string().default(""),
  modelUsed: z.string().optional(),
  constraintStatus: z.enum(["pass", "revise"]).default("pass"),
  constraintResiduals: z.record(z.number()).default({}),
  constraintChecks: z.array(assemblyConstraintCheckSchema).default([]),
}));

export const sceneRevisionRequestSchema = z.object({
  scene: sceneDslSchema,
  quality: qualityInspectionResultSchema,
  userGoal: z.string().default(""),
  round: z.number().int().min(1),
});

export const sceneRevisionResultSchema = z.object({
  scene: sceneDslSchema,
  patch: scenePatchSchema.default({}),
  summary: z.string(),
});

export const workflowRevisionEventSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().optional(),
  round: z.number().int().min(1),
  screenshotPath: z.string().optional(),
  screenshotPaths: z.record(qualityReviewViewSchema, z.string()).default({}),
  score: z.number().min(0).max(1).optional(),
  candidateScore: z.number().min(0).max(1).optional(),
  matchedReferenceView: qualityReviewViewSchema.optional(),
  scores: qualityScoresSchema.optional(),
  status: qualityInspectionStatusSchema.optional(),
  issues: z.array(z.string()).default([]),
  checks: z.array(qualityCheckItemSchema).default([]),
  viewResults: z.array(qualityViewResultSchema).default([]),
  featureMatches: z.array(visualFeatureMatchSchema).default([]),
  embeddingMatches: z.array(visualEmbeddingMatchSchema).default([]),
  structuredIssues: z.array(qualityIssueSchema).default([]),
  patch: scenePatchSchema.optional(),
  modelUsed: z.string().optional(),
  selectedBest: z.boolean().default(false),
  dualCoderUsed: z.boolean().default(false),
  discussionModels: z.array(z.string()).default([]),
  discussionSummary: z.string().default(""),
});

export const workflowQualityHistoryEntrySchema = z.object({
  round: z.number().int().min(1),
  score: z.number().min(0).max(1).optional(),
  candidateScore: z.number().min(0).max(1).optional(),
  status: qualityInspectionStatusSchema.optional(),
  modelUsed: z.string().optional(),
  selectedBest: z.boolean().default(false),
  runtimeError: z.string().optional(),
});

export const workflowBestRoundSchema = z.object({
  round: z.number().int().min(1),
  score: z.number().min(0).max(1),
  candidateScore: z.number().min(0).max(1).optional(),
  modelUsed: z.string().optional(),
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

export const workflowFinalizeRequestSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().optional(),
  label: z.string().min(1).max(80).default("workflow-final"),
  files: fileMapSchema,
  round: z.number().int().min(1).optional(),
  score: z.number().min(0).max(1).optional(),
  screenshotPath: z.string().optional(),
  screenshotPaths: z.record(qualityReviewViewSchema, z.string()).default({}),
  userGoal: z.string().default(""),
  scene: sceneDslSchema.optional(),
});

export const coderRevisionRequestSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().optional(),
  round: z.number().int().min(1),
  userGoal: z.string().default(""),
  files: fileMapSchema,
  quality: qualityInspectionResultSchema,
  referenceImages: z.array(imageInputSchema).default([]),
  screenshots: z.array(qualityScreenshotSchema).default([]),
  runtimeErrors: z.array(runtimeErrorSchema).default([]),
  qualityHistory: z.array(workflowQualityHistoryEntrySchema).default([]),
  bestRound: workflowBestRoundSchema.optional(),
  repairAttempt: z.number().int().min(0).default(0),
  dualCoderRequested: z.boolean().default(false),
  dualCoderReason: z.string().default(""),
});

export const workflowReviewRoundRequestSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().optional(),
  round: z.number().int().min(1),
  userGoal: z.string().default(""),
  files: fileMapSchema,
  referenceImages: z.array(imageInputSchema).default([]),
  screenshots: z.array(qualityScreenshotSchema).default([]),
  scene: sceneDslSchema,
  runtimeErrors: z.array(runtimeErrorSchema).default([]),
  patchGenerator: z.enum(["llm_coder", "runtime_composer"]).default("llm_coder"),
  maxRevisionRounds: z.number().int().min(1).max(20).optional(),
  qualityHistory: z.array(workflowQualityHistoryEntrySchema).default([]),
  bestRound: workflowBestRoundSchema.optional(),
  dualCoderRequested: z.boolean().default(false),
  dualCoderReason: z.string().default(""),
});

export const workflowReviewRoundDecisionSchema = z.enum(["pass", "continue", "ask_user", "fallback", "max_rounds"]);

export const workflowReviewRoundResultSchema = z.object({
  decision: workflowReviewRoundDecisionSchema,
  quality: qualityInspectionResultSchema,
  patch: z.lazy(() => patchEventSchema).optional(),
  modelUsed: z.string().optional(),
  fallbackReason: z.string().optional(),
  message: z.string().default(""),
  dualCoderUsed: z.boolean().default(false),
  discussionModels: z.array(z.string()).default([]),
  discussionSummary: z.string().default(""),
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

export const patchOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace_file"),
    path: allowedFilePathSchema,
    content: z.string(),
  }),
  z.object({
    type: z.literal("replace_function"),
    path: allowedFilePathSchema,
    functionName: z.string().regex(/^[A-Za-z_$][\w$]*$/),
    content: z.string(),
  }),
  z.object({
    type: z.literal("parameter_patch"),
    path: z.literal("src/App.tsx"),
    parameters: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
    targetFunction: z.string().regex(/^[A-Za-z_$][\w$]*$/).optional(),
    reason: z.string().default(""),
  }),
]);

export const patchEventSchema = z.object({
  type: z.literal("patch"),
  operations: z.array(patchOperationSchema).min(1),
  summary: z.string(),
  generator: z.enum(["llm_coder", "runtime_composer"]).default("llm_coder"),
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
export type VisionReviewModelConfig = z.infer<typeof visionReviewModelConfigSchema>;
export type VisionReviewConfig = z.infer<typeof visionReviewConfigSchema>;
export type ScreenshotMode = z.infer<typeof screenshotModeSchema>;
export type RuntimeComposerConfig = z.infer<typeof runtimeComposerConfigSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AssetImportConfig = z.infer<typeof assetImportConfigSchema>;
export type SkillCreateRequest = z.infer<typeof skillCreateRequestSchema>;
export type SkillInferRequest = z.infer<typeof skillInferRequestSchema>;
export type SkillInstallRequest = z.infer<typeof skillInstallRequestSchema>;
export type AircraftAssetCategory = z.infer<typeof aircraftAssetCategorySchema>;
export type AircraftView = z.infer<typeof aircraftViewSchema>;
export type AircraftAssetViewImage = z.infer<typeof aircraftAssetViewImageSchema>;
export type GlbStructureAnalysis = z.infer<typeof glbStructureAnalysisSchema>;
export type GlbTemplateParams = z.infer<typeof glbTemplateParamsSchema>;
export type GlbConstraintHint = z.infer<typeof glbConstraintHintSchema>;
export type AircraftAssetMetadata = z.infer<typeof aircraftAssetMetadataSchema>;
export type AssetImportRequest = z.infer<typeof assetImportRequestSchema>;
export type AssetImportItem = z.infer<typeof assetImportItemSchema>;
export type AssetImportResult = z.infer<typeof assetImportResultSchema>;
export type AssetImportJobStatus = z.infer<typeof assetImportJobStatusSchema>;
export type AssetImportJob = z.infer<typeof assetImportJobSchema>;
export type SemanticIntent = z.infer<typeof semanticIntentSchema>;
export type VisualIntent = z.infer<typeof visualIntentSchema>;
export type AssemblyTransform = z.infer<typeof assemblyTransformSchema>;
export type AssemblyPortKind = z.infer<typeof assemblyPortKindSchema>;
export type AssemblyConstraintPriority = z.infer<typeof assemblyConstraintPrioritySchema>;
export type AssemblyConstraintType = z.infer<typeof assemblyConstraintTypeSchema>;
export type AssemblyPart = z.infer<typeof assemblyPartSchema>;
export type AssemblyPort = z.infer<typeof assemblyPortSchema>;
export type AssemblyFeature = z.infer<typeof assemblyFeatureSchema>;
export type AssemblyGenerator = z.infer<typeof assemblyGeneratorSchema>;
export type AssemblyConstraint = z.infer<typeof assemblyConstraintSchema>;
export type AssemblyGraph = z.infer<typeof assemblyGraphSchema>;
export type AssemblyConstraintCheck = z.infer<typeof assemblyConstraintCheckSchema>;
export type AssemblySolverResult = z.infer<typeof assemblySolverResultSchema>;
export type QualityReviewView = z.infer<typeof qualityReviewViewSchema>;
export type SceneDsl = z.infer<typeof sceneDslSchema>;
export type QualityScreenshot = z.infer<typeof qualityScreenshotSchema>;
export type ScenePatchOperation = z.infer<typeof scenePatchOperationSchema>;
export type ScenePatch = z.infer<typeof scenePatchSchema>;
export type QualityIssue = z.infer<typeof qualityIssueSchema>;
export type RetrievalSearchRequest = z.infer<typeof retrievalSearchRequestSchema>;
export type RetrievalSearchResult = z.infer<typeof retrievalSearchResultSchema>;
export type RagIngestResult = z.infer<typeof ragIngestResultSchema>;
export type KnowledgeClearRequest = z.infer<typeof knowledgeClearRequestSchema>;
export type KnowledgeClearResult = z.infer<typeof knowledgeClearResultSchema>;
export type RagSearchRequest = z.infer<typeof ragSearchRequestSchema>;
export type RagSourceResolveRequest = z.infer<typeof ragSourceResolveRequestSchema>;
export type SceneComposeRequest = z.infer<typeof sceneComposeRequestSchema>;
export type SceneRenderRequest = z.infer<typeof sceneRenderRequestSchema>;
export type QualityInspectionRequest = z.infer<typeof qualityInspectionRequestSchema>;
export type QualityInspectionStatus = z.infer<typeof qualityInspectionStatusSchema>;
export type QualityInspectionResult = z.infer<typeof qualityInspectionResultSchema>;
export type QualityScores = z.infer<typeof qualityScoresSchema>;
export type QualityCheckItem = z.infer<typeof qualityCheckItemSchema>;
export type QualityViewResult = z.infer<typeof qualityViewResultSchema>;
export type VisualEmbeddingMatch = z.infer<typeof visualEmbeddingMatchSchema>;
export type SceneRevisionRequest = z.infer<typeof sceneRevisionRequestSchema>;
export type SceneRevisionResult = z.infer<typeof sceneRevisionResultSchema>;
export type WorkflowRevisionEvent = z.infer<typeof workflowRevisionEventSchema>;
export type WorkflowFinalizeRequest = z.infer<typeof workflowFinalizeRequestSchema>;
export type CoderRevisionRequest = z.infer<typeof coderRevisionRequestSchema>;
export type WorkflowReviewRoundRequest = z.infer<typeof workflowReviewRoundRequestSchema>;
export type WorkflowReviewRoundResult = z.infer<typeof workflowReviewRoundResultSchema>;

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
    if (operation.type === "parameter_patch") {
      sanitizeParameterPatch(operation.parameters);
      continue;
    }
    for (const [pattern, message] of dangerousPatterns) {
      if (pattern.test(operation.content)) {
        throw new Error(`${message}，位置: ${operation.path}`);
      }
    }
    if (operation.type === "replace_function" && operation.path !== "src/App.tsx") {
      throw new Error("函数级补丁 v1 只允许修改 src/App.tsx");
    }
    if (operation.type === "replace_function" && !functionPatchDefines(operation.content, operation.functionName)) {
      throw new Error(`函数级补丁必须完整定义目标函数: ${operation.functionName}`);
    }
    if (operation.type === "replace_file" && operation.path === "package.json") {
      sanitizePackageJson(operation.content);
    }
    if (operation.type === "replace_file" && operation.path === "src/App.tsx") {
      sanitizeAppTsx(operation.content);
    }
  }
  return parsed;
}

export function applyPatch(files: FileMap, patch: PatchEvent): FileMap {
  const sanitized = sanitizePatch(patch);
  const next = { ...files };
  for (const operation of sanitized.operations) {
    if (operation.type === "replace_file") {
      next[operation.path] = operation.content;
    } else if (operation.type === "replace_function") {
      const updated = replaceFunctionInSource(next[operation.path] ?? "", operation.functionName, operation.content);
      next[operation.path] = updated;
      if (operation.path === "src/App.tsx") sanitizeAppTsx(updated);
    } else {
      const updated = applyParameterPatchToSource(next[operation.path] ?? "", operation.parameters, operation.targetFunction);
      next[operation.path] = updated;
      sanitizeAppTsx(updated);
    }
  }
  return fileMapSchema.parse(next);
}

const allowedParameterPatchKeys = new Set([
  "bladeCount",
  "hubRadius",
  "tipRadius",
  "outerRingInnerRadius",
  "outerRingOuterRadius",
  "bladeThickness",
  "bladeTwist",
  "bladeSweep",
  "bladePitch",
  "rootWidth",
  "tipWidth",
  "metalness",
  "roughness",
  "cameraDistance",
  "cameraFov",
  "cameraPreset",
  "renderStyle",
  "hasOuterRing",
  "hasSpinnerCone",
]);

function sanitizeParameterPatch(parameters: Record<string, number | string | boolean>): void {
  for (const [key, value] of Object.entries(parameters)) {
    if (!allowedParameterPatchKeys.has(key)) throw new Error(`参数补丁不允许修改该字段: ${key}`);
    if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 1000)) {
      throw new Error(`参数补丁数值非法: ${key}`);
    }
    if (typeof value === "string" && value.length > 80) {
      throw new Error(`参数补丁字符串过长: ${key}`);
    }
  }
}

function applyParameterPatchToSource(
  source: string,
  parameters: Record<string, number | string | boolean>,
  targetFunction?: string,
): string {
  let next = source;
  const boundedSource = targetFunction ? findFunctionRange(next, targetFunction) : undefined;
  for (const [key, value] of Object.entries(parameters)) {
    const updated = replaceParameterValue(next, key, value, boundedSource);
    if (updated === next) {
      throw new Error(`未找到可安全替换的参数: ${key}`);
    }
    next = updated;
  }
  return next;
}

function replaceParameterValue(
  source: string,
  key: string,
  value: number | string | boolean,
  range?: { start: number; end: number },
): string {
  const start = range?.start ?? 0;
  const end = range?.end ?? source.length;
  const before = source.slice(0, start);
  let body = source.slice(start, end);
  const after = source.slice(end);
  const literal = parameterLiteral(value);
  const quotedProperty = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)(-?\\d+(?:\\.\\d+)?|true|false|"[^"]*")`);
  const bareProperty = new RegExp(`(\\b${escapeRegExp(key)}\\s*:\\s*)(-?\\d+(?:\\.\\d+)?|true|false|"[^"]*")`);
  const constAssignment = new RegExp(`(\\b(?:const|let|var)\\s+${escapeRegExp(key)}\\s*=\\s*)(-?\\d+(?:\\.\\d+)?|true|false|"[^"]*")`);
  if (quotedProperty.test(body)) body = body.replace(quotedProperty, `$1${literal}`);
  else if (bareProperty.test(body)) body = body.replace(bareProperty, `$1${literal}`);
  else if (constAssignment.test(body)) body = body.replace(constAssignment, `$1${literal}`);
  return `${before}${body}${after}`;
}

function parameterLiteral(value: number | string | boolean): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(5)));
}

function functionPatchDefines(content: string, functionName: string): boolean {
  return new RegExp(`\\bfunction\\s+${escapeRegExp(functionName)}\\s*\\(`).test(content) ||
    new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(functionName)}\\s*=`).test(content);
}

function replaceFunctionInSource(source: string, functionName: string, replacement: string): string {
  const range = findFunctionRange(source, functionName);
  if (!range) throw new Error(`未找到可替换函数: ${functionName}`);
  const original = source.slice(range.start, range.end);
  const normalized = normalizeFunctionReplacement(original, functionName, replacement);
  return `${source.slice(0, range.start)}${normalized}\n${source.slice(range.end)}`;
}

function normalizeFunctionReplacement(original: string, functionName: string, replacement: string): string {
  let next = replacement.trim();
  const wasDefaultExport = new RegExp(`^\\s*(?:export\\s+default\\s+)+function\\s+${escapeRegExp(functionName)}\\s*\\(`).test(original);
  if (wasDefaultExport && new RegExp(`^\\s*function\\s+${escapeRegExp(functionName)}\\s*\\(`).test(next)) {
    next = next.replace(/^(\s*)function\b/, "$1export default function");
  }
  next = next.replace(/^(\s*)(?:export\s+default\s+){2,}function\b/, "$1export default function");
  return next;
}

function findFunctionRange(source: string, functionName: string): { start: number; end: number } | undefined {
  const patterns = [
    new RegExp(`\\bfunction\\s+${escapeRegExp(functionName)}\\s*\\(`, "m"),
    new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(functionName)}\\s*=\\s*(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*\\{`, "m"),
    new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(functionName)}\\s*=\\s*function\\s*\\(`, "m"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match || match.index < 0) continue;
    const bodyStart = source.indexOf("{", match.index);
    if (bodyStart < 0) continue;
    const bodyEnd = findMatchingBrace(source, bodyStart);
    if (bodyEnd < 0) continue;
    const statementEnd = findStatementEnd(source, bodyEnd + 1);
    return { start: includeExportDefaultPrefix(source, match.index), end: statementEnd };
  }
  return undefined;
}

function includeExportDefaultPrefix(source: string, functionIndex: number): number {
  const lineStart = source.lastIndexOf("\n", Math.max(0, functionIndex - 1)) + 1;
  const leading = source.slice(lineStart, functionIndex);
  const match = /(?:export\s+default\s+)+$/.exec(leading);
  return match ? functionIndex - match[0].length : functionIndex;
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findStatementEnd(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
  if (source[cursor] === ";") return cursor + 1;
  return index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeAppTsx(content: string): void {
  validateBasicTsxSyntax(content);
  if (/(?:export\s+default\s+){2,}function\s+App\b/.test(content)) {
    throw new Error("src/App.tsx 存在重复 export default，疑似函数级 patch 拼接错误");
  }
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

function validateBasicTsxSyntax(content: string): void {
  const orphanReturnType = /(^|\n)\s*\)\s*:\s*[A-Za-z_$][\w.<>,\s[\]|&?]*\s*\{/m.exec(content);
  if (orphanReturnType) {
    throw new Error("src/App.tsx 存在残缺函数签名，疑似函数级 patch 截断了参数列表");
  }
  const stack: Array<{ char: string; index: number }> = [];
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    const next = content[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      stack.push({ char, index });
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      const last = stack.pop();
      if (!last || !isMatchingBracket(last.char, char)) {
        throw new Error(`src/App.tsx 括号不匹配，位置 ${index}: ${char}`);
      }
    }
  }
  if (quote) throw new Error("src/App.tsx 字符串或模板字符串未闭合");
  if (blockComment) throw new Error("src/App.tsx 块注释未闭合");
  const last = stack.at(-1);
  if (last) throw new Error(`src/App.tsx 括号未闭合，位置 ${last.index}: ${last.char}`);
}

function isMatchingBracket(open: string, close: string): boolean {
  return (open === "(" && close === ")") || (open === "{" && close === "}") || (open === "[" && close === "]");
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
