import type { AircraftAssetCategory } from "@agentic-three/shared";

type TargetFunctionSpec = {
  name: string;
  purpose: string;
  patterns: RegExp[];
};

export type EngineModelingVariant = "open_blisk" | "ducted_turbofan" | "single_blade" | "generic_engine";

const commonTargets: TargetFunctionSpec[] = [
  {
    name: "createScene",
    purpose: "renderer/scene/canvas/bootstrap/render loop and screenshot hook",
    patterns: [/空白|渲染|canvas|renderer|初始化|场景|render|scene|截图|超时|timeout/i],
  },
  {
    name: "setupCamera",
    purpose: "camera position, target, framing, view angle and composition",
    patterns: [/相机|视角|构图|占比|裁切|camera|view|framing|composition|front|side|top|three.?quarter/i],
  },
  {
    name: "setupLighting",
    purpose: "lights, shadows, highlights, exposure and reflection readability",
    patterns: [/光|灯|阴影|高光|反射|曝光|过暗|lighting|light|shadow|highlight|reflection/i],
  },
  {
    name: "buildMaterials",
    purpose: "materials, metalness, roughness, linework style and colors",
    patterns: [/材质|金属|颜色|粗糙|metal|material|roughness|color|线稿|黑线|白图|technical/i],
  },
];

const categoryTargets: Partial<Record<AircraftAssetCategory, TargetFunctionSpec[]>> = {
  engine: [
    {
      name: "buildFanBlades",
      purpose: "radial fan/turbine blades: count, width, thickness, twist, pitch, sweep, leading/trailing edges",
      patterns: [/叶片|扇叶|blade|fan|twist|curv|pitch|sweep|thick|width|前缘|后缘|曲形|弯曲|扭转|厚度|宽度/i],
    },
    {
      name: "buildSpinner",
      purpose: "front center cone/spinner and nose fairing",
      patterns: [/圆锥|锥|整流锥|spinner|cone|中心/i],
    },
    {
      name: "buildRearHub",
      purpose: "rear hub, concave center ring, rear disc and back-side detail",
      patterns: [/后面|背面|凹陷|凹槽|rear|back|hub|轮毂|圆圈/i],
    },
    {
      name: "buildOuterRing",
      purpose: "outer casing, nacelle/duct rings, inner duct and ring proportions",
      patterns: [/外环|机匣|外圈|涵道|casing|ring|duct|outer|nacelle/i],
    },
  ],
  wing: [
    {
      name: "buildWingPlanform",
      purpose: "wing outline, sweep, taper, span and chord proportions",
      patterns: [/机翼|翼面|后掠|翼展|翼弦|翼尖|wing|planform|sweep|span|chord|tip/i],
    },
    {
      name: "buildAirfoilSection",
      purpose: "airfoil cross section, thickness, camber and leading/trailing edge shape",
      patterns: [/翼型|剖面|厚度|弯度|前缘|后缘|airfoil|camber|leading|trailing|section/i],
    },
    {
      name: "buildWingRibs",
      purpose: "ribs, spars, panel lines and structural segmentation",
      patterns: [/翼肋|梁|分段|蒙皮|结构线|rib|spar|panel|segment/i],
    },
    {
      name: "buildControlSurfaces",
      purpose: "flaps, ailerons, slats and movable surface seams",
      patterns: [/襟翼|副翼|缝翼|控制面|flap|aileron|slat|control surface/i],
    },
  ],
  fuselage: [
    {
      name: "buildFuselageBody",
      purpose: "main fuselage tube/body, oval section and length proportions",
      patterns: [/机身|机体|筒体|椭圆|截面|fuselage|body|oval|tube/i],
    },
    {
      name: "buildNoseCone",
      purpose: "nose cone/front taper and cockpit transition",
      patterns: [/机鼻|鼻锥|前端|nose|front taper/i],
    },
    {
      name: "buildTailCone",
      purpose: "tail cone/rear taper and exhaust transition",
      patterns: [/尾锥|尾部|后端|tail|rear taper/i],
    },
    {
      name: "buildWindowsAndPanelLines",
      purpose: "windows, doors, panel seams and engineering line details",
      patterns: [/窗|舱门|门|蒙皮线|面板线|window|door|panel|seam/i],
    },
  ],
  landing_gear: [
    {
      name: "buildWheels",
      purpose: "tires, hubs, wheel count and wheel proportions",
      patterns: [/轮胎|轮毂|车轮|tire|wheel|hub/i],
    },
    {
      name: "buildStruts",
      purpose: "main struts, telescopic cylinders and load-bearing supports",
      patterns: [/支柱|减震|液压|strut|shock|oleo|cylinder/i],
    },
    {
      name: "buildBraces",
      purpose: "diagonal braces, links, hinges and folding structure",
      patterns: [/斜撑|连杆|铰链|brace|link|hinge|fold/i],
    },
  ],
  cockpit: [
    {
      name: "buildCanopy",
      purpose: "canopy glass, cockpit cover and transparent shell shape",
      patterns: [/座舱盖|驾驶舱盖|玻璃|canopy|glass|透明|cockpit cover/i],
    },
    {
      name: "buildCockpitFrame",
      purpose: "canopy frame, windshield bars and cockpit structural outlines",
      patterns: [/框|风挡|挡风|frame|windshield|bar/i],
    },
    {
      name: "buildInstrumentPanel",
      purpose: "instrument panel, dashboard and interior cockpit detail",
      patterns: [/仪表|面板|内饰|instrument|dashboard|panel/i],
    },
  ],
};

