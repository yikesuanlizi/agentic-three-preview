# Aircraft Asset Library

这里存放飞机领域 3D Runtime Composer 的本地资产库。

每个资产目录建议包含：

- `model.glb`: 标准化后的 GLB 模型。
- `metadata.json`: 资产语义、分类、标签、尺度和兼容模板。
- `preview.webp`: 设置页和检索结果里使用的预览图。
- `views/*.webp`: 可选的多方向参考图，建议至少包含 `front / back / left / right / top / bottom`。

v1 可以先只有 `metadata.json`，renderer 会在 GLB 不存在时使用程序化 three.js 模板兜底。

## RAG 入库规则

源码不写入向量数据库。RAG 只保存资产元数据、六方向截图说明、模板说明和本地源码指针。

推荐每个方向图在 `metadata.json` 的 `viewImages` 中写清楚：

- `view`: `front`、`back`、`left`、`right`、`top`、`bottom`、`three_quarter` 或 `detail`。
- `imagePath`: 图片在项目内的路径。
- `title`: 中文标题，便于前端展示。
- `description`: 具体说明这个方向能帮助恢复哪些结构。
- `tags`: 检索标签，例如 `fan-blades`、`nacelle`、`technical-lines`。

检索命中后，系统根据 `sourceKind/sourceId/sourcePath` 回查本地 GLB、renderer 模板或源码文件。
