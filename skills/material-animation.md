# 材质与动画技能

用于生成更有表现力的材质和动画。

- `MeshStandardMaterial` 适合金属、粗糙度、灯光响应明显的效果。
- 动画循环使用 `requestAnimationFrame`，并在 cleanup 中 `cancelAnimationFrame`。
- 多个几何体或材质要保存引用，cleanup 中逐个释放。
- 动画速度要稳定、克制，避免每帧创建新几何体、材质或纹理。
- 可以通过颜色、旋转、缩放、点云和网格辅助线表达视觉变化。
