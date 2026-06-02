# 相机与灯光技能

用于改善预览构图和空间感。

- 主体应位于世界坐标中心附近，避免相机看不到模型。
- 推荐组合：`DirectionalLight` 作为主光，`AmbientLight` 或 `HemisphereLight` 补光。
- 如果用户要求俯视、环绕、近景，优先调整相机位置和 FOV，而不是缩放整个 canvas。
- resize 时必须更新 `camera.aspect`、`camera.updateProjectionMatrix()` 和 `renderer.setSize()`。
