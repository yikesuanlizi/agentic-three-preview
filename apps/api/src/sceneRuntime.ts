import {
  type AgentTurnRequest,
  type FileMap,
  type PatchEvent,
  type RetrievalSearchResult,
  type SceneComposeRequest,
  type SceneDsl,
  type SemanticIntent,
  type VisualIntent,
  defaultFiles,
  sceneComposeRequestSchema,
  sceneDslSchema,
  sceneRenderRequestSchema,
  semanticIntentSchema,
} from "@agentic-three/shared";
import { defaultRetrievalForIntent } from "./aircraftRetrieval.js";
import { searchAircraftRag } from "./rag.js";
import { buildTurbofanAssemblyGraph, solveAssemblyGraph } from "./assembly.js";
import { inferEngineModelingVariant } from "./aircraftModelingTargets.js";

export function parseSemanticIntent(request: AgentTurnRequest, visualIntent?: VisualIntent): SemanticIntent {
  const visualText = visualIntent
    ? [
        visualIntent.subject,
        visualIntent.category,
        visualIntent.retrievalQuery,
        visualIntent.visualFeatures.join(" "),
        visualIntent.geometryHints.join(" "),
      ].filter(Boolean).join(" ")
    : "";
  const text = `${request.message}\n${visualText}`.toLowerCase();
  const isDecorative = /heart|love|爱心|心形|桃心|粉色|pink|星星|star|礼物|gift|球|sphere|抽象|装饰|logo|图标/.test(text);
  const isEngine = /engine|turbofan|fan|发动机|涡扇|进气口|叶片/.test(text);
  const isWing = /wing|机翼|翼型/.test(text);
  const isFuselage = /fuselage|机身|机体/.test(text);
  const isGear = /gear|wheel|起落架|轮胎/.test(text);
  const category = visualIntent?.category ?? (isEngine ? "engine" : isWing ? "wing" : isFuselage ? "fuselage" : isGear ? "landing_gear" : undefined);
  const renderStyle = visualIntent?.renderStyle ?? (/黑线|白图|线稿|工程/.test(text) ? "technical_lines" : isDecorative ? "realistic" : "engineering_white");
  const view = visualIntent?.view ?? (/侧面|side/.test(text) ? "side" : /俯视|top/.test(text) ? "top" : "front");
  return semanticIntentSchema.parse({
    subject: visualIntent?.subject || (isDecorative ? "general decorative 3D scene" : category === "engine" ? "turbofan engine front view" : category === "wing" ? "aircraft wing component" : category === "fuselage" ? "aircraft fuselage component" : category === "landing_gear" ? "aircraft landing gear component" : "aircraft component"),
    category,
    view,
    renderStyle,
    requestedOutputs: isDecorative ? ["animated_preview", "sandpack_preview"] : request.images.length ? ["image_reconstruction", "sandpack_preview"] : ["sandpack_preview"],
    constraints: [
      isDecorative ? `general decorative scene: ${request.message}` : renderStyle === "technical_lines" ? "white background with black linework" : "clean aircraft component preview",
      "no automatic rotation",
      "preserveDrawingBuffer for screenshots",
      ...(visualIntent?.visualFeatures ?? []).map((feature) => `visual feature: ${feature}`),
      ...(visualIntent?.geometryHints ?? []).map((hint) => `geometry hint: ${hint}`),
    ],
  });
}

