import { describe, expect, it } from "vitest";
import {
  applyPatch,
  defaultFiles,
  aircraftAssetMetadataSchema,
  appSettingsSchema,
  qualityInspectionRequestSchema,
  qualityInspectionResultSchema,
  runtimeComposerConfigSchema,
  sanitizePatch,
  sceneDslSchema,
  streamEventSchema,
  workflowFinalizeRequestSchema,
  type PatchEvent,
} from "../packages/shared/src/index";
import { mergeCompactSummary, parseModelFileBlocks } from "../apps/api/src/agent";
import { listAircraftAssets } from "../apps/api/src/aircraftAssets";
import { searchAircraftKnowledge } from "../apps/api/src/aircraftRetrieval";
import { composeScene, createRuntimePatch, createRuntimePatchWithRag, parseSemanticIntent, renderSceneToFiles } from "../apps/api/src/sceneRuntime";
import { reviseScene, superviseQuality } from "../apps/api/src/quality";
import { resolveRagSource } from "../apps/api/src/rag";
import { selectSkillContext, selectSkillContextDynamic } from "../apps/api/src/skills";
import { defaultSettings, resolveModelConfig } from "../apps/api/src/settings";

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

  it("模型配置默认使用 Gitee API Key 环境变量", () => {
    const coder = resolveModelConfig("coder_agent", defaultSettings);
    const summary = resolveModelConfig("summary", defaultSettings);

    expect(coder.model).toBe("Qwen3.5-122B-A10B");
    expect(summary.model).toBe("DeepSeek-V4-Flash");
    expect(coder.apiKeyEnvName).toBe("GITEE_API_KEY");
  });

  it("能解析文件块协议中的源码内容", () => {
    const parsed = parseModelFileBlocks(`SUMMARY:
更新场景

ASSISTANT:
已生成线稿

FILE: src/App.tsx
\`\`\`tsx
import * as THREE from "three";

export default function App() {
  const label = \`line "one"\\path\`;
  return <div>{label}</div>;
}
\`\`\`

FILE: src/styles.css
\`\`\`css
body { background: white; }
\`\`\``);

    expect(parsed.summary).toBe("更新场景");
    expect(parsed.operations).toHaveLength(2);
    expect(parsed.operations[0]?.content).toContain("line \"one\"\\path");
  });

  it("文件块协议拒绝非白名单路径", () => {
    expect(() =>
      parseModelFileBlocks(`SUMMARY:
坏路径

FILE: ../server.ts
\`\`\`ts
export const x = 1;
\`\`\``),
    ).toThrow(/非白名单/);
  });

  it("兼容模型误输出的 CODE_EDIT_BLOCK 文件块", () => {
    const parsed = parseModelFileBlocks(`SUMMARY:
线稿

ASSISTANT:
已生成

FILE: src/App.tsx
\`\`\`tsx|CODE_EDIT_BLOCK|/src/App.tsx|import * as THREE from "three";\\nexport default function App() {\\n  return <div />;\\n}
\`\`\``);

    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]?.content).toContain("import * as THREE");
    expect(parsed.operations[0]?.content).toContain("return <div />");
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
    expect((context.match(/^## /gm) || []).length).toBeLessThanOrEqual(4);
  });

  it("动态 skill 选择失败时会回退到轻量规则选择", async () => {
    const settings = {
      ...defaultSettings,
      enabledSkillIds: [
        "three-scene",
        "camera-light",
        "material-animation",
        "performance-safety",
        "webgpu",
        "threejs-geometry",
      ],
      models: defaultSettings.models.map((model) =>
        model.node === "coder_agent" ? { ...model, apiKeyEnvName: "MISSING_TEST_GITEE_KEY" } : model,
      ),
    };
    const result = await selectSkillContextDynamic({
      message: "根据参考图生成黑线白底的机械线稿",
      enabledSkillIds: settings.enabledSkillIds,
      settings,
    });

    expect(result.source).toBe("heuristic");
    expect(result.context.length).toBeLessThanOrEqual(8000);
    expect(result.selectedSkillIds.length).toBeGreaterThan(0);
    expect(result.selectedSkillIds.length).toBeLessThanOrEqual(4);
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

    expect(["pgvector", "fallback"]).toContain(runtime.retrievalMode);
    expect(runtime.retrievalResults.length).toBeGreaterThan(0);
    expect(runtime.scene.objects[0]?.primitive).toBe("turbofan_front");
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
  });
});
