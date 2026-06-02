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

export function parseSemanticIntent(request: AgentTurnRequest): SemanticIntent {
  const text = request.message.toLowerCase();
  const isEngine = /engine|turbofan|fan|发动机|涡扇|进气口|叶片/.test(text) || request.images.length > 0;
  const isWing = /wing|机翼|翼型/.test(text);
  const renderStyle = /黑线|白图|线稿|工程|ppt|截图/.test(text) ? "technical_lines" : "engineering_white";
  const view = /侧面|side/.test(text) ? "side" : /俯视|top/.test(text) ? "top" : "front";
  return semanticIntentSchema.parse({
    subject: isEngine ? "turbofan engine front view" : isWing ? "aircraft wing component" : "aircraft component",
    category: isEngine ? "engine" : isWing ? "wing" : undefined,
    view,
    renderStyle,
    requestedOutputs: request.images.length ? ["image_reconstruction", "sandpack_preview"] : ["sandpack_preview"],
    constraints: [
      renderStyle === "technical_lines" ? "white background with black linework" : "clean aircraft component preview",
      "no automatic rotation",
      "preserveDrawingBuffer for screenshots",
    ],
  });
}

export function composeScene(input: unknown): SceneDsl {
  const { intent, retrievalResults } = sceneComposeRequestSchema.parse(input);
  const bestAsset = retrievalResults.find((item) => item.kind === "asset");
  const bestTemplate = retrievalResults.find((item) => item.kind === "template");
  const primitive = intent.category === "engine" ? "turbofan_front" : intent.category === "wing" ? "wing_panel" : "generic_part";
  return sceneDslSchema.parse({
    sceneType: bestTemplate?.id === "front_technical_view" ? "front_technical_view" : intent.category === "engine" ? "engine_showcase" : "component_detail",
    cameraPreset: intent.view,
    lightingPreset: "engineering_white",
    renderStyle: intent.renderStyle,
    objects: [
      {
        id: "primary-aircraft-component",
        assetId: bestAsset?.id,
        primitive,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: 1,
      },
    ],
    annotations: intent.constraints,
    animations: [],
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

function renderAppTsx(scene: SceneDsl): string {
  const primary = scene.objects[0];
  const primitive = primary?.primitive ?? "generic_part";
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
    buildPrimitive(root, "${primitive}", lineMaterial);

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
    const animate = () => {
      frame = requestAnimationFrame(animate);
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

function buildPrimitive(root: THREE.Group, primitive: string, lineMaterial: THREE.LineBasicMaterial) {
  if (primitive === "turbofan_front") {
    buildTurbofanFront(root, lineMaterial);
    return;
  }
  if (primitive === "wing_panel") {
    buildWingPanel(root, lineMaterial);
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
  background: ${scene.renderStyle === "technical_lines" ? "#ffffff" : "#f8fafc"};
}

canvas {
  display: block;
}
`;
}
