import "dotenv/config";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { spawnSync } from "node:child_process";
import {
  type AgentTurnRequest,
  assemblyGraphSchema,
  assemblySolverResultSchema,
  aircraftAssetCategorySchema,
  appSettingsSchema,
  agentTurnRequestSchema,
  applyPatch,
  coderRevisionRequestSchema,
  defaultFiles,
  knowledgeClearRequestSchema,
  ndjson,
  qualityInspectionRequestSchema,
  ragIngestResultSchema,
  ragSearchRequestSchema,
  ragSourceResolveRequestSchema,
  retrievalSearchRequestSchema,
  screenshotSaveRequestSchema,
  sceneComposeRequestSchema,
  sceneRenderRequestSchema,
  workflowFinalizeRequestSchema,
  workflowReviewRoundRequestSchema,
  workflowRevisionEventSchema,
} from "@agentic-three/shared";
import { hasThreeConsecutiveCandidateScoreDrops, reviseCoderPatchWithModel, runAgent } from "./agent.js";
import { listAircraftAssets } from "./aircraftAssets.js";
import { readActiveAssetImportJob, readAssetImportJob, startAssetImportJob } from "./assetImporter.js";
import { searchAircraftKnowledge } from "./aircraftRetrieval.js";
import { createSkill, inferSkill, installSkillsFromUrl, listLocalTools, listSkills } from "./skills.js";
import { composeScene, renderSceneToFiles } from "./sceneRuntime.js";
import { inspectQuality, reviseScene } from "./quality.js";
import { solveAssemblyGraph, verifyAssemblyConstraints } from "./assembly.js";
import { clearKnowledgeBase } from "./knowledgeReset.js";
import { ensureAircraftRagSynced, ingestAircraftRag, ingestGeneratedSceneRag, resolveRagSource, searchAircraftRag } from "./rag.js";
import { getRagHealthError, isRagDatabaseReady, isRagFallbackForced, ragDatabaseUrl } from "./ragDb.js";
import { cleanupOrphanArtifactFiles, deleteSessionArtifactFiles, listRecentInputImages, readOutputFile, readProjectAssetFile, saveInputImageArtifacts, saveScreenshotArtifact } from "./artifacts.js";
import { envStatus, getAppSettings, saveAppSettings } from "./settings.js";
import {
  appendRunEvent,
  createRun,
  deleteSession,
  getRun,
  getSessionState,
  listRecentTurns,
  listRunFileSnapshots,
  listRunEvents,
  listScreenshotArtifacts,
  listSessions,
  listTurns,
  saveFileSnapshot,
  saveSceneState,
  saveSummary,
  saveTurn,
  saveVisualMemory,
  updateRunStatus,
  updateRunUsage,
  upsertSession,
} from "./memory.js";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding("utf8");
  process.stderr.setDefaultEncoding("utf8");
  spawnSync("chcp.com", ["65001"], { stdio: "ignore" });
}

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

app.get("/api/assets", async (request) => {
  const query = request.query as { category?: string };
  const category = query.category ? aircraftAssetCategorySchema.parse(query.category) : undefined;
  return {
    assets: listAircraftAssets(category),
  };
});

app.post("/api/assets/import-jobs", async (request) => ({
  job: startAssetImportJob(request.body),
}));

app.get("/api/assets/import-jobs/active", async () => ({
  job: readActiveAssetImportJob() ?? null,
}));

app.get("/api/assets/import-jobs/:jobId", async (request, reply) => {
  const { jobId } = request.params as { jobId: string };
  const job = readAssetImportJob(jobId);
  if (!job) {
    reply.code(404);
    return { error: "导入任务不存在" };
  }
  return { job };
});

app.post("/api/retrieval/search", async (request) => {
  const parsed = retrievalSearchRequestSchema.parse(request.body);
  const result = await searchAircraftRag(parsed);
  return result.mode === "fallback" ? searchAircraftKnowledge(parsed) : result;
});

app.get("/api/rag/status", async () => ({
  ready: await isRagDatabaseReady(),
  databaseUrl: ragDatabaseUrl.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@"),
  fallbackForced: isRagFallbackForced(),
  lastError: getRagHealthError(),
}));

