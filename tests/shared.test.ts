import { describe, expect, it } from "vitest";
import {
  applyPatch,
  defaultFiles,
  sanitizePatch,
  streamEventSchema,
  type PatchEvent,
} from "../packages/shared/src/index";
import { mergeCompactSummary, parseModelFileBlocks } from "../apps/api/src/agent";
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
});