export function composeScene(input: unknown): SceneDsl {
  const { intent, retrievalResults } = sceneComposeRequestSchema.parse(input);
  const bestAsset = retrievalResults.find((item) => item.kind === "asset_view" || item.kind === "asset");
  const bestTemplate = retrievalResults.find((item) => item.kind === "template");
  const decorativeParams = inferDecorativeParams(`${intent.subject}\n${intent.constraints.join("\n")}`);
  const isDecorative = Boolean(decorativeParams);
  const primitive = isDecorative
    ? "decorative_shape"
    : intent.category === "engine"
      ? "turbofan_front"
      : intent.category === "wing"
        ? "wing_panel"
        : intent.category === "fuselage"
          ? "fuselage_section"
          : intent.category === "landing_gear"
            ? "landing_gear"
            : "generic_part";
  const templateId = normalizeRetrievalId(bestTemplate?.id);
  const assemblyGraph = intent.category === "engine" && !isDecorative ? buildTurbofanAssemblyGraph(inferTurbofanParams(intent, bestAsset)) : undefined;
  const solverResult = assemblyGraph ? solveAssemblyGraph(assemblyGraph) : undefined;
  return sceneDslSchema.parse({
    sceneType: templateId === "front_technical_view" ? "front_technical_view" : intent.category === "engine" ? "engine_showcase" : "component_detail",
    cameraPreset: intent.view,
    lightingPreset: "engineering_white",
    renderStyle: intent.renderStyle,
    objects: [
      {
        id: "primary-aircraft-component",
        objectId: "primary-aircraft-component",
        assetId: bestAsset?.sourceId ?? normalizeRetrievalId(bestAsset?.id),
        sourceAsset: {
          assetId: bestAsset?.sourceId ?? normalizeRetrievalId(bestAsset?.id),
          sourcePath: bestAsset?.sourcePath,
          metadataPath: typeof bestAsset?.metadata.metadataPath === "string" ? bestAsset.metadata.metadataPath : undefined,
        },
        primitive,
        semanticRole: intent.category ? `${intent.category}_primary_subject` : "primary_subject",
        purpose: intent.requestedOutputs.includes("image_reconstruction") ? "reconstruct_reference_image" : "visual_subject",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: 1,
        params: decorativeParams ?? (assemblyGraph ? { assemblyTemplate: assemblyGraph.templateId } : {}),
        material: {
          style: intent.renderStyle === "technical_lines" ? "linework" : isDecorative ? "realistic" : "flat",
          color: decorativeParams?.color as string | undefined,
        },
        constraints: intent.constraints,
      },
    ],
    annotations: intent.constraints,
    animations: isDecorative ? ["gentle_loop"] : [],
    semanticSummary: `${intent.subject}; view=${intent.view}; style=${intent.renderStyle}`,
    assemblyGraph,
    solverResult,
    assetUsage: bestAsset
      ? [
          {
            objectId: "primary-aircraft-component",
            assetId: bestAsset.sourceId ?? normalizeRetrievalId(bestAsset.id),
            sourcePath: bestAsset.sourcePath,
            role: "primary_reference",
          },
        ]
      : [],
  });
}

type TurbofanGraphParams = NonNullable<Parameters<typeof buildTurbofanAssemblyGraph>[0]>;

function inferTurbofanParams(intent: SemanticIntent, bestAsset?: RetrievalSearchResult): TurbofanGraphParams {
  const text = `${intent.subject}\n${intent.constraints.join("\n")}`.toLowerCase();
  const engineVariant = inferEngineModelingVariant(text);
  const assetParams = readTurbofanTemplateParams(bestAsset);
  const bladeCount = /叶片少|稀疏|few/.test(text) ? 18 : /密集|很多|多叶片|many/.test(text) ? 36 : 32;
  const bladeThickness = /厚|宽|thick|width|侧面/.test(text) ? 0.075 : 0.055;
  const bladeTwist = /扭转|弯曲|曲形|twist|curv/.test(text) ? 1.05 : 0.85;
  const openBlisk = engineVariant === "open_blisk";
  return {
    variant: openBlisk ? "open_blisk" : "ducted_turbofan",
    bladeCount: assetParams.bladeCount ?? bladeCount,
    hubRadius: assetParams.hubRadius,
    tipRadius: openBlisk ? assetParams.outerRingInnerRadius ?? 1.42 : undefined,
    outerRingInnerRadius: openBlisk ? undefined : assetParams.outerRingInnerRadius,
    outerRingOuterRadius: openBlisk ? undefined : assetParams.outerRingOuterRadius,
    bladeThickness: assetParams.bladeThickness ?? bladeThickness,
    bladeTwist: assetParams.bladeTwist ?? bladeTwist,
    bladePitch: openBlisk ? 0.42 : undefined,
    bladeSweep: openBlisk ? 0.28 : undefined,
  };
}

