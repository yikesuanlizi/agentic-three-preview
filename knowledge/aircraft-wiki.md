# Aircraft Wiki

## 飞机部件

- engine: 发动机、涡扇、进气口、风扇叶片、中心整流锥。
- wing: 机翼、翼型、襟翼、翼尖、面板。
- fuselage: 机身筒段、舱窗、蒙皮、截面。
- landing_gear: 起落架、轮胎、支柱、舱门。
- cockpit: 驾驶舱、风挡、仪表区域。

## Scene DSL 规则

- 黑线白图使用 `renderStyle: technical_lines` 或 `engineering_white`。
- 正面图优先使用 `cameraPreset: front`。
- PPT 截图场景应隐藏网格，背景使用白色或近白色。
- 如果没有真实 GLB，使用程序化 primitive 兜底。

## 模板说明

- `engine_showcase`: 发动机展示，适合涡扇正面、三分之四视角。
- `front_technical_view`: 正面工程线稿，适合黑线白图。
- `exploded_view`: 分解视图。
- `component_detail`: 局部结构详情。
