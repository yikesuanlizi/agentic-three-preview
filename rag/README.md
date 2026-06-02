# RAG 数据层

本项目的 RAG 不存 three.js 源码正文。

向量数据库只保存：

- 飞机资产元数据。
- 六方向/多方向截图的中文标题、描述、标签和图片路径。
- renderer/template 的说明和源码指针。
- Wiki 规则和渲染约束。

检索流程：

```text
用户文本/图片语义
-> metadata + view image 混合检索
-> 返回 sourceKind/sourceId/sourcePath
-> 本地 resolver 读取对应 GLB、renderer 模板或源码引用
-> Runtime Composer 生成 Scene DSL
-> renderer 输出 Sandpack 文件
```

默认数据库：

```text
postgres://agentic_three:agentic_three_dev@127.0.0.1:54329/agentic_three
```

环境变量：

- `RAG_DATABASE_URL`: 覆盖默认 PostgreSQL 连接。
- `RAG_EMBEDDING_MODEL`: 配置后使用 Gitee/OpenAI-compatible embedding。
- `RAG_EMBEDDING_BASE_URL`: 默认 `https://ai.gitee.com/v1`。
- `GITEE_API_KEY`: embedding provider 密钥。

如果没有配置 embedding 模型，系统会使用本地 hash embedding 保证 pgvector 流程可跑通；正式语义检索应配置真实 embedding 模型。
