# Agentic Three Preview

一个实验性的 AI 对话式 three.js 编程与实时预览项目。用户可以用中文描述想要的 3D 场景，也可以上传参考图片；后端会结合技能文档、RAG 知识库、GLB 结构分析和运行时场景 DSL，生成受控的 Sandpack three.js 补丁并在浏览器里预览。

## 当前状态声明

这个项目目前只是半成品预览，不是成熟的自动 3D 建模系统，也不能保证输出结果具备工程可制造性、真实物理正确性或稳定的成品级视觉质量。

当前路线更接近“检索和结构化参考辅助的 three.js 代码生成”：

- 用知识库、GLB metadata、六视图截图、wiki 规则和 three.js 技能文档给模型补上下文。
- 用 Runtime Composer 先生成 Scene DSL 和可运行 Sandpack 骨架。
- 对发动机等少数目标尝试用 AssemblyGraph/Solver 固化同轴、半径、接触、间隙等基础约束。
- 再让 coder model 根据参考包生成或修正 three.js 代码。
- 通过截图、视觉模型、embedding 相似度和启发式规则做多轮质量检查。

也就是说，它不是“模型凭空理解复杂机械结构并自动建好成品”，而是把有限的检索资料、规则约束和模板化运行时拼在一起，尽量让生成结果更接近目标。

## 已知缺点和硬伤

- **模型 3D 编码能力不足是核心硬伤。** 当前依赖的多模态/代码模型对 three.js 复杂几何、局部拓扑、部件比例和参数化建模的稳定掌控还不够，容易生成看似合理但结构不对、比例漂移或细节缺失的代码。
- **物理约束理解不足。** 代码里已经有装配约束、半径约束、同轴约束和质检流程，但这些只能覆盖少量显式规则，不能替代真实 CAD/CAE/物理仿真，也不能保证气动、受力、材料、碰撞、装配公差等工程约束正确。
- **知识库资源不足。** 当前主要依赖 GLB metadata、截图、wiki 文本和少量模板规则。缺少大量高质量成品建模资源、可复用参数化零件、真实设计规范和标注完整的多视图数据，这是检索质量和生成质量的上限瓶颈。
- **GLB 只是参考和基底，不是代码能力本身。** 系统可以分析 GLB 的 bounds、mesh、radial pattern，并把它作为加载基底或参考结构，但这不等于模型真正学会了完整建模流程。
- **结果需要人工判断和修正。** 视觉质检、embedding 相似度和本地启发式只能发现一部分问题，不能代替设计师或工程师审查。
- **泛化范围有限。** 对飞机发动机、机翼、机身、起落架等方向有一些定制逻辑；换到没有知识库和模板覆盖的对象时，通常会退化成普通 three.js 场景生成。
- **资源文件不随代码仓库发布。** `.glb` 文件体积大且属于本地资产，已通过 `.gitignore` 排除。公开仓库只保存代码、文档、metadata 和轻量预览信息；需要本地准备或重新导入 GLB 才能完整复现资产检索效果。

## 当前能力

- 中文对话生成或修改 three.js 场景。
- 支持上传参考图片，提取视觉意图并参与检索和质检。
- 使用 Sandpack 在浏览器 iframe 中预览生成代码。
- 支持 Runtime Composer：把语义意图、RAG 结果和 Scene DSL 渲染成可运行文件。
- 支持 GLB/GLTF/源码资源导入，生成 metadata、预览图、六方向截图和 RAG 索引。
- 支持 Milvus 向量库；没有外部 embedding key 时可退回本地 hash embedding。
- 支持多轮截图质检、视觉模型检查、embedding 相似度、装配约束验证和候选轮次选择。
- 支持会话记忆、运行事件、截图/文件快照和最近输入图片记录。

## 快速启动

```bash
npm install
npm run dev
```

- Web: http://127.0.0.1:5173
- API: http://127.0.0.1:8787

未配置 API Key 时，系统会使用本地 fallback 流程，方便查看界面、补丁应用和基础预览；真实的多模态理解、代码生成、RAG embedding/rerank 和视觉质检质量依赖外部模型。

## 模型和环境变量

密钥通过系统环境变量提供，后端不会把前端提交的密钥写入项目 `.env`。

PowerShell 示例：

```powershell
setx ZHIPU_API_KEY "your-zhipu-api-key"
setx ARK_API_KEY "your-volc-ark-api-key"
setx GITEE_API_KEY "your-gitee-api-key"
```

- `ZHIPU_API_KEY`：默认 coder agent 使用的 GLM-5V-Turbo。
- `ARK_API_KEY`：默认视觉质检、规划、摘要等模型配置。
- `GITEE_API_KEY`：RAG embedding、rerank 和 visual embedding。
- `RAG_MILVUS_ADDRESS`：可选，默认 `127.0.0.1:19530`。

更多 RAG 配置见 `rag/README.md`。

## RAG 和资产

本项目的 RAG 不把 GLB 文件本体写进向量库。向量库保存的是资产 metadata、六视图描述、截图 embedding、模板/wiki 指针和项目内相对路径。

推荐本地资产结构：

```text
assets/aircraft/engines/my-engine-v1/
  model.glb
  preview.webp
  views/
    front.webp
    back.webp
    left.webp
    right.webp
    top.webp
    bottom.webp
  metadata.json
```

注意：仓库默认忽略 `*.glb`。如果从 GitHub 克隆本项目，需要自行准备 GLB 资源，或通过界面/接口重新导入本地资产目录。

## 安全模型

- 生成代码只在 Sandpack 浏览器 iframe 中运行。
- 后端不执行 Agent 生成的用户代码。
- Agent 只能修改 `src/App.tsx`、`src/main.tsx`、`src/styles.css` 和 `package.json`。
- 如果补丁包含 `eval`、`new Function`、`fetch`、Worker、Service Worker 或脚本注入等危险能力，会被服务端拒绝。
- 资产路径 schema 会拒绝绝对路径和 `..`，避免逃逸项目目录。

## 目录说明

- `apps/web`：React + TypeScript 前端，包含聊天、图片输入、设置面板、RAG 面板、代码编辑和 Sandpack 预览。
- `apps/api`：Node + TypeScript 后端，包含 Agent 编排、RAG、资产导入、GLB 分析、Scene DSL、质量检查、装配约束和会话记忆。
- `packages/shared`：共享 schema、默认 Sandpack 文件、补丁校验、安全策略、Scene DSL 和质量检查类型。
- `skills`：中文 three.js 和飞机参数化建模技能说明，供 Agent 构建上下文。
- `knowledge`：本地 wiki/领域知识文本。
- `rag`：RAG 数据层说明和 Milvus 配置。
- `assets`：本地飞机资源 metadata、预览图和可选 GLB 资产。`.glb` 不提交到公开仓库。
- `references`：记录本地参考源码路径，例如 three.js、LangGraph JS、LangChain JS、Codex。

## 适合的使用方式

- 当作 three.js Agent 工作台和 RAG/视觉质检实验项目。
- 用来验证“参考图/GLB/知识库 -> 结构化提示 -> Sandpack 代码”的流程。
- 用来快速做可视化原型、工程图风格草图、参数化建模思路验证。

不适合直接当作成品级 CAD、自动游戏资产生产线、真实飞机结构设计工具或物理仿真系统。
