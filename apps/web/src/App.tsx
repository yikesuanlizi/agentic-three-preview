import { type ClipboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type AppSettings,
  type FileMap,
  type ImageInput,
  type ModelConfig,
  type PatchEvent,
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

type PreviewView = "front" | "back" | "left" | "right" | "top" | "bottom";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787";
const initialAssistantMessage = "准备好了。把你的 three.js 场景想法发给我。";
const maxInputImageEdge = 1600;
const inputImageQuality = 0.86;

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
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
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
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [screenshotMode, setScreenshotMode] = useState<ScreenshotMode>("download");
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
  const [past, setPast] = useState<FileMap[]>([]);
  const [future, setFuture] = useState<FileMap[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const currentFiles = useCallback(() => extractSandpackFiles(sandpack.files), [sandpack.files]);

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
      for (const path of ALLOWED_FILE_PATHS) {
        sandpack.updateFile(`/${path}`, snapshot[path]);
      }
    },
    [sandpack],
  );

  const applyAgentPatch = useCallback(
    (patch: PatchEvent) => {
      const before = currentFiles();
      const after = applyPatch(before, patch);
      setPast((items) => [...items, before].slice(-20));
      setFuture([]);
      applySnapshot(after);
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `已应用补丁: ${patch.summary}`,
        },
      ]);
    },
    [applySnapshot, currentFiles],
  );

  const undo = () => {
    setPast((items) => {
      const snapshot = items.at(-1);
      if (!snapshot) return items;
      setFuture((futureItems) => [currentFiles(), ...futureItems].slice(0, 20));
      applySnapshot(snapshot);
      return items.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture((items) => {
      const snapshot = items[0];
      if (!snapshot) return items;
      setPast((pastItems) => [...pastItems, currentFiles()].slice(-20));
      applySnapshot(snapshot);
      return items.slice(1);
    });
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
    setSessionId(targetSessionId);
    setMessages(
      data.turns.length
        ? data.turns.map((turn) => ({
            id: String(turn.id),
            role: turn.role,
            content: turn.content,
          }))
        : [{ id: crypto.randomUUID(), role: "assistant", content: initialAssistantMessage }],
    );
    if (state?.latestStableSnapshot?.files) {
      applySnapshot(state.latestStableSnapshot.files);
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
      const payload = {
        sessionId,
        message: userText,
        images,
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
      for await (const event of readNdjson(response.body)) {
        handleStreamEvent(event, applyAgentPatch, setMessages, setCurrentRunId);
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
                <button className="send-button" onClick={() => void submit()} disabled={isRunning}>
                  <Send size={16} />
                  <span>{isRunning ? "执行中" : "发送"}</span>
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
          apiKeyDraft={apiKeyDraft}
          onApiKeyDraftChange={setApiKeyDraft}
          onClose={() => setSettingsOpen(false)}
          onChange={setAppSettings}
          onSkillsRefresh={refreshSkills}
          onSave={async () => {
            const response = await fetch(`${apiUrl}/api/settings`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                settings: { ...appSettings, screenshotMode },
                secrets: apiKeyDraft ? { GITEE_API_KEY: apiKeyDraft } : {},
              }),
            });
            if (!response.ok) throw new Error(`设置保存失败: ${response.status}`);
            const data = (await response.json()) as { settings: AppSettings; env: Record<string, boolean> };
            setAppSettings(data.settings);
            setEnvStatus(data.env);
            setApiKeyDraft("");
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
  apiKeyDraft,
  onApiKeyDraftChange,
  onChange,
  onSkillsRefresh,
  onClose,
  onSave,
}: {
  settings: AppSettings;
  skills: SkillCard[];
  envStatus: Record<string, boolean>;
  apiKeyDraft: string;
  onApiKeyDraftChange: (value: string) => void;
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
  const updateModel = (index: number, patch: Partial<ModelConfig>) => {
    onChange({
      ...settings,
      models: settings.models.map((model, modelIndex) => (modelIndex === index ? { ...model, ...patch } : model)),
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
          <div className="settings-secret">
            <label>
              GITEE_API_KEY
              <input
                value={apiKeyDraft}
                onChange={(event) => onApiKeyDraftChange(event.target.value)}
                placeholder={envStatus.GITEE_API_KEY ? "已检测到环境变量" : "未检测到，请输入后保存到项目 .env"}
                type="password"
              />
            </label>
            <span className={envStatus.GITEE_API_KEY ? "env-ok" : "env-missing"}>
              {envStatus.GITEE_API_KEY ? "已配置" : "未配置"}
            </span>
          </div>
          <div className="settings-grid">
            {settings.models.map((model, index) => (
              <div className="settings-row" key={model.node}>
                <strong>{model.node}</strong>
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

function handleStreamEvent(
  event: StreamEvent,
  applyAgentPatch: (patch: PatchEvent) => void,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setCurrentRunId: React.Dispatch<React.SetStateAction<string | undefined>>,
) {
  if (event.type === "run_id") {
    setCurrentRunId(event.runId);
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

type ViewName = "front" | "back" | "left" | "right" | "top" | "bottom";

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
    top: [0, distance, 0.01],
    bottom: [0, -distance, 0.01],
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
    }, 3500);
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
