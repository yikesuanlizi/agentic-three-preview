import { type ClipboardEvent, type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SandpackCodeEditor,
  SandpackLayout,
  SandpackPreview,
  SandpackProvider,
  useSandpack,
} from "@codesandbox/sandpack-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Bot, Camera, Code2, Grid3X3, History, ImagePlus, Plus, RotateCcw, RotateCw, Send, Settings, Sparkles, User, X } from "lucide-react";
import {
  ALLOWED_FILE_PATHS,
  type AllowedFilePath,
  type AssetImportJob,
  type AppSettings,
  type FileMap,
  type ImageInput,
  type ModelConfig,
  type PatchEvent,
  type QualityInspectionResult,
  type QualityReviewView,
  type RetrievalSearchResult,
  type RuntimeComposerConfig,
  type SceneDsl,
  type ScreenshotMode,
  type SkillCreateRequest,
  type StreamEvent,
  applyPatch,
  defaultFiles,
  imageInputSchema,
  streamEventSchema,
} from "@agentic-three/shared";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

type RuntimeError = {
  message: string;
  stack?: string;
  source?: string;
};

type QualityHistoryEntry = {
  round: number;
  score?: number;
  candidateScore?: number;
  status?: QualityInspectionResult["status"];
  modelUsed?: string;
  selectedBest?: boolean;
  runtimeError?: string;
};

type WorkflowBestRound = {
  round: number;
  score: number;
  candidateScore?: number;
  modelUsed?: string;
};

function modelNodeLabel(node: ModelConfig["node"]): string {
  if (node === "review_agent") return "safety_review";
  return node;
}

function modelNodeDescription(node: ModelConfig["node"]): string {
  if (node === "coder_agent") return "代码生成 / 多模态建模";
  if (node === "planner_agent") return "任务规划 / Skill 选择";
  if (node === "review_agent") return "补丁安全审查";
  if (node === "summary") return "对话摘要 / 记忆压缩";
  return "默认兜底模型";
}

function visionReviewDescription(index: number): string {
  return `第 ${index + 1} 顺位视觉质检`;
}

const QUALITY_REVIEW_VIEWS: QualityReviewView[] = ["front", "side", "top", "three_quarter"];

function computeCandidateSelectionScore(result: QualityInspectionResult): number {
  if (typeof result.candidateScore === "number") return result.candidateScore;
  const scores = result.scores;
  if (scores.renderHealth < 0.65) return Math.min(result.score, scores.renderHealth * 0.5);

  const structuralScore = clamp01(
    scores.geometry * 0.46 +
      scores.referenceSimilarity * 0.24 +
      scores.material * 0.2 +
      scores.renderHealth * 0.1,
  );
  const hasNonVisionCriticalFailure = result.checks.some(
    (check) => !check.pass && check.severity === "critical" && !isVisionReviewProcessFailure(check.item, check.note),
  );
  const criticalPenalty = hasNonVisionCriticalFailure ? 0.12 : 0;
  const successfulVisionViews = result.viewResults.filter((view) => view.modelUsed && view.modelUsed !== "vision-error").length;
  const allVisionFailedPenalty = result.viewResults.length > 0 && successfulVisionViews === 0 ? 0.08 : 0;

  return clamp01(Math.max(result.score, structuralScore) - criticalPenalty - allVisionFailedPenalty);
}

function isVisionReviewProcessFailure(item: string, note?: string): boolean {
  return /视觉质检失败|视觉对比|必须完成视觉|vision[-_ ]?error|模型.*json|模型.*返回|限速|rate/i.test(`${item}\n${note ?? ""}`);
}

function formatFeatureMatchScore(result: QualityInspectionResult): string {
  if (!result.featureMatches.length) return "-";
  const totalConfidence = result.featureMatches.reduce((sum, match) => sum + match.confidence, 0);
  if (totalConfidence <= 0) return "-";
  const score = result.featureMatches.reduce((sum, match) => {
    const value = match.pass ? 1 : Math.max(0, 1 - match.distance);
    return sum + value * match.confidence;
  }, 0) / totalConfidence;
  return score.toFixed(2);
}

function describePatchOperations(patch: PatchEvent): string {
  const details = patch.operations.map((operation) => {
    if (operation.type === "parameter_patch") {
      const params = Object.entries(operation.parameters).map(([key, value]) => `${key}=${String(value)}`).join(", ");
      return `参数微调${operation.targetFunction ? `(${operation.targetFunction})` : ""}: ${params || "无参数"}`;
    }
    if (operation.type === "replace_function") return `函数替换: ${operation.functionName}`;
    return `文件替换: ${operation.path}`;
  });
  return details.length ? `\n补丁类型: ${details.join("；")}` : "";
}

