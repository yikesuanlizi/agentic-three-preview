# three.js 场景技能

用于生成或修改基础 three.js React 场景。

- 使用 `useEffect` 初始化 `Scene`、`PerspectiveCamera`、`WebGLRenderer`。
- renderer 必须挂载到 `ref` 容器，并在 cleanup 中 `dispose()` 和移除 DOM。
- 相机需要设置合理 near/far，默认可以用 `camera.position.set(0, 1.2, 4)`。
- 场景必须有背景色、至少一个主光源和一个可见主体。
- 避免依赖外部图片、模型或网络资源；第一版只生成程序化几何体。
