import {
  type AgentTurnRequest,
  type FileMap,
  type PatchEvent,
  type RetrievalSearchResult,
  type SceneComposeRequest,
  type SceneDsl,
  type SemanticIntent,
  defaultFiles,
  sceneComposeRequestSchema,
  sceneDslSchema,
  sceneRenderRequestSchema,
  semanticIntentSchema,
} from "@agentic-three/shared";
import { defaultRetrievalForIntent } from "./aircraftRetrieval.js";
import { searchAircraftRag } from "./rag.js";

export function parseSemanticIntent(request: AgentTurnRequest): SemanticIntent {
  const text = request.message.toLowerCase();
  const isDecorative = /heart|love|爱心|心形|桃心|粉色|pink|星星|star|礼物|gift|球|sphere|抽象|装饰|logo|图标/.test(text);
  const isEngine = /engine|turbofan|fan|发动机|涡扇|进气口|叶片/.test(text) || request.images.length > 0;
  const isWing = /wing|机翼|翼型/.test(text);
  const renderStyle = /黑线|白图|线稿|工程/.test(text) ? "technical_lines" : isDecorative ? "realistic" : "engineering_white";
  const view = /侧面|side/.test(text) ? "side" : /俯视|top/.test(text) ? "top" : "front";
  return semanticIntentSchema.parse({
    subject: isDecorative ? "general decorative 3D scene" : isEngine ? "turbofan engine front view" : isWing ? "aircraft wing component" : "aircraft component",
    category: isEngine ? "engine" : isWing ? "wing" : undefined,
    view,
    renderStyle,
    requestedOutputs: isDecorative ? ["animated_preview", "sandpack_preview"] : request.images.length ? ["image_reconstruction", "sandpack_preview"] : ["sandpack_preview"],
    constraints: [
      isDecorative ? `general decorative scene: ${request.message}` : renderStyle === "technical_lines" ? "white background with black linework" : "clean aircraft component preview",
      "no automatic rotation",
      "preserveDrawingBuffer for screenshots",
    ],
  });
}

export function composeScene(input: unknown): SceneDsl {
  const { intent, retrievalResults } = sceneComposeRequestSchema.parse(input);
  const bestAsset = retrievalResults.find((item) => item.kind === "asset_view" || item.kind === "asset");
  const bestTemplate = retrievalResults.find((item) => item.kind === "template");
  const decorativeParams = inferDecorativeParams(`${intent.subject}\n${intent.constraints.join("\n")}`);
  const isDecorative = Boolean(decorativeParams);
  const primitive = isDecorative ? "decorative_shape" : intent.category === "engine" ? "turbofan_front" : intent.category === "wing" ? "wing_panel" : "generic_part";
  const templateId = normalizeRetrievalId(bestTemplate?.id);
  return sceneDslSchema.parse({
    sceneType: templateId === "front_technical_view" ? "front_technical_view" : intent.category === "engine" ? "engine_showcase" : "component_detail",
    cameraPreset: intent.view,
    lightingPreset: "engineering_white",
    renderStyle: intent.renderStyle,
    objects: [
      {
        id: "primary-aircraft-component",
        assetId: bestAsset?.sourceId ?? normalizeRetrievalId(bestAsset?.id),
        primitive,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: 1,
        params: decorativeParams ?? {},
      },
    ],
    annotations: intent.constraints,
    animations: isDecorative ? ["gentle_loop"] : [],
  });
}

export function renderSceneToFiles(input: unknown): { files: FileMap; summary: string } {
  const { scene } = sceneRenderRequestSchema.parse(input);
  const app = renderAppTsx(scene);
  const styles = renderStylesCss(scene);
  return {
    files: {
      ...defaultFiles,
      "src/App.tsx": app,
      "src/styles.css": styles,
    },
    summary: `已使用 ${scene.sceneType} DSL 程序化渲染 three.js 场景。`,
  };
}

export function createRuntimePatch(request: AgentTurnRequest): { patch: PatchEvent; intent: SemanticIntent; scene: SceneDsl; retrievalResults: RetrievalSearchResult[] } {
  const intent = parseSemanticIntent(request);
  const retrievalResults = defaultRetrievalForIntent(`${request.message} ${intent.subject}`, intent.category);
  return createRuntimePatchFromRetrieval(request, intent, retrievalResults);
}

export async function createRuntimePatchWithRag(request: AgentTurnRequest): Promise<{
  patch: PatchEvent;
  intent: SemanticIntent;
  scene: SceneDsl;
  retrievalResults: RetrievalSearchResult[];
  retrievalMode: "pgvector" | "fallback";
}> {
  const intent = parseSemanticIntent(request);
  const shouldUseAircraftRag = Boolean(intent.category) || /aircraft|飞机|发动机|机翼|机身|起落架|涡扇/.test(`${request.message} ${intent.subject}`.toLowerCase());
  const retrieval = shouldUseAircraftRag
    ? await searchAircraftRag({
        query: `${request.message} ${intent.subject} ${intent.constraints.join(" ")}`,
        categories: intent.category ? [intent.category] : [],
        topK: 6,
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

function renderAppTsx(scene: SceneDsl): string {
  const primary = scene.objects[0];
  const primitive = primary?.primitive ?? "generic_part";
  const primitiveParams = primary?.params ?? {};
  return `import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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
    buildPrimitive(root, "${primitive}", lineMaterial, ${JSON.stringify(primitiveParams, null, 2)});
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
    buildTurbofanFront(root, lineMaterial);
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

function addEdges(root: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.LineBasicMaterial, transform?: (line: THREE.LineSegments) => void) {
  const edges = new THREE.EdgesGeometry(geometry, 18);
  const line = new THREE.LineSegments(edges, material);
  transform?.(line);
  root.add(line);
  geometry.dispose();
}

function buildTurbofanFront(root: THREE.Group, material: THREE.LineBasicMaterial) {
  addEdges(root, new THREE.TorusGeometry(1.75, 0.18, 24, 128), material, (line) => {
    line.rotation.x = Math.PI / 2;
  });
  addEdges(root, new THREE.TorusGeometry(1.18, 0.035, 12, 96), material, (line) => {
    line.rotation.x = Math.PI / 2;
  });

  const bladeCount = 24;
  for (let index = 0; index < bladeCount; index += 1) {
    const angle = (index / bladeCount) * Math.PI * 2;
    addEdges(root, new THREE.BoxGeometry(0.08, 0.82, 0.035, 1, 4, 1), material, (blade) => {
      blade.position.set(Math.cos(angle) * 0.72, Math.sin(angle) * 0.72, 0);
      blade.rotation.z = angle - Math.PI / 2;
      blade.rotation.y = 0.35;
      blade.scale.x = 1 + index * 0.002;
    });
  }

  addEdges(root, new THREE.SphereGeometry(0.32, 32, 16), material, (line) => {
    line.scale.z = 0.55;
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