app.post("/api/rag/ingest", async () => ({
  result: ragIngestResultSchema.parse(await ingestAircraftRag()),
}));

app.post("/api/rag/clear", async (request) => {
  const parsed = knowledgeClearRequestSchema.parse(request.body);
  return {
    result: await clearKnowledgeBase(parsed),
  };
});

app.post("/api/rag/search", async (request) => {
  const parsed = ragSearchRequestSchema.parse(request.body);
  if (parsed.scope !== "imported") await ensureAircraftRagSynced();
  return searchAircraftRag(parsed);
});

app.post("/api/rag/source", async (request) => {
  const parsed = ragSourceResolveRequestSchema.parse(request.body);
  return resolveRagSource(parsed);
});

app.post("/api/scene/compose", async (request) => {
  const parsed = sceneComposeRequestSchema.parse(request.body);
  return {
    scene: composeScene(parsed),
  };
});

app.post("/api/scene/render", async (request) => {
  const parsed = sceneRenderRequestSchema.parse(request.body);
  return renderSceneToFiles(parsed);
});

app.post("/api/assembly/solve", async (request) => {
  const graph = assemblyGraphSchema.parse(request.body);
  return {
    result: solveAssemblyGraph(graph),
  };
});

app.post("/api/assembly/verify", async (request) => {
  const body = request.body as { graph?: unknown; solverResult?: unknown };
  const graph = assemblyGraphSchema.parse(body.graph ?? request.body);
  const solverResult = body.solverResult ? assemblySolverResultSchema.parse(body.solverResult) : undefined;
  return {
    result: verifyAssemblyConstraints(graph, solverResult),
  };
});

app.post("/api/quality/inspect", async (request) => {
  const result = await inspectQuality(request.body, getAppSettings());
  const parsed = workflowQualityStateInput(request.body);
  saveSceneState({
    sessionId: parsed.sessionId,
    runId: parsed.runId,
    round: parsed.round,
    userGoal: parsed.userGoal,
    scene: parsed.scene,
    quality: result,
    screenshotPaths: Object.fromEntries(parsed.screenshots.map((screenshot) => [screenshot.view, screenshot.path ?? ""]).filter((entry) => entry[1])),
    status: "reviewed",
  });
  if (parsed.runId) {
    appendRunEvent(parsed.runId, parsed.sessionId, "quality.inspect", {
      round: parsed.round,
      modelUsed: result.modelUsed,
      score: result.score,
      scores: result.scores,
      status: result.status,
      issues: result.issues,
      checks: result.checks,
      viewResults: result.viewResults,
      structuredIssues: result.structuredIssues,
      constraintStatus: result.constraintStatus,
      constraintResiduals: result.constraintResiduals,
      constraintChecks: result.constraintChecks,
    });
  }
  return { result };
});