function formatEmbeddingSimilarity(result: QualityInspectionResult): string {
  if (result.scores.embeddingSimilarity > 0) return result.scores.embeddingSimilarity.toFixed(2);
  const matched = result.embeddingMatches.find((match) => match.matched);
  return matched ? ((matched.similarity + 1) / 2).toFixed(2) : "-";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

type MemorySession = {
  id: string;
  title: string;
  updatedAt: string;
};

type MemoryTurn = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

type SkillCard = {
  id: string;
  title: string;
  description: string;
};

type RagStatus = {
  ready: boolean;
  databaseUrl: string;
  fallbackForced?: boolean;
  lastError?: string;
};

type RagIngestResult = {
  ok: boolean;
  documentCount: number;
  mode: "milvus" | "fallback";
  message: string;
};

type KnowledgeClearResult = {
  ok: boolean;
  deletedFiles: number;
  clearedTables: string[];
  milvusDropped: boolean;
  message: string;
};

type RagSourceResult = {
  kind: string;
  id: string;
  sourcePath: string;
  source: unknown;
};

type SessionState = {
  summary: {
    userGoal: string;
    codeState: string;
    nextSteps: string;
    updatedAt?: string;
  };
  latestRun?: {
    runId: string;
    status: string;
    error?: string | null;
  };
  latestStableSnapshot?: {
    files: FileMap;
    label: string;
    createdAt: string;
  };
};

type RunRecord = {
  runId: string;
  sessionId: string;
  status: "pending" | "running" | "success" | "error" | "interrupted" | string;
  error?: string | null;
  updatedAt?: string;
};

type RunEventRecord = {
  id: number;
  runId: string;
  sessionId: string;
  eventType: string;
  content: string;
  createdAt: string;
};

type WorkflowRunState = {
  run: RunRecord;
  events: RunEventRecord[];
};

type PendingWorkflowResume = {
  runId: string;
  userGoal: string;
  scene: SceneDsl;
  config: RuntimeComposerConfig;
  referenceImages: ImageInput[];
  patchGenerator: PatchEvent["generator"];
};

type PreviewView = "front" | "back" | "left" | "right" | "top" | "bottom";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787";
const initialAssistantMessage = "准备好了。把你的 three.js 场景想法发给我。";
const activeSessionStorageKey = "agentic-three:active-session-id";
const maxInputImageEdge = 1600;
const inputImageQuality = 0.86;

function createInitialSessionId(): string {
  try {
    return window.localStorage.getItem(activeSessionStorageKey) || crypto.randomUUID();
  } catch {
    return crypto.randomUUID();
  }
}

export default function App() {
  const files = useMemo(() => toSandpackFiles(defaultFiles), []);

  return (
    <SandpackProvider
      template="react-ts"
      files={files}
      customSetup={{
        dependencies: {
          three: "0.168.0",
          "@types/three": "0.168.0",
        },
      }}
      options={{
        activeFile: "/src/App.tsx",
        visibleFiles: ["/src/App.tsx", "/src/main.tsx", "/src/styles.css", "/package.json"],
        externalResources: [],
        recompileMode: "delayed",
        recompileDelay: 400,
      }}
    >
      <Workspace />
    </SandpackProvider>
  );
}

function Workspace() {
  const { sandpack } = useSandpack();
  const isNarrowViewport = useIsNarrowViewport();
  const [sessionId, setSessionId] = useState<string>(() => createInitialSessionId());
  const [sessions, setSessions] = useState<MemorySession[]>([]);
  const [showHistory, setShowHistory] = useState(true);
  const [showCode, setShowCode] = useState(true);
  const [gridVisible, setGridVisible] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [envStatus, setEnvStatus] = useState<Record<string, boolean>>({});
  const [screenshotMode, setScreenshotMode] = useState<ScreenshotMode>("download");
  const [workflowConfig, setWorkflowConfig] = useState<RuntimeComposerConfig | null>(null);
  const [latestSceneDsl, setLatestSceneDsl] = useState<SceneDsl | null>(null);
  const [latestPatchGenerator, setLatestPatchGenerator] = useState<PatchEvent["generator"] | null>(null);
  const [isQualityRunning, setIsQualityRunning] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: initialAssistantMessage,
    },
  ]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageInput[]>([]);
  const [runtimeErrors, setRuntimeErrors] = useState<RuntimeError[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [pendingWorkflowResume, setPendingWorkflowResume] = useState<PendingWorkflowResume | null>(null);
  const [past, setPast] = useState<FileMap[]>([]);
  const [future, setFuture] = useState<FileMap[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const runtimeErrorsRef = useRef<RuntimeError[]>([]);
  const filesRef = useRef<FileMap>(defaultFiles);
  const restoredSessionRef = useRef(false);
  const restoredRunEventIdsRef = useRef<Set<number>>(new Set());
  const [runEventPollingActive, setRunEventPollingActive] = useState(false);

  const currentFiles = useCallback(() => filesRef.current, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(activeSessionStorageKey, sessionId);
    } catch {
      // Best effort only: private browsing or locked storage should not break the app.
    }
  }, [sessionId]);

  useEffect(() => {
    runtimeErrorsRef.current = runtimeErrors;
  }, [runtimeErrors]);

  const refreshSessions = useCallback(async () => {
    const response = await fetch(`${apiUrl}/api/memory/sessions`);
    if (!response.ok) return;
    const data = (await response.json()) as { sessions: MemorySession[] };
    setSessions(data.sessions);
  }, []);

  const deleteSession = useCallback(
    async (targetId: string) => {
      const response = await fetch(`${apiUrl}/api/memory/sessions/${encodeURIComponent(targetId)}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) return;
      await refreshSessions();
      if (targetId === sessionId) {
        startNewSession();
      }
    },
    [sessionId, refreshSessions],
  );

  const refreshSettings = useCallback(async () => {
    const response = await fetch(`${apiUrl}/api/settings`);
    if (!response.ok) return;
    const data = (await response.json()) as { settings: AppSettings; env: Record<string, boolean> };
    setAppSettings(data.settings);
    setEnvStatus(data.env);
    setScreenshotMode(data.settings.screenshotMode);
  }, []);

  const refreshSkills = useCallback(async () => {
    const response = await fetch(`${apiUrl}/api/skills`);
    if (!response.ok) return;
    const data = (await response.json()) as { skills: SkillCard[] };
    setSkills(data.skills);
  }, []);

  useEffect(() => {
    void refreshSessions();
    void refreshSettings();
    void refreshSkills();
  }, [refreshSessions, refreshSettings, refreshSkills]);

  const openSettings = async () => {
    await Promise.all([refreshSettings(), refreshSkills()]);
    setSettingsOpen(true);
  };

  const applySnapshot = useCallback(
    (snapshot: FileMap) => {
      filesRef.current = snapshot;
      for (const path of ALLOWED_FILE_PATHS) {
        sandpack.updateFile(`/${path}`, snapshot[path]);
      }
    },
    [sandpack],
  );

  const applyAgentPatch = useCallback(
    (patch: PatchEvent) => {
      const before = currentFiles();
      let after: FileMap;
      try {
        after = applyPatch(before, patch);
      } catch (error) {
        setMessages((items) => [
          ...items,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `补丁未应用: ${error instanceof Error ? error.message : String(error)}。已保留当前代码。`,
          },
        ]);
        throw error;
      }
      setPast((items) => [...items, before].slice(-20));
      setFuture([]);
      setRuntimeErrors([]);
      runtimeErrorsRef.current = [];
      applySnapshot(after);
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `已应用补丁: ${patch.summary}${describePatchOperations(patch)}`,
        },
      ]);
    },
    [applySnapshot, currentFiles],
  );

  const undo = () => {
    const snapshot = past.at(-1);
    if (!snapshot) return;
    setFuture((items) => [currentFiles(), ...items].slice(0, 20));
    setPast((items) => items.slice(0, -1));
    applySnapshot(snapshot);
  };

  const redo = () => {
    const snapshot = future[0];
    if (!snapshot) return;
    setPast((items) => [...items, currentFiles()].slice(-20));
    setFuture((items) => items.slice(1));
    applySnapshot(snapshot);
  };

  const startNewSession = () => {
    const nextSessionId = crypto.randomUUID();
    setSessionId(nextSessionId);
    setMessages([{ id: crypto.randomUUID(), role: "assistant", content: initialAssistantMessage }]);
    setImages([]);
    setRuntimeErrors([]);
    setPast([]);
    setFuture([]);
    setCurrentRunId(undefined);
    restoredRunEventIdsRef.current = new Set();
    setRunEventPollingActive(false);
    setLatestSceneDsl(null);
    setWorkflowConfig(null);
    applySnapshot(defaultFiles);
  };

  const loadSession = async (targetSessionId: string) => {
    const [turnsResponse, stateResponse] = await Promise.all([
      fetch(`${apiUrl}/api/memory/sessions/${targetSessionId}/turns`),
      fetch(`${apiUrl}/api/sessions/${targetSessionId}/state`),
    ]);
    if (!turnsResponse.ok) return;
    const data = (await turnsResponse.json()) as { turns: MemoryTurn[] };
    const state = stateResponse.ok ? ((await stateResponse.json()) as SessionState) : undefined;
    const runState = state?.latestRun?.runId ? await fetchWorkflowRunState(state.latestRun.runId) : undefined;
    const restoredEventMessages = runState?.events.length ? runEventsToChatMessages(runState.events) : [];
    restoredRunEventIdsRef.current = new Set(runState?.events.map((event) => event.id) ?? []);
    setSessionId(targetSessionId);
    const turnMessages = data.turns.length
      ? data.turns.map((turn) => ({
          id: String(turn.id),
          role: turn.role,
          content: turn.content,
        }))
      : [{ id: crypto.randomUUID(), role: "assistant" as const, content: initialAssistantMessage }];
    setMessages([
      ...turnMessages,
      ...(restoredEventMessages.length
        ? [
            {
              id: crypto.randomUUID(),
              role: "system" as const,
              content: `已恢复最近一次运行流程记录，共 ${restoredEventMessages.length} 条事件。刷新不会再把过程日志藏起来了。`,
            },
            ...restoredEventMessages,
          ]
        : []),
    ]);
    if (state?.latestStableSnapshot?.files) {
      applySnapshot(state.latestStableSnapshot.files);
    }
    if (runState?.run.runId) {
      setCurrentRunId(runState.run.runId);
      setRunEventPollingActive(runState.run.status === "pending" || runState.run.status === "running");
    }
    const latestWorkflow = deriveLatestWorkflowState(runState?.events ?? []);
    if (latestWorkflow.config) setWorkflowConfig(latestWorkflow.config);
    if (latestWorkflow.scene) setLatestSceneDsl(latestWorkflow.scene);
    if (runState && shouldResumeWorkflowAfterRefresh(runState) && latestWorkflow.scene && latestWorkflow.config) {
      const referenceImages = await fetchRecentInputImages(targetSessionId);
      setPendingWorkflowResume({
        runId: runState.run.runId,
        userGoal: latestWorkflow.userGoal,
        scene: latestWorkflow.scene,
        config: latestWorkflow.config,
        referenceImages,
        patchGenerator: latestWorkflow.patchGenerator,
      });
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `检测到刷新前质检闭环尚未最终保存，已准备从 run ${runState.run.runId.slice(0, 8)} 继续。参考图 ${referenceImages.length} 张。`,
        },
      ]);
    }
    const failedRun = state?.latestRun?.status === "error" ? state.latestRun : undefined;
    if (failedRun) {
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `上次运行未正常完成: ${failedRun.error ?? "未知错误"}。已恢复最后稳定快照。`,
        },
      ]);
    }
  };

  useEffect(() => {
    if (restoredSessionRef.current) return;
    restoredSessionRef.current = true;
    void loadSession(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!currentRunId || !runEventPollingActive) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const runState = await fetchWorkflowRunState(currentRunId);
        if (!runState || cancelled) return;
        const nextEvents = runState.events.filter((event) => !restoredRunEventIdsRef.current.has(event.id));
        if (nextEvents.length) {
          nextEvents.forEach((event) => restoredRunEventIdsRef.current.add(event.id));
          setMessages((items) => [...items, ...runEventsToChatMessages(nextEvents)]);
          const latestWorkflow = deriveLatestWorkflowState(nextEvents);
          if (latestWorkflow.config) setWorkflowConfig(latestWorkflow.config);
          if (latestWorkflow.scene) setLatestSceneDsl(latestWorkflow.scene);
        }
        if (runState.run.status !== "pending" && runState.run.status !== "running") {
          setRunEventPollingActive(false);
        }
      } catch (error) {
        if (!cancelled) {
          setMessages((items) => [
            ...items,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `恢复运行日志轮询失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ]);
          setRunEventPollingActive(false);
        }
      }
    };
    const id = window.setInterval(() => void poll(), 1800);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [currentRunId, runEventPollingActive]);

  const postPreviewCommand = useCallback((payload: Record<string, unknown>) => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Sandpack Preview"]');
    iframe?.contentWindow?.postMessage(payload, "*");
  }, []);

  const setPreviewView = (view: PreviewView) => {
    postPreviewCommand({ type: "agentic-three:set-view", view });
  };

  const toggleGrid = () => {
    setGridVisible((visible) => {
      const next = !visible;
      postPreviewCommand({ type: "agentic-three:set-grid", visible: next });
      return next;
    });
  };

  const toggleAutoRotate = () => {
    setAutoRotate((enabled) => {
      const next = !enabled;
      postPreviewCommand({ type: "agentic-three:set-auto-rotate", enabled: next });
      return next;
    });
  };

  const capturePreview = async () => {
    try {
      const dataUrl = await requestPreviewCapture(postPreviewCommand);
      const fileName = `three-scene-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      if (screenshotMode === "download" || screenshotMode === "both") {
        downloadDataUrl(dataUrl, fileName);
      }
      let savedPath = "";
      if (screenshotMode === "save" || screenshotMode === "both") {
        const response = await fetch(`${apiUrl}/api/artifacts/screenshots`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            runId: currentRunId,
            dataUrl,
            view: "free",
            mode: screenshotMode,
          }),
        });
        if (!response.ok) throw new Error(`截图保存失败: ${response.status}`);
        const data = (await response.json()) as { artifact: { path: string } };
        savedPath = data.artifact.path;
      }
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          content:
            screenshotMode === "download"
              ? `截图已进入浏览器下载: ${fileName}`
              : screenshotMode === "save"
                ? `截图已保存到项目目录: ${savedPath}`
                : `截图已下载并保存到项目目录: ${savedPath}`,
        },
      ]);
    } catch (error) {
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
  };

  const runQualityWorkflow = useCallback(
    async (options: {
      scene: SceneDsl;
      config: RuntimeComposerConfig;
      userGoal: string;
      runId?: string;
      referenceImages: ImageInput[];
      runtimeErrors: RuntimeError[];
      patchGenerator: PatchEvent["generator"];
    }) => {
      if (!options.config.enabled || !options.config.autoCaptureAfterPatch) return;
      const allowDslRevision = options.patchGenerator === "runtime_composer";
      const visualReferenceMinScore = options.referenceImages.length && !allowDslRevision
        ? Math.max(options.config.minQualityScore, 0.88)
        : options.config.minQualityScore;
      setIsQualityRunning(true);
      let currentScene = options.scene;
      let noImprovementRounds = 0;
      let runtimeRepairRounds = 0;
      const qualityHistory: QualityHistoryEntry[] = [];
      let best:
        | {
            round: number;
            score: number;
            selectionScore: number;
            path: string;
            screenshotPaths: Record<string, string>;
            result: QualityInspectionResult;
            files: FileMap;
            scene: SceneDsl;
          }
        | undefined;
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: allowDslRevision
            ? `已进入 Runtime Composer 多轮质检，最多 ${options.config.maxRevisionRounds} 轮。`
            : `已进入 LLM coder 视觉闭环，最多 ${options.config.maxRevisionRounds} 轮：截图、视觉检查，并由 coder 修正代码，不再用 Runtime Composer 覆盖代码。`,
        },
      ]);
      try {
        let round = 1;
        while (round <= options.config.maxRevisionRounds) {
          await delay(options.config.captureDelayMs);
          const preCaptureErrors = runtimeErrorsRef.current;
          if (!allowDslRevision && preCaptureErrors.length) {
            const bestSnapshotForRepair = best;
            const repairBaseFiles = bestSnapshotForRepair && runtimeRepairRounds > 0 ? bestSnapshotForRepair.files : currentFiles();
            if (runtimeRepairRounds >= 3) {
              if (bestSnapshotForRepair) applySnapshot(bestSnapshotForRepair.files);
              throw new Error("连续运行错误修复仍未稳定，已停止当前闭环，避免继续消耗视觉轮数。");
            }
            if (bestSnapshotForRepair && runtimeRepairRounds > 0) {
              applySnapshot(bestSnapshotForRepair.files);
              setMessages((items) => [
                ...items,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  content: `连续运行错误修复未稳定，已先回滚到第 ${bestSnapshotForRepair.round} 轮可截图版本，再尝试最小运行错误修复。`,
                },
              ]);
            }
            runtimeRepairRounds += 1;
            const repaired = await repairRuntimeErrorBeforeCapture({
              sessionId,
              round,
              runId: options.runId,
              userGoal: options.userGoal,
              files: repairBaseFiles,
              referenceImages: options.referenceImages,
              runtimeErrors: preCaptureErrors,
              qualityHistory,
              bestRound: bestSnapshotForRepair
                ? {
                    round: bestSnapshotForRepair.round,
                    score: bestSnapshotForRepair.score,
                    candidateScore: bestSnapshotForRepair.selectionScore,
                    modelUsed: bestSnapshotForRepair.result.modelUsed,
                  }
                : undefined,
              repairAttempt: runtimeRepairRounds,
              dualCoderRequested: runtimeRepairRounds >= 2,
              dualCoderReason: runtimeRepairRounds >= 2 ? `连续 ${runtimeRepairRounds} 次运行错误修复仍未稳定，启用双 coder 会诊` : "",
              applyAgentPatch,
              setLatestPatchGenerator,
              setMessages,
            });
            if (repaired) continue;
            throw new Error("运行错误修复失败，已停止本轮闭环，避免继续用坏代码截图。");
          }
          let screenshots: Awaited<ReturnType<typeof captureWorkflowScreenshots>>;
          try {
            screenshots = await captureWorkflowScreenshots({
              sessionId,
              runId: options.runId,
              round,
              postPreviewCommand,
            });
          } catch (captureError) {
            const latestRuntimeErrors = runtimeErrorsRef.current.length ? runtimeErrorsRef.current : options.runtimeErrors;
            const roundFiles = currentFiles();
            const syntheticQuality = buildRenderFailureQuality(captureError, latestRuntimeErrors);
            setMessages((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `第 ${round} 轮截图失败，转入 coder 运行错误修复: ${captureError instanceof Error ? captureError.message : String(captureError)}。${latestRuntimeErrors[0]?.message ? `最近运行错误: ${latestRuntimeErrors[0].message}` : ""}`,
              },
            ]);
            if (allowDslRevision) throw captureError;
            if (runtimeRepairRounds >= 3) {
              if (best) applySnapshot(best.files);
              throw new Error("截图失败修复连续未稳定，已回滚 best 并停止，避免继续用坏代码截图。");
            }
            runtimeRepairRounds += 1;
            const coderRevisionResponse = await fetch(`${apiUrl}/api/coder/revise`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                sessionId,
                runId: options.runId,
                round,
                userGoal: options.userGoal,
                files: roundFiles,
                quality: syntheticQuality,
                referenceImages: options.referenceImages,
                screenshots: [],
                runtimeErrors: latestRuntimeErrors.length
                  ? latestRuntimeErrors
                  : [{ message: captureError instanceof Error ? captureError.message : String(captureError), source: "capture" }],
                qualityHistory,
                bestRound: best
                  ? {
                      round: best.round,
                      score: best.score,
                      candidateScore: best.selectionScore,
                      modelUsed: best.result.modelUsed,
                    }
                  : undefined,
                repairAttempt: runtimeRepairRounds,
                dualCoderRequested: runtimeRepairRounds >= 2,
                dualCoderReason: runtimeRepairRounds >= 2 ? `连续 ${runtimeRepairRounds} 次截图/运行错误修复仍未稳定，启用双 coder 会诊` : "",
              }),
            });
            if (!coderRevisionResponse.ok) throw new Error(`截图失败后的 coder 修复请求失败: ${coderRevisionResponse.status}`);
            const revisionData = (await coderRevisionResponse.json()) as {
              patch: PatchEvent;
              modelUsed?: string;
              fallbackReason?: string;
              dualCoderUsed?: boolean;
              discussionModels?: string[];
              discussionSummary?: string;
            };
            applyAgentPatch(revisionData.patch);
            setLatestPatchGenerator("llm_coder");
            setMessages((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `${revisionData.dualCoderUsed ? `双 coder 已启用: ${(revisionData.discussionModels ?? []).join(" + ") || "GLM + Doubao"}。${revisionData.discussionSummary ?? ""}\n` : ""}已根据运行错误调用 LLM coder 修复代码。模型: ${revisionData.modelUsed ?? "unknown"}。${revisionData.patch.summary}`,
              },
            ]);
            continue;
          }
          const nonBlankRatios = await Promise.all(screenshots.map((screenshot) => estimateNonBlankPixelRatio(screenshot.dataUrl)));
          const nonBlankRatio = Math.min(...nonBlankRatios);
          const screenshotPaths = Object.fromEntries(screenshots.map((screenshot) => [screenshot.view, screenshot.path]));
          const primaryScreenshot = screenshots.find((screenshot) => screenshot.view === "front") ?? screenshots[0]!;
          const screenshot = {
            sessionId,
            runId: options.runId,
            view: `workflow-round-${round}`,
            path: primaryScreenshot.path,
          };
          const roundFiles = currentFiles();
          const inspectionResponse = await fetch(`${apiUrl}/api/workflow/review-rounds`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              runId: options.runId,
              round,
              userGoal: options.userGoal,
              files: roundFiles,
              referenceImages: options.referenceImages,
              screenshots: screenshots.map(({ view, dataUrl, path }) => ({ view, dataUrl, path })),
              scene: currentScene,
              runtimeErrors: runtimeErrorsRef.current.length ? runtimeErrorsRef.current : options.runtimeErrors,
              patchGenerator: options.patchGenerator,
              maxRevisionRounds: options.config.maxRevisionRounds,
              qualityHistory,
              bestRound: best
                ? {
                    round: best.round,
                    score: best.score,
                    candidateScore: best.selectionScore,
                    modelUsed: best.result.modelUsed,
                  }
                : undefined,
            }),
          });
          if (!inspectionResponse.ok) throw new Error(`质检闭环请求失败: ${inspectionResponse.status}`);
          const inspectionData = (await inspectionResponse.json()) as {
            decision: "pass" | "continue" | "ask_user" | "fallback" | "max_rounds";
            quality: QualityInspectionResult;
            patch?: PatchEvent;
            modelUsed?: string;
            fallbackReason?: string;
            message?: string;
            dualCoderUsed?: boolean;
            discussionModels?: string[];
            discussionSummary?: string;
          };
          let result = inspectionData.quality;
          if (nonBlankRatio < options.config.nonBlankPixelThreshold) {
            result = {
              ...result,
              status: "revise",
              score: Math.min(result.score, 0.2),
              issues: [`截图非空像素占比 ${nonBlankRatio.toFixed(3)} 低于阈值，疑似空白或主体过小。`, ...result.issues],
              revisionHints: ["放大主体并确保 renderer 已完成首帧渲染。", ...result.revisionHints],
            };
          }
          if (!allowDslRevision && options.referenceImages.length && result.status === "pass" && result.score < visualReferenceMinScore) {
            result = {
              ...result,
              status: "revise",
              issues: [
                `参考图驱动的 LLM coder 结果需要更严格阈值 ${visualReferenceMinScore.toFixed(2)}，当前 ${result.score.toFixed(2)} 不能直接通过。`,
                ...result.issues,
              ],
              revisionHints: [
                "继续让 coder 对比参考图和当前截图，细化关键几何细节，而不是直接结束质检。",
                ...result.revisionHints,
              ],
            };
          }
          const selectionScore = computeCandidateSelectionScore(result);
          const improved = !best || result.score > best.score + 0.02 || selectionScore > best.selectionScore + 0.005;
          if (improved) {
            best = { round, score: result.score, selectionScore, path: screenshot.path, screenshotPaths, result, files: roundFiles, scene: currentScene };
            noImprovementRounds = 0;
            runtimeRepairRounds = 0;
          } else {
            noImprovementRounds += 1;
          }
          qualityHistory.push({
            round,
            score: result.score,
            candidateScore: selectionScore,
            status: result.status,
            modelUsed: result.modelUsed,
            selectedBest: improved,
          });
          await fetch(`${apiUrl}/api/workflow/revision-event`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              runId: options.runId,
              round,
              screenshotPath: screenshot.path,
              screenshotPaths,
              score: result.score,
              candidateScore: selectionScore,
              matchedReferenceView: result.matchedReferenceView,
              status: result.status,
              issues: result.issues,
              scores: result.scores,
              checks: result.checks,
              viewResults: result.viewResults,
              featureMatches: result.featureMatches,
              embeddingMatches: result.embeddingMatches,
              structuredIssues: result.structuredIssues,
              modelUsed: result.modelUsed,
              selectedBest: improved,
              dualCoderUsed: inspectionData.dualCoderUsed ?? false,
              discussionModels: inspectionData.discussionModels ?? [],
              discussionSummary: inspectionData.discussionSummary ?? "",
            }),
          });
          setMessages((items) => [
            ...items,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `第 ${round} 轮质检: ${result.status}/${inspectionData.decision}，overall ${result.score.toFixed(2)}，candidate ${selectionScore.toFixed(2)}，matchedView ${result.matchedReferenceView ?? "-"}，embeddingSim ${formatEmbeddingSimilarity(result)}，featureMatch ${formatFeatureMatchScore(result)}，geometry ${result.scores.geometry.toFixed(2)}，similarity ${result.scores.referenceSimilarity.toFixed(2)}，view ${result.scores.viewMatch.toFixed(2)}，material ${result.scores.material.toFixed(2)}，health ${result.scores.renderHealth.toFixed(2)}。模型: ${result.modelUsed ?? "unknown"}。失败项: ${result.checks.filter((check) => !check.pass).slice(0, 5).map((check) => `${check.view ?? "-"}:${check.item}`).join("；") || "无"}。截图: ${screenshot.path}`,
            },
          ]);
          if (inspectionData.dualCoderUsed) {
            setMessages((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `双 coder 已启用: ${(inspectionData.discussionModels ?? []).join(" + ") || "GLM + Doubao"}。${inspectionData.discussionSummary ?? ""}`,
              },
            ]);
          }
          if (inspectionData.decision === "pass") {
            await finalizeWorkflowSnapshot({
              sessionId,
              runId: options.runId,
              label: `workflow-pass-round-${round}`,
              files: roundFiles,
              round,
              score: result.score,
              screenshotPath: screenshot.path,
              screenshotPaths,
              userGoal: options.userGoal,
              scene: currentScene,
            });
            setMessages((items) => [
              ...items,
              { id: crypto.randomUUID(), role: "assistant", content: "质检通过，当前预览已保存为稳定快照。" },
            ]);
            return;
          }
          if (inspectionData.decision === "ask_user" || inspectionData.decision === "fallback") {
            setMessages((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: inspectionData.message || result.bestEffortReason || "质检认为需要人工确认，自动修订已停止。",
              },
            ]);
            return;
          }
          if (!allowDslRevision && best && noImprovementRounds >= 4) {
            const bestSnapshot = best;
            applySnapshot(bestSnapshot.files);
            setMessages((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `连续 ${noImprovementRounds} 个有效质检轮候选质量没有提升，已停止继续改坏代码，并恢复到第 ${bestSnapshot.round} 轮最好结果，overall ${bestSnapshot.score.toFixed(2)}，candidate ${bestSnapshot.selectionScore.toFixed(2)}。`,
              },
            ]);
            break;
          }
          if (!allowDslRevision) {
            if (inspectionData.decision === "max_rounds") break;
            if (!inspectionData.patch) {
              setMessages((items) => [
                ...items,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  content: `LLM coder 第 ${round} 轮没有可应用修正 patch。${inspectionData.message || "保留当前模型继续下一轮截图。"} 当前代码未改变，下一轮仍会产出截图用于比较。`,
                },
              ]);
              round += 1;
              continue;
            }
            const nextPatch = inspectionData.patch;
            applyAgentPatch(nextPatch);
            setLatestPatchGenerator("llm_coder");
            setMessages((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `已由后端闭环调用 LLM coder 根据第 ${round} 轮质检继续修正代码。模型: ${inspectionData.modelUsed ?? "unknown"}。${nextPatch.summary}`,
              },
            ]);
            round += 1;
            continue;
          }
          if (round >= options.config.maxRevisionRounds) break;
          const revisionResponse = await fetch(`${apiUrl}/api/scene/revise`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              scene: currentScene,
              quality: result,
              userGoal: options.userGoal,
              round,
            }),
          });
          if (!revisionResponse.ok) throw new Error(`Scene DSL 修订失败: ${revisionResponse.status}`);
          const revisionData = (await revisionResponse.json()) as { result: { scene: SceneDsl; summary: string } };
          currentScene = revisionData.result.scene;
          setLatestSceneDsl(currentScene);
          const renderResponse = await fetch(`${apiUrl}/api/scene/render`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scene: currentScene }),
          });
          if (!renderResponse.ok) throw new Error(`Scene DSL 渲染失败: ${renderResponse.status}`);
          const renderData = (await renderResponse.json()) as { files: FileMap; summary: string };
          const patch: PatchEvent = {
            type: "patch",
            summary: `${revisionData.result.summary} ${renderData.summary}`,
            generator: "runtime_composer",
            operations: (["src/App.tsx", "src/styles.css"] as const).map((path) => ({
              type: "replace_file",
              path,
              content: renderData.files[path] ?? "",
            })),
          };
          applyAgentPatch(patch);
          round += 1;
        }
        if (best) {
          const bestResult = best;
          applySnapshot(bestResult.files);
          await finalizeWorkflowSnapshot({
            sessionId,
            runId: options.runId,
            label: `workflow-best-round-${bestResult.round}`,
            files: bestResult.files,
            round: bestResult.round,
            score: bestResult.score,
              screenshotPath: bestResult.path,
              screenshotPaths: bestResult.screenshotPaths,
              userGoal: options.userGoal,
              scene: bestResult.scene,
            });
          await fetch(`${apiUrl}/api/workflow/revision-event`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              runId: options.runId,
              round: bestResult.round,
              screenshotPath: bestResult.path,
              screenshotPaths: bestResult.screenshotPaths,
              score: bestResult.score,
              candidateScore: bestResult.selectionScore,
              matchedReferenceView: bestResult.result.matchedReferenceView,
              status: bestResult.result.status,
              issues: bestResult.result.issues,
              scores: bestResult.result.scores,
              checks: bestResult.result.checks,
              viewResults: bestResult.result.viewResults,
              featureMatches: bestResult.result.featureMatches,
              embeddingMatches: bestResult.result.embeddingMatches,
              structuredIssues: bestResult.result.structuredIssues,
              modelUsed: bestResult.result.modelUsed,
              selectedBest: true,
            }),
          });
          setMessages((items) => [
            ...items,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: `已达到最大质检轮数，已恢复并保存当前最好结果: 第 ${bestResult.round} 轮，分数 ${bestResult.score.toFixed(2)}，截图 ${bestResult.path}。`,
            },
          ]);
        }
      } catch (error) {
        setMessages((items) => [
          ...items,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: error instanceof Error ? `自动质检失败: ${error.message}` : `自动质检失败: ${String(error)}`,
          },
        ]);
      } finally {
        setIsQualityRunning(false);
      }
    },
    [applyAgentPatch, applySnapshot, currentFiles, postPreviewCommand, sessionId],
  );

  useEffect(() => {
    if (!pendingWorkflowResume || isRunning || isQualityRunning) return;
    const resume = pendingWorkflowResume;
    setPendingWorkflowResume(null);
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: "system",
        content: "正在恢复刷新前中断的质检闭环；这次会继续截图、review 和保存过程事件。",
      },
    ]);
    void runQualityWorkflow({
      scene: resume.scene,
      config: resume.config,
      userGoal: resume.userGoal,
      runId: resume.runId,
      referenceImages: resume.referenceImages,
      runtimeErrors: [],
      patchGenerator: resume.patchGenerator,
    }).catch((error) => {
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `恢复质检闭环失败: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    });
  }, [isQualityRunning, isRunning, pendingWorkflowResume, runQualityWorkflow]);

  const submit = async () => {
    const message = input.trim();
    if (!message && images.length === 0) return;
    setInput("");
    const userText = message || "请根据我上传的图片作为视觉参考来修改场景。";
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", content: userText },
      { id: crypto.randomUUID(), role: "system", content: "正在发送给 LangGraph Agent..." },
    ]);
    setIsRunning(true);

    try {
      const referenceImages = images;
      const payload = {
        sessionId,
        message: userText,
        images: referenceImages,
        files: currentFiles(),
        runtimeErrors,
        history: messages
          .filter((item) => item.role === "user" || item.role === "assistant")
          .slice(-4)
          .map((item) => ({ role: item.role, content: item.content })),
      };
      const body = JSON.stringify(payload);
      console.log("[agentic-three:web] submit", {
        sessionId,
        message: userText,
        imageCount: images.length,
        imageBytes: images.map((image) => ({
          name: image.name,
          mimeType: image.mimeType,
          dataUrlLength: image.dataUrl.length,
        })),
        bodyBytes: new Blob([body]).size,
      });
      const response = await fetch(`${apiUrl}/api/agent/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Agent 请求失败: ${response.status}`);
      }
      let sceneForWorkflow: SceneDsl | null = null;
      let configForWorkflow: RuntimeComposerConfig | null = appSettings?.runtimeComposer ?? null;
      let runIdForWorkflow: string | undefined = currentRunId;
      let patchApplied = false;
      let patchGenerator: PatchEvent["generator"] = "llm_coder";
      for await (const event of readNdjson(response.body)) {
        if (event.type === "run_id") runIdForWorkflow = event.runId;
        if (event.type === "workflow_config") configForWorkflow = event.config;
        if (event.type === "scene_dsl") sceneForWorkflow = event.scene;
        if (event.type === "patch") {
          patchApplied = true;
          patchGenerator = event.generator;
          setLatestPatchGenerator(event.generator);
        }
        handleStreamEvent(event, applyAgentPatch, setMessages, setCurrentRunId, setWorkflowConfig, setLatestSceneDsl);
      }
      if (patchApplied && sceneForWorkflow && configForWorkflow?.autoCaptureAfterPatch) {
        await runQualityWorkflow({
          scene: sceneForWorkflow,
          config: configForWorkflow,
          userGoal: userText,
          runId: runIdForWorkflow,
          referenceImages,
          runtimeErrors,
          patchGenerator,
        });
      }
      setImages([]);
      void refreshSessions();
    } catch (error) {
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setIsRunning(false);
    }
  };

  const appendImageFiles = async (files: File[]) => {
    const next: ImageInput[] = [];
    for (const file of files.slice(0, 4)) {
      if (!file.type.startsWith("image/")) continue;
      const image = await prepareImageForModel(file);
      console.log("[agentic-three:web] image prepared", {
        name: image.name,
        mimeType: image.mimeType,
        originalBytes: file.size,
        dataUrlLength: image.dataUrl.length,
        note: image.note,
      });
      next.push(imageInputSchema.parse(image));
    }
    setImages((items) => [...items, ...next].slice(0, 4));
  };

  const onUploadImages = async (files: FileList | null) => {
    if (!files) return;
    await appendImageFiles(Array.from(files));
  };

  const onPasteImages = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!pastedImages.length) return;
    event.preventDefault();
    await appendImageFiles(pastedImages);
  };

  const removeImage = (dataUrl: string) => {
    setImages((items) => items.filter((image) => image.dataUrl !== dataUrl));
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">agentic three.js</div>
          <h1>实时预览工作台</h1>
        </div>
        <div className="topbar-actions">
          <button onClick={() => setShowHistory((visible) => !visible)} title={showHistory ? "隐藏历史" : "显示历史"}>
            <History size={16} />
          </button>
          <button onClick={() => setShowCode((visible) => !visible)} title={showCode ? "隐藏代码区" : "显示代码区"}>
            <Code2 size={16} />
          </button>
          <button onClick={() => {
            void openSettings();
          }} title="设置">
            <Settings size={16} />
          </button>
          <button onClick={undo} disabled={!past.length} title="撤销补丁">
            <RotateCcw size={16} />
          </button>
          <button onClick={redo} disabled={!future.length} title="重做补丁">
            <RotateCw size={16} />
          </button>
        </div>
      </header>

      <PanelGroup direction={isNarrowViewport ? "vertical" : "horizontal"} className="workspace">
        {showHistory && (
          <>
            <Panel defaultSize={isNarrowViewport ? 18 : 14} minSize={isNarrowViewport ? 14 : 10} maxSize={isNarrowViewport ? 35 : 22}>
              <HistoryPanel
                sessions={sessions}
                currentSessionId={sessionId}
                onNew={startNewSession}
                onSelect={(id) => void loadSession(id)}
                onDelete={(id) => void deleteSession(id)}
              />
            </Panel>
            <PanelResizeHandle className="resize-handle" />
          </>
        )}

        <Panel defaultSize={isNarrowViewport ? 28 : 25} minSize={isNarrowViewport ? 18 : 20}>
          <aside className="chat-panel">
            <div className="messages">
              {messages.map((message) => (
                <div key={message.id} className={`message ${message.role}`}>
                  <span className="message-icon">
                    {message.role === "user" ? <User size={14} /> : message.role === "assistant" ? <Bot size={14} /> : <Sparkles size={14} />}
                  </span>
                  <p>{message.content}</p>
                </div>
              ))}
            </div>
            {!!images.length && (
              <div className="image-strip">
                {images.map((image) => (
                  <div className="image-chip" key={image.dataUrl}>
                    <img src={image.dataUrl} alt={image.name} />
                    <button type="button" onClick={() => removeImage(image.dataUrl)} title={`移除 ${image.name}`}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!!runtimeErrors.length && (
              <div className="runtime-card">
                <strong>最近运行信号</strong>
                <span>{runtimeErrors[0]?.message}</span>
              </div>
            )}
            {(workflowConfig || latestSceneDsl || isQualityRunning) && (
              <div className="runtime-card">
                <strong>Runtime Composer</strong>
                <span>
                  {isQualityRunning
                    ? "正在自动截图质检"
                    : latestPatchGenerator === "llm_coder"
                      ? `LLM coder 质检闭环，多轮上限 ${workflowConfig?.maxRevisionRounds ?? "-"}`
                      : workflowConfig?.enabled
                        ? `Runtime Composer 已启用，多轮上限 ${workflowConfig.maxRevisionRounds}`
                      : "未启用"}
                  {latestSceneDsl ? `；DSL: ${latestSceneDsl.sceneType} / ${latestSceneDsl.renderStyle}` : ""}
                </span>
              </div>
            )}
            <div className="composer">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onPaste={(event) => {
                  void onPasteImages(event);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    void submit();
                  }
                }}
                placeholder="描述场景、材质、相机运动、动画；也可以直接粘贴图片作为参考..."
              />
              <div className="composer-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(event) => {
                    void onUploadImages(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
                <button onClick={() => fileInputRef.current?.click()} title="上传参考图">
                  <ImagePlus size={16} />
                </button>
                <button className="send-button" onClick={() => void submit()} disabled={isRunning || isQualityRunning}>
                  <Send size={16} />
                  <span>{isRunning || isQualityRunning ? "执行中" : "发送"}</span>
                </button>
              </div>
            </div>
          </aside>
        </Panel>

        <PanelResizeHandle className="resize-handle" />

        {showCode && (
          <>
            <Panel defaultSize={isNarrowViewport ? 36 : 38} minSize={isNarrowViewport ? 24 : 28}>
              <section className="code-panel">
                <SandpackLayout>
                  <SandpackCodeEditor showTabs showLineNumbers closableTabs wrapContent />
                </SandpackLayout>
              </section>
            </Panel>

            <PanelResizeHandle className="resize-handle" />
          </>
        )}

        <Panel defaultSize={isNarrowViewport ? 36 : 37} minSize={isNarrowViewport ? 24 : 28}>
          <section className="preview-panel">
            <RuntimeBridge onRuntimeError={(error) => setRuntimeErrors((items) => [error, ...items].slice(0, 5))} />
            <PreviewToolbar
              autoRotate={autoRotate}
              gridVisible={gridVisible}
              screenshotMode={screenshotMode}
              onCapture={() => void capturePreview()}
              onScreenshotModeChange={setScreenshotMode}
              onToggleAutoRotate={toggleAutoRotate}
              onSetView={setPreviewView}
              onToggleGrid={toggleGrid}
            />
            <SandpackLayout>
              <SandpackPreview showNavigator={false} showOpenInCodeSandbox={false} />
            </SandpackLayout>
          </section>
        </Panel>
      </PanelGroup>

      {settingsOpen && appSettings && (
        <SettingsDialog
          settings={appSettings}
          skills={skills}
          envStatus={envStatus}
          onClose={() => setSettingsOpen(false)}
          onChange={setAppSettings}
          onSkillsRefresh={refreshSkills}
          onSave={async () => {
            const response = await fetch(`${apiUrl}/api/settings`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                settings: { ...appSettings, screenshotMode },
              }),
            });
            if (!response.ok) throw new Error(`设置保存失败: ${response.status}`);
            const data = (await response.json()) as { settings: AppSettings; env: Record<string, boolean> };
            setAppSettings(data.settings);
            setEnvStatus(data.env);
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function HistoryPanel({
  sessions,
  currentSessionId,
  onNew,
  onSelect,
  onDelete,
}: {
  sessions: MemorySession[];
  currentSessionId: string;
  onNew: () => void;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  return (
    <aside className="history-panel">
      <div className="history-header">
        <strong>历史</strong>
        <button onClick={onNew} title="新建会话">
          <Plus size={15} />
        </button>
      </div>
      <div className="history-list">
        {sessions.length ? (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`history-item ${session.id === currentSessionId ? "active" : ""}`}
            >
              <button
                className="history-item-main"
                onClick={() => onSelect(session.id)}
                title={session.title}
              >
                <span>{session.title}</span>
                <small>{formatHistoryTime(session.updatedAt)}</small>
              </button>
              <button
                className="history-item-delete"
                title="删除会话"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`确定要删除会话「${session.title}」吗？`)) {
                    onDelete(session.id);
                  }
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))
        ) : (
          <p className="history-empty">暂无历史</p>
        )}
      </div>
    </aside>
  );
}

function SettingsDialog({
  settings,
  skills,
  envStatus,
  onChange,
  onSkillsRefresh,
  onClose,
  onSave,
}: {
  settings: AppSettings;
  skills: SkillCard[];
  envStatus: Record<string, boolean>;
  onChange: (settings: AppSettings) => void;
  onSkillsRefresh: () => Promise<void>;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [newSkill, setNewSkill] = useState<SkillCreateRequest>({
    id: "",
    title: "",
    description: "",
    content: "",
  });
  const [skillUrl, setSkillUrl] = useState("https://github.com/CloudAI-X/threejs-skills/tree/main");
  const [ragStatus, setRagStatus] = useState<RagStatus | null>(null);
  const [ragQuery, setRagQuery] = useState("发动机 正面 黑线白图 六视图");
  const [ragSearchScope, setRagSearchScope] = useState<"imported" | "all">("imported");
  const [ragResults, setRagResults] = useState<RetrievalSearchResult[]>([]);
  const [ragMode, setRagMode] = useState<"milvus" | "fallback" | "">("");
  const [ragSource, setRagSource] = useState<RagSourceResult | null>(null);
  const [ragMessage, setRagMessage] = useState("");
  const [ragBusy, setRagBusy] = useState(false);
  const [ragBusyAction, setRagBusyAction] = useState<"status" | "ingest" | "clear" | "search" | "source" | "">("");
  const [assetImportJob, setAssetImportJob] = useState<AssetImportJob | null>(null);
  const [assetImportMessage, setAssetImportMessage] = useState("");
  const updateModel = (index: number, patch: Partial<ModelConfig>) => {
    onChange({
      ...settings,
      models: settings.models.map((model, modelIndex) => (modelIndex === index ? { ...model, ...patch } : model)),
    });
  };
  const updateVisionReviewModel = (index: number, patch: Partial<AppSettings["visionReview"]["models"][number]>) => {
    onChange({
      ...settings,
      visionReview: {
        ...settings.visionReview,
        models: settings.visionReview.models.map((model, modelIndex) => (modelIndex === index ? { ...model, ...patch } : model)),
      },
    });
  };
  const requiredEnvNames = Array.from(new Set([
    ...settings.models.map((model) => model.apiKeyEnvName),
    ...settings.visionReview.models.map((model) => model.apiKeyEnvName),
  ])).sort();
  const updateRuntimeComposer = (patch: Partial<RuntimeComposerConfig>) => {
    onChange({
      ...settings,
      runtimeComposer: {
        ...settings.runtimeComposer,
        ...patch,
      },
    });
  };
  const updateAssetImport = (patch: Partial<AppSettings["assetImport"]>) => {
    onChange({
      ...settings,
      assetImport: {
        ...settings.assetImport,
        ...patch,
      },
    });
  };
  const toggleSkill = (skillId: string) => {
    const enabled = new Set(settings.enabledSkillIds);
    if (enabled.has(skillId)) enabled.delete(skillId);
    else enabled.add(skillId);
    onChange({ ...settings, enabledSkillIds: Array.from(enabled) });
  };
  const addSkill = async () => {
    const skillToCreate = newSkill.id && newSkill.title && newSkill.description ? newSkill : await inferSkill();
    const response = await fetch(`${apiUrl}/api/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(skillToCreate),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `添加 skill 失败: ${response.status}`);
    }
    onChange({ ...settings, enabledSkillIds: Array.from(new Set([...settings.enabledSkillIds, skillToCreate.id])) });
    setNewSkill({ id: "", title: "", description: "", content: "" });
    await onSkillsRefresh();
  };
  const inferSkill = async () => {
    const response = await fetch(`${apiUrl}/api/skills/infer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: newSkill.content }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `自动识别失败: ${response.status}`);
    }
    const data = (await response.json()) as { skill: SkillCreateRequest };
    setNewSkill(data.skill);
    return data.skill;
  };
  const installSkillUrl = async () => {
    const response = await fetch(`${apiUrl}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: skillUrl }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `安装失败: ${response.status}`);
    }
    const data = (await response.json()) as { skills: SkillCard[] };
    onChange({
      ...settings,
      enabledSkillIds: Array.from(new Set([...settings.enabledSkillIds, ...data.skills.map((skill) => skill.id)])),
    });
    await onSkillsRefresh();
  };
  const refreshRagStatus = async () => {
    setRagBusy(true);
    setRagBusyAction("status");
    const response = await fetch(`${apiUrl}/api/rag/status`);
    try {
      if (!response.ok) throw new Error(`RAG 状态读取失败: ${response.status}`);
      setRagStatus((await response.json()) as RagStatus);
    } finally {
      setRagBusy(false);
      setRagBusyAction("");
    }
  };
  const ingestRag = async () => {
    setRagBusy(true);
    setRagBusyAction("ingest");
    setRagMessage("正在重建基础 RAG 索引...");
    try {
      const response = await fetch(`${apiUrl}/api/rag/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(`RAG 入库失败: ${response.status}`);
      const data = (await response.json()) as { result: RagIngestResult };
      setRagMessage(`${data.result.mode}: ${data.result.documentCount} 条。${data.result.message}`);
      await refreshRagStatus();
    } finally {
      setRagBusy(false);
      setRagBusyAction("");
    }
  };
  const clearKnowledge = async () => {
    const confirmed = window.confirm(
      `将清除知识库测试数据：\n\n- 导入目录: ${settings.assetImport.uploadDirectory}\n- SQLite 导入记录/视觉记忆/场景状态\n- Milvus RAG collection\n\n不会删除来源目录。确认继续？`,
    );
    if (!confirmed) return;
    setRagBusy(true);
    setRagBusyAction("clear");
    setRagMessage("正在清除知识库...");
    try {
      const response = await fetch(`${apiUrl}/api/rag/clear`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadDirectory: settings.assetImport.uploadDirectory,
          clearImportedFiles: true,
          clearMilvus: true,
          clearSqlite: true,
        }),
      });
      if (!response.ok) throw new Error(`清除知识库失败: ${response.status}`);
      const data = (await response.json()) as { result: KnowledgeClearResult };
      setRagResults([]);
      setRagSource(null);
      setAssetImportJob(null);
      setAssetImportMessage("");
      setRagMessage(data.result.message);
      await refreshRagStatus();
    } finally {
      setRagBusy(false);
      setRagBusyAction("");
    }
  };
  const searchRag = async () => {
    setRagBusy(true);
    setRagBusyAction("search");
    setRagSource(null);
    setRagMessage("正在检索 RAG...");
    try {
      const response = await fetch(`${apiUrl}/api/rag/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: ragQuery, topK: 6, scope: ragSearchScope }),
      });
      if (!response.ok) throw new Error(`RAG 检索失败: ${response.status}`);
      const data = (await response.json()) as { results: RetrievalSearchResult[]; mode: "milvus" | "fallback" };
      setRagResults(data.results);
      setRagMode(data.mode);
      setRagMessage(`${data.mode}: ${ragSearchScope === "imported" ? "导入/生成知识" : "全部知识"}命中 ${data.results.length} 条。`);
    } finally {
      setRagBusy(false);
      setRagBusyAction("");
    }
  };
  const resolveRagSource = async (result: RetrievalSearchResult) => {
    setRagBusy(true);
    setRagBusyAction("source");
    try {
      const response = await fetch(`${apiUrl}/api/rag/source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: result.kind, id: result.id }),
      });
      if (!response.ok) throw new Error(`source 解析失败: ${response.status}`);
      setRagSource((await response.json()) as RagSourceResult);
    } finally {
      setRagBusy(false);
      setRagBusyAction("");
    }
  };
  const refreshActiveImportJob = async () => {
    const response = await fetch(`${apiUrl}/api/assets/import-jobs/active`);
    if (!response.ok) throw new Error(`导入任务状态读取失败: ${response.status}`);
    const data = (await response.json()) as { job: AssetImportJob | null };
    setAssetImportJob(data.job);
    return data.job;
  };
  const refreshImportJob = async (jobId: string) => {
    const response = await fetch(`${apiUrl}/api/assets/import-jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) throw new Error(`导入任务状态读取失败: ${response.status}`);
    const data = (await response.json()) as { job: AssetImportJob };
    setAssetImportJob(data.job);
    return data.job;
  };
  const startImportAssets = async () => {
    setAssetImportMessage("正在启动后台导入任务...");
    try {
      const response = await fetch(`${apiUrl}/api/assets/import-jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceDirectory: settings.assetImport.sourceDirectory,
          uploadDirectory: settings.assetImport.uploadDirectory,
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `资产导入失败: ${response.status}`);
      }
      const data = (await response.json()) as { job: AssetImportJob };
      setAssetImportJob(data.job);
      setAssetImportMessage(`后台任务已启动: ${data.job.jobId.slice(0, 8)}`);
      await refreshRagStatus();
    } catch (startError) {
      setAssetImportMessage(startError instanceof Error ? startError.message : String(startError));
      throw startError;
    }
  };

  useEffect(() => {
    void refreshRagStatus().catch((statusError) =>
      setRagMessage(statusError instanceof Error ? statusError.message : String(statusError)),
    );
    void refreshActiveImportJob().catch((jobError) =>
      setAssetImportMessage(jobError instanceof Error ? jobError.message : String(jobError)),
    );
  }, []);

  useEffect(() => {
    if (!assetImportJob || !["queued", "running"].includes(assetImportJob.status)) return;
    const timer = window.setInterval(() => {
      void refreshImportJob(assetImportJob.jobId).catch((jobError) =>
        setAssetImportMessage(jobError instanceof Error ? jobError.message : String(jobError)),
      );
    }, 1200);
    return () => window.clearInterval(timer);
  }, [assetImportJob?.jobId, assetImportJob?.status]);

  return (
    <div className="settings-backdrop">
      <section className="settings-dialog">
        <header className="settings-title">
          <div>
            <strong>设置</strong>
            <span>模型、密钥和截图偏好</span>
          </div>
          <button onClick={onClose}>关闭</button>
        </header>
        <div className="settings-body">
          <div className="settings-secret-list">
            {requiredEnvNames.map((name) => (
              <div className="settings-secret" key={name}>
                <label>
                  {name}
                  <span className="env-hint">
                    {envStatus[name] ? "API 进程已读取到该系统环境变量" : "未检测到，请在系统环境变量中配置后重启 API"}
                  </span>
                </label>
                <span className={envStatus[name] ? "env-ok" : "env-missing"}>
                  {envStatus[name] ? "已配置" : "未配置"}
                </span>
              </div>
            ))}
          </div>
          <div className="settings-grid">
            {settings.models.map((model, index) => (
              <div className="settings-row" key={model.node}>
                <div className="settings-model-label" title={model.node}>
                  <strong>{modelNodeLabel(model.node)}</strong>
                  <span>{modelNodeDescription(model.node)}</span>
                </div>
                <input value={model.model} onChange={(event) => updateModel(index, { model: event.target.value })} />
                <input value={model.baseURL} onChange={(event) => updateModel(index, { baseURL: event.target.value })} />
                <input value={model.apiKeyEnvName} onChange={(event) => updateModel(index, { apiKeyEnvName: event.target.value })} />
                <input
                  type="number"
                  value={model.temperature}
                  step="0.1"
                  min="0"
                  max="2"
                  onChange={(event) => updateModel(index, { temperature: Number(event.target.value) })}
                />
                <input
                  type="number"
                  value={model.maxTokens}
                  min="128"
                  max="32768"
                  onChange={(event) => updateModel(index, { maxTokens: Number(event.target.value) })}
                />
              </div>
            ))}
          </div>
          <section className="settings-skills">
            <div className="settings-section-title">
              <strong>多视角视觉质检模型</strong>
              <span>Runtime Composer 截 front/side/top/three-quarter 后调用；第 1/2/3 轮按下方列表轮换</span>
            </div>
            <div className="settings-grid">
              {settings.visionReview.models.map((model, index) => (
                <div className="settings-row" key={`vision-review-${index}`}>
                  <div className="settings-model-label" title={`vision_${index + 1}`}>
                    <strong>vision_{index + 1}</strong>
                    <span>{visionReviewDescription(index)}</span>
                  </div>
                  <input value={model.model} onChange={(event) => updateVisionReviewModel(index, { model: event.target.value })} />
                  <input value={model.baseURL} onChange={(event) => updateVisionReviewModel(index, { baseURL: event.target.value })} />
                  <input value={model.apiKeyEnvName} onChange={(event) => updateVisionReviewModel(index, { apiKeyEnvName: event.target.value })} />
                  <input
                    type="number"
                    value={model.temperature}
                    step="0.1"
                    min="0"
                    max="2"
                    onChange={(event) => updateVisionReviewModel(index, { temperature: Number(event.target.value) })}
                  />
                  <input
                    type="number"
                    value={model.maxTokens}
                    min="128"
                    max="32768"
                    onChange={(event) => updateVisionReviewModel(index, { maxTokens: Number(event.target.value) })}
                  />
                </div>
              ))}
            </div>
            <p className="rag-message">
              这里才是看图质检模型；上面的 safety_review 只做补丁安全检查，不负责判断画面好坏。
            </p>
          </section>
          <section className="settings-skills">
            <div className="settings-section-title">
              <strong>资产导入</strong>
              <span>保存资源目录后，后台遍历 GLB/three.js 源码、去重、截图六面图并入库</span>
            </div>
            <div className="runtime-settings-grid">
              <label>
                <span>来源目录</span>
                <input
                  value={settings.assetImport.sourceDirectory}
                  onChange={(event) => updateAssetImport({ sourceDirectory: event.target.value })}
                  placeholder="例如 E:\\models\\aircraft 或 D:\\three-scenes"
                />
              </label>
              <label>
                <span>默认导入目录</span>
                <input
                  value={settings.assetImport.uploadDirectory}
                  onChange={(event) => updateAssetImport({ uploadDirectory: event.target.value })}
                  placeholder="assets/aircraft/imported"
                />
              </label>
            </div>
            <div className="rag-status-row">
              <button
                onClick={() => {
                  void onSave().catch((saveError) => setError(saveError instanceof Error ? saveError.message : String(saveError)));
                }}
              >
                保存目录
              </button>
              <button
                disabled={Boolean(assetImportJob && ["queued", "running"].includes(assetImportJob.status)) || !settings.assetImport.sourceDirectory.trim()}
                onClick={() => {
                  void startImportAssets().catch((importError) => setError(importError instanceof Error ? importError.message : String(importError)));
                }}
              >
                开始提取入库
              </button>
              <small>任务在后端运行，关闭设置面板不会中断。</small>
            </div>
            {assetImportJob && (
              <div className="rag-source-card">
                <strong>导入进度 · {assetImportJob.status}</strong>
                <span>{assetImportJob.phase} · {assetImportJob.percent.toFixed(0)}%</span>
                <progress value={assetImportJob.percent} max={100} />
                <small>
                  已处理 {assetImportJob.processed}/{assetImportJob.total}；导入 {assetImportJob.imported}；跳过 {assetImportJob.skipped}；失败 {assetImportJob.failed}
                </small>
                {assetImportJob.currentFile && <code>{assetImportJob.currentFile}</code>}
                {assetImportJob.message && <p className="rag-message">{assetImportJob.message}</p>}
                {!!assetImportJob.items.filter((item) => !item.ok).length && (
                  <>
                    <small>失败项</small>
                    <pre>{formatJsonPreview(assetImportJob.items.filter((item) => !item.ok).slice(-8))}</pre>
                  </>
                )}
                {!!assetImportJob.items.filter((item) => item.ok && /跳过/.test(item.message)).length && (
                  <>
                    <small>最近跳过项</small>
                    <pre>{formatJsonPreview(assetImportJob.items.filter((item) => item.ok && /跳过/.test(item.message)).slice(-8))}</pre>
                  </>
                )}
              </div>
            )}
            {assetImportMessage && <p className="rag-message">{assetImportMessage}</p>}
          </section>
          <details className="settings-skills">
            <summary className="settings-section-title">
              <strong>RAG 诊断工具</strong>
              <span>用于手动验证 Milvus 状态、重建基础索引和测试检索</span>
            </summary>
            <div className="rag-panel">
              <div className="rag-status-row">
                <span className={ragStatus?.ready ? "env-ok" : "env-missing"}>
                  {ragStatus?.ready ? "Milvus 已连接" : "Milvus 未连接"}
                </span>
                <small>{ragStatus?.databaseUrl ?? "正在检测数据库状态..."}</small>
                {ragStatus?.fallbackForced && <small>RAG_FORCE_FALLBACK=1，当前强制使用本地 fallback。</small>}
                {!!ragStatus?.lastError && <small>最后错误: {ragStatus.lastError}</small>}
                <button
                  disabled={ragBusy}
                  onClick={() => {
                    void refreshRagStatus().catch((statusError) =>
                      setError(statusError instanceof Error ? statusError.message : String(statusError)),
                    );
                  }}
                >
                  {ragBusyAction === "status" && <span className="mini-spinner" aria-hidden="true" />}
                  刷新状态
                </button>
                <button
                  disabled={ragBusy}
                  onClick={() => {
                    void ingestRag().catch((ingestError) =>
                      setError(ingestError instanceof Error ? ingestError.message : String(ingestError)),
                    );
                  }}
                >
                  {ragBusyAction === "ingest" && <span className="mini-spinner" aria-hidden="true" />}
                  重建索引
                </button>
                <button
                  disabled={ragBusy}
                  onClick={() => {
                    void clearKnowledge().catch((clearError) =>
                      setError(clearError instanceof Error ? clearError.message : String(clearError)),
                    );
                  }}
                >
                  {ragBusyAction === "clear" && <span className="mini-spinner" aria-hidden="true" />}
                  清除知识库
                </button>
              </div>
              <div className="rag-search-row">
                <input value={ragQuery} onChange={(event) => setRagQuery(event.target.value)} placeholder="测试检索，例如：发动机 正面 黑线白图 六视图" />
                <select value={ragSearchScope} onChange={(event) => setRagSearchScope(event.target.value as "imported" | "all")}>
                  <option value="imported">仅导入/生成</option>
                  <option value="all">全部知识</option>
                </select>
                <button
                  disabled={ragBusy}
                  onClick={() => {
                    void searchRag().catch((searchError) =>
                      setError(searchError instanceof Error ? searchError.message : String(searchError)),
                    );
                  }}
                >
                  {ragBusyAction === "search" && <span className="mini-spinner" aria-hidden="true" />}
                  检索
                </button>
              </div>
              {ragMessage && (
                <p className="rag-message">
                  {ragBusy && <span className="mini-spinner" aria-hidden="true" />}
                  {ragMessage}
                </p>
              )}
              {!!ragResults.length && (
                <div className="rag-results">
                  <div className="rag-results-title">
                    <strong>命中结果</strong>
                    <span>{ragMode || "unknown"}</span>
                  </div>
                  {ragResults.map((result) => (
                    <button
                      key={`${result.kind}:${result.id}`}
                      className="rag-result-item"
                      onClick={() => {
                        void resolveRagSource(result).catch((sourceError) =>
                          setError(sourceError instanceof Error ? sourceError.message : String(sourceError)),
                        );
                      }}
                    >
                      <span>
                        <strong>{result.title}</strong>
                        <small>
                          {result.kind} · {result.id} · score {result.score.toFixed(3)}
                        </small>
                      </span>
                      <small>
                        {result.view ? `${result.view} · ` : ""}
                        {result.sourcePath ?? result.imagePath ?? "无 source 指针"}
                      </small>
                    </button>
                  ))}
                </div>
              )}
              {ragSource && (
                <div className="rag-source-card">
                  <strong>Source Resolver</strong>
                  <span>{ragSource.kind} · {ragSource.id}</span>
                  <code>{ragSource.sourcePath}</code>
                  <pre>{formatJsonPreview(ragSource.source)}</pre>
                </div>
              )}
            </div>
          </details>
          <section className="settings-skills">
            <div className="settings-section-title">
              <strong>Runtime Composer</strong>
              <span>控制自动截图质检和多轮修订</span>
            </div>
            <div className="runtime-settings-grid">
              <label>
                <span>启用 Runtime Composer</span>
                <input
                  type="checkbox"
                  checked={settings.runtimeComposer.enabled}
                  onChange={(event) => updateRuntimeComposer({ enabled: event.target.checked })}
                />
              </label>
              <label>
                <span>自动截图质检</span>
                <input
                  type="checkbox"
                  checked={settings.runtimeComposer.autoCaptureAfterPatch}
                  onChange={(event) => updateRuntimeComposer({ autoCaptureAfterPatch: event.target.checked })}
                />
              </label>
              <label>
                <span>要求视觉质检</span>
                <input
                  type="checkbox"
                  checked={settings.runtimeComposer.requireVisualInspection}
                  onChange={(event) => updateRuntimeComposer({ requireVisualInspection: event.target.checked })}
                />
              </label>
              <label>
                <span>最大修订轮数</span>
                <input
                  type="number"
                  min="1"
                  max="8"
                  value={settings.runtimeComposer.maxRevisionRounds}
                  onChange={(event) => updateRuntimeComposer({ maxRevisionRounds: Number(event.target.value) })}
                />
              </label>
              <label>
                <span>通过分数阈值</span>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={settings.runtimeComposer.minQualityScore}
                  onChange={(event) => updateRuntimeComposer({ minQualityScore: Number(event.target.value) })}
                />
              </label>
              <label>
                <span>截图延迟 ms</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="100"
                  value={settings.runtimeComposer.captureDelayMs}
                  onChange={(event) => updateRuntimeComposer({ captureDelayMs: Number(event.target.value) })}
                />
              </label>
              <label>
                <span>非空像素阈值</span>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={settings.runtimeComposer.nonBlankPixelThreshold}
                  onChange={(event) => updateRuntimeComposer({ nonBlankPixelThreshold: Number(event.target.value) })}
                />
              </label>
            </div>
          </section>
          <section className="settings-skills">
            <div className="settings-section-title">
              <strong>Skills</strong>
              <span>勾选后会进入 Agent 的技能上下文</span>
            </div>
            <div className="skill-list">
              {skills.map((skill) => (
                <label key={skill.id} className="skill-item">
                  <input
                    type="checkbox"
                    checked={settings.enabledSkillIds.includes(skill.id)}
                    onChange={() => toggleSkill(skill.id)}
                  />
                  <span>
                    <strong>{skill.title}</strong>
                    <small>{skill.id} · {skill.description}</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="skill-add">
              <div className="skill-url-row">
                <input
                  value={skillUrl}
                  onChange={(event) => setSkillUrl(event.target.value)}
                  placeholder="GitHub/Gitee skills 仓库链接"
                />
                <button
                  onClick={() => {
                    void installSkillUrl().catch((installError) =>
                      setError(installError instanceof Error ? installError.message : String(installError)),
                    );
                  }}
                >
                  从链接安装
                </button>
              </div>
              <textarea
                value={newSkill.content}
                onChange={(event) => setNewSkill((item) => ({ ...item, content: event.target.value }))}
                placeholder="手动添加时只需要粘贴 skill 正文；点击自动识别后会补全 id、标题和描述。"
              />
              <div className="skill-meta-grid">
                <input
                  value={newSkill.id}
                  onChange={(event) => setNewSkill((item) => ({ ...item, id: event.target.value }))}
                  placeholder="自动识别 id"
                />
                <input
                  value={newSkill.title}
                  onChange={(event) => setNewSkill((item) => ({ ...item, title: event.target.value }))}
                  placeholder="自动识别标题"
                />
                <input
                  value={newSkill.description}
                  onChange={(event) => setNewSkill((item) => ({ ...item, description: event.target.value }))}
                  placeholder="自动识别描述"
                />
              </div>
              <button
                onClick={() => {
                  void inferSkill().catch((inferError) => setError(inferError instanceof Error ? inferError.message : String(inferError)));
                }}
              >
                自动识别
              </button>
              <button
                onClick={() => {
                  void addSkill().catch((addError) => setError(addError instanceof Error ? addError.message : String(addError)));
                }}
              >
                添加 Skill
              </button>
            </div>
          </section>
          {error && <p className="settings-error">{error}</p>}
        </div>
        <footer className="settings-footer">
          <button
            className="send-button"
            onClick={() => {
              void onSave().catch((saveError) => setError(saveError instanceof Error ? saveError.message : String(saveError)));
            }}
          >
            保存设置
          </button>
        </footer>
      </section>
    </div>
  );
}

function PreviewToolbar({
  autoRotate,
  gridVisible,
  screenshotMode,
  onCapture,
  onScreenshotModeChange,
  onToggleAutoRotate,
  onSetView,
  onToggleGrid,
}: {
  autoRotate: boolean;
  gridVisible: boolean;
  screenshotMode: ScreenshotMode;
  onCapture: () => void;
  onScreenshotModeChange: (mode: ScreenshotMode) => void;
  onToggleAutoRotate: () => void;
  onSetView: (view: PreviewView) => void;
  onToggleGrid: () => void;
}) {
  const views: Array<[PreviewView, string]> = [
    ["front", "前"],
    ["back", "后"],
    ["left", "左"],
    ["right", "右"],
    ["top", "上"],
    ["bottom", "下"],
  ];

    return (
      <div className="preview-toolbar">
      <select value={screenshotMode} onChange={(event) => onScreenshotModeChange(event.target.value as ScreenshotMode)} title="截图保存模式">
        <option value="download">下载</option>
        <option value="save">存目录</option>
        <option value="both">两者</option>
      </select>
      <button onClick={onCapture} title="截图">
        <Camera size={15} />
      </button>
      <button className={!gridVisible ? "muted" : ""} onClick={onToggleGrid} title={gridVisible ? "隐藏坐标方格" : "显示坐标方格"}>
        <Grid3X3 size={15} />
      </button>
      <button className={!autoRotate ? "muted" : ""} onClick={onToggleAutoRotate} title={autoRotate ? "停止预览旋转" : "开启预览旋转"}>
        <RotateCw size={15} />
      </button>
      <div className="view-buttons" aria-label="视角">
        {views.map(([view, label]) => (
          <button key={view} onClick={() => onSetView(view)} title={`${label}视角`}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function useIsNarrowViewport() {
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 760);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 759px)");
    const update = () => setIsNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isNarrow;
}

function RuntimeBridge({ onRuntimeError }: { onRuntimeError: (error: RuntimeError) => void }) {
  const { listen } = useSandpack();

  useEffect(() => {
    const unsubscribe = listen((message: unknown) => {
      const event = message as { type?: string; level?: string; data?: unknown; title?: string; message?: string };
      const text = [event.title, event.message, formatRuntimePayload(event.data)].filter(Boolean).join(" ");
      if (!text) return;
      if (event.type?.toLowerCase().includes("error") || event.level === "error" || /error|exception|failed/i.test(text)) {
        onRuntimeError({ message: text, source: "sandpack" });
      }
    });
    return () => unsubscribe();
  }, [listen, onRuntimeError]);

  return null;
}

function formatRuntimePayload(data: unknown): string {
  if (data == null) return "";
  if (Array.isArray(data)) return data.map(formatRuntimePayload).filter(Boolean).join(" ");
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (data instanceof Error) return data.message;
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    const direct = [record.message, record.error, record.name, record.stack].map(formatRuntimePayload).filter(Boolean).join(" ");
    if (direct) return direct;
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

function formatJsonPreview(value: unknown, limit = 900): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}\n...` : text;
  } catch {
    return String(value);
  }
}

async function fetchWorkflowRunState(runId: string): Promise<WorkflowRunState | undefined> {
  const response = await fetch(`${apiUrl}/api/workflow/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) return undefined;
  return (await response.json()) as WorkflowRunState;
}

async function fetchRecentInputImages(sessionId: string): Promise<ImageInput[]> {
  const response = await fetch(`${apiUrl}/api/memory/sessions/${encodeURIComponent(sessionId)}/input-images/recent?limit=4`);
  if (!response.ok) return [];
  const data = (await response.json()) as { images: ImageInput[] };
  return data.images.map((image) => imageInputSchema.parse(image));
}

function runEventsToChatMessages(events: RunEventRecord[]): ChatMessage[] {
  return events.map(runEventToChatMessage).filter((message): message is ChatMessage => Boolean(message));
}

function runEventToChatMessage(event: RunEventRecord): ChatMessage | undefined {
  const content = parseRunEventContent(event.content);
  if (event.eventType === "run.start") {
    const value = asRecord(content);
    return {
      id: `run-event-${event.id}`,
      role: "system",
      content: `任务开始: ${String(value.message ?? "无文字输入")}；参考图 ${String(value.imageCount ?? 0)} 张。`,
    };
  }
  if (event.eventType === "run.success") {
    return { id: `run-event-${event.id}`, role: "system", content: "Agent 运行完成。" };
  }
  if (event.eventType === "run.error") {
    return { id: `run-event-${event.id}`, role: "system", content: "Agent 运行失败，已保留当前稳定快照。" };
  }
  if (event.eventType === "workflow.review_round") {
    const value = asRecord(content);
    const scores = asRecord(value.scores);
    const failedChecks = Array.isArray(value.checks)
      ? value.checks
          .map(asRecord)
          .filter((check) => check.pass === false)
          .slice(0, 5)
          .map((check) => `${String(check.view ?? "-")}:${String(check.item ?? "检查项")}`)
      : [];
    return {
      id: `run-event-${event.id}`,
      role: "system",
      content: `第 ${String(value.round ?? "?")} 轮质检: ${String(value.status ?? "unknown")}/${String(value.decision ?? "-")}，overall ${formatMaybeNumber(value.score)}，candidate ${formatMaybeNumber(value.candidateScore)}，matchedView ${String(value.matchedReferenceView ?? "-")}，geometry ${formatMaybeNumber(scores.geometry)}，similarity ${formatMaybeNumber(scores.referenceSimilarity)}。模型: ${String(value.modelUsed ?? "unknown")}。失败项: ${failedChecks.join("；") || "无"}。`,
    };
  }
  if (event.eventType === "coder.revise") {
    const value = asRecord(content);
    return {
      id: `run-event-${event.id}`,
      role: "assistant",
      content: `${value.dualCoderUsed ? `双 coder 已启用: ${Array.isArray(value.discussionModels) ? value.discussionModels.join(" + ") : "GLM + Doubao"}。${String(value.discussionSummary ?? "")}\n` : ""}已根据运行/质检问题调用 coder 修复。模型: ${String(value.modelUsed ?? "unknown")}。${String(value.summary ?? "")}`,
    };
  }
  if (event.eventType === "workflow.finalize") {
    const value = asRecord(content);
    return {
      id: `run-event-${event.id}`,
      role: "assistant",
      content: `已保存最终/最佳结果: ${String(value.label ?? "workflow-final")}，第 ${String(value.round ?? "?")} 轮，分数 ${formatMaybeNumber(value.score)}，截图 ${String(value.screenshotPath ?? "-")}。`,
    };
  }

  const streamEvent = tryParseStreamEvent(content);
  if (!streamEvent) return undefined;
  if (streamEvent.type === "workflow_config") {
    return {
      id: `run-event-${event.id}`,
      role: "system",
      content: `工作流配置: 自动质检${streamEvent.config.autoCaptureAfterPatch ? "开启" : "关闭"}，最多 ${streamEvent.config.maxRevisionRounds} 轮，阈值 ${streamEvent.config.minQualityScore}。`,
    };
  }
  if (streamEvent.type === "scene_dsl") {
    return {
      id: `run-event-${event.id}`,
      role: "system",
      content: `Scene DSL: ${streamEvent.scene.sceneType} / ${streamEvent.scene.cameraPreset} / ${streamEvent.scene.renderStyle}。`,
    };
  }
  if (streamEvent.type === "patch") {
    return {
      id: `run-event-${event.id}`,
      role: "system",
      content: `已应用补丁: ${streamEvent.summary}${describePatchOperations(streamEvent)}`,
    };
  }
  if (streamEvent.type === "assistant_message") {
    return { id: `run-event-${event.id}`, role: "assistant", content: streamEvent.message };
  }
  if (streamEvent.type === "status" || streamEvent.type === "reasoning_summary" || streamEvent.type === "coder_input_summary" || streamEvent.type === "error") {
    return { id: `run-event-${event.id}`, role: "system", content: streamEvent.message };
  }
  if (streamEvent.type === "run_status") {
    return {
      id: `run-event-${event.id}`,
      role: "system",
      content: streamEvent.message ?? `运行状态: ${streamEvent.status}`,
    };
  }
  if (streamEvent.type === "snapshot_saved") {
    return {
      id: `run-event-${event.id}`,
      role: "system",
      content: `已保存${streamEvent.stable ? "稳定" : ""}快照: ${streamEvent.label}`,
    };
  }
  return undefined;
}

function deriveLatestWorkflowState(events: RunEventRecord[]): {
  config?: RuntimeComposerConfig;
  scene?: SceneDsl;
  userGoal: string;
  patchGenerator: PatchEvent["generator"];
} {
  const result: {
    config?: RuntimeComposerConfig;
    scene?: SceneDsl;
    userGoal: string;
    patchGenerator: PatchEvent["generator"];
  } = {
    userGoal: "",
    patchGenerator: "llm_coder",
  };
  for (const event of events) {
    const content = parseRunEventContent(event.content);
    if (event.eventType === "run.start") {
      const value = asRecord(content);
      result.userGoal = String(value.message ?? result.userGoal);
    }
    const streamEvent = tryParseStreamEvent(content);
    if (streamEvent?.type === "workflow_config") result.config = streamEvent.config;
    if (streamEvent?.type === "scene_dsl") result.scene = streamEvent.scene;
    if (streamEvent?.type === "patch") result.patchGenerator = streamEvent.generator;
  }
  return result;
}

function shouldResumeWorkflowAfterRefresh(runState: WorkflowRunState): boolean {
  if (runState.run.status !== "success") return false;
  if (!runState.run.updatedAt) return false;
  const ageMs = Date.now() - new Date(runState.run.updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 20 * 60 * 1000) return false;
  if (runState.events.some((event) => event.eventType === "workflow.finalize")) return false;
  const reviewRounds = runState.events.filter((event) => event.eventType === "workflow.review_round");
  const lastReview = reviewRounds.at(-1);
  if (!lastReview) return true;
  const lastDecision = String(asRecord(parseRunEventContent(lastReview.content)).decision ?? "");
  return lastDecision === "continue";
}

function parseRunEventContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function tryParseStreamEvent(content: unknown): StreamEvent | undefined {
  const parsed = streamEventSchema.safeParse(content);
  return parsed.success ? parsed.data : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function formatMaybeNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "-";
}

function handleStreamEvent(
  event: StreamEvent,
  applyAgentPatch: (patch: PatchEvent) => void,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setCurrentRunId: React.Dispatch<React.SetStateAction<string | undefined>>,
  setWorkflowConfig: React.Dispatch<React.SetStateAction<RuntimeComposerConfig | null>>,
  setLatestSceneDsl: React.Dispatch<React.SetStateAction<SceneDsl | null>>,
) {
  if (event.type === "run_id") {
    setCurrentRunId(event.runId);
    return;
  }
  if (event.type === "workflow_config") {
    setWorkflowConfig(event.config);
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: "system",
        content: `工作流配置: 自动质检${event.config.autoCaptureAfterPatch ? "开启" : "关闭"}，最多 ${event.config.maxRevisionRounds} 轮，阈值 ${event.config.minQualityScore}。`,
      },
    ]);
    return;
  }
  if (event.type === "scene_dsl") {
    setLatestSceneDsl(event.scene);
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: "system",
        content: `Scene DSL: ${event.scene.sceneType} / ${event.scene.cameraPreset} / ${event.scene.renderStyle}。`,
      },
    ]);
    return;
  }
  if (event.type === "patch") {
    applyAgentPatch(event);
    return;
  }
  if (event.type === "assistant_message") {
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "assistant", content: event.message }]);
    return;
  }
  if (event.type === "status" || event.type === "reasoning_summary" || event.type === "coder_input_summary" || event.type === "error") {
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "system", content: event.message }]);
  }
  if (event.type === "run_status") {
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "system", content: event.message ?? `运行状态: ${event.status}` },
    ]);
  }
  if (event.type === "snapshot_saved") {
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "system", content: `已保存${event.stable ? "稳定" : ""}快照: ${event.label}` },
    ]);
  }
}

