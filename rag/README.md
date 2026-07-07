# RAG 数据层

本项目的 RAG 不存 three.js 源码正文，也不把 GLB 文件本体写进向量库。

向量库只保存：

- 飞机资产元数据。
- 六方向/多方向截图的中文标题、描述、标签、图片 embedding 和项目内相对路径。
- renderer/template 的说明和项目内相对路径指针。
- Wiki 规则和渲染约束。

检索流程：

```text
用户文本/图片语义
-> Milvus 向量召回资产/视图/template/wiki
-> 本地关键词混合打分
-> Gitee Qwen3-VL-Reranker-8B 重排
-> 返回 sourceKind/sourceId/sourcePath
-> 本地 resolver 读取对应 GLB、renderer 模板或 wiki
-> Runtime Composer 生成 Scene DSL
-> renderer 输出 Sandpack 文件
```

## Milvus

默认地址：

```text
127.0.0.1:19530
```

启动：

```bash
docker compose up -d milvus
```

环境变量：

- `RAG_MILVUS_ADDRESS`: 覆盖默认 Milvus 地址。
- `RAG_MILVUS_COLLECTION`: 覆盖默认 collection，默认 `agentic_three_rag`。
- `RAG_MILVUS_TOKEN` / `RAG_MILVUS_USERNAME` / `RAG_MILVUS_PASSWORD`: 连接鉴权。
- `RAG_EMBEDDING_MODEL`: 默认 `Qwen3-VL-Embedding-8B`。
- `RAG_EMBEDDING_BASE_URL`: 默认 `https://ai.gitee.com/v1`。
- `RAG_RERANK_MODEL`: 默认 `Qwen3-VL-Reranker-8B`。
- `RAG_RERANK_URL`: 默认 `https://ai.gitee.com/v1/rerank/multimodal`。
- `GITEE_API_KEY`: embedding 和 rerank 密钥。

没有 `GITEE_API_KEY` 时，系统会使用本地 hash embedding 保证流程可跑通；正式检索质量应使用 Gitee 多模态 embedding 和 rerank。

## GLB 资产目录

GLB、预览图和六视图截图必须放在项目根目录内，推荐结构：

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

`metadata.json` 里的 `assetPath`、`previewPath`、`viewImages[].imagePath` 必须使用项目内相对路径，例如：

```json
{
  "assetPath": "assets/aircraft/engines/my-engine-v1/model.glb",
  "previewPath": "assets/aircraft/engines/my-engine-v1/preview.webp",
  "viewImages": [
    {
      "view": "front",
      "imagePath": "assets/aircraft/engines/my-engine-v1/views/front.webp",
      "title": "发动机正面视图",
      "description": "可见进气环、中心轮毂和叶片分布。",
      "tags": ["发动机", "正面", "六视图"]
    }
  ]
}
```

不要写绝对路径，也不要写 `..`。schema 会拒绝逃逸项目目录的路径。
