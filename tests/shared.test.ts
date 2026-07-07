import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import {
  applyPatch,
  defaultFiles,
  assetImportJobSchema,
  assemblyGraphSchema,
  assemblyPortKindSchema,
  assemblySolverResultSchema,
  aircraftAssetMetadataSchema,
  appSettingsSchema,
  qualityInspectionRequestSchema,
  qualityInspectionResultSchema,
  runtimeComposerConfigSchema,
  sanitizePatch,
  sceneDslSchema,
  streamEventSchema,
  visualIntentSchema,
  workflowReviewRoundRequestSchema,
  workflowFinalizeRequestSchema,
  type PatchEvent,
} from "../packages/shared/src/index";
import {
  buildCoderMessages,
  buildCoderPromptText,
  generateCoderPatchFromConfigs,
  hasThreeConsecutiveCandidateScoreDrops,
  mergeCompactSummary,
  resolveCoderModelFallbackConfigs,
} from "../apps/api/src/agent";
import { listAircraftAssets } from "../apps/api/src/aircraftAssets";
import { searchAircraftKnowledge } from "../apps/api/src/aircraftRetrieval";
import { buildCoderReferencePack } from "../apps/api/src/coderReferencePack";
import { composeScene, createRuntimePatch, createRuntimePatchWithRag, parseSemanticIntent, renderSceneToFiles } from "../apps/api/src/sceneRuntime";
import { applyScenePatch, buildVisionReviewMessages, inspectQuality, resolveVisionReviewModel, reviseScene, superviseQuality } from "../apps/api/src/quality";
import { resolveRagSource } from "../apps/api/src/rag";
import { importAircraftAssets, readAssetImportJob, startAssetImportJob } from "../apps/api/src/assetImporter";
import { selectSkillContext, selectSkillContextDynamic } from "../apps/api/src/skills";
import { defaultSettings, resolveModelConfig } from "../apps/api/src/settings";
import { deleteSession, getSessionState, projectRoot, saveArtifact, saveSceneState, saveVisualMemory, upsertSession } from "../apps/api/src/memory";
import { clearKnowledgeBase } from "../apps/api/src/knowledgeReset";
import { extractVisualIntent } from "../apps/api/src/visualIntent";
import { compareReferenceAndScreenshots, embedImageText } from "../apps/api/src/visualEmbedding";
import { supportsImageInput } from "../apps/api/src/modelCapabilities";
import { cleanupOrphanArtifactFiles, deleteSessionArtifactFiles } from "../apps/api/src/artifacts";
import {
  buildAircraftReviewChecklistInstruction,
  buildAircraftTargetFunctionCatalog,
  inferAircraftTargetFunctionFromText,
  inferEngineModelingVariant,
} from "../apps/api/src/aircraftModelingTargets";
import { buildTurbofanAssemblyGraph, solveAssemblyGraph, verifyAssemblyConstraints } from "../apps/api/src/assembly";
import { analyzeGlbStructure } from "../apps/api/src/glbAnalyzer";

