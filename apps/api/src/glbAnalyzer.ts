import { readFileSync } from "node:fs";
import { NodeIO, type Mesh, type Node as GltfNode, type Primitive } from "@gltf-transform/core";
import {
  type GlbConstraintHint,
  type GlbStructureAnalysis,
  type GlbTemplateParams,
  glbConstraintHintSchema,
  glbStructureAnalysisSchema,
  glbTemplateParamsSchema,
} from "@agentic-three/shared";
import { Box3, Matrix4, Vector3 } from "three";

type MeshStat = GlbStructureAnalysis["meshStats"][number];
type Axis = NonNullable<GlbStructureAnalysis["dominantAxis"]>;

const trianglesMode = 4;

export async function analyzeGlbStructure(path: string): Promise<{
  structureAnalysis: GlbStructureAnalysis;
  templateParams: GlbTemplateParams;
  constraintHints: GlbConstraintHint[];
}> {
  try {
    const io = new NodeIO();
    const document = await io.readBinary(new Uint8Array(readFileSync(path)));
    const root = document.getRoot();
    const nodes = root.listNodes();
    const meshes = root.listMeshes();
    const materials = root.listMaterials().map((material) => material.getName()).filter(Boolean);
    const meshStats = nodes
      .filter((node) => node.getMesh())
      .map((node) => meshStatFromNode(node))
      .filter((stat): stat is MeshStat => Boolean(stat));
    const overallBox = unionStats(meshStats);
    const bounds = boxToBounds(overallBox);
    const dominantAxis = bounds ? inferDominantAxis(bounds.size) : undefined;
    const radialPatterns = detectRadialPatterns(meshStats);
    const structureAnalysis = glbStructureAnalysisSchema.parse({
      status: "success",
      nodeCount: nodes.length,
      meshCount: meshes.length,
      materialCount: root.listMaterials().length,
      bounds,
      dominantAxis,
      meshStats: meshStats.slice(0, 80),
      radialPatterns,
    });
    const templateParams = buildTemplateParams(structureAnalysis);
    const constraintHints = buildConstraintHints(structureAnalysis, templateParams);
    return { structureAnalysis, templateParams, constraintHints };
  } catch (error) {
    return {
      structureAnalysis: glbStructureAnalysisSchema.parse({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }),
      templateParams: glbTemplateParamsSchema.parse({}),
      constraintHints: [],
    };
  }
}

function meshStatFromNode(node: GltfNode): MeshStat | undefined {
  const mesh = node.getMesh();
  if (!mesh) return undefined;
  const matrix = new Matrix4().fromArray(Array.from(node.getWorldMatrix()));
  const box = new Box3();
  let vertexCount = 0;
  let triangleCount = 0;
  const materials = new Set<string>();
  for (const primitive of mesh.listPrimitives()) {
    const primitiveBox = primitiveBounds(primitive, matrix);
    if (primitiveBox) box.union(primitiveBox);
    const position = primitive.getAttribute("POSITION");
    vertexCount += position?.getCount() ?? 0;
    triangleCount += primitiveTriangleCount(primitive);
    const materialName = primitive.getMaterial()?.getName();
    if (materialName) materials.add(materialName);
  }
  if (box.isEmpty()) return undefined;
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  return {
    name: node.getName() || mesh.getName() || "mesh",
    vertexCount,
    triangleCount,
    center: vectorTuple(center),
    size: vectorTuple(size),
    radiusEstimate: Math.max(size.x, size.y) / 2,
    materials: Array.from(materials),
  };
}

function primitiveBounds(primitive: Primitive, matrix: Matrix4): Box3 | undefined {
  const position = primitive.getAttribute("POSITION");
  if (!position || position.getCount() <= 0) return undefined;
  const min = position.getMin([0, 0, 0]);
  const max = position.getMax([0, 0, 0]);
  const box = new Box3();
  for (const x of [min[0] ?? 0, max[0] ?? 0]) {
    for (const y of [min[1] ?? 0, max[1] ?? 0]) {
      for (const z of [min[2] ?? 0, max[2] ?? 0]) {
        box.expandByPoint(new Vector3(x, y, z).applyMatrix4(matrix));
      }
    }
  }
  return box;
}

function primitiveTriangleCount(primitive: Primitive): number {
  const position = primitive.getAttribute("POSITION");
  const indices = primitive.getIndices();
  if (primitive.getMode() !== trianglesMode) return 0;
  if (indices) return Math.floor(indices.getCount() / 3);
  return Math.floor((position?.getCount() ?? 0) / 3);
}

function unionStats(stats: MeshStat[]): Box3 {
  const box = new Box3();
  for (const stat of stats) {
    const center = new Vector3(...stat.center);
    const half = new Vector3(...stat.size).multiplyScalar(0.5);
    box.union(new Box3(center.clone().sub(half), center.clone().add(half)));
  }
  return box;
}

function boxToBounds(box: Box3): GlbStructureAnalysis["bounds"] | undefined {
  if (box.isEmpty()) return undefined;
  return {
    center: vectorTuple(box.getCenter(new Vector3())),
    size: vectorTuple(box.getSize(new Vector3())),
  };
}

function inferDominantAxis(size: [number, number, number]): Axis {
  const entries: Array<[Axis, number]> = [
    ["+X", Math.abs(size[0])],
    ["+Y", Math.abs(size[1])],
    ["+Z", Math.abs(size[2])],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] ?? "+Z";
}