function readTurbofanTemplateParams(bestAsset?: RetrievalSearchResult): TurbofanGraphParams {
  const params = (bestAsset?.metadata.templateParams as { turbofan?: Record<string, unknown> } | undefined)?.turbofan;
  if (!params) return {};
  return {
    bladeCount: numberParam(params.bladeCount),
    hubRadius: numberParam(params.hubRadius),
    outerRingInnerRadius: numberParam(params.outerRingInnerRadius),
    outerRingOuterRadius: numberParam(params.outerRingOuterRadius),
    bladeThickness: numberParam(params.bladeThickness),
    bladeTwist: numberParam(params.bladeTwist),
  };
}

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function renderSceneToFiles(input: unknown): { files: FileMap; summary: string } {
  const { scene } = sceneRenderRequestSchema.parse(input);
  const app = renderAppTsx(scene);
  const styles = renderStylesCss(scene);
  const modelSourcePath = findLoadableModelSource(scene);
  return {
    files: {
      ...defaultFiles,
      "src/App.tsx": app,
      "src/styles.css": styles,
    },
    summary: modelSourcePath
      ? `已使用 ${scene.sceneType} DSL 加载 RAG 命中 GLB 基底，并叠加参数化 three.js 微调层。`
      : `已使用 ${scene.sceneType} DSL 程序化渲染 three.js 场景。`,
  };
}

export function createRuntimePatch(request: AgentTurnRequest): { patch: PatchEvent; intent: SemanticIntent; scene: SceneDsl; retrievalResults: RetrievalSearchResult[] } {
  const intent = parseSemanticIntent(request);
  const retrievalResults = defaultRetrievalForIntent(`${request.message} ${intent.subject}`, intent.category);
  return createRuntimePatchFromRetrieval(request, intent, retrievalResults);
}

export async function createRuntimePatchWithRag(request: AgentTurnRequest, visualIntent?: VisualIntent): Promise<{
  patch: PatchEvent;
  intent: SemanticIntent;
  scene: SceneDsl;
  retrievalResults: RetrievalSearchResult[];
  retrievalMode: "milvus" | "fallback";
}> {
  const intent = parseSemanticIntent(request, visualIntent);
  const retrievalQuery = visualIntent?.retrievalQuery || `${request.message} ${intent.subject} ${intent.constraints.join(" ")}`;
  const shouldUseAircraftRag = Boolean(intent.category) || /aircraft|飞机|发动机|机翼|机身|起落架|涡扇|翼型/.test(`${retrievalQuery} ${intent.subject}`.toLowerCase());
  const retrieval = shouldUseAircraftRag
    ? await searchAircraftRag({
        query: retrievalQuery,
        categories: intent.category ? [intent.category] : [],
        topK: 12,
      })
    : { results: [] as RetrievalSearchResult[], mode: "fallback" as const };
  return {
    ...createRuntimePatchFromRetrieval(request, intent, retrieval.results),
    retrievalMode: retrieval.mode,
  };
}

function createRuntimePatchFromRetrieval(
  request: AgentTurnRequest,
  intent: SemanticIntent,
  retrievalResults: RetrievalSearchResult[],
): { patch: PatchEvent; intent: SemanticIntent; scene: SceneDsl; retrievalResults: RetrievalSearchResult[] } {
  const scene = composeScene({ intent, retrievalResults } satisfies SceneComposeRequest);
  const rendered = renderSceneToFiles({ scene });
  const operations = (["src/App.tsx", "src/styles.css"] as const).map((path) => ({
    type: "replace_file" as const,
    path,
    content: rendered.files[path] ?? "",
  }));
  return {
    intent,
    retrievalResults,
    scene,
    patch: {
      type: "patch",
      summary: `${rendered.summary} 主题: ${intent.subject}；风格: ${intent.renderStyle}。`,
      generator: "runtime_composer",
      operations,
    },
  };
}

function normalizeRetrievalId(id?: string): string | undefined {
  return id?.replace(/^(asset|asset-view|template|wiki):/, "").split(":")[0];
}

