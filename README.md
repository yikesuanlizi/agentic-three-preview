# Agentic Three Preview

一个轻量的 AI 对话式 three.js 编程与实时预览项目。用户可以用中文描述想要的 3D 场景，也可以上传参考图片；Agent 会生成受控代码补丁，并在浏览器 Sandpack 沙箱中实时预览。

## 快速启动

```bash
npm install
npm run dev
```

- Web: http://127.0.0.1:5173
- API: http://127.0.0.1:8787

未配置 API Key 时，系统会使用本地 fallback Agent，方便直接查看代码编辑和预览流程。需要接入 Gitee AI 时，复制 `apps/api/.env.example` 为 `apps/api/.env`，并设置 `GITEE_AI_API_KEY`。

## 模型分工

当前不额外拆复杂多 Agent。图片和文本会先经过一个轻量“需求适配”步骤，转成给原有 coder agent 使用的中文专业编码需求；真正负责生成 three.js 补丁的仍然是原有编码层次。

- `VISION_MODEL`：负责理解图片、多图角度和用户文本，并整理成编码需求，默认 `Qwen3.5-122B-A10B`。
- `CODER_MODEL`：负责根据整理后的需求、当前文件和运行错误生成受控补丁，默认 `qwen3-coder-480b-a35b-instruct`。
- 支持只上传图片不写文本；此时系统会把图片当作视觉参考自动转成场景需求。

## 安全模型

- 生成代码只在 Sandpack 浏览器 iframe 中运行。
- 后端不执行 Agent 生成的用户代码。
- Agent 只能修改 `src/App.tsx`、`src/main.tsx`、`src/styles.css` 和 `package.json`。
- 如果补丁包含 `eval`、`new Function`、`fetch`、Worker、Service Worker 或脚本注入等危险能力，会被服务端拒绝。

## 目录说明

- `apps/web`：React + TypeScript 前端，包含聊天、图片输入、代码编辑和 Sandpack 预览。
- `apps/api`：Node + TypeScript 后端，使用 LangGraph JS 编排轻量编程 Agent。
- `packages/shared`：共享 schema、默认 Sandpack 文件、补丁校验和安全策略。
- `skills`：中文 three.js 技能说明，供 Agent 构建上下文。
- `references`：记录本地参考源码路径，例如 three.js、LangGraph JS、LangChain JS、Codex。