app.post("/api/workflow/review-rounds", async (request) => {
  const parsed = workflowReviewRoundRequestSchema.parse(request.body);
  const settings = getAppSettings();
  const quality = await inspectQuality(
    {
      sessionId: parsed.sessionId,
      runId: parsed.runId,
      round: parsed.round,
      userGoal: parsed.userGoal,
      referenceImages: parsed.referenceImages,
      screenshots: parsed.screenshots,
      scene: parsed.scene,
      runtimeErrors: parsed.runtimeErrors,
    },
    settings,
  );
  const screenshotPaths = Object.fromEntries(parsed.screenshots.map((screenshot) => [screenshot.view, screenshot.path ?? ""]).filter((entry) => entry[1]));
  saveSceneState({
    sessionId: parsed.sessionId,
    runId: parsed.runId,
    round: parsed.round,
    userGoal: parsed.userGoal,
    scene: parsed.scene,
    quality,
    screenshotPaths,
    status: "reviewed",
  });
  const qualityHistory = [
    ...parsed.qualityHistory,
    {
      round: parsed.round,
      score: quality.score,
      candidateScore: quality.candidateScore,
      status: quality.status,
      modelUsed: quality.modelUsed,
      selectedBest: false,
    },
  ];
  const scoreDropDualCoder = hasThreeConsecutiveCandidateScoreDrops(qualityHistory);
  const dualCoderRequested = parsed.dualCoderRequested || scoreDropDualCoder;
  const dualCoderReason = parsed.dualCoderReason || (scoreDropDualCoder ? "连续 3 个有效质检轮候选分下降" : "");
  const maxRevisionRounds = parsed.maxRevisionRounds ?? settings.runtimeComposer.maxRevisionRounds;
  const nonBlockingFallback =
    quality.status === "fallback" &&
    !parsed.referenceImages.length &&
    !quality.checks.some((check) => !check.pass && check.severity === "critical");
  let decision: "pass" | "continue" | "ask_user" | "fallback" | "max_rounds" =
    quality.status === "pass"
      ? "pass"
      : quality.status === "ask_user"
        ? "ask_user"
        : quality.status === "fallback" && !nonBlockingFallback
          ? "fallback"
          : parsed.round >= maxRevisionRounds
            ? "max_rounds"
            : "continue";
  let patchResult: Awaited<ReturnType<typeof reviseCoderPatchWithModel>> | undefined;
  let patchApplyError = "";
  if (decision === "continue" && parsed.patchGenerator === "llm_coder") {
    patchResult = await reviseCoderPatchWithModel({
      request: {
        sessionId: parsed.sessionId,
        runId: parsed.runId,
        round: parsed.round,
        userGoal: parsed.userGoal,
        files: parsed.files,
        quality,
        referenceImages: parsed.referenceImages,
        screenshots: parsed.screenshots,
        runtimeErrors: parsed.runtimeErrors,
        qualityHistory,
        bestRound: parsed.bestRound,
        repairAttempt: 0,
        dualCoderRequested,
        dualCoderReason,
      },
      settings,
    });
    if (!patchResult) decision = "fallback";
  }
  const coderSnapshotLabel = patchResult ? `workflow-coder-revise-round-${parsed.round}` : undefined;
  if (patchResult) {
    try {
      const revisedFiles = applyPatch(parsed.files, { ...patchResult.patch, generator: "llm_coder" as const });
      if (parsed.runId) saveFileSnapshot(parsed.sessionId, parsed.runId, coderSnapshotLabel!, revisedFiles, false);
    } catch (error) {
      patchApplyError = error instanceof Error ? error.message : String(error);
      const retryResult = await reviseCoderPatchWithModel({
        request: {
          sessionId: parsed.sessionId,
          runId: parsed.runId,
          round: parsed.round,
          userGoal: `${parsed.userGoal}\n\n上一次 coder patch 无法应用: ${patchApplyError}。如果目标函数不存在，必须改用 replace_file 完整重构，或只替换 Current Files 中确实存在的函数。`,
          files: parsed.files,
          quality,
          referenceImages: parsed.referenceImages,
          screenshots: parsed.screenshots,
          runtimeErrors: [
            ...parsed.runtimeErrors,
            {
              message: `coder patch apply failed: ${patchApplyError}`,
              source: "workflow.patch_apply",
            },
          ],
          qualityHistory: parsed.qualityHistory,
          bestRound: parsed.bestRound,
          repairAttempt: 0,
          dualCoderRequested: true,
          dualCoderReason: `patch 应用失败后升级双 coder: ${patchApplyError}`,
        },
        settings,
      });
      if (retryResult) {
        try {
          const revisedFiles = applyPatch(parsed.files, { ...retryResult.patch, generator: "llm_coder" as const });
          patchResult = retryResult;
          patchApplyError = "";
          if (parsed.runId) saveFileSnapshot(parsed.sessionId, parsed.runId, coderSnapshotLabel!, revisedFiles, false);
        } catch (retryError) {
          patchApplyError = `${patchApplyError}；重试 patch 仍无法应用: ${retryError instanceof Error ? retryError.message : String(retryError)}`;
          decision = parsed.round >= maxRevisionRounds ? "max_rounds" : "continue";
          patchResult = undefined;
        }
      } else {
        decision = parsed.round >= maxRevisionRounds ? "max_rounds" : "continue";
        patchResult = undefined;
      }
    }
  }
  const response = {
    decision,
    quality,
    patch: patchResult ? { ...patchResult.patch, generator: "llm_coder" as const } : undefined,
    modelUsed: patchResult?.modelUsed,
    fallbackReason: patchResult?.fallbackReason,
    dualCoderUsed: patchResult?.dualCoderUsed ?? false,
    discussionModels: patchResult?.discussionModels ?? [],
    discussionSummary: patchResult?.discussionSummary ?? "",
    message:
      patchApplyError
        ? `coder 返回的 patch 无法应用，已拒绝本轮修正但保留当前可截图版本继续: ${patchApplyError}`
        :
      decision === "pass"
        ? "视觉 review 通过。"
        : decision === "max_rounds"
          ? "已达到最大 review 轮数，保留当前最好结果。"
          : decision === "continue"
            ? "视觉 review 未通过，已生成下一轮 coder 修正 patch。"
            : quality.bestEffortReason || "视觉 review 无法继续自动修正。",
  };
  if (parsed.runId) {
    appendRunEvent(parsed.runId, parsed.sessionId, "workflow.review_round", {
      round: parsed.round,
      decision,
      modelUsed: quality.modelUsed,
      score: quality.score,
      candidateScore: quality.candidateScore,
      matchedReferenceView: quality.matchedReferenceView,
      scores: quality.scores,
      status: quality.status,
      issues: quality.issues,
      checks: quality.checks,
      viewResults: quality.viewResults,
      featureMatches: quality.featureMatches,
      embeddingMatches: quality.embeddingMatches,
      structuredIssues: quality.structuredIssues,
      constraintStatus: quality.constraintStatus,
      constraintResiduals: quality.constraintResiduals,
      constraintChecks: quality.constraintChecks,
      coderModelUsed: patchResult?.modelUsed,
      coderSummary: patchResult?.patch.summary,
      coderSnapshotLabel,
      patchApplyError,
      dualCoderUsed: patchResult?.dualCoderUsed ?? false,
      discussionModels: patchResult?.discussionModels ?? [],
      discussionSummary: patchResult?.discussionSummary ?? "",
    });
  }
  return response;
});

