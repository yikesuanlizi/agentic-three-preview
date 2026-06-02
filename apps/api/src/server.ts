import "dotenv/config";
import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  type AgentTurnRequest,
  appSettingsSchema,
  agentTurnRequestSchema,
  applyPatch,
  defaultFiles,
  ndjson,
  screenshotSaveRequestSchema,
} from "@agentic-three/shared";
import { runAgent } from "./agent.js";
import { createSkill, inferSkill, installSkillsFromUrl, listLocalTools, listSkills } from "./skills.js";
import { listRecentInputImages, readOutputFile, saveInputImageArtifacts, saveScreenshotArtifact } from "./artifacts.js";
import { envStatus, getAppSettings, saveAppSettings } from "./settings.js";
import {
  appendRunEvent,
  createRun,
  deleteSession,
  getRun,
  getSessionState,
  listRecentTurns,
  listRunEvents,
  listScreenshotArtifacts,
  listSessions,
  listTurns,
  saveFileSnapshot,
  saveSummary,
  saveTurn,
  updateRunStatus,
  updateRunUsage,
  upsertSession,
} from "./memory.js";

const app = Fastify({
  logger: true,
  bodyLimit: 25 * 1024 * 1024,
});

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

app.get("/health", async () => ({ ok: true }));

app.get("/api/skills", async () => ({
  skills: listSkills().map(({ content: _content, ...skill }) => skill),
}));

app.post("/api/skills", async (request) => ({
  skill: createSkill(request.body),
}));

app.post("/api/skills/infer", async (request) => ({
  skill: await inferSkill(request.body),
}));

app.post("/api/skills/install", async (request) => ({
  skills: await installSkillsFromUrl(request.body),
}));

app.get("/api/tools", async () => ({
  tools: listLocalTools(),
}));

app.get("/api/default-files", async () => ({
  files: defaultFiles,
}));

app.get("/api/memory/sessions", async () => ({
  sessions: listSessions(),
}));

app.delete("/api/memory/sessions/:sessionId", async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const deleted = deleteSession(sessionId);
  if (!deleted) {
    reply.code(404);
    return { error: "会话不存在" };
  }
  return { ok: true };
});

app.get("/api/memory/sessions/:sessionId/turns", async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  return {
    turns: listTurns(sessionId),
  };
});

app.get("/api/sessions/:sessionId/state", async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  return getSessionState(sessionId);
});

app.get("/api/settings", async () => {
  const settings = getAppSettings();
  return {
    settings,
    env: envStatus(settings),
  };
});

app.put("/api/settings", async (request) => {
  const body = request.body as { settings?: unknown; secrets?: Record<string, string> };
  const settings = appSettingsSchema.parse(body.settings);
  const saved = saveAppSettings(settings, body.secrets);
  return {
    settings: saved,
    env: envStatus(saved),
  };
});

app.get("/api/runs/:runId", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const run = getRun(runId);
  if (!run) {
    reply.code(404);
    return { error: "运行不存在" };
  }
  return {
    run,
    events: listRunEvents(runId),
  };
});

app.post("/api/artifacts/screenshots", async (request) => {
  const parsed = screenshotSaveRequestSchema.parse(request.body);
  const artifact = saveScreenshotArtifact(parsed);
  return {
    artifact,
    mode: parsed.mode,
  };
});

app.get("/api/artifacts/screenshots", async (request) => {
  const query = request.query as { sessionId?: string };
  return {
    artifacts: listScreenshotArtifacts(query.sessionId),
  };
});

app.get("/api/artifacts/file", async (request, reply) => {
  const query = request.query as { path?: string };
  if (!query.path) {
    reply.code(400);
    return { error: "缺少 path" };
  }
  const file = readOutputFile(query.path);
  reply.header("content-type", "image/png");
  reply.header("content-disposition", `inline; filename="${encodeURIComponent(file.fileName)}"`);
  return reply.send(file.bytes);
});