describe("共享补丁安全策略", () => {
  it("允许替换白名单文件", () => {
    const patch: PatchEvent = {
      type: "patch",
      summary: "更新场景",
      operations: [
        {
          type: "replace_file",
          path: "src/App.tsx",
          content: `import * as THREE from "three";
export default function App() {
  const renderer = new THREE.WebGLRenderer();
  document.body.appendChild(renderer.domElement);
  renderer.render(new THREE.Scene(), new THREE.PerspectiveCamera());
  return <div />;
}`,
        },
      ],
    };

    const next = applyPatch(defaultFiles, patch);
    expect(next["src/App.tsx"]).toContain("return <div />");
  });

  it("函数级补丁只替换目标函数，保留其他代码结构", () => {
    const app = `import * as THREE from "three";
function buildFanBlades() {
  return new THREE.BoxGeometry(0.08, 0.82, 0.035);
}
function setupLighting(scene: THREE.Scene) {
  scene.add(new THREE.AmbientLight("#ffffff", 1));
}
export default function App() {
  const mount = document.createElement("div");
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  mount.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  buildFanBlades();
  setupLighting(scene);
  renderer.render(scene, camera);
  (window as any).__AGENTIC_THREE_VIEW__ = { scene, camera, renderer };
  return <div />;
}`;
    const next = applyPatch(
      { ...defaultFiles, "src/App.tsx": app },
      {
        type: "patch",
        summary: "只加厚叶片",
        operations: [
          {
            type: "replace_function",
            path: "src/App.tsx",
            functionName: "buildFanBlades",
            content: `function buildFanBlades() {
  return new THREE.BoxGeometry(0.18, 0.82, 0.08);
}`,
          },
        ],
      },
    );

    expect(next["src/App.tsx"]).toContain("BoxGeometry(0.18");
    expect(next["src/App.tsx"]).toContain("function setupLighting");
    expect(next["src/App.tsx"]).toContain("__AGENTIC_THREE_VIEW__");
  });

  it("拒绝残缺函数签名，避免坏代码进入 Sandpack 运行轮次", () => {
    const brokenApp = `import * as THREE from "three";
export default function App() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  renderer.render(scene, camera);
  (window as any).__AGENTIC_THREE_VIEW__ = { scene, camera, renderer };
  return <div />;
}
): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry());
}`;

    expect(() =>
      applyPatch(defaultFiles, {
        type: "patch",
        summary: "坏的运行错误修复",
        operations: [{ type: "replace_file", path: "src/App.tsx", content: brokenApp }],
      }),
    ).toThrow(/残缺函数签名|括号不匹配/);
  });

  it("函数级替换 App 时不会叠加 export default", () => {
    const app = `import * as THREE from "three";
export default function App() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  renderer.render(scene, camera);
  (window as any).__AGENTIC_THREE_VIEW__ = { scene, camera, renderer };
  return <div />;
}`;
    const replacement = `export default function App() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  renderer.render(scene, camera);
  (window as any).__AGENTIC_THREE_VIEW__ = { scene, camera, renderer };
  return <div className="fixed" />;
}`;
    const next = applyPatch(
      { ...defaultFiles, "src/App.tsx": app },
      {
        type: "patch",
        summary: "替换 App",
        operations: [{ type: "replace_function", path: "src/App.tsx", functionName: "App", content: replacement }],
      },
    );

    expect(next["src/App.tsx"]).toContain("export default function App()");
    expect(next["src/App.tsx"]).not.toContain("export default export default");
    expect(next["src/App.tsx"]).toContain("fixed");
  });

  it("拒绝重复 export default，避免重复修复越修越坏", () => {
    const broken = `import * as THREE from "three";
export default export default function App() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  renderer.render(scene, camera);
  (window as any).__AGENTIC_THREE_VIEW__ = { scene, camera, renderer };
  return <div />;
}`;

    expect(() =>
      applyPatch(defaultFiles, {
        type: "patch",
        summary: "重复 export default",
        operations: [{ type: "replace_file", path: "src/App.tsx", content: broken }],
      }),
    ).toThrow(/重复 export default/);
  });

  it("参数级补丁只调整登记参数，不重写函数结构", () => {
    const app = `import * as THREE from "three";
function buildFanBlades() {
  const turbofanParams = {
    bladeCount: 24,
    bladeTwist: 0.7,
    bladeThickness: 0.035,
    metalness: 0.8,
  };
  return turbofanParams;
}
export default function App() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  buildFanBlades();
  renderer.render(scene, camera);
  (window as any).__AGENTIC_THREE_VIEW__ = { scene, camera, renderer };
  return <div />;
}`;
    const next = applyPatch(
      { ...defaultFiles, "src/App.tsx": app },
      {
        type: "patch",
        summary: "微调叶片参数",
        operations: [
          {
            type: "parameter_patch",
            path: "src/App.tsx",
            parameters: {
              bladeTwist: 1.15,
              bladeThickness: 0.08,
            },
            targetFunction: "buildFanBlades",
            reason: "特征点显示叶片厚度和扭转不足",
          },
        ],
      },
    );

    expect(next["src/App.tsx"]).toContain("bladeTwist: 1.15");
    expect(next["src/App.tsx"]).toContain("bladeThickness: 0.08");
    expect(next["src/App.tsx"]).toContain("function buildFanBlades()");
  });

  it("参数级补丁拒绝越权字段，避免模型自由改坐标", () => {
    expect(() =>
      sanitizePatch({
        type: "patch",
        summary: "越权参数",
        operations: [
          {
            type: "parameter_patch",
            path: "src/App.tsx",
            parameters: {
              unsafePositionX: 99,
            },
          },
        ],
      }),
    ).toThrow(/参数补丁不允许修改该字段/);
  });

  it("拒绝越权路径", () => {
    expect(() =>
      sanitizePatch({
        type: "patch",
        summary: "越权",
        operations: [
          {
            type: "replace_file",
            path: "../server.ts" as "src/App.tsx",
            content: "bad",
          },
        ],
      }),
    ).toThrow();
  });

  it("拒绝危险 API", () => {
    expect(() =>
      sanitizePatch({
        type: "patch",
        summary: "危险",
        operations: [
          {
            type: "replace_file",
            path: "src/App.tsx",
            content: "eval('alert(1)')",
          },
        ],
      }),
    ).toThrow(/eval/);
  });

  it("三段式摘要不会被空值覆盖", () => {
    const next = mergeCompactSummary(
      {
        userGoal: "生成产品展示场景",
        codeState: "已有 OrbitControls",
        nextSteps: "准备截图",
      },
      {
        userGoal: "",
        codeState: "新增金属材质",
      },
    );

    expect(next.userGoal).toBe("生成产品展示场景");
    expect(next.codeState).toBe("新增金属材质");
    expect(next.nextSteps).toBe("准备截图");
  });

  it("模型配置默认 coder 用 GLM 原厂，其它非 embedding/rerank 用 Doubao Ark", () => {
    const coder = resolveModelConfig("coder_agent", defaultSettings);
    const planner = resolveModelConfig("planner_agent", defaultSettings);
    const summary = resolveModelConfig("summary", defaultSettings);

    expect(coder.model).toBe("GLM-5V-Turbo");
    expect(planner.model).toBe("doubao-seed-2-0-code-preview-260215");
    expect(summary.model).toBe("doubao-seed-2-0-code-preview-260215");
    expect(defaultSettings.visionReview.models.map((model) => model.model)).toEqual([
      "doubao-seed-2-0-code-preview-260215",
    ]);
    expect(coder.apiKeyEnvName).toBe("ZHIPU_API_KEY");
    expect(defaultSettings.visionReview.models.map((model) => model.apiKeyEnvName)).toEqual([
      "ARK_API_KEY",
    ]);
    expect(planner.apiKeyEnvName).toBe("ARK_API_KEY");
  });

  it("coder 运行候选默认使用 GLM 原厂和 Doubao，不再隐式追加 Gitee Kimi/Qwen", () => {
    const models = resolveCoderModelFallbackConfigs(defaultSettings).map((model) => model.model);

    expect(models).toEqual(["GLM-5V-Turbo", "doubao-seed-2-0-code-preview-260215"]);
    expect(models).not.toContain("Kimi-K2.6");
    expect(models).not.toContain("Qwen3.6-Plus");
    expect(models).not.toContain("MiniMax-M3");
    expect(models).not.toContain("MiMo-V2.5-Pro");
  });

  it("技能上下文会被限制在轻量范围内", () => {
    const context = selectSkillContext("把这个面的3d图给我，黑线白图", [
      "three-scene",
      "camera-light",
      "material-animation",
      "performance-safety",
      "webgpu",
      "threejs-fundamentals",
      "threejs-animation",
      "threejs-geometry",
      "threejs-interaction",
      "threejs-loaders",
      "threejs-lighting",
      "threejs-materials",
      "threejs-shaders",
      "threejs-postprocessing",
      "threejs-textures",
    ]);

    expect(context.length).toBeLessThanOrEqual(8000);
    expect((context.match(/^## /gm) || []).length).toBeLessThanOrEqual(10);
  });

  it("动态 skill 选择失败时会回退到轻量规则选择", async () => {
    const settings = {
      ...defaultSettings,
      enabledSkillIds: [
        "aircraft-parametric-modeling",
        "three-scene",
        "camera-light",
        "material-animation",
        "performance-safety",
        "webgpu",
        "threejs-geometry",
        "threejs-materials",
      ],
      models: defaultSettings.models.map((model) =>
        model.node === "coder_agent" ? { ...model, apiKeyEnvName: "MISSING_TEST_ARK_KEY" } : model,
      ),
    };
    const result = await selectSkillContextDynamic({
      message: "根据参考图生成涡轮发动机扇叶黑线白底的机械线稿，叶片要有厚度和扭转曲面",
      enabledSkillIds: settings.enabledSkillIds,
      settings,
    });

    expect(result.source).toBe("heuristic");
    expect(result.context.length).toBeLessThanOrEqual(8000);
    expect(result.selectedSkillIds.length).toBeGreaterThan(0);
    expect(result.selectedSkillIds.length).toBeLessThanOrEqual(6);
    expect(result.selectedSkillIds).toContain("aircraft-parametric-modeling");
    expect(result.selectedSkillIds).toContain("threejs-geometry");
  });

  it("前端一个 skill 都不选时不加载 skill", async () => {
    const result = await selectSkillContextDynamic({
      message: "生成黑线白底线稿",
      enabledSkillIds: [],
      settings: defaultSettings,
    });

    expect(result.source).toBe("none");
    expect(result.context).toBe("");
    expect(result.selectedSkillIds).toEqual([]);
  });

  it("前端选择不超过 4 个 skill 时直接加载，不调用动态选择", async () => {
    const result = await selectSkillContextDynamic({
      message: "生成黑线白底线稿",
      enabledSkillIds: ["three-scene", "camera-light"],
      settings: defaultSettings,
    });

    expect(result.source).toBe("direct");
    expect(result.selectedSkillIds).toEqual(["camera-light", "three-scene"]);
    expect((result.context.match(/^## /gm) || []).length).toBe(2);
  });

  it("支持 coder_input_summary 作为调试事件传递", () => {
    const event = streamEventSchema.parse({
      type: "coder_input_summary",
      message: "coder 收到 2 张图片，prompt 1500 字符。",
    });

    expect(event.type).toBe("coder_input_summary");
  });

  it("Runtime Composer 默认配置会被 settings schema 补齐", () => {
    const settings = appSettingsSchema.parse({
      models: defaultSettings.models,
      screenshotMode: "save",
      enabledSkillIds: [],
    });
    const config = runtimeComposerConfigSchema.parse(settings.runtimeComposer);

    expect(config.enabled).toBe(true);
    expect(config.maxRevisionRounds).toBe(3);
    expect(config.minQualityScore).toBe(0.75);
    expect(config.nonBlankPixelThreshold).toBe(0.02);
    expect(settings.visionReview.models.map((model) => model.model)).toEqual([
      "doubao-seed-2-0-code-preview-260215",
    ]);
  });

  it("视觉 review 默认每轮都使用 Doubao", () => {
    expect(resolveVisionReviewModel(1, defaultSettings).model).toBe("doubao-seed-2-0-code-preview-260215");
    expect(resolveVisionReviewModel(2, defaultSettings).model).toBe("doubao-seed-2-0-code-preview-260215");
    expect(resolveVisionReviewModel(3, defaultSettings).model).toBe("doubao-seed-2-0-code-preview-260215");
  });

  it("无参考图时 fallback 质检会降级为可继续修正", () => {
    const result = superviseQuality(
      qualityInspectionResultSchema.parse({
        status: "fallback",
        score: 0.72,
        modelUsed: "local-heuristic",
        issues: [],
        checks: [],
      }),
      defaultSettings.runtimeComposer,
      { referenceImages: [] },
    );

    expect(result.status).toBe("revise");
    expect(result.revisionHints.join("\n")).toContain("继续");
  });

  it("模型能力标记会把纯文本模型和视觉模型严格区分", () => {
    expect(supportsImageInput({ model: "MiMo-V2.5-Pro", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "GITEE_API_KEY", temperature: 0.2, maxTokens: 1200 })).toBe(false);
    expect(supportsImageInput({ model: "DeepSeek-V4-Pro", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "GITEE_API_KEY", temperature: 0.2, maxTokens: 1200 })).toBe(false);
    expect(supportsImageInput({ model: "doubao-seed-2-0-lite-260215", baseURL: "https://ark.cn-beijing.volces.com/api/v3", apiKeyEnvName: "ARK_API_KEY", temperature: 0.2, maxTokens: 1200 })).toBe(false);
    expect(supportsImageInput({ model: "doubao-seed-2-0-code-preview-260215", baseURL: "https://ark.cn-beijing.volces.com/api/v3", apiKeyEnvName: "ARK_API_KEY", temperature: 0.2, maxTokens: 1200 })).toBe(true);
    expect(supportsImageInput({ model: "GLM-5V-Turbo", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "GITEE_API_KEY", temperature: 0.2, maxTokens: 1200 })).toBe(true);
    expect(supportsImageInput({ model: "Kimi-K2.6", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "GITEE_API_KEY", temperature: 0.2, maxTokens: 1200 })).toBe(true);
    expect(supportsImageInput({ model: "Qwen3.6-Plus", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "GITEE_API_KEY", temperature: 0.2, maxTokens: 1200 })).toBe(true);
  });

  it("有图片但无视觉意图时不会默认识别为发动机", () => {
    const intent = parseSemanticIntent({
      sessionId: "image-no-default-engine",
      message: "",
      images: [{ name: "unknown.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aaaa" }],
      files: defaultFiles,
      runtimeErrors: [],
      history: [],
    });

    expect(intent.category).toBeUndefined();
    expect(intent.subject).toBe("aircraft component");
  });

  it("mock visualIntent 返回机翼时，Runtime/RAG 使用机翼类别和查询", async () => {
    const request = {
      sessionId: "visual-intent-wing",
      message: "",
      images: [{ name: "wing.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aaaa" }],
      files: defaultFiles,
      runtimeErrors: [],
      history: [],
    };
    const runtime = await createRuntimePatchWithRag(request, {
      subject: "aircraft wing from reference image",
      category: "wing",
      view: "front",
      renderStyle: "technical_lines",
      retrievalQuery: "aircraft wing airfoil black line technical drawing",
      visualFeatures: ["薄翼型截面", "轻微后掠"],
      geometryHints: ["翼型截面", "翼肋线"],
      materialHints: ["白底黑线"],
      codeHints: ["ExtrudeGeometry 生成翼型", "LineSegments 绘制翼肋"],
      confidence: 0.86,
      modelUsed: "MiniMax-M3",
      fallbackReason: "",
    });

    expect(runtime.intent.category).toBe("wing");
    expect(runtime.scene.objects[0]?.primitive).toBe("wing_panel");
    expect(runtime.scene.objects[0]?.constraints.join("\n")).toContain("翼型截面");
  });

  it("visualIntent 默认使用 Doubao，失败才回退规则", async () => {
    const request = {
      sessionId: "visual-intent-fallback",
      message: "黑线白图",
      images: [{ name: "engine.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aaaa" }],
      files: defaultFiles,
      runtimeErrors: [],
      history: [],
    };
    const success = await extractVisualIntent({
      request,
      normalizedGoal: "黑线白图",
      settings: defaultSettings,
      skipExternal: false,
      caller: async () => {
        return {
          subject: "turbofan engine",
          category: "engine",
          view: "front",
          renderStyle: "technical_lines",
          retrievalQuery: "turbofan engine front fan blades",
          visualFeatures: ["圆形进气口", "放射状叶片"],
          geometryHints: ["外环", "中心锥"],
          materialHints: ["白底黑线"],
          codeHints: ["TorusGeometry", "EdgesGeometry"],
          confidence: 0.9,
        };
      },
    });
    const fallback = await extractVisualIntent({
      request,
      normalizedGoal: "黑线白图",
      settings: defaultSettings,
      skipExternal: false,
      caller: async () => {
        throw new Error("mock all down");
      },
    });

    expect(success.modelUsed).toBe("doubao-seed-2-0-code-preview-260215");
    expect(success.category).toBe("engine");
    expect(success.codeHints).toContain("TorusGeometry");
    expect(fallback.modelUsed).toBe("local-rules");
    expect(fallback.fallbackReason).toContain("视觉模型不可用");
  });

  it("visualIntent 能容忍模型返回尾逗号或未加引号 key 的 JSON", async () => {
    const request = {
      sessionId: "visual-intent-json-repair",
      message: "这是涡轮发动机扇叶组件图片",
      images: [{ name: "engine.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aaaa" }],
      files: defaultFiles,
      runtimeErrors: [],
      history: [],
    };
    const result = await extractVisualIntent({
      request,
      normalizedGoal: request.message,
      settings: defaultSettings,
      skipExternal: false,
      caller: async () => `{
        subject: '涡轮发动机扇叶组件',
        category: 'engine',
        view: 'front',
        renderStyle: 'realistic',
        retrievalQuery: 'turbofan fan blade assembly',
        visualFeatures: ['中心圆锥', '放射状叶片',],
        geometryHints: ['外环', '轮毂',],
        confidence: 0.88,
      }`,
    });

    expect(result.modelUsed).toBe("doubao-seed-2-0-code-preview-260215");
    expect(result.category).toBe("engine");
    expect(result.visualFeatures).toContain("中心圆锥");
  });

  it("visualIntent 和 quality schema 能保存特征点、匹配视角和候选分", () => {
    const intent = visualIntentSchema.parse({
      subject: "turbine blade disk",
      category: "engine",
      view: "three_quarter",
      renderStyle: "realistic",
      retrievalQuery: "open turbine blade disk",
      visualFeatures: ["中心孔", "弯曲叶片"],
      geometryHints: ["叶片根部", "叶尖包络"],
      materialHints: ["银灰金属"],
      codeHints: ["BufferGeometry 参数化叶片"],
      confidence: 0.92,
      modelUsed: "Kimi-K2.6",
      referenceView: "three_quarter",
      referenceFeatures: [
        { id: "hub-hole", label: "中心孔", part: "hub", x: 0.5, y: 0.52, kind: "hole", confidence: 0.9, parameterHint: "hubRadius" },
        { id: "blade-tip", label: "叶尖包络", part: "bladeArray", x: 0.86, y: 0.3, kind: "blade_tip", confidence: 0.85, parameterHint: "tipRadius" },
      ],
      featureExpectations: [
        { id: "twist", label: "叶片扭转", part: "bladeArray", expected: "叶片应有连续弯曲和厚度", priority: "critical", parameterHint: "bladeTwist" },
      ],
    });
    const quality = qualityInspectionResultSchema.parse({
      status: "revise",
      score: 0.64,
      candidateScore: 0.72,
      matchedReferenceView: "three_quarter",
      scores: { geometry: 0.6, viewMatch: 0.8, material: 0.6, referenceSimilarity: 0.7, embeddingSimilarity: 0.74, renderHealth: 1, overall: 0.64 },
      embeddingMatches: [
        { referenceName: "ref.png", referenceIndex: 0, screenshotView: "three_quarter", similarity: 0.88, model: "Qwen3-VL-Embedding-8B", dimension: 2048, matched: true },
      ],
      featureMatches: [
        { referenceId: "hub-hole", screenshotId: "hub-hole", label: "中心孔", view: "three_quarter", distance: 0.04, pass: true, confidence: 0.9, suggestedParameter: "hubRadius" },
      ],
      viewResults: [
        {
          view: "three_quarter",
          scores: { geometry: 0.6, viewMatch: 0.8, material: 0.6, referenceSimilarity: 0.7, embeddingSimilarity: 0.74, renderHealth: 1, overall: 0.64 },
          featurePoints: intent.referenceFeatures,
          featureMatches: [
            { referenceId: "hub-hole", screenshotId: "hub-hole", label: "中心孔", view: "three_quarter", distance: 0.04, pass: true, confidence: 0.9 },
          ],
        },
      ],
    });

    expect(intent.referenceView).toBe("three_quarter");
    expect(intent.referenceFeatures[0]?.parameterHint).toBe("hubRadius");
    expect(quality.matchedReferenceView).toBe("three_quarter");
    expect(quality.candidateScore).toBeCloseTo(0.72);
    expect(quality.scores.embeddingSimilarity).toBeCloseTo(0.74);
    expect(quality.embeddingMatches[0]?.matched).toBe(true);
    expect(quality.featureMatches[0]?.suggestedParameter).toBe("hubRadius");
  });

  it("视觉 embedding 能按配置维度归一化，并在维度不匹配时 fallback", async () => {
    const previousDim = process.env.VISUAL_EMBEDDING_DIM;
    process.env.VISUAL_EMBEDDING_DIM = "64";
    try {
      const ok = await embedImageText({
        text: "embedding-dim-ok",
        imageDataUrl: "data:image/png;base64,embedding-dim-ok",
        runner: async () => new Array(64).fill(0).map((_item, index) => (index === 0 ? 3 : 0)),
      });
      const fallback = await embedImageText({
        text: "embedding-dim-bad",
        imageDataUrl: "data:image/png;base64,embedding-dim-bad",
        runner: async () => [1, 2, 3],
      });

      expect(ok.embedding).toHaveLength(64);
      expect(ok.embedding[0]).toBeCloseTo(1);
      expect(ok.fallbackReason).toBe("");
      expect(fallback.embedding).toHaveLength(64);
      expect(fallback.fallbackReason).toContain("维度不匹配");
      expect(fallback.model).toContain("local-hash-fallback");
    } finally {
      if (previousDim === undefined) delete process.env.VISUAL_EMBEDDING_DIM;
      else process.env.VISUAL_EMBEDDING_DIM = previousDim;
    }
  });

  it("单参考图向量评分只选择匹配视角作为主相似度", async () => {
    const previousDim = process.env.VISUAL_EMBEDDING_DIM;
    process.env.VISUAL_EMBEDDING_DIM = "64";
    try {
      const result = await compareReferenceAndScreenshots({
        userGoal: "参考图是侧面涡轮叶盘",
        referenceImages: [{ name: "ref-side.png", mimeType: "image/png", dataUrl: "data:image/png;base64,ref-side" }],
        preferredView: "side",
        screenshots: [
          { view: "front", dataUrl: "data:image/png;base64,current-front" },
          { view: "side", dataUrl: "data:image/png;base64,current-side" },
        ],
        runner: async ({ text }) => {
          const vector = new Array(64).fill(0);
          if (/参考图|side/.test(text)) vector[0] = 1;
          else vector[1] = 1;
          return vector;
        },
      });

      expect(result?.matchedView).toBe("side");
      expect(result?.score).toBeCloseTo(1);
      expect(result?.matches.find((match) => match.screenshotView === "side")?.matched).toBe(true);
      expect(result?.matches.find((match) => match.screenshotView === "front")?.matched).toBe(false);
    } finally {
      if (previousDim === undefined) delete process.env.VISUAL_EMBEDDING_DIM;
      else process.env.VISUAL_EMBEDDING_DIM = previousDim;
    }
  });

  it("涡扇 Runtime 首轮具备约束模板条件，避免自由坐标作为核心结构", async () => {
    const runtime = await createRuntimePatchWithRag(
      {
        sessionId: "agent-template-first",
        message: "这是涡轮发动机扇叶组件图片，画出他的3d图",
        images: [{ name: "engine.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aaaa" }],
        files: defaultFiles,
        runtimeErrors: [],
        history: [],
      },
      {
        subject: "turbofan engine",
        category: "engine",
        view: "front",
        renderStyle: "engineering_white",
        retrievalQuery: "turbofan fan blade assembly",
        visualFeatures: ["中心圆锥", "放射状叶片"],
        geometryHints: ["外环", "轮毂"],
        materialHints: [],
        codeHints: [],
        confidence: 0.88,
        modelUsed: "MiniMax-M3",
        fallbackReason: "",
      },
    );

    expect(runtime.scene.assemblyGraph?.templateId).toBe("turbofan_v1");
    expect(runtime.scene.solverResult?.ok).toBe(true);
    expect(runtime.patch.operations[0]?.content).toContain("buildTurbofanFront");
    expect(runtime.patch.operations[0]?.content).toContain("makeBladeGeometry");
  });

  it("开放式叶盘目标不会被错误要求生成外涵道大圆环", async () => {
    const runtime = await createRuntimePatchWithRag(
      {
        sessionId: "agent-open-blisk-template",
        message: "这是涡轮发动机扇叶叶盘，画出他的3d图",
        images: [{ name: "blisk.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aaaa" }],
        files: defaultFiles,
        runtimeErrors: [],
        history: [],
      },
      {
        subject: "turbofan engine blade disk assembly",
        category: "engine",
        view: "three_quarter",
        renderStyle: "realistic",
        retrievalQuery: "open blisk turbine blade disk",
        visualFeatures: ["开放式叶盘", "中心轮毂", "放射状弯曲叶片"],
        geometryHints: ["无外环", "叶片有宽度和扭转"],
        materialHints: ["银灰金属"],
        codeHints: ["radial blade array"],
        confidence: 0.92,
        modelUsed: "Kimi-K2.6",
        fallbackReason: "",
      },
    );
    const app = runtime.patch.operations[0]?.content ?? "";

    expect(inferEngineModelingVariant("涡轮发动机扇叶叶盘 无外环")).toBe("open_blisk");
    expect(runtime.scene.assemblyGraph?.parts.some((part) => part.id === "outerRing")).toBe(false);
    expect(runtime.scene.assemblyGraph?.constraints.some((constraint) => /outerRing/.test(constraint.id))).toBe(false);
    expect(runtime.scene.solverResult?.ok).toBe(true);
    expect(app).toContain('"hasOuterRing": false');
    expect(app).toContain('"hasSpinnerCone": false');
  });

  it("engine review checklist 会区分开放式叶盘和带涵道涡扇", () => {
    const openChecklist = buildAircraftReviewChecklistInstruction("engine", "涡轮发动机 blade disk blisk 叶盘 无外环");
    const ductedChecklist = buildAircraftReviewChecklistInstruction("engine", "涡扇发动机整机 进气口 外涵道 机匣");

    expect(openChecklist).toContain("开放式叶盘");
    expect(openChecklist).toContain("大外环");
    expect(openChecklist).toContain("critical");
    expect(ductedChecklist).toContain("带涵道");
    expect(ductedChecklist).toContain("外环/机匣/涵道");
  });

  it("支持 workflow_config 和 scene_dsl 流事件", () => {
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", primitive: "turbofan_front" }],
    });

    expect(streamEventSchema.parse({ type: "workflow_config", config: defaultSettings.runtimeComposer }).type).toBe(
      "workflow_config",
    );
    expect(streamEventSchema.parse({ type: "scene_dsl", scene }).type).toBe("scene_dsl");
  });

  it("质检 schema 能表达截图、参考图和 DSL", () => {
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", primitive: "turbofan_front" }],
    });
    const request = qualityInspectionRequestSchema.parse({
      sessionId: "quality-test",
      round: 1,
      userGoal: "画发动机正面黑线白图",
      screenshotDataUrl: "data:image/png;base64,aaaa",
      scene,
    });

    expect(request.referenceImages).toEqual([]);
    expect(request.scene.objects[0]?.primitive).toBe("turbofan_front");
    expect(qualityInspectionResultSchema.parse({ status: "pass", score: 0.9, modelUsed: "MiniMax-M3" }).modelUsed).toBe("MiniMax-M3");
  });

  it("质检 schema 支持多维 scores、checks 和 viewResults，并保留旧 score 兼容", () => {
    const parsed = qualityInspectionResultSchema.parse({
      status: "revise",
      scores: {
        geometry: 0.6,
        viewMatch: 0.7,
        material: 0.8,
        referenceSimilarity: 0.5,
        renderHealth: 1,
        overall: 0.65,
      },
      checks: [
        {
          view: "front",
          dimension: "geometry",
          item: "主体结构完整",
          pass: false,
          confidence: 0.9,
          note: "缺少关键曲面细节",
          severity: "major",
          suggestedFix: "增加曲面叶片厚度和扭转。",
          targetFunction: "buildFanBlades",
        },
      ],
      viewResults: [
        {
          view: "front",
          scores: {
            geometry: 0.6,
            viewMatch: 0.7,
            material: 0.8,
            referenceSimilarity: 0.5,
            renderHealth: 1,
            overall: 0.65,
          },
          checks: [],
          issues: [],
          revisionHints: [],
          modelUsed: "GLM-5V-Turbo",
        },
      ],
    });

    expect(parsed.score).toBe(0.65);
    expect(parsed.scores.geometry).toBe(0.6);
    expect(parsed.checks[0]?.dimension).toBe("geometry");
    expect(parsed.checks[0]?.targetFunction).toBe("buildFanBlades");
    expect(parsed.viewResults[0]?.view).toBe("front");
  });

  it("航空建模 targetFunction registry 覆盖发动机、机翼、机身、起落架和驾驶舱", () => {
    const catalog = buildAircraftTargetFunctionCatalog();

    expect(catalog).toContain("buildFanBlades");
    expect(catalog).toContain("buildWingPlanform");
    expect(catalog).toContain("buildFuselageBody");
    expect(catalog).toContain("buildWheels");
    expect(catalog).toContain("buildCanopy");
    expect(inferAircraftTargetFunctionFromText("叶片厚度和扭转不够", "engine")).toBe("buildFanBlades");
    expect(inferAircraftTargetFunctionFromText("翼型厚度和前缘曲率不对", "wing")).toBe("buildAirfoilSection");
    expect(inferAircraftTargetFunctionFromText("起落架支柱和斜撑缺失", "landing_gear")).toBe("buildStruts");
  });

  it("critical check 失败时即使 overall 高也不能 pass", () => {
    const config = runtimeComposerConfigSchema.parse({ minQualityScore: 0.75 });
    const result = superviseQuality(
      qualityInspectionResultSchema.parse({
        status: "pass",
        scores: {
          geometry: 0.95,
          viewMatch: 0.95,
          material: 0.95,
          referenceSimilarity: 0.95,
          renderHealth: 1,
          overall: 0.96,
        },
        checks: [
          {
            dimension: "referenceSimilarity",
            item: "参考图相似度必须通过",
            pass: false,
            confidence: 1,
            severity: "critical",
            note: "当前结果明显不像参考图",
            suggestedFix: "继续 coder 修正。",
          },
        ],
      }),
      config,
    );

    expect(result.status).toBe("revise");
  });

  it("workflow review-round 请求能携带多视角截图、当前文件和 LLM coder 来源", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(9000)}`;
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", objectId: "engine", primitive: "turbofan_front" }],
    });
    const parsed = workflowReviewRoundRequestSchema.parse({
      sessionId: "workflow-round-schema-test",
      runId: "run-1",
      round: 2,
      userGoal: "按参考图画涡轮发动机扇叶",
      files: defaultFiles,
      referenceImages: [{ name: "ref.png", mimeType: "image/png", dataUrl }],
      screenshots: ["front", "side", "top", "three_quarter"].map((view) => ({ view, dataUrl })),
      scene,
      patchGenerator: "llm_coder",
      maxRevisionRounds: 8,
    });

    expect(parsed.screenshots).toHaveLength(4);
    expect(parsed.patchGenerator).toBe("llm_coder");
    expect(parsed.files["src/App.tsx"]).toContain("THREE");
  });

  it("旧 Scene DSL 会兼容升级为 Scene Graph 默认结构", () => {
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", primitive: "turbofan_front" }],
    });

    expect(scene.version).toBe(2);
    expect(scene.objects[0]?.semanticRole).toBe("primary_subject");
    expect(scene.objects[0]?.visibility.front).toBe(true);
    expect(scene.qualityState.status).toBe("unknown");
  });

  it("AssemblyGraph 只表达结构约束，SolverResult 独立保存 transforms/residuals", () => {
    const graph = buildTurbofanAssemblyGraph();
    const parsedGraph = assemblyGraphSchema.parse(graph);
    const result = assemblySolverResultSchema.parse(solveAssemblyGraph(parsedGraph));

    expect("solvedTransforms" in parsedGraph).toBe(false);
    expect(parsedGraph.parts.map((part) => part.id)).toEqual(["hub", "spinner", "rearHub", "outerRing", "bladeArray"]);
    expect(parsedGraph.ports.some((port) => port.kind === "edge")).toBe(false);
    expect(assemblyPortKindSchema.options).toEqual(["axis", "face", "radius", "point", "edge"]);
    expect(result.transforms.hub?.position).toEqual([0, 0, 0]);
    expect(result.residuals["coaxial.core.coaxialError"]).toBeLessThanOrEqual(0.001);
  });

  it("TurbofanTemplate 默认能通过硬约束，radialArray 作为生成规则保留", () => {
    const graph = buildTurbofanAssemblyGraph({ bladeCount: 32 });
    const result = solveAssemblyGraph(graph);

    expect(graph.generators[0]?.type).toBe("radialArray");
    expect(graph.constraints.some((constraint) => constraint.type === "coaxial" && constraint.priority === "critical")).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.pass)).toBe(true);
    expect(result.residuals["bladeArray.radialArray.expectedAngleStep"]).toBeCloseTo((Math.PI * 2) / 32);
    expect(result.residuals["insideRadius.bladeTip.outerRing.tipClearance"]).toBeGreaterThanOrEqual(0);
  });

  it("Constraint Verifier 能发现同轴和半径 critical 失败", () => {
    const graph = buildTurbofanAssemblyGraph();
    const badGraph = assemblyGraphSchema.parse({
      ...graph,
      ports: graph.ports.map((port) => port.id === "bladeArray.tipRadius" ? { ...port, radius: 2.0 } : port),
    });
    const solved = solveAssemblyGraph(badGraph);
    const shifted = assemblySolverResultSchema.parse({
      ...solved,
      transforms: {
        ...solved.transforms,
        outerRing: { position: [0.2, 0, 0], rotation: [0, 0, 0], scale: 1 },
      },
    });
    const result = verifyAssemblyConstraints(badGraph, shifted);

    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.constraintId === "coaxial.core" && !check.pass && check.priority === "critical")).toBe(true);
    expect(result.checks.some((check) => check.constraintId === "insideRadius.bladeTip.outerRing" && !check.pass && check.priority === "critical")).toBe(true);
  });

  it("多视角质检请求会被 inspect 接收并保留结构化问题字段", async () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(9000)}`;
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", objectId: "engine", primitive: "turbofan_front" }],
    });
    const result = await inspectQuality(
      {
        sessionId: "multi-view-quality-test",
        round: 1,
        userGoal: "画发动机正面黑线白图",
        screenshots: ["front", "side", "top", "three_quarter"].map((view) => ({ view, dataUrl })),
        scene,
      },
      defaultSettings,
    );

    expect(["pass", "revise"]).toContain(result.status);
    expect(result.modelUsed).toContain("local-heuristic");
    expect(result.structuredIssues).toEqual(expect.any(Array));
  });

  it("critical assembly constraint fail 时质检不得通过", async () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(9000)}`;
    const graph = buildTurbofanAssemblyGraph();
    const solved = solveAssemblyGraph(graph);
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", objectId: "engine", primitive: "turbofan_front" }],
      assemblyGraph: graph,
      solverResult: {
        ...solved,
        transforms: {
          ...solved.transforms,
          outerRing: { position: [0.25, 0, 0], rotation: [0, 0, 0], scale: 1 },
        },
      },
    });
    const result = await inspectQuality(
      {
        sessionId: "assembly-quality-test",
        round: 1,
        userGoal: "画涡轮发动机扇叶",
        screenshots: ["front", "side", "top", "three_quarter"].map((view) => ({ view, dataUrl })),
        scene,
      },
      defaultSettings,
    );

    expect(result.status).toBe("revise");
    expect(result.constraintStatus).toBe("revise");
    expect(result.constraintChecks.some((check) => !check.pass && check.priority === "critical")).toBe(true);
    expect(result.checks.some((check) => check.dimension === "constraint" && !check.pass)).toBe(true);
  });

  it("有参考图时 local-heuristic 不能直接判定质检通过", async () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(9000)}`;
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", objectId: "engine", primitive: "turbofan_front" }],
    });
    const result = await inspectQuality(
      {
        sessionId: "reference-quality-test",
        round: 1,
        userGoal: "根据参考图画涡轮发动机曲面扇叶",
        referenceImages: [{ name: "ref.png", mimeType: "image/png", dataUrl }],
        screenshots: ["front", "side", "top", "three_quarter"].map((view) => ({ view, dataUrl })),
        scene,
      },
      defaultSettings,
    );

    expect(result.modelUsed).toContain("local-heuristic");
    expect(result.modelUsed).toContain("embedding:Qwen3-VL-Embedding-8B");
    expect(result.status).toBe("revise");
    expect(result.scores.referenceSimilarity).toBeLessThanOrEqual(0.35);
    expect(result.scores.embeddingSimilarity).toBeGreaterThan(0);
    expect(result.issues[0]).toContain("视觉模型未完成质检");
    expect(result.checks.some((check) => !check.pass && check.targetFunction === "createScene")).toBe(true);
  });

  it("视觉质检消息最多携带 5 张图片，避免超过 MiniMax 图片数量限制", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(9000)}`;
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", objectId: "engine", primitive: "turbofan_front" }],
    });
    const messages = buildVisionReviewMessages(
      qualityInspectionRequestSchema.parse({
        sessionId: "quality-image-cap-test",
        round: 1,
        userGoal: "画发动机正面黑线白图",
        referenceImages: [
          { name: "front.png", mimeType: "image/png", dataUrl },
          { name: "back.png", mimeType: "image/png", dataUrl },
        ],
        screenshots: ["front", "side", "top", "three_quarter"].map((view) => ({ view, dataUrl })),
        scene,
      }),
    );
    const imageCount = Array.isArray(messages[1]?.content)
      ? messages[1].content.filter((part) => part.type === "image_url").length
      : 0;

    expect(imageCount).toBeLessThanOrEqual(5);
    expect(imageCount).toBe(5);
  });

  it("资产导入按内容指纹跳过重复，并在内容变化时重新导入", async () => {
    const previousFallback = process.env.RAG_FORCE_FALLBACK;
    process.env.RAG_FORCE_FALLBACK = "1";
    const root = resolve(process.cwd(), ".data", `asset-import-test-${Date.now()}`);
    const source = resolve(root, "source");
    const output = `.data/asset-import-output-${Date.now()}`;
    mkdirSync(source, { recursive: true });
    try {
      const file = resolve(source, "机翼演示.tsx");
      writeFileSync(file, `/** wing import smoke ${Date.now()} */\nexport default function Demo(){ return null; }\n`, "utf8");
      const first = await importAircraftAssets({ sourceDirectory: source, uploadDirectory: output });
      const second = await importAircraftAssets({ sourceDirectory: source, uploadDirectory: output });
      writeFileSync(file, `/** wing import changed ${Date.now()} */\nexport default function Demo(){ return <div />; }\n`, "utf8");
      const third = await importAircraftAssets({ sourceDirectory: source, uploadDirectory: output });

      expect(first.importedCount).toBe(1);
      expect(first.ok).toBe(true);
      expect(first.items[0]?.id).toMatch(/^[a-z0-9-]+$/);
      expect(first.items[0]?.viewCount).toBe(6);
      expect(second.importedCount).toBe(0);
      expect(second.ok).toBe(true);
      expect(second.items[0]?.message).toContain("文件未变更");
      expect(second.items[0]?.viewCount).toBe(6);
      expect(third.importedCount).toBe(1);
      expect(third.items[0]?.viewCount).toBe(6);
    } finally {
      process.env.RAG_FORCE_FALLBACK = previousFallback;
      rmSync(root, { recursive: true, force: true });
      rmSync(resolve(process.cwd(), output), { recursive: true, force: true });
    }
  }, 20000);

  it("后台导入 job 能返回进度和统计", async () => {
    const previousFallback = process.env.RAG_FORCE_FALLBACK;
    process.env.RAG_FORCE_FALLBACK = "1";
    const root = resolve(process.cwd(), ".data", `asset-import-job-test-${Date.now()}`);
    const source = resolve(root, "source");
    const output = `.data/asset-import-job-output-${Date.now()}`;
    mkdirSync(source, { recursive: true });
    try {
      writeFileSync(resolve(source, "engine-demo.tsx"), "/** engine demo */\nexport default function Demo(){ return null; }\n", "utf8");
      const job = startAssetImportJob({ sourceDirectory: source, uploadDirectory: output });
      const parsed = assetImportJobSchema.parse(job);
      expect(parsed.status).toMatch(/queued|running/);

      let latest = readAssetImportJob(job.jobId);
      for (let attempt = 0; attempt < 80 && latest?.status !== "success"; attempt += 1) {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
        latest = readAssetImportJob(job.jobId);
      }

      expect(latest?.status).toBe("success");
      expect(latest?.processed).toBe(1);
      expect((latest?.imported ?? 0) + (latest?.skipped ?? 0)).toBe(1);
      expect(latest?.percent).toBe(100);
    } finally {
      process.env.RAG_FORCE_FALLBACK = previousFallback;
      rmSync(root, { recursive: true, force: true });
      rmSync(resolve(process.cwd(), output), { recursive: true, force: true });
    }
  });

  it("工作流 finalize 请求只能保存白名单文件快照", () => {
    const request = workflowFinalizeRequestSchema.parse({
      sessionId: "finalize-test",
      runId: "run-1",
      label: "workflow-best-round-2",
      files: defaultFiles,
      round: 2,
      score: 0.82,
      screenshotPath: "outputs/screenshots/test/a.png",
    });

    expect(request.label).toBe("workflow-best-round-2");
    expect(request.files["src/App.tsx"]).toContain("three");
    expect(() =>
      workflowFinalizeRequestSchema.parse({
        ...request,
        files: { ...defaultFiles, "../escape.ts": "bad" },
      }),
    ).toThrow();
  });

  it("Scene Patch 只按 objectId 修改目标对象", () => {
    const scene = sceneDslSchema.parse({
      sceneType: "component_detail",
      cameraPreset: "three_quarter",
      lightingPreset: "studio_soft",
      renderStyle: "realistic",
      objects: [
        { id: "engine", objectId: "engine", primitive: "generic_part", scale: 1 },
        { id: "wing", objectId: "wing", primitive: "wing_panel", scale: 1 },
      ],
    });
    const patched = applyScenePatch(scene, {
      summary: "只修发动机对象",
      operations: [
        { op: "set_object", objectId: "engine", path: "primitive", value: "turbofan_front", reason: "发动机对象需要叶片结构" },
        { op: "set_object", objectId: "engine", path: "scale", value: 1.2, reason: "放大目标对象" },
      ],
    });

    expect(patched.objects[0]?.primitive).toBe("turbofan_front");
    expect(patched.objects[0]?.scale).toBeCloseTo(1.2);
    expect(patched.objects[1]?.primitive).toBe("wing_panel");
    expect(patched.objects[1]?.scale).toBe(1);
  });

  it("Scene State 和视觉记忆会持久化并能从 session state 恢复", () => {
    const sessionId = `scene-state-test-${Date.now()}`;
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", objectId: "engine", primitive: "turbofan_front" }],
    });
    const state = saveSceneState({
      sessionId,
      runId: "run-1",
      round: 1,
      userGoal: "发动机正面黑线白图",
      scene,
      screenshotPaths: { front: "outputs/screenshots/front.png" },
      status: "final",
    });
    saveVisualMemory({
      sessionId,
      runId: "run-1",
      stateId: state.stateId,
      userGoal: "发动机正面黑线白图",
      scene: state.scene,
      screenshotPaths: { front: "outputs/screenshots/front.png" },
      score: 0.88,
    });
    const restored = getSessionState(sessionId);

    expect(restored.latestSceneState?.stateId).toBe(state.stateId);
    expect(restored.recentVisualMemories[0]?.score).toBe(0.88);
    expect(restored.recentVisualMemories[0]?.scene.objects[0]?.objectId).toBe("engine");
  });

  it("删除会话时会删除该会话产生的截图和输入图文件", () => {
    const sessionId = `delete-session-artifacts-${Date.now()}`;
    upsertSession(sessionId, "删除会话文件测试");
    const root = resolve(projectRoot, "outputs", "screenshots", `delete-session-artifacts-${Date.now()}`);
    const file = resolve(root, "shot.png");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(file, "png", "utf8");
      saveArtifact({
        sessionId,
        kind: "screenshot",
        path: file,
        fileName: "shot.png",
        url: "/api/artifacts/file?path=outputs/screenshots/shot.png",
      });

      const deletedFiles = deleteSessionArtifactFiles(sessionId);
      const deleted = deleteSession(sessionId);

      expect(deleted).toBe(true);
      expect(deletedFiles.deletedFiles).toBe(1);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      deleteSession(sessionId);
    }
  });

  it("orphan cleanup 会删除 outputs 下没有数据库引用的垃圾文件", () => {
    const root = resolve(projectRoot, "outputs", "screenshots", `orphan-artifacts-${Date.now()}`);
    const file = resolve(root, "orphan.png");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(file, "png", "utf8");

      const result = cleanupOrphanArtifactFiles({ roots: [root] });

      expect(result.deletedFiles).toBeGreaterThanOrEqual(1);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("清除知识库会删除导入目录并清空知识库 SQLite 记录", async () => {
    const previousFallback = process.env.RAG_FORCE_FALLBACK;
    process.env.RAG_FORCE_FALLBACK = "1";
    const uploadDirectory = `.data/knowledge-clear-test-${Date.now()}`;
    const uploadRoot = resolve(process.cwd(), uploadDirectory);
    try {
      mkdirSync(uploadRoot, { recursive: true });
      writeFileSync(resolve(uploadRoot, "metadata.json"), "{}", "utf8");
      const scene = sceneDslSchema.parse({
        sceneType: "engine_showcase",
        cameraPreset: "front",
        lightingPreset: "engineering_white",
        renderStyle: "technical_lines",
        objects: [{ id: "engine", objectId: "engine", primitive: "turbofan_front" }],
      });
      saveSceneState({ sessionId: "knowledge-clear-test", scene, status: "final" });
      saveVisualMemory({ sessionId: "knowledge-clear-test", scene, screenshotPaths: { front: "outputs/x.png" } });

      const result = await clearKnowledgeBase({ uploadDirectory });
      const restored = getSessionState("knowledge-clear-test");

      expect(result.ok).toBe(true);
      expect(existsSync(uploadRoot)).toBe(false);
      expect(result.clearedTables).toContain("imported_assets");
      expect(restored.latestSceneState).toBeUndefined();
      expect(restored.recentVisualMemories).toEqual([]);
    } finally {
      process.env.RAG_FORCE_FALLBACK = previousFallback;
      rmSync(uploadRoot, { recursive: true, force: true });
    }
  });

  it("质检 supervisor 按阈值决定 pass 或 revise", () => {
    const config = runtimeComposerConfigSchema.parse({ minQualityScore: 0.75 });
    const pass = superviseQuality(
      qualityInspectionResultSchema.parse({ status: "revise", score: 0.82, issues: [], revisionHints: [] }),
      config,
    );
    const revise = superviseQuality(
      qualityInspectionResultSchema.parse({ status: "pass", score: 0.4, issues: ["主体太小"], revisionHints: [] }),
      config,
    );

    expect(pass.status).toBe("pass");
    expect(revise.status).toBe("revise");
    expect(revise.revisionHints.length).toBeGreaterThan(0);
  });

  it("能校验飞机资产 metadata schema", () => {
    const asset = aircraftAssetMetadataSchema.parse({
      id: "turbofan-test",
      category: "engine",
      title: "测试涡扇",
      description: "测试资产",
      tags: ["engine"],
      assetPath: "assets/aircraft/engines/turbofan-test/model.glb",
      previewPath: "assets/aircraft/engines/turbofan-test/preview.webp",
      shapeSummary: "GLB 形体摘要: 正面外涵道圆环、风扇叶片和中心锥。",
      viewFeatures: ["正面: 可见外环、内环、叶片和中心锥。"],
      skeletonHints: ["使用 TorusGeometry 表达外涵道圆环。"],
      codeSummary: "源码摘要: 使用 EdgesGeometry 输出工程线稿。",
      keySnippets: ["function buildEngine(){ return new THREE.TorusGeometry(1, .1); }"],
      detectedPatterns: ["TorusGeometry", "EdgesGeometry"],
      viewImages: [
        {
          view: "front",
          imagePath: "assets/aircraft/engines/turbofan-test/views/front.webp",
          title: "正面参考",
          description: "用于识别进气口、叶片和中心整流锥。",
          tags: ["front", "fan-blades"],
        },
      ],
    });

    expect(asset.category).toBe("engine");
    expect(asset.pivot).toBe("center");
    expect(asset.viewImages[0]?.view).toBe("front");
    expect(asset.shapeSummary).toContain("外涵道");
    expect(asset.keySnippets[0]).toContain("buildEngine");
    expect(asset.structureAnalysis.status).toBe("skipped");
    expect(asset.constraintHints).toEqual([]);
  });

  it("飞机资产 metadata schema 可保存 GLB 结构分析和模板参数", () => {
    const asset = aircraftAssetMetadataSchema.parse({
      id: "turbofan-structure-test",
      category: "engine",
      title: "结构分析测试涡扇",
      description: "测试资产",
      tags: ["engine", "glb"],
      assetPath: "assets/aircraft/imported/turbofan-structure-test/model.glb",
      previewPath: "assets/aircraft/imported/turbofan-structure-test/preview.png",
      structureAnalysis: {
        status: "success",
        nodeCount: 10,
        meshCount: 8,
        materialCount: 2,
        bounds: { center: [0, 0, 0], size: [3, 3, 0.8] },
        dominantAxis: "+X",
        meshStats: [{ name: "blade-01", vertexCount: 24, triangleCount: 12, center: [1, 0, 0], size: [0.2, 0.8, 0.05], radiusEstimate: 0.4 }],
        radialPatterns: [{ type: "radialArray", count: 8, axis: "+Z", confidence: 0.82, radiusRange: [0.5, 1.4] }],
      },
      templateParams: {
        template: "turbofan",
        confidence: 0.82,
        turbofan: { bladeCount: 8, hubRadius: 0.36, outerRingInnerRadius: 1.2, outerRingOuterRadius: 1.4 },
      },
      constraintHints: [{ type: "coaxial", priority: "critical", confidence: 0.82, reason: "轴对称结构" }],
    });

    expect(asset.structureAnalysis.radialPatterns[0]?.count).toBe(8);
    expect(asset.templateParams.turbofan.bladeCount).toBe(8);
    expect(asset.constraintHints[0]?.type).toBe("coaxial");
  });

  it("glbAnalyzer 能读取简单 GLB 并检测径向重复结构", async () => {
    const root = resolve(projectRoot, "outputs", "glb-analyzer-test");
    const path = resolve(root, "radial.glb");
    try {
      mkdirSync(root, { recursive: true });
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial("dark-metal");
      const positions = doc.createAccessor("blade-positions", buffer)
        .setType(Accessor.Type.VEC3)
        .setArray(new Float32Array([
          -0.05, -0.2, -0.02,
          0.05, -0.2, 0.02,
          0, 0.2, 0,
        ]));
      const mesh = doc.createMesh("blade").addPrimitive(doc.createPrimitive().setAttribute("POSITION", positions).setMaterial(material));
      const scene = doc.createScene("radial-scene");
      for (let index = 0; index < 8; index += 1) {
        const angle = (index / 8) * Math.PI * 2;
        scene.addChild(doc.createNode(`Blade_${index + 1}`).setMesh(mesh).setTranslation([Math.cos(angle), Math.sin(angle), 0]));
      }
      await new NodeIO().write(path, doc);

      const result = await analyzeGlbStructure(path);

      expect(result.structureAnalysis.status).toBe("success");
      expect(result.structureAnalysis.meshStats.length).toBe(8);
      expect(result.structureAnalysis.radialPatterns[0]?.count).toBe(8);
      expect(result.templateParams.template).toBe("turbofan");
      expect(result.constraintHints.some((hint) => hint.type === "radialArray")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("glbAnalyzer 读取损坏 GLB 时返回 error，不抛出", async () => {
    const root = resolve(projectRoot, "outputs", "glb-analyzer-bad-test");
    const path = resolve(root, "bad.glb");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(path, "not-a-glb", "utf8");

      const result = await analyzeGlbStructure(path);

      expect(result.structureAnalysis.status).toBe("error");
      expect(result.templateParams.template).toBeUndefined();
      expect(result.constraintHints).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GLB 检索结果能生成包含六视图特征和骨架建议的 coder reference pack", () => {
    const pack = buildCoderReferencePack({
      request: {
        sessionId: "reference-pack-glb",
        message: "根据图片画飞机发动机黑线白图",
        images: [{ name: "engine.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aaaa" }],
        files: defaultFiles,
        runtimeErrors: [],
        history: [],
      },
      retrievalResults: [
        {
          kind: "asset",
          id: "asset:test-engine",
          title: "测试涡扇 GLB",
          description: "相似发动机模型。",
          score: 0.91,
          tags: ["imported", "engine", "glb"],
          sourceKind: "asset",
          sourceId: "test-engine",
          sourcePath: "assets/aircraft/imported/test-engine/model.glb",
          imagePath: "assets/aircraft/imported/test-engine/preview.png",
          metadata: {
            category: "engine",
            shapeSummary: "正面大圆环、内涵道、风扇叶片、中心整流锥。",
            viewFeatures: ["正面: 外环和叶片清晰", "侧面: 短圆筒机匣"],
            skeletonHints: ["用 TorusGeometry 做外环", "用多片 BoxGeometry/Shape 做叶片"],
            structureAnalysis: {
              status: "success",
              nodeCount: 12,
              meshCount: 8,
              materialCount: 2,
              bounds: { center: [0, 0, 0], size: [3, 3, 0.8] },
              dominantAxis: "+Z",
              meshStats: [],
              radialPatterns: [{ type: "radialArray", count: 32, axis: "+Z", confidence: 0.86 }],
            },
            templateParams: {
              template: "turbofan",
              confidence: 0.86,
              turbofan: { bladeCount: 32, hubRadius: 0.42, outerRingInnerRadius: 1.52, outerRingOuterRadius: 1.75 },
            },
            constraintHints: [{ type: "coaxial", priority: "critical", confidence: 0.86, reason: "径向阵列应同轴" }],
          },
        },
      ],
      visualIntent: {
        subject: "turbofan engine",
        category: "engine",
        view: "front",
        renderStyle: "technical_lines",
        retrievalQuery: "turbofan front fan blade line drawing",
        visualFeatures: ["圆形进气口", "放射状叶片"],
        geometryHints: ["外环", "中心锥"],
        materialHints: ["白底黑线"],
        codeHints: ["TorusGeometry", "LineSegments"],
        confidence: 0.88,
        modelUsed: "MiniMax-M3",
        fallbackReason: "",
      },
    });

    expect(pack.modelAssetCount).toBe(1);
    expect(pack.markdown).toContain("Visual Intent");
    expect(pack.markdown).toContain("圆形进气口");
    expect(pack.markdown).toContain("六视图特征");
    expect(pack.markdown).toContain("TorusGeometry");
    expect(pack.markdown).toContain("GLTFLoader");
    expect(pack.markdown).toContain("可加载基底资产");
    expect(pack.markdown).toContain("GLB 结构分析");
    expect(pack.markdown).toContain("radialPatterns=32个");
    expect(pack.markdown).toContain("模板参数建议");
    expect(pack.markdown).toContain("约束提示");
  });

  it("three.js 源码检索结果能生成源码摘要和关键片段，不塞完整超长源码", () => {
    const longSnippet = `function buildEngineReference(root){\n${"root.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.TorusGeometry(1, .1)), material));\n".repeat(80)}}`;
    const pack = buildCoderReferencePack({
      request: {
        sessionId: "reference-pack-source",
        message: "画发动机结构线稿",
        images: [],
        files: defaultFiles,
        runtimeErrors: [],
        history: [],
      },
      retrievalResults: [
        {
          kind: "asset",
          id: "asset:engine-source",
          title: "发动机源码参考",
          description: "three.js 程序化发动机参考。",
          score: 0.88,
          tags: ["imported", "threejs-source", "engine"],
          sourceKind: "asset",
          sourceId: "engine-source",
          sourcePath: "assets/aircraft/imported/engine-source/source.tsx",
          metadata: {
            category: "engine",
            codeSummary: "使用 TorusGeometry、EdgesGeometry 和 LineSegments 构建发动机工程线稿。",
            detectedPatterns: ["TorusGeometry", "EdgesGeometry", "LineSegments"],
            keySnippets: [longSnippet],
          },
        },
      ],
    });

    expect(pack.sourceAssetCount).toBe(1);
    expect(pack.markdown).toContain("源码摘要");
    expect(pack.markdown).toContain("关键源码片段");
    expect(pack.markdown.length).toBeLessThanOrEqual(14050);
    expect(pack.markdown).toContain("truncated");
  });

  it("coder_agent prompt 包含 reference pack、当前文件和上传图片输入", async () => {
    const request = {
      sessionId: "coder-prompt-pack",
      message: "根据参考图画飞机发动机黑线白图",
      images: [{ name: "engine.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aaaa" }],
      files: defaultFiles,
      runtimeErrors: [],
      history: [],
    };
    const runtime = await createRuntimePatchWithRag(request);
    const visualIntent = {
      subject: "turbofan engine",
      category: "engine" as const,
      view: "front" as const,
      renderStyle: "technical_lines" as const,
      retrievalQuery: "turbofan engine front black line",
      visualFeatures: ["外环", "叶片"],
      geometryHints: ["TorusGeometry 外环"],
      materialHints: ["白底黑线"],
      codeHints: ["EdgesGeometry"],
      confidence: 0.91,
      modelUsed: "MiniMax-M3",
      fallbackReason: "",
    };
    const pack = buildCoderReferencePack({
      request,
      retrievalResults: [
        {
          kind: "asset",
          id: "asset:test-engine",
          title: "测试发动机参考",
          description: "正面涡扇参考。",
          score: 0.9,
          tags: ["engine", "glb"],
          sourceKind: "asset",
          sourceId: "test-engine",
          sourcePath: "assets/aircraft/imported/test-engine/model.glb",
          metadata: {
            category: "engine",
            shapeSummary: "正面外环、风扇叶片、中心锥。",
            skeletonHints: ["用 TorusGeometry 和放射状叶片表达。"],
          },
        },
      ],
      fallbackScene: runtime.scene,
      fallbackPatch: runtime.patch,
      visualIntent,
    });
    const state = {
      request,
      normalizedGoal: "根据参考图画飞机发动机黑线白图",
      visualIntent,
      compactSummary: {},
      recentHistory: [],
      skillContext: "three.js 工程线稿 skill",
      plan: "生成 Sandpack 代码 patch",
    };
    const prompt = buildCoderPromptText(state, runtime, pack);
    const messages = buildCoderMessages(state, runtime, pack);

    expect(prompt).toContain("Coder Reference Pack");
    expect(prompt).toContain("Visual Intent");
    expect(prompt).toContain("外环");
    expect(prompt).toContain("src/App.tsx");
    expect(prompt).toContain("TorusGeometry");
    expect(JSON.stringify(messages)).toContain("image_url");
  });

  it("coder patch 生成器会按显式 GLM 候选顺序重试", async () => {
    const validApp = `import * as THREE from "three";