app.post("/api/scene/revise", async (request) => ({
  result: await reviseScene(request.body),
}));

app.post("/api/coder/revise", async (request, reply) => {
  const parsed = coderRevisionRequestSchema.parse(request.body);
  let result = await reviseCoderPatchWithModel({ request: parsed, settings: getAppSettings() });
  if (!result) {
    reply.code(502);
    return {
      error: "coder_agent 未能根据质检报告生成可用修正 patch。",
    };
  }
  let revisedFiles: ReturnType<typeof applyPatch>;
  let patchApplyError = "";
  let patchApplyRetried = false;
  try {
    revisedFiles = applyPatch(parsed.files, { ...result.patch, generator: "llm_coder" as const });
  } catch (error) {
    patchApplyError = error instanceof Error ? error.message : String(error);
    patchApplyRetried = true;
    const retryResult = await reviseCoderPatchWithModel({
      request: {
        ...parsed,
        userGoal: `${parsed.userGoal}\n\n上一次运行错误修复 patch 无法应用，错误如下: ${patchApplyError}\n必须返回能通过 TypeScript/TSX 基础语法检查的 patch；如果函数级补丁导致残缺签名或目标函数范围不确定，必须改用 replace_file 输出完整 src/App.tsx。`,
        runtimeErrors: [
          ...parsed.runtimeErrors,
          {
            message: `coder runtime repair patch apply failed: ${patchApplyError}`,
            source: "coder.revise.patch_apply",
          },
        ],
        dualCoderRequested: true,
        dualCoderReason: `运行错误修复 patch 应用失败后升级双 coder: ${patchApplyError}`,
      },
      settings: getAppSettings(),
    });
    if (!retryResult) {
      reply.code(422);
      return {
        error: `coder_agent 返回的 patch 无法应用: ${patchApplyError}`,
      };
    }
    try {
      revisedFiles = applyPatch(parsed.files, { ...retryResult.patch, generator: "llm_coder" as const });
      result = retryResult;
      patchApplyError = "";
    } catch (retryError) {
      reply.code(422);
      return {
        error: `coder_agent 返回的 patch 无法应用: ${patchApplyError}；重试 patch 仍无法应用: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
      };
    }
  }
  if (parsed.runId) {
    const snapshotLabel = `coder-revise-round-${parsed.round}`;
    saveFileSnapshot(parsed.sessionId, parsed.runId, snapshotLabel, revisedFiles, false);
    appendRunEvent(parsed.runId, parsed.sessionId, "coder.revise", {
      round: parsed.round,
      modelUsed: result.modelUsed,
      fallbackReason: result.fallbackReason,
      summary: result.patch.summary,
      snapshotLabel,
      patchApplyRetry: patchApplyRetried,
      dualCoderUsed: result.dualCoderUsed ?? false,
      discussionModels: result.discussionModels ?? [],
      discussionSummary: result.discussionSummary ?? "",
    });
  }
  return {
    patch: { ...result.patch, generator: "llm_coder" as const },
    modelUsed: result.modelUsed,
    fallbackReason: result.fallbackReason,
    usage: result.usage,
    dualCoderUsed: result.dualCoderUsed ?? false,
    discussionModels: result.discussionModels ?? [],
    discussionSummary: result.discussionSummary ?? "",
  };
});

app.post("/api/workflow/revision-event", async (request) => {
  const parsed = workflowRevisionEventSchema.parse(request.body);
  if (parsed.runId) {
    appendRunEvent(parsed.runId, parsed.sessionId, "workflow.revision", parsed);
  }
  return { ok: true };
});

app.post("/api/workflow/finalize", async (request) => {
  const parsed = workflowFinalizeRequestSchema.parse(request.body);
  saveFileSnapshot(parsed.sessionId, parsed.runId, parsed.label, parsed.files, true);
  let stateId: string | undefined;
  if (parsed.scene) {
    const sceneState = saveSceneState({
      sessionId: parsed.sessionId,
      runId: parsed.runId,
      round: parsed.round,
      userGoal: parsed.userGoal,
      scene: parsed.scene,
      screenshotPaths: parsed.screenshotPaths,
      status: "final",
    });
    stateId = sceneState.stateId;
    saveVisualMemory({
      sessionId: parsed.sessionId,
      runId: parsed.runId,
      stateId,
      userGoal: parsed.userGoal,
      scene: sceneState.scene,
      screenshotPaths: parsed.screenshotPaths,
      score: parsed.score,
    });
  }
  const ragResult = await ingestGeneratedSceneRag({
    sessionId: parsed.sessionId,
    runId: parsed.runId,
    label: parsed.label,
    userGoal: parsed.userGoal,
    scene: parsed.scene,
    screenshotPath: parsed.screenshotPath,
    round: parsed.round,
    score: parsed.score,
  });
  if (parsed.runId) {
    appendRunEvent(parsed.runId, parsed.sessionId, "workflow.finalize", {
      label: parsed.label,
      round: parsed.round,
      score: parsed.score,
      screenshotPath: parsed.screenshotPath,
      screenshotPaths: parsed.screenshotPaths,
      stateId,
      rag: ragResult,
    });
  }
  return {
    ok: true,
    label: parsed.label,
    rag: ragResult,
  };
});

app.get("/api/default-files", async () => ({
  files: defaultFiles,
}));

app.get("/api/memory/sessions", async () => ({
  sessions: listSessions(),
}));

app.delete("/api/memory/sessions/:sessionId", async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const sessionArtifacts = deleteSessionArtifactFiles(sessionId);
  const deleted = deleteSession(sessionId);
  if (!deleted) {
    reply.code(404);
    return { error: "会话不存在" };
  }
  const orphanArtifacts = cleanupOrphanArtifactFiles();
  return { ok: true, deletedArtifacts: sessionArtifacts, orphanCleanup: orphanArtifacts };
});

app.get("/api/memory/sessions/:sessionId/turns", async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  return {
    turns: listTurns(sessionId),
  };
});

app.get("/api/memory/sessions/:sessionId/input-images/recent", async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  const query = request.query as { limit?: string };
  return {
    images: listRecentInputImages(sessionId, Math.max(1, Math.min(4, Number(query.limit ?? 4) || 4))),
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
    snapshots: listRunFileSnapshots(runId),
  };
});

app.get("/api/workflow/runs/:runId", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const run = getRun(runId);
  if (!run) {
    reply.code(404);
    return { error: "运行不存在" };
  }
  const events = listRunEvents(runId);
  return {
    run,
    events,
    snapshots: listRunFileSnapshots(runId),
    reviewRounds: events.filter((event) => event.eventType === "workflow.review_round"),
    finalizations: events.filter((event) => event.eventType === "workflow.finalize"),
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

app.get("/api/assets/file", async (request, reply) => {
  const query = request.query as { path?: string };
  if (!query.path) {
    reply.code(400);
    return { error: "缺少 path" };
  }
  const file = readProjectAssetFile(query.path);
  reply.header("content-type", file.mimeType);
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

  let clientClosed = false;
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) clientClosed = true;
  });
  const write = (event: Parameters<typeof ndjson>[0]) => {
    if (clientClosed || reply.raw.destroyed || reply.raw.writableEnded) return;
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
    } else if (shouldReuseRecentImages(parsed.message, parsed.sessionId)) {
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
    appendRunEvent(run.runId, parsed.sessionId, "run_id", { type: "run_id", runId: run.runId });
    appendRunEvent(run.runId, parsed.sessionId, "run.start", {
      message: parsed.message,
      imageCount: parsed.images.length,
      receivedImageCount,
      reusedImageCount,
    });
    saveFileSnapshot(parsed.sessionId, run.runId, "pre-run", parsed.files, true);
    write({ type: "snapshot_saved", runId: run.runId, label: "pre-run", stable: true });
    appendRunEvent(run.runId, parsed.sessionId, "snapshot_saved", {
      type: "snapshot_saved",
      runId: run.runId,
      label: "pre-run",
      stable: true,
    });
    updateRunStatus(run.runId, "running");
    write({ type: "run_status", runId: run.runId, status: "running", message: "Agent 运行中。" });
    appendRunEvent(run.runId, parsed.sessionId, "run_status", {
      type: "run_status",
      runId: run.runId,
      status: "running",
      message: "Agent 运行中。",
    });
    if (reusedImageCount) {
      write({ type: "status", message: `已复用上一轮参考图 ${reusedImageCount} 张。` });
      appendRunEvent(run.runId, parsed.sessionId, "status", {
        type: "status",
        message: `已复用上一轮参考图 ${reusedImageCount} 张。`,
      });
    }
    saveTurn(parsed.sessionId, "user", formatUserTurnMemory(parsed.message, parsed.images.length, reusedImageCount));
    write({ type: "status", message: "Agent 图开始执行。" });
    appendRunEvent(run.runId, parsed.sessionId, "status", { type: "status", message: "Agent 图开始执行。" });
    const heartbeatStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - heartbeatStartedAt) / 1000));
      const message = `Agent 仍在执行中，已等待 ${elapsedSeconds} 秒；模型长请求未返回前这是正常的。`;
      write({ type: "status", message });
      appendRunEvent(run.runId, parsed.sessionId, "status", { type: "status", message });
    }, 15000);
    const sessionState = getSessionState(parsed.sessionId);
    const compactSummary = sessionState.recentVisualMemories.length
      ? {
          ...sessionState.summary,
          codeState: [
            sessionState.summary.codeState,
            "最近视觉记忆:",
            ...sessionState.recentVisualMemories.map((memory) =>
              [
                `score=${typeof memory.score === "number" ? memory.score.toFixed(2) : "n/a"}`,
                memory.userGoal ? `goal=${memory.userGoal}` : "",
                `scene=${memory.scene.sceneType}/${memory.scene.cameraPreset}/${memory.scene.renderStyle}`,
                `screenshots=${Object.values(memory.screenshotPaths).filter(Boolean).join(",") || "none"}`,
                `assets=${memory.assetUsage.map((item) => JSON.stringify(item)).join(";") || "none"}`,
              ]
                .filter(Boolean)
                .join(" | "),
            ),
          ]
            .filter(Boolean)
            .join("\n"),
        }
      : sessionState.summary;
    const recentHistory = listRecentTurns(parsed.sessionId, 4).map((turn) => ({ role: turn.role, content: turn.content }));
    let result: Awaited<ReturnType<typeof runAgent>>;
    try {
      result = await runAgent({
        request: parsed,
        runId: run.runId,
        compactSummary,
        recentHistory,
        settings: getAppSettings(),
      });
    } finally {
      clearInterval(heartbeat);
    }
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
        appendRunEvent(run.runId, parsed.sessionId, "snapshot_saved", {
          type: "snapshot_saved",
          runId: run.runId,
          label: "post-run",
          stable: true,
        });
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
      appendRunEvent(run.runId, parsed.sessionId, "run_status", {
        type: "run_status",
        runId: run.runId,
        status: "error",
        message: "Agent 运行失败，已保留当前稳定快照。",
      });
      write({ type: "status", message: "Agent 图执行结束，但没有产生有效补丁。" });
      appendRunEvent(run.runId, parsed.sessionId, "status", {
        type: "status",
        message: "Agent 图执行结束，但没有产生有效补丁。",
      });
    } else {
      updateRunStatus(run.runId, "success");
      appendRunEvent(run.runId, parsed.sessionId, "run.success", {});
      write({ type: "run_status", runId: run.runId, status: "success", message: "Agent 运行完成。" });
      appendRunEvent(run.runId, parsed.sessionId, "run_status", {
        type: "run_status",
        runId: run.runId,
        status: "success",
        message: "Agent 运行完成。",
      });
      write({ type: "status", message: "Agent 图执行结束。" });
      appendRunEvent(run.runId, parsed.sessionId, "status", { type: "status", message: "Agent 图执行结束。" });
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
        appendRunEvent(latest.runId, body.sessionId, "run_status", {
          type: "run_status",
          runId: latest.runId,
          status: "error",
          message: "Agent 运行失败。",
        });
      }
    }
  } finally {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  }
});

const host = process.env.API_HOST || "127.0.0.1";
const port = Number(process.env.API_PORT || 8787);

await app.listen({ host, port });

function shouldReuseRecentImages(message: string, sessionId: string): boolean {
  const text = message.trim();
  if (!text) return true;
  if (!listRecentInputImages(sessionId, 1).length) return false;
  if (/再试|重试|继续|按刚才|刚才那张|上一张|上次|刚才|这个图|这张图|参考图|仍然|依旧|重新|改成|改为|错了|不对|不是|应该是|它|他|这个|那个|主体/i.test(text)) {
    return true;
  }
  if (text.length <= 40 && /发动机|扇叶|叶片|涡扇|正面|背面|侧面|中心|圆锥|圆柱|厚度|曲形|弯曲|黑线|白图|材质|颜色/.test(text)) {
    return true;
  }
  return false;
}

function formatUserTurnMemory(message: string, imageCount: number, reusedImageCount: number): string {
  const text = message.trim() || "图片参考场景";
  const imageNote = imageCount
    ? `\n[参考图 ${imageCount} 张${reusedImageCount ? `，其中复用上一轮 ${reusedImageCount} 张` : ""}]`
    : "";
  return `${text}${imageNote}`;
}

function workflowQualityStateInput(input: unknown) {
  const parsed = qualityInspectionRequestSchema.parse(input);
  const screenshots = parsed.screenshots.length
    ? parsed.screenshots
    : parsed.screenshotDataUrl
      ? [{ view: "front" as const, dataUrl: parsed.screenshotDataUrl }]
      : [];
  return { ...parsed, screenshots };
}
