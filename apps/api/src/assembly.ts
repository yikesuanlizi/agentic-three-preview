import {
  type AssemblyConstraintCheck,
  type AssemblyGraph,
  type AssemblySolverResult,
  type AssemblyTransform,
  assemblyGraphSchema,
  assemblySolverResultSchema,
} from "@agentic-three/shared";

const defaultTolerance = 0.001;

export function buildTurbofanAssemblyGraph(input: {
  variant?: "ducted_turbofan" | "open_blisk";
  bladeCount?: number;
  hubRadius?: number;
  tipRadius?: number;
  outerRingInnerRadius?: number;
  outerRingOuterRadius?: number;
  bladeThickness?: number;
  bladeTwist?: number;
  bladePitch?: number;
  bladeSweep?: number;
} = {}): AssemblyGraph {
  const variant = input.variant ?? "ducted_turbofan";
  const hasOuterRing = variant !== "open_blisk";
  const hasSpinner = variant !== "open_blisk";
  const hubRadius = input.hubRadius ?? 0.42;
  const tipRadius = input.tipRadius ?? 1.44;
  const outerRingInnerRadius = input.outerRingInnerRadius ?? Math.max(tipRadius + 0.08, 1.52);
  const outerRingOuterRadius = input.outerRingOuterRadius ?? Math.max(outerRingInnerRadius + 0.18, 1.75);
  const bladeTipRadius = hasOuterRing ? Math.max(hubRadius + 0.2, outerRingInnerRadius - 0.08) : Math.max(hubRadius + 0.2, tipRadius);
  const bladeCount = input.bladeCount ?? 32;
  return assemblyGraphSchema.parse({
    id: "turbofan-assembly",
    templateId: "turbofan_v1",
    axis: [0, 0, 1],
    parts: [
      { id: "hub", type: "cylindrical_hub", objectId: "hub", params: { radius: hubRadius, depth: 0.38 }, portIds: ["hub.axis", "hub.outerRadius"], featureIds: ["hub.outerRadius"] },
      ...(hasSpinner ? [{ id: "spinner", type: "front_spinner_cone", objectId: "spinner", params: { baseRadius: 0.32, length: 0.66 }, portIds: ["spinner.axis", "spinner.baseFace"], featureIds: ["spinner.cone"] }] : []),
      { id: "rearHub", type: "rear_concave_hub", objectId: "rearHub", params: { radius: 0.52, depth: 0.26, recess: 0.16 }, portIds: ["rearHub.axis", "rearHub.frontFace"], featureIds: ["rearHub.recess"] },
      ...(hasOuterRing
        ? [{ id: "outerRing", type: "duct_ring", objectId: "outerRing", params: { innerRadius: outerRingInnerRadius, outerRadius: outerRingOuterRadius, tube: (outerRingOuterRadius - outerRingInnerRadius) / 2 }, portIds: ["outerRing.axis", "outerRing.innerRadius"], featureIds: ["outerRing.innerRadius"] }]
        : []),
      {
        id: "bladeArray",
        type: "radial_blade_array",
        objectId: "bladeArray",
        params: { count: bladeCount },
        portIds: ["bladeArray.axis", "bladeArray.rootRadius", "bladeArray.tipRadius"],
        featureIds: ["bladeArray.leadingEdge", "bladeArray.trailingEdge", "bladeArray.twist"],
        generatorIds: ["bladeArray.radialArray"],
      },
    ],
    ports: [
      { id: "hub.axis", partId: "hub", kind: "axis", axis: [0, 0, 1] },
      { id: "hub.outerRadius", partId: "hub", kind: "radius", radius: hubRadius },
      ...(hasSpinner
        ? [
            { id: "spinner.axis", partId: "spinner", kind: "axis", axis: [0, 0, 1] },
            { id: "spinner.baseFace", partId: "spinner", kind: "face", normal: [0, 0, -1] },
          ]
        : []),
      { id: "rearHub.axis", partId: "rearHub", kind: "axis", axis: [0, 0, 1] },
      { id: "rearHub.frontFace", partId: "rearHub", kind: "face", normal: [0, 0, 1] },
      ...(hasOuterRing
        ? [
            { id: "outerRing.axis", partId: "outerRing", kind: "axis", axis: [0, 0, 1] },
            { id: "outerRing.innerRadius", partId: "outerRing", kind: "radius", radius: outerRingInnerRadius },
          ]
        : []),
      { id: "bladeArray.axis", partId: "bladeArray", kind: "axis", axis: [0, 0, 1] },
      { id: "bladeArray.rootRadius", partId: "bladeArray", kind: "radius", radius: hubRadius },
      { id: "bladeArray.tipRadius", partId: "bladeArray", kind: "radius", radius: bladeTipRadius },
      ...(!hasOuterRing ? [{ id: "bladeArray.designTipRadius", partId: "bladeArray", kind: "radius", radius: bladeTipRadius + 0.08 }] : []),
    ],
    features: [
      { id: "hub.outerRadius", partId: "hub", kind: "hubOuterRadius", value: hubRadius, portIds: ["hub.outerRadius"] },
      ...(hasSpinner ? [{ id: "spinner.cone", partId: "spinner", kind: "frontCenterCone", params: { baseRadius: 0.32, length: 0.66 } }] : []),
      { id: "rearHub.recess", partId: "rearHub", kind: "concaveRearRing", params: { recess: 0.16 } },
      ...(hasOuterRing ? [{ id: "outerRing.innerRadius", partId: "outerRing", kind: "ringInnerRadius", value: outerRingInnerRadius, portIds: ["outerRing.innerRadius"] }] : []),
      { id: "bladeArray.leadingEdge", partId: "bladeArray", kind: "leadingEdge" },
      { id: "bladeArray.trailingEdge", partId: "bladeArray", kind: "trailingEdge" },
      { id: "bladeArray.twist", partId: "bladeArray", kind: "bladeTwist", value: input.bladeTwist ?? 0.85 },
    ],
    generators: [
      {
        id: "bladeArray.radialArray",
        type: "radialArray",
        partId: "bladeArray",
        axisPortId: "bladeArray.axis",
        count: bladeCount,
        params: {
          rootRadius: hubRadius,
          tipRadius: bladeTipRadius,
          pitch: input.bladePitch ?? 0.36,
          twist: input.bladeTwist ?? 0.85,
          sweep: input.bladeSweep ?? 0.18,
          thickness: input.bladeThickness ?? 0.055,
          rootWidth: 0.24,
          tipWidth: 0.14,
        },
      },
    ],
    constraints: [
      { id: "coaxial.core", type: "coaxial", a: "hub.axis", partIds: [...(hasSpinner ? ["spinner"] : []), "hub", "rearHub", ...(hasOuterRing ? ["outerRing"] : []), "bladeArray"], priority: "critical", tolerance: defaultTolerance },
      ...(hasOuterRing
        ? [{ id: "insideRadius.bladeTip.outerRing", type: "insideRadius", a: "bladeArray.tipRadius", b: "outerRing.innerRadius", priority: "critical", tolerance: 0.0001, params: { minClearance: 0.02 } }]
        : [{ id: "insideRadius.bladeTip.designRadius", type: "insideRadius", a: "bladeArray.tipRadius", b: "bladeArray.designTipRadius", priority: "critical", tolerance: 0.0001, params: { minClearance: 0.02 } }]),
      { id: "contact.bladeRoot.hub", type: "contact", a: "bladeArray.rootRadius", b: "hub.outerRadius", priority: "high", tolerance: 0.02 },
      ...(hasOuterRing ? [{ id: "clearance.bladeTip.outerRing", type: "clearance", a: "bladeArray.tipRadius", b: "outerRing.innerRadius", priority: "high", tolerance: 0.02, params: { min: 0.02, max: 0.22 } }] : []),
    ],
  });
}