function inferDecorativeParams(text: string): Record<string, unknown> | undefined {
  const lower = text.toLowerCase();
  if (!/heart|love|爱心|心形|桃心|粉色|pink|星星|star|礼物|gift|球|sphere|抽象|装饰|logo|图标/.test(lower)) return undefined;
  const shape = /heart|love|爱心|心形|桃心/.test(lower)
    ? "heart"
    : /星星|star/.test(lower)
      ? "star"
      : /球|sphere/.test(lower)
        ? "sphere"
        : "abstract";
  const color = /粉色|pink/.test(lower) ? "#ff5ca8" : /红色|red/.test(lower) ? "#ef4444" : /蓝色|blue/.test(lower) ? "#38bdf8" : "#a78bfa";
  return { shape, color };
}

function extractTurbofanRenderParams(scene: SceneDsl): Record<string, unknown> {
  const graph = scene.assemblyGraph;
  if (!graph) return {};
  const generator = graph.generators.find((item) => item.type === "radialArray" && item.partId === "bladeArray");
  const hubRadius = graph.ports.find((port) => port.id === "hub.outerRadius")?.radius;
  const outerRingInnerRadius = graph.ports.find((port) => port.id === "outerRing.innerRadius")?.radius;
  const outerRingPart = graph.parts.find((part) => part.id === "outerRing");
  const spinnerPart = graph.parts.find((part) => part.id === "spinner");
  const outerRingOuterRadius = typeof outerRingPart?.params.outerRadius === "number" ? outerRingPart.params.outerRadius : undefined;
  const hasOuterRing = Boolean(outerRingPart);
  return {
    engineVariant: hasOuterRing ? "ducted_turbofan" : "open_blisk",
    hasOuterRing,
    hasSpinnerCone: Boolean(spinnerPart),
    bladeCount: generator?.count,
    hubRadius,
    tipRadius: generator?.params.tipRadius,
    outerRingInnerRadius,
    outerRingOuterRadius,
    bladeThickness: generator?.params.thickness,
    bladeTwist: generator?.params.twist,
    bladeSweep: generator?.params.sweep,
    bladePitch: generator?.params.pitch,
  };
}

function findLoadableModelSource(scene: SceneDsl): string | undefined {
  for (const object of scene.objects) {
    const sourcePath = object.sourceAsset?.sourcePath;
    if (!sourcePath) continue;
    const normalized = sourcePath.replace(/\\/g, "/");
    if (!normalized.startsWith("assets/")) continue;
    if (/\.(glb|gltf)$/i.test(normalized)) return normalized;
  }
  return undefined;
}

function assetFileUrl(sourcePath: string): string {
  const baseUrl = process.env.API_PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || "http://127.0.0.1:8787";
  return `${baseUrl.replace(/\/$/, "")}/api/assets/file?path=${encodeURIComponent(sourcePath)}`;
}

function glbRuntimeHelpers(): string {
  return `
async function loadGlbAsset(root: THREE.Group, url: string, lineMaterial: THREE.LineBasicMaterial, renderStyle: string) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const pivot = new THREE.Group();
  pivot.name = "loaded-rag-glb";
  pivot.add(gltf.scene);
  normalizeLoadedModel(pivot, gltf.scene);
  applyModelMaterialAndEdges(gltf.scene, lineMaterial, renderStyle);
  root.add(pivot);
  return pivot;
}

function normalizeLoadedModel(pivot: THREE.Group, model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxAxis = Math.max(size.x, size.y, size.z, 0.001);
  const targetSize = 3.35;
  model.position.sub(center);
  pivot.scale.setScalar(targetSize / maxAxis);
}

function applyModelMaterialAndEdges(model: THREE.Object3D, lineMaterial: THREE.LineBasicMaterial, renderStyle: string) {
  const edgeMaterial = lineMaterial.clone();
  edgeMaterial.color.set(renderStyle === "technical_lines" || renderStyle === "engineering_white" ? "#050505" : "#111827");
  const meshMaterial = new THREE.MeshStandardMaterial({
    color: renderStyle === "technical_lines" || renderStyle === "engineering_white" ? "#f8fafc" : "#1f2937",
    metalness: renderStyle === "realistic" ? 0.82 : 0.25,
    roughness: renderStyle === "realistic" ? 0.26 : 0.44,
    side: THREE.DoubleSide,
  });
  model.traverse((item) => {
    const mesh = item as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (renderStyle === "technical_lines" || renderStyle === "engineering_white") {
      mesh.material = meshMaterial;
    }
    const edges = new THREE.EdgesGeometry(mesh.geometry, 22);
    const lines = new THREE.LineSegments(edges, edgeMaterial);
    lines.name = "glb-derived-edge-overlay";
    mesh.add(lines);
  });
}
`;
}