async function* readNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      yield streamEventSchema.parse(JSON.parse(line));
    }
  }
  if (buffer.trim()) {
    yield streamEventSchema.parse(JSON.parse(buffer));
  }
}

function extractSandpackFiles(files: Record<string, { code: string } | string>): FileMap {
  const result: Partial<Record<AllowedFilePath, string>> = {};
  for (const path of ALLOWED_FILE_PATHS) {
    const withSlash = files[`/${path}`];
    const withoutSlash = files[path];
    const value = withSlash ?? withoutSlash;
    result[path] = typeof value === "string" ? value : value?.code ?? defaultFiles[path];
  }
  return result as FileMap;
}

function toSandpackFiles(files: FileMap) {
  return {
    ...Object.fromEntries(Object.entries(files).map(([path, code]) => [`/${path}`, { code }])),
    "/App.tsx": {
      code: `import { useEffect } from "react";
import * as THREE from "three";
import "./src/styles.css";
import UserApp from "./src/App";

type ViewName = "front" | "back" | "left" | "right" | "side" | "top" | "bottom" | "three_quarter";

function readView() {
  return (window as any).__AGENTIC_THREE_VIEW__;
}

function renderView(view: any) {
  view?.controls?.update?.();
  if (view?.scene && view?.camera && view?.renderer) {
    view.renderer.render(view.scene, view.camera);
  }
}

function getSubjectBounds(view: any) {
  if (!view?.scene) return null;
  const bounds = new THREE.Box3();
  let hasSubject = false;
  view.scene.traverse((object: any) => {
    if (!object?.isMesh && !object?.isPoints && !object?.isLine) return;
    if (object === view.grid || object.userData?.agenticIgnoreBounds) return;
    bounds.expandByObject(object);
    hasSubject = true;
  });
  return hasSubject && !bounds.isEmpty() ? bounds : null;
}

function getFramedTarget(view: any) {
  const bounds = getSubjectBounds(view);
  if (!bounds) {
    const fallback = view?.target ?? view?.controls?.target ?? { x: 0, y: 0, z: 0 };
    return { target: fallback, radius: 1.8 };
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  return { target: center, radius: Math.max(size.x, size.y, size.z, 1.8) };
}

function setView(name: ViewName) {
  const view = readView();
  if (!view?.camera) return;
  const { target, radius } = getFramedTarget(view);
  const distance = Math.max(radius * 2.35, 4.2);
  const offsets: Record<ViewName, [number, number, number]> = {
    front: [0, radius * 0.12, distance],
    back: [0, radius * 0.12, -distance],
    left: [-distance, radius * 0.12, 0],
    right: [distance, radius * 0.12, 0],
    side: [distance, radius * 0.12, 0],
    top: [0, distance, 0.01],
    bottom: [0, -distance, 0.01],
    three_quarter: [distance * 0.72, radius * 0.35, distance * 0.72],
  };
  const [x, y, z] = offsets[name];
  view.camera.position.set(target.x + x, target.y + y, target.z + z);
  view.camera.lookAt(target.x, target.y, target.z);
  if (view.controls?.target?.set) {
    view.controls.target.set(target.x, target.y, target.z);
  }
  renderView(view);
}

let autoRotateFrame = 0;
let autoRotateEnabled = false;

function rotateCameraFallback(view: any) {
  if (!view?.camera?.position?.set) return;
  const target = view.target ?? view.controls?.target ?? { x: 0, y: 0, z: 0 };
  const dx = view.camera.position.x - target.x;
  const dz = view.camera.position.z - target.z;
  const angle = 0.008;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  view.camera.position.set(target.x + dx * cos - dz * sin, view.camera.position.y, target.z + dx * sin + dz * cos);
  view.camera.lookAt(target.x, target.y, target.z);
}

function tickAutoRotate() {
  if (!autoRotateEnabled) return;
  const view = readView();
  if (view?.controls) {
    view.controls.autoRotate = true;
    view.controls.autoRotateSpeed = 1.1;
  } else {
    rotateCameraFallback(view);
  }
  renderView(view);
  autoRotateFrame = requestAnimationFrame(tickAutoRotate);
}

function setAutoRotate(enabled: boolean) {
  autoRotateEnabled = enabled;
  const view = readView();
  if (view?.controls) {
    view.controls.autoRotate = enabled;
    view.controls.autoRotateSpeed = 1.1;
  }
  if (enabled) {
    cancelAnimationFrame(autoRotateFrame);
    tickAutoRotate();
  } else {
    cancelAnimationFrame(autoRotateFrame);
    autoRotateFrame = 0;
    renderView(view);
  }
}

export default function SandpackRoot() {
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; view?: ViewName; visible?: boolean; enabled?: boolean };
      const view = readView();
      if (data.type === "agentic-three:set-view" && data.view) {
        setView(data.view);
      }
      if (data.type === "agentic-three:set-grid") {
        if (view?.grid) view.grid.visible = data.visible !== false;
        renderView(view);
      }
      if (data.type === "agentic-three:set-auto-rotate") {
        setAutoRotate(data.enabled === true);
      }
      if (data.type === "agentic-three:capture") {
        try {
          renderView(view);
          const canvas = view?.renderer?.domElement ?? document.querySelector("canvas");
          if (!canvas) throw new Error("没有找到可截图的 canvas");
          const dataUrl = canvas.toDataURL("image/png");
          window.parent.postMessage({ type: "agentic-three:capture-result", requestId: data.requestId, dataUrl }, "*");
        } catch (error) {
          window.parent.postMessage({
            type: "agentic-three:capture-result",
            requestId: data.requestId,
            error: error instanceof Error ? error.message : String(error),
          }, "*");
        }
      }
    };
    window.addEventListener("message", handler);
    return () => {
      setAutoRotate(false);
      window.removeEventListener("message", handler);
    };
  }, []);

  return <UserApp />;
}
`,
      hidden: true,
      readOnly: true,
    },
  };
}