export function getAircraftTargetFunctionSpecs(category?: AircraftAssetCategory): TargetFunctionSpec[] {
  const domainTargets = category ? categoryTargets[category] ?? [] : Object.values(categoryTargets).flat();
  const targets = [...domainTargets, ...commonTargets];
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.name)) return false;
    seen.add(target.name);
    return true;
  });
}

export function getAircraftTargetFunctionNames(category?: AircraftAssetCategory): string[] {
  return getAircraftTargetFunctionSpecs(category).map((target) => target.name);
}

export function buildAircraftTargetFunctionCatalog(category?: AircraftAssetCategory): string {
  return getAircraftTargetFunctionSpecs(category)
    .map((target) => `- ${target.name}: ${target.purpose}`)
    .join("\n");
}

export function inferEngineModelingVariant(text: string): EngineModelingVariant {
  const normalized = text.toLowerCase();
  if (/single\s+blade|one\s+blade|单片叶片|单个叶片|叶片特写|榫头|blade\s+root|dovetail/.test(normalized)) {
    return "single_blade";
  }
  if (/无外环|不要外环|没有外环|去掉外环|移除外环|open\s+rotor|open\s+blisk|open\s+fan/.test(normalized)) {
    return "open_blisk";
  }
  if (/nacelle|duct|ducted|casing|inlet|intake|cowling|outer\s+ring|engine\s+front|涵道|外涵道|机匣|进气口|整机|外环|外圈/.test(normalized)) {
    return "ducted_turbofan";
  }
  if (/blisk|blade\s*disk|blade\s*disc|rotor\s*disk|rotor\s*disc|impeller|compressor\s*wheel|fan\s*wheel|叶盘|叶轮|轮盘|转子盘|开放式|无外环|不要外环|扇叶盘|涡轮盘|压气机/.test(normalized)) {
    return "open_blisk";
  }
  if (/扇叶|叶片|blade|fan|rotor|涡轮/.test(normalized) && !/发动机整机|进气口|涵道|机匣|nacelle|duct|intake/.test(normalized)) {
    return "open_blisk";
  }
  return "generic_engine";
}

export function buildAircraftReviewChecklistInstruction(category?: AircraftAssetCategory, contextText = ""): string {
  const catalog = buildAircraftTargetFunctionCatalog(category);
  const engineVariant = category === "engine" ? inferEngineModelingVariant(contextText) : "generic_engine";
  const engineChecks =
    engineVariant === "open_blisk"
      ? [
          "发动机开放式叶盘/blisk checks:",
          "- 目标是无大外涵道的叶盘/叶轮/转子盘，而不是完整涡扇进气口。",
          "- 必须重点检查中心轮毂/中心孔/螺栓孔或凹陷环、放射状曲面叶片、叶片数量和均匀排列。",
          "- 叶片必须有宽度、厚度、弯曲/扭转、前后缘；侧面应能看出曲形截面和叶片高度。",
          "- 材质应接近参考图的金属叶盘，通常是银灰/深灰金属、平滑高光，而不是纯黑薄三角片。",
          "- 如果参考图没有外环/涵道/机匣，大外环、双环、笼状圆圈、完整 nacelle 应作为 critical 几何错误扣分，不能因为是 engine 就奖励外环。",
        ].join("\n")
      : engineVariant === "single_blade"
        ? [
            "发动机单叶片 checks:",
            "- 目标是单个涡轮/风扇叶片，不是完整叶盘。",
            "- 必须检查翼型截面、叶根榫头、扭转曲面、前缘/后缘、厚度和金属材质。",
            "- 不应强行生成外环、完整轮毂或整圈叶片，除非用户明确要求组件/叶盘。",
          ].join("\n")
        : [
            "发动机带涵道/整机 checks:",
            "- 目标是涡扇/发动机整机正面或带进气口结构。",
            "- 必须检查中心圆锥/轮毂、外环/机匣/涵道、叶片数量、叶片宽度厚度、叶片弯曲/扭转、侧面深度或曲形截面、背面凹陷轮毂。",
            "- 外环/机匣只在参考图或用户目标呈现整机/涵道/进气口时作为正向要求。",
          ].join("\n");
  const domainChecks: Record<string, string> = {
    engine: engineChecks,
    wing: "机翼增强 checks: 翼型截面、后掠/翼展/翼弦比例、翼尖形态、翼肋/梁/分段线、襟翼/副翼缝线。",
    fuselage: "机身增强 checks: 长筒/椭圆截面、机鼻/尾锥收缩、舷窗/舱门/蒙皮线、轴线比例和截面连续性。",
    landing_gear: "起落架增强 checks: 轮胎/轮毂比例、支柱/减震筒、斜撑/连杆、左右对称、接地点和承重结构。",
    cockpit: "驾驶舱增强 checks: 透明座舱盖轮廓、风挡框架、仪表/座椅内饰、与机身过渡比例。",
  };
  return [
    domainChecks[category ?? ""] ?? "若能识别出具体航空部件，请补充该部件的关键结构 checks，不要只给泛泛评价。",
    "targetFunction 必须尽量从以下航空建模函数目录选择:",
    catalog,
  ].join("\n");
}

export function inferAircraftTargetFunctionFromText(text: string, category?: AircraftAssetCategory): string | undefined {
  const normalized = text.toLowerCase();
  for (const target of getAircraftTargetFunctionSpecs(category)) {
    if (target.patterns.some((pattern) => pattern.test(normalized))) return target.name;
  }
  if (!category) {
    for (const target of Object.values(categoryTargets).flat()) {
      if (target.patterns.some((pattern) => pattern.test(normalized))) return target.name;
    }
  }
  return undefined;
}