export function solveAssemblyGraph(input: unknown): AssemblySolverResult {
  const graph = assemblyGraphSchema.parse(input);
  const transforms = Object.fromEntries(graph.parts.map((part) => [part.id, solvePartTransform(part.id)]));
  const preliminary = assemblySolverResultSchema.parse({
    graphId: graph.id,
    transforms,
    residuals: {},
    checks: [],
    ok: true,
    message: "closed-form axisymmetric solver v1",
  });
  const verified = verifyAssemblyConstraints(graph, preliminary);
  return assemblySolverResultSchema.parse({
    ...preliminary,
    residuals: verified.residuals,
    checks: verified.checks,
    ok: verified.checks.every((check) => check.pass || check.priority !== "critical"),
  });
}

export function verifyAssemblyConstraints(inputGraph: unknown, inputSolver?: unknown): AssemblySolverResult {
  const graph = assemblyGraphSchema.parse(inputGraph);
  const solver = inputSolver
    ? assemblySolverResultSchema.parse(inputSolver)
    : assemblySolverResultSchema.parse({
        graphId: graph.id,
        transforms: Object.fromEntries(graph.parts.map((part) => [part.id, solvePartTransform(part.id)])),
      });
  const checks: AssemblyConstraintCheck[] = [];
  const residuals: Record<string, number> = {};

  for (const constraint of graph.constraints) {
    if (constraint.type === "coaxial") {
      const partIds = constraint.partIds.length ? constraint.partIds : [partIdFromPort(graph, constraint.a), constraint.b ? partIdFromPort(graph, constraint.b) : ""].filter(Boolean);
      const residual = coaxialResidual(partIds, solver.transforms);
      residuals[`${constraint.id}.coaxialError`] = residual;
      checks.push({
        constraintId: constraint.id,
        type: constraint.type,
        priority: constraint.priority,
        pass: residual <= constraint.tolerance,
        residual,
        tolerance: constraint.tolerance,
        message: residual <= constraint.tolerance ? "轴线同轴" : `轴线偏移 ${residual.toFixed(4)} 超过 ${constraint.tolerance}`,
      });
    }
    if (constraint.type === "insideRadius") {
      const a = portRadius(graph, constraint.a);
      const b = constraint.b ? portRadius(graph, constraint.b) : 0;
      const minClearance = numberParam(constraint.params.minClearance, 0);
      const clearance = b - a;
      residuals[`${constraint.id}.tipClearance`] = clearance;
      checks.push({
        constraintId: constraint.id,
        type: constraint.type,
        priority: constraint.priority,
        pass: clearance >= minClearance - constraint.tolerance,
        residual: Math.max(0, minClearance - clearance),
        tolerance: constraint.tolerance,
        message: clearance >= minClearance - constraint.tolerance ? `半径内约束通过，clearance=${clearance.toFixed(4)}` : `叶尖/部件超出或间隙不足，clearance=${clearance.toFixed(4)}`,
      });
    }
    if (constraint.type === "contact") {
      const a = portRadius(graph, constraint.a);
      const b = constraint.b ? portRadius(graph, constraint.b) : 0;
      const gap = Math.abs(a - b);
      residuals[`${constraint.id}.contactGap`] = gap;
      checks.push({
        constraintId: constraint.id,
        type: constraint.type,
        priority: constraint.priority,
        pass: gap <= constraint.tolerance,
        residual: gap,
        tolerance: constraint.tolerance,
        message: gap <= constraint.tolerance ? "接触约束通过" : `接触间隙 ${gap.toFixed(4)} 超过 ${constraint.tolerance}`,
      });
    }
    if (constraint.type === "clearance") {
      const a = portRadius(graph, constraint.a);
      const b = constraint.b ? portRadius(graph, constraint.b) : 0;
      const clearance = b - a;
      const min = numberParam(constraint.params.min, 0);
      const max = numberParam(constraint.params.max, Number.POSITIVE_INFINITY);
      const residual = clearance < min ? min - clearance : clearance > max ? clearance - max : 0;
      residuals[`${constraint.id}.clearance`] = clearance;
      checks.push({
        constraintId: constraint.id,
        type: constraint.type,
        priority: constraint.priority,
        pass: residual <= constraint.tolerance,
        residual,
        tolerance: constraint.tolerance,
        message: residual <= constraint.tolerance ? `间隙约束通过，clearance=${clearance.toFixed(4)}` : `间隙 ${clearance.toFixed(4)} 不在 [${min}, ${max}]`,
      });
    }
  }

  for (const generator of graph.generators.filter((item) => item.type === "radialArray")) {
    const expected = (Math.PI * 2) / generator.count;
    residuals[`${generator.id}.radialSpacingError`] = 0;
    residuals[`${generator.id}.expectedAngleStep`] = expected;
  }

  return assemblySolverResultSchema.parse({
    ...solver,
    residuals,
    checks,
    ok: checks.every((check) => check.pass || check.priority !== "critical"),
    message: checks.some((check) => !check.pass && check.priority === "critical")
      ? "存在 critical assembly constraint failure"
      : "assembly constraints verified",
  });
}

function solvePartTransform(partId: string): AssemblyTransform {
  if (partId === "spinner") return { position: [0, 0, 0.34], rotation: [0, 0, 0], scale: 1 };
  if (partId === "rearHub") return { position: [0, 0, -0.24], rotation: [0, 0, 0], scale: 1 };
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
}

function coaxialResidual(partIds: string[], transforms: Record<string, AssemblyTransform>): number {
  const centers: Array<[number, number, number]> = partIds.map((id) => transforms[id]?.position ?? [0, 0, 0]);
  if (centers.length < 2) return 0;
  const base = centers[0]!;
  return Math.max(...centers.map((center) => Math.hypot(component(center, 0) - component(base, 0), component(center, 1) - component(base, 1))));
}

function component(vector: [number, number, number], index: 0 | 1 | 2): number {
  return vector[index] ?? 0;
}

function partIdFromPort(graph: AssemblyGraph, portId: string): string {
  return graph.ports.find((port) => port.id === portId)?.partId ?? "";
}

function portRadius(graph: AssemblyGraph, portId: string): number {
  return graph.ports.find((port) => port.id === portId)?.radius ?? 0;
}

function numberParam(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