app.post("/api/agent/turn", async (request, reply) => {
  const origin = request.headers.origin;
  reply.raw.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": origin ?? "*",
    vary: "origin",
  });

  const write = (event: Parameters<typeof ndjson>[0]) => {
    reply.raw.write(ndjson(event));
  };

  try {
    let parsed = agentTurnRequestSchema.parse(request.body) as AgentTurnRequest;
    console.log("[agentic-three:api] /api/agent/turn received", {
      sessionId: parsed.sessionId,
      message: parsed.message,
      imageCount: parsed.images.length,
      imageDataUrlLengths: parsed.images.map((image) => image.dataUrl.length),
      runtimeErrorCount: parsed.runtimeErrors.length,
    });
    upsertSession(parsed.sessionId, parsed.message || "图片参考场景");
    const run = createRun(parsed.sessionId);
    const receivedImageCount = parsed.images.length;
    let reusedImageCount = 0;
    if (parsed.images.length) {
      parsed = {
        ...parsed,
        images: saveInputImageArtifacts({ sessionId: parsed.sessionId, runId: run.runId, images: parsed.images }),
      };
      console.log("[agentic-three:api] input images saved", {
        runId: run.runId,
        imageCount: parsed.images.length,
        names: parsed.images.map((image) => image.name),
      });
    } else if (shouldReuseRecentImages(parsed.message)) {
      const recentImages = listRecentInputImages(parsed.sessionId, 4);
      if (recentImages.length) {
        reusedImageCount = recentImages.length;
        parsed = { ...parsed, images: recentImages };
      }
    }
    console.log("[agentic-three:api] run input finalized", {
      runId: run.runId,
      receivedImageCount,
      reusedImageCount,
      finalImageCount: parsed.images.length,
    });
    write({ type: "run_id", runId: run.runId });
    appendRunEvent(run.runId, parsed.sessionId, "run.start", {
      message: parsed.message,
      imageCount: parsed.images.length,
      receivedImageCount,
      reusedImageCount,
    });
    saveFileSnapshot(parsed.sessionId, run.runId, "pre-run", parsed.files, true);
    write({ type: "snapshot_saved", runId: run.runId, label: "pre-run", stable: true });
    updateRunStatus(run.runId, "running");
    write({ type: "run_status", runId: run.runId, status: "running", message: "Agent 运行中。" });
    if (reusedImageCount) {
      write({ type: "status", message: `已复用上一轮参考图 ${reusedImageCount} 张。` });
    }
    saveTurn(parsed.sessionId, "user", formatUserTurnMemory(parsed.message, parsed.images.length, reusedImageCount));
    write({ type: "status", message: "Agent 图开始执行。" });
    const sessionState = getSessionState(parsed.sessionId);
    const recentHistory = listRecentTurns(parsed.sessionId, 4).map((turn) => ({ role: turn.role, content: turn.content }));
    const result = await runAgent({
      request: parsed,
      runId: run.runId,
      compactSummary: sessionState.summary,
      recentHistory,
      settings: getAppSettings(),
    });
    const assistantMemory: string[] = [];
    let latestFiles = parsed.files;
    let hadError = false;
    for (const event of result.events) {
      write(event);
      appendRunEvent(run.runId, parsed.sessionId, event.type, event);
      if (event.type === "assistant_message") assistantMemory.push(event.message);
      if (event.type === "patch") {
        assistantMemory.push(`已应用补丁: ${event.summary}`);
        latestFiles = applyPatch(latestFiles, event);
        saveFileSnapshot(parsed.sessionId, run.runId, "post-run", latestFiles, true);
        write({ type: "snapshot_saved", runId: run.runId, label: "post-run", stable: true });
      }
      if (event.type === "error") {
        hadError = true;
        assistantMemory.push(`错误: ${event.message}`);
      }
      if (event.type === "usage") updateRunUsage(run.runId, event.inputTokens, event.outputTokens);
    }
    if (assistantMemory.length) {
      saveTurn(parsed.sessionId, "assistant", assistantMemory.join("\n\n"));
    }
    saveSummary(parsed.sessionId, result.nextCompactSummary);
    if (hadError) {
      updateRunStatus(run.runId, "error", "Agent 输出了错误事件，未完成有效补丁。");
      appendRunEvent(run.runId, parsed.sessionId, "run.error", {});
      write({ type: "run_status", runId: run.runId, status: "error", message: "Agent 运行失败，已保留当前稳定快照。" });
      write({ type: "status", message: "Agent 图执行结束，但没有产生有效补丁。" });
    } else {
      updateRunStatus(run.runId, "success");
      appendRunEvent(run.runId, parsed.sessionId, "run.success", {});
      write({ type: "run_status", runId: run.runId, status: "success", message: "Agent 运行完成。" });
      write({ type: "status", message: "Agent 图执行结束。" });
    }
  } catch (error) {
    console.error("[agentic-three:api] /api/agent/turn failed", error);
    const body = request.body as { sessionId?: string };
    write({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    if (body?.sessionId) {
      const latest = getSessionState(body.sessionId).latestRun;
      if (latest && (latest.status === "running" || latest.status === "pending")) {
        updateRunStatus(latest.runId, "error", error instanceof Error ? error.message : String(error));
        write({ type: "run_status", runId: latest.runId, status: "error", message: "Agent 运行失败。" });
      }
    }
  } finally {
    reply.raw.end();
  }
});

const host = process.env.API_HOST || "127.0.0.1";
const port = Number(process.env.API_PORT || 8787);

await app.listen({ host, port });

function shouldReuseRecentImages(message: string): boolean {
  const text = message.trim();
  if (!text) return true;
  return /再试|重试|继续|按刚才|刚才那张|上一张|这个图|这张图|参考图|仍然|依旧|重新/i.test(text);
}

function formatUserTurnMemory(message: string, imageCount: number, reusedImageCount: number): string {
  const text = message.trim() || "图片参考场景";
  const imageNote = imageCount
    ? `\n[参考图 ${imageCount} 张${reusedImageCount ? `，其中复用上一轮 ${reusedImageCount} 张` : ""}]`
    : "";
  return `${text}${imageNote}`;
}
