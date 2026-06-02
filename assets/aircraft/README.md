# Aircraft Asset Library

这里存放飞机领域 3D Runtime Composer 的本地资产库。

每个资产目录建议包含：

- `model.glb`: 标准化后的 GLB 模型。
- `metadata.json`: 资产语义、分类、标签、尺度和兼容模板。
- `preview.webp`: 设置页和检索结果里使用的预览图。

v1 可以先只有 `metadata.json`，renderer 会在 GLB 不存在时使用程序化 three.js 模板兜底。