export default function App() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  renderer.render(scene, camera);
  return <div />;
}`;
    let calls = 0;
    const result = await generateCoderPatchFromConfigs({
      configs: [
        { model: "GLM-5V-Turbo", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "GITEE_API_KEY", temperature: 0.2, maxTokens: 8192 },
        { model: "GLM-5V-Turbo-Backup", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "GITEE_API_KEY", temperature: 0.2, maxTokens: 8192 },
      ],
      messages: [{ role: "user", content: "test" }],
      runner: async (config) => {
        calls += 1;
        if (config.model === "GLM-5V-Turbo") return { text: "not-json", reasoning: "" };
        return {
          text: JSON.stringify({
            summary: "fallback coder patch",
            operations: [
              { path: "src/App.tsx", content: validApp },
              { path: "src/styles.css", content: "html,body,#root{width:100%;height:100%;margin:0}canvas{display:block}" },
            ],
          }),
          reasoning: "",
        };
      },
    });

    expect(calls).toBe(2);
    expect(result?.modelUsed).toBe("GLM-5V-Turbo-Backup");
    expect(result?.fallbackReason).toContain("GLM-5V-Turbo");
    expect(result?.patch.operations[0]?.content).toContain("preserveDrawingBuffer");
  });

  it("连续 3 个有效候选分下降会触发双 coder 会诊", () => {
    expect(hasThreeConsecutiveCandidateScoreDrops([
      { round: 1, candidateScore: 0.72, selectedBest: true },
      { round: 2, candidateScore: 0.68, selectedBest: false },
      { round: 3, candidateScore: 0.61, selectedBest: false },
      { round: 4, candidateScore: 0.55, selectedBest: false },
    ])).toBe(true);
    expect(hasThreeConsecutiveCandidateScoreDrops([
      { round: 1, candidateScore: 0.72, selectedBest: true },
      { round: 2, candidateScore: 0.68, selectedBest: false },
      { round: 3, candidateScore: 0.7, selectedBest: true },
      { round: 4, candidateScore: 0.69, selectedBest: false },
    ])).toBe(false);
  });

  it("coder revise 可以返回函数级 replace_function 补丁", async () => {
    const result = await generateCoderPatchFromConfigs({
      configs: [
        { model: "GLM-5V-Turbo", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "GITEE_API_KEY", temperature: 0.2, maxTokens: 8192 },
      ],
      messages: [{ role: "user", content: "test" }],
      runner: async () => ({
        reasoning: "",
        text: JSON.stringify({
          summary: "只修改叶片函数",
          operations: [
            {
              type: "replace_function",
              path: "src/App.tsx",
              functionName: "buildFanBlades",
              content: `function buildFanBlades() {
  return new THREE.BoxGeometry(0.18, 0.82, 0.08);
}`,
            },
          ],
        }),
      }),
    });

    expect(result?.patch.operations[0]?.type).toBe("replace_function");
    expect(result?.patch.operations[0]).toMatchObject({ functionName: "buildFanBlades" });
  });

  it("coder revise 默认可以返回 parameter_patch 参数级补丁", async () => {
    const result = await generateCoderPatchFromConfigs({
      configs: [
        { model: "GLM-5V-Turbo", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "ZHIPU_API_KEY", temperature: 0.2, maxTokens: 8192 },
      ],
      messages: [{ role: "user", content: "test" }],
      runner: async () => ({
        reasoning: "",
        text: JSON.stringify({
          summary: "按特征点微调叶片",
          operations: [
            {
              type: "parameter_patch",
              path: "src/App.tsx",
              targetFunction: "buildFanBlades",
              parameters: {
                bladeThickness: 0.08,
                bladeTwist: 1.1,
                metalness: 0.95,
              },
              reason: "叶片厚度和金属高光不足",
            },
          ],
        }),
      }),
    });

    expect(result?.patch.operations[0]?.type).toBe("parameter_patch");
    expect(result?.patch.operations[0]).toMatchObject({
      targetFunction: "buildFanBlades",
      parameters: { bladeThickness: 0.08, bladeTwist: 1.1, metalness: 0.95 },
    });
  });

  it("coder 直接输出 App.tsx 源码时会自动包装为 patch", async () => {
    const result = await generateCoderPatchFromConfigs({
      configs: [
        { model: "GLM-5V-Turbo", baseURL: "https://ai.gitee.com/v1", apiKeyEnvName: "GITEE_API_KEY", temperature: 0.2, maxTokens: 8192 },
      ],
      messages: [{ role: "user", content: "test" }],
      runner: async () => ({
        reasoning: "",
        text: `\`\`\`tsx
import * as THREE from "three";
export default function App() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  renderer.render(scene, camera);
  return <div />;
}
\`\`\`
\`\`\`css
html,body,#root{width:100%;height:100%;margin:0}
canvas{display:block}
\`\`\``,
      }),
    });

    expect(result?.patch.summary).toContain("源码而非 JSON");
    expect(result?.patch.generator).toBe("llm_coder");
    expect(result?.patch.operations.map((operation) => operation.path)).toEqual(["src/App.tsx", "src/styles.css"]);
  });

  it("RAG source resolver 只返回源码指针或本地资产，不从向量库取源码正文", () => {
    const source = resolveRagSource({ kind: "template", id: "template:engine_showcase" });

    expect(source.sourcePath).toBe("apps/api/src/sceneRuntime.ts");
    expect(JSON.stringify(source.source)).toContain("向量库只存模板指针");
  });

  it("能读取本地飞机资产库并检索发动机资产", () => {
    const assets = listAircraftAssets();
    const search = searchAircraftKnowledge({ query: "发动机 正面 黑线白图", topK: 5 });

    expect(assets.some((asset) => asset.id === "turbofan-front-v1")).toBe(true);
    expect(search.results.some((result) => result.id === "turbofan-front-v1")).toBe(true);
  });

  it("Scene DSL 可以渲染为合法 Sandpack 文件", () => {
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "technical_lines",
      objects: [{ id: "engine", primitive: "turbofan_front" }],
    });
    const rendered = renderSceneToFiles({ scene });

    expect(rendered.files["src/App.tsx"]).toContain("import * as THREE");
    expect(rendered.files["src/App.tsx"]).toContain("buildTurbofanFront");
    expect(rendered.files["src/styles.css"]).toContain("background: #ffffff");
  });

  it("Scene DSL 命中 GLB 时会生成 GLTFLoader 资产基底和程序化微调层", () => {
    const scene = sceneDslSchema.parse({
      sceneType: "engine_showcase",
      cameraPreset: "front",
      lightingPreset: "engineering_white",
      renderStyle: "realistic",
      objects: [
        {
          id: "engine",
          primitive: "turbofan_front",
          sourceAsset: {
            assetId: "asset-test",
            sourcePath: "assets/aircraft/imported/asset-test/model.glb",
          },
        },
      ],
    });
    const rendered = renderSceneToFiles({ scene });
    const app = rendered.files["src/App.tsx"] ?? "";

    expect(app).toContain("GLTFLoader");
    expect(app).toContain("/api/assets/file?path=");
    expect(app).toContain("rag-glb-asset-wrapper");
    expect(app).toContain("procedural-adjustment-layer");
    expect(rendered.summary).toContain("加载 RAG 命中 GLB 基底");
  });

  it("Scene DSL 命中 GLB templateParams 时会用结构参数填充 TurbofanTemplate", () => {
    const intent = parseSemanticIntent({
      sessionId: "template-param-runtime",
      message: "画涡扇发动机扇叶",
      images: [],
      files: defaultFiles,
      runtimeErrors: [],
      history: [],
    });
    const scene = composeScene({
      intent,
      retrievalResults: [
        {
          kind: "asset",
          id: "asset:template-param-engine",
          title: "结构参数发动机",
          description: "带 template params 的测试 GLB",
          score: 0.9,
          tags: ["engine", "glb"],
          sourceKind: "asset",
          sourceId: "template-param-engine",
          sourcePath: "assets/aircraft/imported/template-param-engine/model.glb",
          metadata: {
            category: "engine",
            templateParams: {
              template: "turbofan",
              confidence: 0.88,
              turbofan: { bladeCount: 18, hubRadius: 0.5, outerRingInnerRadius: 1.6, outerRingOuterRadius: 1.9, bladeThickness: 0.09, bladeTwist: 1.15 },
            },
          },
        },
      ],
    });
    const generator = scene.assemblyGraph?.generators.find((item) => item.type === "radialArray");

    expect(generator?.count).toBe(18);
    expect(generator?.params.thickness).toBeCloseTo(0.09);
    expect(scene.assemblyGraph?.ports.find((port) => port.id === "hub.outerRadius")?.radius).toBeCloseTo(0.5);
    expect(scene.assemblyGraph?.ports.find((port) => port.id === "outerRing.innerRadius")?.radius).toBeCloseTo(1.6);
  });

  it("Runtime Composer 能从用户请求生成安全 patch", () => {
    const request = {
      sessionId: "test-runtime",
      message: "画出发动机正面3d图，黑线白图",
      images: [],
      files: defaultFiles,
      runtimeErrors: [],
      history: [],
    };
    const intent = parseSemanticIntent(request);
    const scene = composeScene({ intent, retrievalResults: searchAircraftKnowledge({ query: request.message }).results });
    const runtime = createRuntimePatch(request);

    expect(intent.category).toBe("engine");
    expect(scene.objects[0]?.primitive).toBe("turbofan_front");
    expect(scene.assemblyGraph?.templateId).toBe("turbofan_v1");
    expect(scene.solverResult?.ok).toBe(true);
    expect(runtime.patch.generator).toBe("runtime_composer");
    expect(runtime.patch.operations.map((operation) => operation.path)).toEqual(["src/App.tsx", "src/styles.css"]);
    expect(() => sanitizePatch(runtime.patch)).not.toThrow();
  });

  it("Runtime Composer 主链路可以通过 RAG 检索生成安全 patch", async () => {
    const request = {
      sessionId: "test-runtime-rag",
      message: "画出发动机正面3d图，黑线白图，参考六视图",
      images: [],
      files: defaultFiles,
      runtimeErrors: [],
      history: [],
    };
    const runtime = await createRuntimePatchWithRag(request);

    expect(["milvus", "fallback"]).toContain(runtime.retrievalMode);
    expect(runtime.retrievalResults.length).toBeGreaterThan(0);
    expect(runtime.scene.objects[0]?.primitive).toBe("turbofan_front");
    expect(runtime.scene.assemblyGraph?.constraints.some((constraint) => constraint.type === "coaxial")).toBe(true);
    expect(runtime.scene.solverResult?.residuals["coaxial.core.coaxialError"]).toBeLessThanOrEqual(0.001);
    expect(() => sanitizePatch(runtime.patch)).not.toThrow();
  });

  it("Runtime Composer 能用通用场景处理非飞机装饰类动图请求", async () => {
    const request = {
      sessionId: "test-runtime-heart",
      message: "给我画一个三维粉色爱心动图",
      images: [],
      files: defaultFiles,
      runtimeErrors: [],
      history: [],
    };
    const runtime = await createRuntimePatchWithRag(request);

    expect(runtime.retrievalResults).toHaveLength(0);
    expect(runtime.scene.objects[0]?.primitive).toBe("decorative_shape");
    expect(runtime.scene.objects[0]?.params.shape).toBe("heart");
    expect(runtime.scene.objects[0]?.params.color).toBe("#ff5ca8");
    expect(runtime.scene.animations).toContain("gentle_loop");
    expect(runtime.scene.renderStyle).toBe("realistic");
    expect(runtime.patch.summary).toContain("general decorative 3D scene");
    expect(runtime.patch.operations[0]?.content).toContain("buildDecorativeShape");
    expect(() => sanitizePatch(runtime.patch)).not.toThrow();
  });

  it("Scene revise 只修改 DSL，不直接生成 three.js", async () => {
    const scene = sceneDslSchema.parse({
      sceneType: "component_detail",
      cameraPreset: "three_quarter",
      lightingPreset: "studio_soft",
      renderStyle: "realistic",
      objects: [{ id: "part", primitive: "generic_part" }],
    });
    const revised = await reviseScene({
      scene,
      userGoal: "画发动机正面3d图，黑线白图",
      round: 1,
      quality: {
        status: "revise",
        score: 0.45,
        issues: ["不像发动机", "不是正面"],
        revisionHints: ["增加叶片", "调整到正面", "改成白底黑线"],
      },
    });

    expect(revised.scene.sceneType).toBe("engine_showcase");
    expect(revised.scene.cameraPreset).toBe("front");
    expect(revised.scene.renderStyle).toBe("technical_lines");
    expect(revised.scene.objects[0]?.primitive).toBe("turbofan_front");
    expect(revised.patch.operations.length).toBeGreaterThan(0);
  });
});
