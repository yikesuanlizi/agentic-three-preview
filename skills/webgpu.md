# WebGPU 技能

第一版默认不启用 WebGPU 渲染，但可以参考其约束。

- 默认使用 `WebGLRenderer`，保证 Sandpack 浏览器预览兼容。
- 如果后续接入 WebGPU，需要做能力检测和降级路径。
- 不要在第一版生成外部 shader 文件或远程依赖。
- WebGPU/MCP 工具暂时作为可插拔方向，不作为当前运行依赖。