function renderAppTsx(scene: SceneDsl): string {
  const primary = scene.objects[0];
  const primitive = primary?.primitive ?? "generic_part";
  const primitiveParams = {
    ...(primary?.params ?? {}),
    ...(primitive === "turbofan_front" ? extractTurbofanRenderParams(scene) : {}),
  };
  const modelSourcePath = findLoadableModelSource(scene);
  const modelSource = modelSourcePath
    ? {
        path: modelSourcePath,
        url: assetFileUrl(modelSourcePath),
      }
    : null;
  return `import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#ffffff");

    const camera = new THREE.PerspectiveCamera(38, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.set(0, 0.2, 6.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = true;
    controls.target.set(0, 0, 0);

    const root = new THREE.Group();
    root.name = "aircraft-runtime-scene";
    scene.add(root);

    const lineMaterial = new THREE.LineBasicMaterial({ color: "#050505" });
    const sourceAsset = ${JSON.stringify(modelSource, null, 2)} as { path: string; url: string } | null;
    const proceduralLayer = new THREE.Group();
    proceduralLayer.name = "procedural-adjustment-layer";
    root.add(proceduralLayer);
    buildPrimitive(proceduralLayer, "${primitive}", lineMaterial, ${JSON.stringify(primitiveParams, null, 2)});
    if (sourceAsset) {
      const assetGroup = new THREE.Group();
      assetGroup.name = "rag-glb-asset-wrapper";
      root.add(assetGroup);
      loadGlbAsset(assetGroup, sourceAsset.url, lineMaterial, "${scene.renderStyle}").then(() => {
        proceduralLayer.visible = false;
        const view = (window as any).__AGENTIC_THREE_VIEW__;
        if (view) view.assetLoaded = true;
      }).catch((error) => {
        proceduralLayer.visible = true;
        const view = (window as any).__AGENTIC_THREE_VIEW__;
        if (view) view.assetLoadError = error instanceof Error ? error.message : String(error);
        console.warn("RAG GLB asset load failed; using procedural fallback.", error);
      });
    }
    const activeAnimations = ${JSON.stringify(scene.animations)};

    const light = new THREE.DirectionalLight("#ffffff", 2.2);
    light.position.set(3, 4, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight("#ffffff", 1.2));

    camera.lookAt(0, 0, 0);
    controls.update();

    (window as any).__AGENTIC_THREE_VIEW__ = {
      scene,
      camera,
      renderer,
      controls,
      grid: null,
      target: controls.target,
      sceneDsl: ${JSON.stringify(scene, null, 2)}
    };

    let frame = 0;
    const clock = new THREE.Clock();
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();
      if (activeAnimations.includes("gentle_loop")) {
        root.rotation.y = elapsed * 0.55;
        root.rotation.z = Math.sin(elapsed * 1.4) * 0.08;
        const pulse = 1 + Math.sin(elapsed * 2.4) * 0.045;
        root.scale.setScalar(pulse);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      renderer.render(scene, camera);
    };
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      delete (window as any).__AGENTIC_THREE_VIEW__;
      controls.dispose();
      root.traverse((item) => {
        const mesh = item as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material?.dispose();
      });
      lineMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className="scene-root" ref={mountRef} />;
}

function buildPrimitive(root: THREE.Group, primitive: string, lineMaterial: THREE.LineBasicMaterial, params: Record<string, unknown>) {
  if (primitive === "turbofan_front") {
    buildTurbofanFront(root, lineMaterial, params);
    return;
  }
  if (primitive === "wing_panel") {
    buildWingPanel(root, lineMaterial);
    return;
  }
  if (primitive === "decorative_shape") {
    buildDecorativeShape(root, lineMaterial, params);
    return;
  }
  buildGenericPart(root, lineMaterial);
}

${glbRuntimeHelpers()}

function addEdges(root: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.LineBasicMaterial, transform?: (line: THREE.LineSegments) => void) {
  const edges = new THREE.EdgesGeometry(geometry, 18);
  const line = new THREE.LineSegments(edges, material);
  transform?.(line);
  root.add(line);
  geometry.dispose();
}

function buildTurbofanFront(root: THREE.Group, material: THREE.LineBasicMaterial, params: Record<string, unknown>) {
  const bladeCount = typeof params.bladeCount === "number" ? params.bladeCount : 32;
  const hubRadius = typeof params.hubRadius === "number" ? params.hubRadius : 0.42;
  const tipRadius = typeof params.tipRadius === "number" ? params.tipRadius : 1.44;
  const outerRingInnerRadius = typeof params.outerRingInnerRadius === "number" ? params.outerRingInnerRadius : 1.52;
  const outerRingOuterRadius = typeof params.outerRingOuterRadius === "number" ? params.outerRingOuterRadius : 1.75;
  const bladeThickness = typeof params.bladeThickness === "number" ? params.bladeThickness : 0.055;
  const bladeTwist = typeof params.bladeTwist === "number" ? params.bladeTwist : 0.85;
  const bladeSweep = typeof params.bladeSweep === "number" ? params.bladeSweep : 0.18;
  const bladePitch = typeof params.bladePitch === "number" ? params.bladePitch : 0.36;
  const hasOuterRing = params.hasOuterRing !== false;
  const hasSpinnerCone = params.hasSpinnerCone !== false;

  if (hasOuterRing) {
    addEdges(root, new THREE.TorusGeometry((outerRingInnerRadius + outerRingOuterRadius) / 2, (outerRingOuterRadius - outerRingInnerRadius) / 2, 24, 128), material, (line) => {
      line.rotation.x = Math.PI / 2;
    });
  }
  addEdges(root, new THREE.TorusGeometry(hubRadius + 0.12, 0.035, 12, 96), material, (line) => {
    line.rotation.x = Math.PI / 2;
  });

  const bladeGeometry = makeBladeGeometry({
    rootRadius: hubRadius,
    tipRadius,
    rootWidth: 0.24,
    tipWidth: 0.14,
    thickness: bladeThickness,
    twist: bladeTwist,
    sweep: bladeSweep,
    pitch: bladePitch,
  });
  for (let index = 0; index < bladeCount; index += 1) {
    const angle = (index / bladeCount) * Math.PI * 2;
    addEdges(root, bladeGeometry.clone(), material, (blade) => {
      blade.rotation.z = angle;
    });
  }
  bladeGeometry.dispose();

  addEdges(root, new THREE.CylinderGeometry(hubRadius, hubRadius, 0.32, 48, 1), material, (line) => {
    line.rotation.x = Math.PI / 2;
  });
  if (!hasOuterRing) {
    for (let index = 0; index < 10; index += 1) {
      const angle = (index / 10) * Math.PI * 2;
      addEdges(root, new THREE.CylinderGeometry(0.035, 0.035, 0.34, 16, 1), material, (line) => {
        line.rotation.x = Math.PI / 2;
        line.position.set(Math.cos(angle) * (hubRadius * 0.68), Math.sin(angle) * (hubRadius * 0.68), 0.03);
      });
    }
  }
  if (hasSpinnerCone) {
    addEdges(root, new THREE.ConeGeometry(0.32, 0.66, 48, 1), material, (line) => {
      line.rotation.x = Math.PI / 2;
      line.position.z = 0.34;
    });
  } else {
    addEdges(root, new THREE.TorusGeometry(hubRadius * 0.42, 0.045, 16, 64), material, (line) => {
      line.rotation.x = Math.PI / 2;
      line.position.z = 0.05;
    });
  }
  addEdges(root, new THREE.TorusGeometry(0.36, 0.05, 12, 64), material, (line) => {
    line.rotation.x = Math.PI / 2;
    line.position.z = -0.24;
  });

  const spiral = new THREE.CurvePath<THREE.Vector3>();
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 90; i += 1) {
    const t = i / 89;
    const radius = 0.05 + t * 0.23;
    const angle = t * Math.PI * 4.5;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.34));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  const spiralGeometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(120));
  root.add(new THREE.Line(spiralGeometry, material));
}

function makeBladeGeometry(params: {
  rootRadius: number;
  tipRadius: number;
  rootWidth: number;
  tipWidth: number;
  thickness: number;
  twist: number;
  sweep: number;
  pitch: number;
}) {
  const stations = 6;
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= stations; i += 1) {
    const t = i / stations;
    const radius = THREE.MathUtils.lerp(params.rootRadius, params.tipRadius, t);
    const width = THREE.MathUtils.lerp(params.rootWidth, params.tipWidth, t);
    const theta = params.sweep * t + params.twist * (t - 0.5) * 0.18;
    const center = new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, (t - 0.5) * params.pitch);
    const tangent = new THREE.Vector3(-Math.sin(theta), Math.cos(theta), 0).normalize();
    const normal = new THREE.Vector3(0, 0, 1);
    const camber = Math.sin(t * Math.PI) * width * 0.16;
    const leading = center.clone().addScaledVector(tangent, width * 0.55).addScaledVector(normal, camber);
    const trailing = center.clone().addScaledVector(tangent, -width * 0.45).addScaledVector(normal, -camber * 0.55);
    for (const z of [-params.thickness / 2, params.thickness / 2]) {
      vertices.push(leading.x, leading.y, leading.z + z, trailing.x, trailing.y, trailing.z + z);
    }
  }
  for (let i = 0; i < stations; i += 1) {
    const a = i * 4;
    const b = a + 4;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
    indices.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
    indices.push(a, a + 2, b, a + 2, b + 2, b);
    indices.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildWingPanel(root: THREE.Group, material: THREE.LineBasicMaterial) {
  addEdges(root, new THREE.BoxGeometry(3.2, 0.08, 0.9, 4, 1, 2), material, (line) => {
    line.rotation.z = -0.12;
  });
}

function buildDecorativeShape(root: THREE.Group, lineMaterial: THREE.LineBasicMaterial, params: Record<string, unknown>) {
  const shapeName = typeof params.shape === "string" ? params.shape : "abstract";
  if (shapeName === "heart") {
    buildExtrudedHeart(root, lineMaterial, typeof params.color === "string" ? params.color : "#ff5ca8");
    return;
  }
  if (shapeName === "sphere") {
    const color = typeof params.color === "string" ? params.color : "#a78bfa";
    const geometry = new THREE.SphereGeometry(1.15, 48, 24);
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.12 });
    const mesh = new THREE.Mesh(geometry, material);
    root.add(mesh);
    addEdges(root, geometry.clone(), lineMaterial);
    return;
  }
  buildGenericPart(root, lineMaterial);
}

function buildExtrudedHeart(root: THREE.Group, lineMaterial: THREE.LineBasicMaterial, color: string) {
  const shape = new THREE.Shape();
  for (let index = 0; index <= 160; index += 1) {
    const t = (index / 160) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3) * 0.055;
    const y = (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * 0.055;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.42,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.08,
    bevelSegments: 8,
    curveSegments: 32,
  });
  geometry.center();
  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: "#7c174d",
    emissiveIntensity: 0.18,
    metalness: 0.08,
    roughness: 0.28,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI;
  mesh.scale.setScalar(1.45);
  root.add(mesh);

  const edges = new THREE.EdgesGeometry(geometry, 28);
  const edgeLines = new THREE.LineSegments(edges, lineMaterial);
  edgeLines.rotation.copy(mesh.rotation);
  edgeLines.scale.copy(mesh.scale);
  root.add(edgeLines);
}

function buildGenericPart(root: THREE.Group, material: THREE.LineBasicMaterial) {
  addEdges(root, new THREE.BoxGeometry(1.8, 0.8, 0.8, 3, 2, 2), material);
}
`;
}

function renderStylesCss(scene: SceneDsl): string {
  return `html,
body,
#root {
  width: 100%;
  height: 100%;
  margin: 0;
  background: #ffffff;
}

.scene-root {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: ${scene.objects.some((object) => object.primitive === "decorative_shape") ? "#fff5fb" : scene.renderStyle === "technical_lines" ? "#ffffff" : "#f8fafc"};
}

canvas {
  display: block;
}
`;
}