function requestPreviewCapture(postPreviewCommand: (payload: Record<string, unknown>) => void): Promise<string> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("截图超时，请确认预览已经渲染完成。"));
    }, 10000);
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; dataUrl?: string; error?: string };
      if (data.type !== "agentic-three:capture-result" || data.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", handler);
      if (data.error) {
        reject(new Error(data.error));
        return;
      }
      if (!data.dataUrl) {
        reject(new Error("截图没有返回图片数据。"));
        return;
      }
      resolve(data.dataUrl);
    };
    window.addEventListener("message", handler);
    postPreviewCommand({ type: "agentic-three:capture", requestId });
  });
}

async function saveWorkflowScreenshot(input: {
  sessionId: string;
  runId?: string;
  dataUrl: string;
  view: string;
}): Promise<{ path: string; fileName: string; url: string }> {
  const response = await fetch(`${apiUrl}/api/artifacts/screenshots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      runId: input.runId,
      dataUrl: input.dataUrl,
      view: input.view,
      mode: "save",
    }),
  });
  if (!response.ok) throw new Error(`工作流截图保存失败: ${response.status}`);
  const data = (await response.json()) as { artifact: { path: string; fileName: string; url: string } };
  return data.artifact;
}

async function captureWorkflowScreenshots(input: {
  sessionId: string;
  runId?: string;
  round: number;
  postPreviewCommand: (payload: Record<string, unknown>) => void;
}): Promise<Array<{ view: QualityReviewView; dataUrl: string; path: string; fileName: string; url: string }>> {
  const screenshots: Array<{ view: QualityReviewView; dataUrl: string; path: string; fileName: string; url: string }> = [];
  for (const view of QUALITY_REVIEW_VIEWS) {
    input.postPreviewCommand({ type: "agentic-three:set-view", view });
    await delay(180);
    const dataUrl = await requestPreviewCapture(input.postPreviewCommand);
    const artifact = await saveWorkflowScreenshot({
      sessionId: input.sessionId,
      runId: input.runId,
      dataUrl,
      view: `workflow-round-${input.round}-${view}`,
    });
    screenshots.push({ view, dataUrl, ...artifact });
  }
  return screenshots;
}

function buildRenderFailureQuality(error: unknown, runtimeErrors: RuntimeError[]): QualityInspectionResult {
  const message = error instanceof Error ? error.message : String(error);
  const runtimeMessage = runtimeErrors.map((item) => item.message).filter(Boolean).join("；");
  const note = [message, runtimeMessage].filter(Boolean).join("；");
  return {
    status: "revise",
    score: 0,
    scores: {
      geometry: 0,
      viewMatch: 0,
      material: 0,
      referenceSimilarity: 0,
      embeddingSimilarity: 0,
      renderHealth: 0,
      overall: 0,
    },
    checks: [
      {
        dimension: "renderHealth",
        item: "当前代码必须能渲染并完成截图",
        pass: false,
        confidence: 1,
        note,
        severity: "critical",
        suggestedFix:
          "只做运行健康最小修复：修复运行时错误、变量初始化顺序、renderer 初始化、render loop 和 __AGENTIC_THREE_VIEW__，确保下一轮能截图；不要重构模型外观。",
      },
    ],
    viewResults: [],
    featureMatches: [],
    embeddingMatches: [],
    issues: [`截图失败或运行时错误: ${note}`],
    structuredIssues: [
      {
        severity: "critical",
        problem: `截图失败或运行时错误: ${note}`,
      },
    ],
    revisionHints: [
      "运行健康修复模式：只修错误，不做视觉重构，不替换成新的示例模型。",
      "先修复运行时错误，尤其是 Cannot access 'x' before initialization / ReferenceError 这类变量作用域和初始化顺序问题。",
      "确保 renderer、scene、camera 初始化成功，并设置 window.__AGENTIC_THREE_VIEW__。",
    ],
    bestEffortReason: "当前预览无法截图，必须先修代码。",
    modelUsed: "render-health-guard",
    constraintStatus: "pass",
    constraintResiduals: {},
    constraintChecks: [],
  };
}

async function repairRuntimeErrorBeforeCapture(input: {
  sessionId: string;
  round: number;
  runId?: string;
  userGoal: string;
  files: FileMap;
  referenceImages: ImageInput[];
  runtimeErrors: RuntimeError[];
  qualityHistory: QualityHistoryEntry[];
  bestRound?: WorkflowBestRound;
  repairAttempt: number;
  dualCoderRequested: boolean;
  dualCoderReason: string;
  applyAgentPatch: (patch: PatchEvent) => void;
  setLatestPatchGenerator: Dispatch<SetStateAction<PatchEvent["generator"] | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}): Promise<boolean> {
  const quality = buildRenderFailureQuality(new Error("截图前运行健康检查发现 runtime error"), input.runtimeErrors);
  input.setMessages((items) => [
    ...items,
    {
      id: crypto.randomUUID(),
      role: "system",
      content: `第 ${input.round} 轮截图前发现运行错误，先调用 coder 修复，不进入视觉截图。最近错误: ${input.runtimeErrors[0]?.message ?? "unknown"}`,
    },
  ]);
  const response = await fetch(`${apiUrl}/api/coder/revise`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      runId: input.runId,
      round: input.round,
      userGoal: input.userGoal,
      files: input.files,
      quality,
      referenceImages: input.referenceImages,
      screenshots: [],
      runtimeErrors: input.runtimeErrors,
      qualityHistory: input.qualityHistory,
      bestRound: input.bestRound,
      repairAttempt: input.repairAttempt,
      dualCoderRequested: input.dualCoderRequested,
      dualCoderReason: input.dualCoderReason,
    }),
  });
  if (!response.ok) {
    input.setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: "system",
        content: `截图前运行错误修复失败: ${response.status}`,
      },
    ]);
    return false;
  }
  const data = (await response.json()) as {
    patch: PatchEvent;
    modelUsed?: string;
    dualCoderUsed?: boolean;
    discussionModels?: string[];
    discussionSummary?: string;
  };
  input.applyAgentPatch(data.patch);
  input.setLatestPatchGenerator("llm_coder");
  input.setMessages((items) => [
    ...items,
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `${data.dualCoderUsed ? `双 coder 已启用: ${(data.discussionModels ?? []).join(" + ") || "GLM + Doubao"}。${data.discussionSummary ?? ""}\n` : ""}已在截图前修复运行错误。模型: ${data.modelUsed ?? "unknown"}。${data.patch.summary}`,
    },
  ]);
  return true;
}

async function finalizeWorkflowSnapshot(input: {
  sessionId: string;
  runId?: string;
  label: string;
  files: FileMap;
  round: number;
  score: number;
  screenshotPath: string;
  screenshotPaths: Record<string, string>;
  userGoal: string;
  scene: SceneDsl;
}): Promise<void> {
  const response = await fetch(`${apiUrl}/api/workflow/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`工作流稳定快照保存失败: ${response.status}`);
}