function detectRadialPatterns(stats: MeshStat[]): GlbStructureAnalysis["radialPatterns"] {
  const groups = groupSimilarMeshes(stats)
    .filter((group) => group.length >= 6)
    .map((group) => scoreRadialGroup(group))
    .filter((pattern): pattern is NonNullable<ReturnType<typeof scoreRadialGroup>> => Boolean(pattern))
    .sort((a, b) => b.confidence - a.confidence);
  return groups.slice(0, 3);
}

function groupSimilarMeshes(stats: MeshStat[]): MeshStat[][] {
  const groups = new Map<string, MeshStat[]>();
  for (const stat of stats) {
    const size = stat.size.map((value) => Math.max(0.001, value));
    const sortedSize = [...size].sort((a, b) => b - a);
    const signature = [
      Math.round(Math.log10(Math.max(1, stat.vertexCount)) * 3),
      ...sortedSize.map((value) => Math.round(value * 10)),
      stat.materials[0] ?? "",
    ].join("|");
    const group = groups.get(signature) ?? [];
    group.push(stat);
    groups.set(signature, group);
  }
  return Array.from(groups.values());
}

function scoreRadialGroup(group: MeshStat[]): GlbStructureAnalysis["radialPatterns"][number] | undefined {
  const radii = group.map((stat) => Math.hypot(stat.center[0], stat.center[1]));
  const avgRadius = average(radii);
  if (avgRadius <= 0.001) return undefined;
  const radiusVariance = average(radii.map((radius) => Math.abs(radius - avgRadius))) / avgRadius;
  const angles = group
    .map((stat) => Math.atan2(stat.center[1], stat.center[0]))
    .sort((a, b) => a - b);
  const gaps = angles.map((angle, index) => {
    const next = angles[(index + 1) % angles.length] ?? angle;
    const rawGap = index === angles.length - 1 ? next + Math.PI * 2 - angle : next - angle;
    return rawGap;
  });
  const expected = (Math.PI * 2) / group.length;
  const spacingError = average(gaps.map((gap) => Math.abs(gap - expected))) / expected;
  const confidence = clamp01(1 - radiusVariance * 2 - spacingError * 1.5 + Math.min(group.length, 32) / 96);
  if (confidence < 0.45) return undefined;
  return {
    type: "radialArray",
    count: group.length,
    axis: "+Z",
    confidence,
    radiusRange: [Math.min(...radii), Math.max(...radii)],
  };
}

function buildTemplateParams(analysis: GlbStructureAnalysis): GlbTemplateParams {
  const pattern = analysis.radialPatterns[0];
  if (!analysis.bounds) return glbTemplateParamsSchema.parse({});
  const radius = Math.max(analysis.bounds.size[0], analysis.bounds.size[1]) / 2;
  const hasRadialArray = Boolean(pattern && pattern.count >= 6);
  const template = hasRadialArray ? "turbofan" : "generic_model";
  const hubRadius = pattern?.radiusRange?.[0] ? Math.max(0.05, pattern.radiusRange[0] * 0.72) : radius * 0.26;
  const outerRingOuterRadius = radius;
  const outerRingInnerRadius = Math.max(hubRadius + 0.2, radius * 0.86);
  const bladeThickness = estimateBladeThickness(analysis.meshStats, pattern?.count);
  return glbTemplateParamsSchema.parse({
    template,
    confidence: hasRadialArray ? Math.max(0.5, pattern?.confidence ?? 0.5) : 0.35,
    turbofan: hasRadialArray
      ? {
          bladeCount: pattern?.count,
          hubRadius,
          outerRingInnerRadius,
          outerRingOuterRadius,
          bladeThickness,
          bladeTwist: 0.85,
          spinnerDirection: "unknown",
        }
      : {},
  });
}

function buildConstraintHints(analysis: GlbStructureAnalysis, params: GlbTemplateParams): GlbConstraintHint[] {
  if (params.template !== "turbofan") return [];
  const hints: GlbConstraintHint[] = [
    { type: "coaxial", priority: "critical", confidence: params.confidence ?? 0.5, reason: "GLB 分析识别到轴对称/径向结构，hub、spinner、bladeArray、outerRing 应共轴。" },
    { type: "insideRadius", priority: "critical", confidence: params.confidence ?? 0.5, reason: "叶片阵列应保持在外环内半径以内，避免叶尖穿出机匣。" },
    { type: "contact", priority: "high", confidence: params.confidence ?? 0.5, reason: "叶片根部应贴合轮毂外半径。" },
  ];
  const pattern = analysis.radialPatterns[0];
  if (pattern) {
    hints.push({
      type: "radialArray",
      priority: "high",
      confidence: pattern.confidence,
      reason: `检测到 ${pattern.count} 个候选径向重复部件，可作为 bladeArray.count。`,
    });
  }
  return hints.map((hint) => glbConstraintHintSchema.parse(hint));
}

function estimateBladeThickness(stats: MeshStat[], count: number | undefined): number | undefined {
  if (!count) return undefined;
  const candidates = groupSimilarMeshes(stats)
    .filter((group) => group.length === count)
    .flat()
    .map((stat) => Math.min(...stat.size.filter((value) => value > 0.0001)));
  if (!candidates.length) return undefined;
  return Math.max(0.01, average(candidates));
}

function vectorTuple(vector: Vector3): [number, number, number] {
  return [roundMetric(vector.x), roundMetric(vector.y), roundMetric(vector.z)];
}

function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
