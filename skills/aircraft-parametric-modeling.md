---
name: aircraft-parametric-modeling
description: 航空部件参数化建模规范。用于发动机叶轮、机翼、机身、起落架、驾驶舱等复杂航空 3D 部件，要求使用稳定函数、可调参数和可视觉闭环修正的 three.js 结构。
---

# Aircraft Parametric Modeling

复杂航空部件不要从零自由拼凑随机 mesh。必须先写参数化生成器，再由视觉 review 调参或替换局部函数。

## Required File Structure

`src/App.tsx` 必须拆成稳定函数，方便后续 `replace_function` 精确修正。

```ts
function createScene(container: HTMLElement) {}
function setupCamera(bounds?: THREE.Box3) {}
function setupLighting(scene: THREE.Scene) {}
function buildMaterials() {}
function buildFanBlades(params: FanBladeParams) {}
function buildSpinner(params: SpinnerParams) {}
function buildRearHub(params: RearHubParams) {}
function buildOuterRing(params: RingParams) {}
```

如果目标不是发动机，使用对应函数：

```ts
function buildWingPlanform(params: WingParams) {}
function buildAirfoilSection(params: AirfoilParams) {}
function buildWingRibs(params: RibParams) {}
function buildFuselageBody(params: FuselageParams) {}
function buildNoseCone(params: NoseParams) {}
function buildTailCone(params: TailParams) {}
function buildWheels(params: WheelParams) {}
function buildStruts(params: StrutParams) {}
function buildCanopy(params: CanopyParams) {}
```

## Turbofan / Turbine Fan Blade Rules

发动机叶轮不能只用三角片或平面扇形。必须体现：

- 前视图：中心圆锥 spinner、轮毂、内外环、放射状叶片。
- 侧视图：叶片有厚度、宽度和曲形截面，不是单薄黑片。
- 背视图：后部轮毂或凹陷圆环，不能和正面完全一样。
- 叶片：root 宽、tip 宽、pitch、twist、sweep、thickness 都必须是参数。
- 材质：写实时使用 `MeshStandardMaterial`，金属叶片 `metalness` 高、`roughness` 中低；线稿时叠加 `EdgesGeometry/LineSegments`。

稳定做法：

```ts
type FanBladeParams = {
  count: number;
  rootRadius: number;
  tipRadius: number;
  rootWidth: number;
  tipWidth: number;
  thickness: number;
  twist: number;
  sweep: number;
  pitch: number;
};
```

每片叶片优先用自定义 `BufferGeometry` 或 `Shape + ExtrudeGeometry`。不要用单个 `BoxGeometry` 旋转复制冒充曲面叶片。

可用自定义网格：

```ts
function makeBladeGeometry(params: FanBladeParams) {
  const vertices: number[] = [];
  const indices: number[] = [];
  // root/tip 两端各构造前缘、后缘、正反面点。
  // tip 相对 root 要有 twist/sweep/pitch 偏移。
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
```

## Three.js API Choices

- `TorusGeometry`: 外环、内环、轮胎、涵道圆环。
- `CylinderGeometry`: 轮毂、支柱、机身基础圆筒。
- `ConeGeometry`: 中心圆锥、机鼻、尾锥。
- `LatheGeometry`: 旋转体，例如机鼻、尾锥、轮毂截面。
- `ExtrudeGeometry`: 翼型截面、曲面叶片、面板厚度。
- `BufferGeometry`: 精确控制曲面叶片、翼型、复杂多边形。
- `EdgesGeometry + LineSegments`: 工程线稿、结构线、边缘强调。

## Visual Review Friendly Rules

- 关键部件必须命名：`mesh.name = "fan-blade-07"`、`group.name = "outer-ring"`。
- 主体必须居中，使用 `Box3` 自动计算相机距离。
- 必须设置 `window.__AGENTIC_THREE_VIEW__ = { scene, camera, renderer }`。
- 禁止自动旋转影响截图，除非用户明确要求动画。
- 第一轮代码宁可少而稳，也不要堆随机复杂 mesh。