async function estimateNonBlankPixelRatio(dataUrl: string): Promise<number> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  const width = 160;
  const height = Math.max(1, Math.round((image.height / Math.max(image.width, 1)) * width));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return 0;
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  let nonBlank = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 0;
    if (alpha < 8) continue;
    const red = pixels[index] ?? 255;
    const green = pixels[index + 1] ?? 255;
    const blue = pixels[index + 2] ?? 255;
    if (Math.abs(red - 255) + Math.abs(green - 255) + Math.abs(blue - 255) > 24) {
      nonBlank += 1;
    }
  }
  return nonBlank / (pixels.length / 4);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function downloadDataUrl(dataUrl: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  link.click();
}

async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  if (!navigator.clipboard || !("ClipboardItem" in window)) return false;
  const ClipboardItemCtor = window.ClipboardItem;
  await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type]: blob })]);
  return true;
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function prepareImageForModel(file: File): Promise<ImageInput> {
  if (file.type === "image/gif" || file.size < 700_000) {
    return {
      name: file.name || "参考图",
      mimeType: file.type || "image/png",
      dataUrl: await readDataUrl(file),
    };
  }

  try {
    const dataUrl = await resizeImageToJpegDataUrl(file, maxInputImageEdge, inputImageQuality);
    return {
      name: file.name || "参考图",
      mimeType: "image/jpeg",
      dataUrl,
      note: `已压缩到最长边不超过 ${maxInputImageEdge}px，避免请求体过大。`,
    };
  } catch {
    return {
      name: file.name || "参考图",
      mimeType: file.type || "image/png",
      dataUrl: await readDataUrl(file),
    };
  }
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function resizeImageToJpegDataUrl(file: File, maxEdge: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("无法创建图片压缩画布"));
        return;
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("图片压缩失败"));
    };
    image.src = objectUrl;
  });
}
