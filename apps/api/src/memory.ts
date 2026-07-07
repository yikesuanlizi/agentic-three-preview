import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  type AssetImportItem,
  type AssetImportJob,
  type AppSettings,
  type CompactSummary,
  type FileMap,
  type QualityInspectionResult,
  type SceneDsl,
  type ScenePatch,
  assetImportJobSchema,
  appSettingsSchema,
  compactSummarySchema,
  fileMapSchema,
  modelNodeSchema,
  qualityInspectionResultSchema,
  sceneDslSchema,
  scenePatchSchema,
} from "@agentic-three/shared";

export type MemorySession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryTurn = {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type RunStatus = "pending" | "running" | "success" | "error" | "interrupted";

export type RunRecord = {
  runId: string;
  sessionId: string;
  status: RunStatus;
  error?: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
};

export type RunEvent = {
  id: number;
  runId: string;
  sessionId: string;
  eventType: string;
  content: string;
  createdAt: string;
};

export type ArtifactRecord = {
  id?: number;
  sessionId: string;
  runId?: string;
  kind: "screenshot" | "input_image";
  path: string;
  fileName: string;
  url: string;
  createdAt?: string;
};

export type ArtifactCleanupCandidate = ArtifactRecord & {
  reason: "session_deleted" | "db_orphan";
};

export type ImportedAssetRecord = {
  contentHash: string;
  sourcePath: string;
  assetId: string;
  metadataPath?: string;
  previewPath?: string;
  viewCount: number;
  sourceMtimeMs?: number;
  sourceSize?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type SceneStateRecord = {
  stateId: string;
  sessionId: string;
  runId?: string;
  round: number;
  userGoal: string;
  scene: SceneDsl;
  quality?: QualityInspectionResult;
  patch?: ScenePatch;
  screenshotPaths: Record<string, string>;
  status: "draft" | "reviewed" | "final";
  createdAt: string;
};

export type VisualMemoryRecord = {
  memoryId: string;
  sessionId: string;
  runId?: string;
  stateId?: string;
  userGoal: string;
  scene: SceneDsl;
  screenshotPaths: Record<string, string>;
  assetUsage: unknown[];
  score?: number;
  createdAt: string;
};

export type VisualEmbeddingCacheRecord = {
  cacheKey: string;
  model: string;
  dimension: number;
  embedding: number[];
  fallbackReason?: string;
  createdAt: string;
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(moduleDir, "../../..");
const dbPath = resolve(projectRoot, ".data/memory.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_turns_session_created
    ON turns(session_id, created_at);

  CREATE TABLE IF NOT EXISTS summaries (
    session_id TEXT PRIMARY KEY,
    user_goal TEXT NOT NULL DEFAULT '',
    code_state TEXT NOT NULL DEFAULT '',
    next_steps TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'success', 'error', 'interrupted')),
    error TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_runs_session_created
    ON runs(session_id, created_at);

  CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_run_events_run_created
    ON run_events(run_id, created_at);

  CREATE TABLE IF NOT EXISTS file_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    run_id TEXT,
    label TEXT NOT NULL,
    files_json TEXT NOT NULL,
    stable INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_file_snapshots_session_stable
    ON file_snapshots(session_id, stable, created_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    run_id TEXT,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS asset_import_jobs (
    job_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'success', 'error', 'interrupted')),
    source_directory TEXT NOT NULL,
    upload_directory TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'queued',
    current_file TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    imported INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    percent REAL NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_asset_import_jobs_status_updated
    ON asset_import_jobs(status, updated_at);

  CREATE TABLE IF NOT EXISTS imported_assets (
    content_hash TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    metadata_path TEXT,
    preview_path TEXT,
    view_count INTEGER NOT NULL DEFAULT 0,
    source_mtime_ms REAL,
    source_size INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_imported_assets_source_path
    ON imported_assets(source_path);

  CREATE TABLE IF NOT EXISTS scene_states (
    state_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT,
    round INTEGER NOT NULL DEFAULT 0,
    user_goal TEXT NOT NULL DEFAULT '',
    scene_json TEXT NOT NULL,
    quality_json TEXT,
    patch_json TEXT,
    screenshot_paths_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK(status IN ('draft', 'reviewed', 'final')),
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scene_states_session_created
    ON scene_states(session_id, created_at);

  CREATE TABLE IF NOT EXISTS visual_memories (
    memory_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT,
    state_id TEXT,
    user_goal TEXT NOT NULL DEFAULT '',
    scene_json TEXT NOT NULL,
    screenshot_paths_json TEXT NOT NULL DEFAULT '{}',
    asset_usage_json TEXT NOT NULL DEFAULT '[]',
    score REAL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_visual_memories_session_created
    ON visual_memories(session_id, created_at);

  CREATE TABLE IF NOT EXISTS visual_embedding_cache (
    cache_key TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    embedding_json TEXT NOT NULL,
    fallback_reason TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_visual_embedding_cache_model_dim
    ON visual_embedding_cache(model, dimension);
`);

ensureImportedAssetColumns();

reconcileInflightRuns();
reconcileInflightAssetImportJobs();

export function upsertSession(sessionId: string, titleSeed: string): void {
  const now = new Date().toISOString();
  const title = makeTitle(titleSeed);
  db.prepare(
    `
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `,
  ).run(sessionId, title, now, now);
}

export function saveTurn(sessionId: string, role: "user" | "assistant", content: string): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO turns (session_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
    sessionId,
    role,
    content,
    now,
  );
  touchSession(sessionId, now);
}

export function listSessions(limit = 40): MemorySession[] {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  return db
    .prepare(
      `
        SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT ${safeLimit}
      `,
    )
    .all() as MemorySession[];
}

export function getSession(sessionId: string): MemorySession | undefined {
  return db
    .prepare("SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?")
    .get(sessionId) as MemorySession | undefined;
}

export function listTurns(sessionId: string): MemoryTurn[] {
  return db
    .prepare(
      `
        SELECT id, session_id AS sessionId, role, content, created_at AS createdAt
        FROM turns
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC
      `,
    )
    .all(sessionId) as MemoryTurn[];
}

export function listRecentTurns(sessionId: string, limit = 4): MemoryTurn[] {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  return db
    .prepare(
      `
        SELECT id, session_id AS sessionId, role, content, created_at AS createdAt
        FROM turns
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ${safeLimit}
      `,
    )
    .all(sessionId)
    .reverse() as MemoryTurn[];
}

export function getSummary(sessionId: string): CompactSummary {
  const row = db
    .prepare(
      `
        SELECT user_goal AS userGoal, code_state AS codeState, next_steps AS nextSteps, updated_at AS updatedAt
        FROM summaries
        WHERE session_id = ?
      `,
    )
    .get(sessionId) as CompactSummary | undefined;
  return compactSummarySchema.parse(row ?? {});
}

export function saveSummary(sessionId: string, summary: CompactSummary): CompactSummary {
  const parsed = compactSummarySchema.parse(summary);
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO summaries (session_id, user_goal, code_state, next_steps, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        user_goal = excluded.user_goal,
        code_state = excluded.code_state,
        next_steps = excluded.next_steps,
        updated_at = excluded.updated_at
    `,
  ).run(sessionId, parsed.userGoal, parsed.codeState, parsed.nextSteps, now);
  return { ...parsed, updatedAt: now };
}

export function createRun(sessionId: string): RunRecord {
  const now = new Date().toISOString();
  const runId = randomUUID();
  db.prepare(
    `
      INSERT INTO runs (run_id, session_id, status, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)
    `,
  ).run(runId, sessionId, now, now);
  return getRun(runId)!;
}

export function updateRunStatus(runId: string, status: RunStatus, error?: string): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE run_id = ?").run(status, error ?? null, now, runId);
}

export function updateRunUsage(runId: string, inputTokens?: number, outputTokens?: number): void {
  const now = new Date().toISOString();
  db.prepare(
    `
      UPDATE runs
      SET input_tokens = COALESCE(?, input_tokens),
          output_tokens = COALESCE(?, output_tokens),
          updated_at = ?
      WHERE run_id = ?
    `,
  ).run(inputTokens ?? null, outputTokens ?? null, now, runId);
}

export function getRun(runId: string): RunRecord | undefined {
  return db
    .prepare(
      `
        SELECT run_id AS runId, session_id AS sessionId, status, error,
               input_tokens AS inputTokens, output_tokens AS outputTokens,
               created_at AS createdAt, updated_at AS updatedAt
        FROM runs
        WHERE run_id = ?
      `,
    )
    .get(runId) as RunRecord | undefined;
}

export function getLatestRun(sessionId: string): RunRecord | undefined {
  return db
    .prepare(
      `
        SELECT run_id AS runId, session_id AS sessionId, status, error,
               input_tokens AS inputTokens, output_tokens AS outputTokens,
               created_at AS createdAt, updated_at AS updatedAt
        FROM runs
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get(sessionId) as RunRecord | undefined;
}

export function appendRunEvent(runId: string, sessionId: string, eventType: string, content: unknown): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO run_events (run_id, session_id, event_type, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
    runId,
    sessionId,
    eventType,
    typeof content === "string" ? content : JSON.stringify(content),
    now,
  );
}

export function listRunEvents(runId: string): RunEvent[] {
  return db
    .prepare(
      `
        SELECT id, run_id AS runId, session_id AS sessionId, event_type AS eventType, content, created_at AS createdAt
        FROM run_events
        WHERE run_id = ?
        ORDER BY created_at ASC, id ASC
      `,
    )
    .all(runId) as RunEvent[];
}

export function saveFileSnapshot(sessionId: string, runId: string | undefined, label: string, files: FileMap, stable: boolean): void {
  const parsed = fileMapSchema.parse(files);
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO file_snapshots (session_id, run_id, label, files_json, stable, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(sessionId, runId ?? null, label, JSON.stringify(parsed), stable ? 1 : 0, now);
}

export function getLatestStableSnapshot(sessionId: string): { files: FileMap; label: string; createdAt: string } | undefined {
  const row = db
    .prepare(
      `
        SELECT files_json AS filesJson, label, created_at AS createdAt
        FROM file_snapshots
        WHERE session_id = ? AND stable = 1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(sessionId) as { filesJson: string; label: string; createdAt: string } | undefined;
  if (!row) return undefined;
  return { files: fileMapSchema.parse(JSON.parse(row.filesJson)), label: row.label, createdAt: row.createdAt };
}

export function listRunFileSnapshots(runId: string): Array<{ label: string; files: FileMap; stable: boolean; createdAt: string }> {
  const rows = db
    .prepare(
      `
        SELECT label, files_json AS filesJson, stable, created_at AS createdAt
        FROM file_snapshots
        WHERE run_id = ?
        ORDER BY created_at ASC
      `,
    )
    .all(runId) as Array<{ label: string; filesJson: string; stable: number; createdAt: string }>;
  return rows.map((row) => ({
    label: row.label,
    files: fileMapSchema.parse(JSON.parse(row.filesJson)),
    stable: row.stable === 1,
    createdAt: row.createdAt,
  }));
}

export function readSettings(defaults: AppSettings): AppSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined;
  if (!row) return defaults;
  const stored = JSON.parse(row.value) as Partial<AppSettings>;
  const merged = { ...defaults, ...stored };
  if (Array.isArray(merged.models)) {
    const filtered = merged.models.filter((model) => modelNodeSchema.safeParse(model.node).success);
    if (filtered.length !== merged.models.length) {
      merged.models = filtered;
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      ).run(JSON.stringify(merged), now);
    }
  }
  return appSettingsSchema.parse(merged);
}

export function writeSettings(settings: AppSettings): AppSettings {
  const parsed = appSettingsSchema.parse(settings);
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO settings (key, value, updated_at)
      VALUES ('app', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(JSON.stringify(parsed), now);
  return parsed;
}

export function saveArtifact(artifact: Omit<ArtifactRecord, "id" | "createdAt">): ArtifactRecord {
  const now = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO artifacts (session_id, run_id, kind, path, file_name, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(artifact.sessionId, artifact.runId ?? null, artifact.kind, artifact.path, artifact.fileName, artifact.url, now);
  return { ...artifact, id: Number(result.lastInsertRowid), createdAt: now };
}

export function listScreenshotArtifacts(sessionId?: string): ArtifactRecord[] {
  const sql = `
    SELECT id, session_id AS sessionId, run_id AS runId, kind, path, file_name AS fileName, url, created_at AS createdAt
    FROM artifacts
    WHERE kind = 'screenshot' ${sessionId ? "AND session_id = ?" : ""}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as ArtifactRecord[];
}

export function listInputImageArtifacts(sessionId: string, limit = 4): ArtifactRecord[] {
  const safeLimit = Math.max(1, Math.min(limit, 12));
  return db
    .prepare(
      `
        SELECT id, session_id AS sessionId, run_id AS runId, kind, path, file_name AS fileName, url, created_at AS createdAt
        FROM artifacts
        WHERE kind = 'input_image' AND session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ${safeLimit}
      `,
    )
    .all(sessionId)
    .reverse() as ArtifactRecord[];
}

export function listSessionArtifacts(sessionId: string): ArtifactRecord[] {
  return db
    .prepare(
      `
        SELECT id, session_id AS sessionId, run_id AS runId, kind, path, file_name AS fileName, url, created_at AS createdAt
        FROM artifacts
        WHERE session_id = ?
      `,
    )
    .all(sessionId) as ArtifactRecord[];
}

export function listAllArtifactRecords(): ArtifactRecord[] {
  return db
    .prepare(
      `
        SELECT id, session_id AS sessionId, run_id AS runId, kind, path, file_name AS fileName, url, created_at AS createdAt
        FROM artifacts
      `,
    )
    .all() as ArtifactRecord[];
}

export function listOrphanArtifactRecords(): ArtifactCleanupCandidate[] {
  return db
    .prepare(
      `
        SELECT a.id, a.session_id AS sessionId, a.run_id AS runId, a.kind, a.path,
               a.file_name AS fileName, a.url, a.created_at AS createdAt
        FROM artifacts a
        LEFT JOIN sessions s ON s.id = a.session_id
        WHERE s.id IS NULL
      `,
    )
    .all()
    .map((artifact) => ({ ...(artifact as ArtifactRecord), reason: "db_orphan" as const }));
}

export function getSessionState(sessionId: string) {
  return {
    summary: getSummary(sessionId),
    latestRun: getLatestRun(sessionId),
    latestStableSnapshot: getLatestStableSnapshot(sessionId),
    latestSceneState: getLatestSceneState(sessionId),
    recentVisualMemories: listVisualMemories(sessionId, 5),
  };
}

export function saveSceneState(input: {
  stateId?: string;
  sessionId: string;
  runId?: string;
  round?: number;
  userGoal?: string;
  scene: SceneDsl;
  quality?: QualityInspectionResult;
  patch?: ScenePatch;
  screenshotPaths?: Record<string, string>;
  status?: "draft" | "reviewed" | "final";
}): SceneStateRecord {
  const stateId = input.stateId ?? randomUUID();
  const now = new Date().toISOString();
  const scene = sceneDslSchema.parse({
    ...input.scene,
    stateId,
    parentStateId: input.scene.stateId,
  });
  const quality = input.quality ? qualityInspectionResultSchema.parse(input.quality) : undefined;
  const patch = input.patch ? scenePatchSchema.parse(input.patch) : undefined;
  db.prepare(
    `
      INSERT INTO scene_states
        (state_id, session_id, run_id, round, user_goal, scene_json, quality_json, patch_json,
         screenshot_paths_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(state_id) DO UPDATE SET
        scene_json = excluded.scene_json,
        quality_json = excluded.quality_json,
        patch_json = excluded.patch_json,
        screenshot_paths_json = excluded.screenshot_paths_json,
        status = excluded.status
    `,
  ).run(
    stateId,
    input.sessionId,
    input.runId ?? null,
    input.round ?? 0,
    input.userGoal ?? "",
    JSON.stringify(scene),
    quality ? JSON.stringify(quality) : null,
    patch ? JSON.stringify(patch) : null,
    JSON.stringify(input.screenshotPaths ?? {}),
    input.status ?? "reviewed",
    now,
  );
  return {
    stateId,
    sessionId: input.sessionId,
    runId: input.runId,
    round: input.round ?? 0,
    userGoal: input.userGoal ?? "",
    scene,
    quality,
    patch,
    screenshotPaths: input.screenshotPaths ?? {},
    status: input.status ?? "reviewed",
    createdAt: now,
  };
}

export function getLatestSceneState(sessionId: string): SceneStateRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT state_id AS stateId, session_id AS sessionId, run_id AS runId, round, user_goal AS userGoal,
               scene_json AS sceneJson, quality_json AS qualityJson, patch_json AS patchJson,
               screenshot_paths_json AS screenshotPathsJson, status, created_at AS createdAt
        FROM scene_states
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get(sessionId) as SceneStateRow | undefined;
  return row ? parseSceneStateRow(row) : undefined;
}

export function saveVisualMemory(input: {
  memoryId?: string;
  sessionId: string;
  runId?: string;
  stateId?: string;
  userGoal?: string;
  scene: SceneDsl;
  screenshotPaths?: Record<string, string>;
  score?: number;
}): VisualMemoryRecord {
  const memoryId = input.memoryId ?? randomUUID();
  const now = new Date().toISOString();
  const scene = sceneDslSchema.parse(input.scene);
  const assetUsage = scene.assetUsage.length
    ? scene.assetUsage
    : scene.objects.map((object) => ({
        objectId: object.objectId ?? object.id,
        assetId: object.assetId,
        sourcePath: object.sourceAsset.sourcePath,
        role: object.semanticRole,
      }));
  db.prepare(
    `
      INSERT INTO visual_memories
        (memory_id, session_id, run_id, state_id, user_goal, scene_json, screenshot_paths_json,
         asset_usage_json, score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    memoryId,
    input.sessionId,
    input.runId ?? null,
    input.stateId ?? null,
    input.userGoal ?? "",
    JSON.stringify(scene),
    JSON.stringify(input.screenshotPaths ?? {}),
    JSON.stringify(assetUsage),
    input.score ?? null,
    now,
  );
  return {
    memoryId,
    sessionId: input.sessionId,
    runId: input.runId,
    stateId: input.stateId,
    userGoal: input.userGoal ?? "",
    scene,
    screenshotPaths: input.screenshotPaths ?? {},
    assetUsage,
    score: input.score,
    createdAt: now,
  };
}

export function listVisualMemories(sessionId: string, limit = 5): VisualMemoryRecord[] {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  const rows = db
    .prepare(
      `
        SELECT memory_id AS memoryId, session_id AS sessionId, run_id AS runId, state_id AS stateId,
               user_goal AS userGoal, scene_json AS sceneJson, screenshot_paths_json AS screenshotPathsJson,
               asset_usage_json AS assetUsageJson, score, created_at AS createdAt
        FROM visual_memories
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ${safeLimit}
      `,
    )
    .all(sessionId) as VisualMemoryRow[];
  return rows.map(parseVisualMemoryRow);
}

export function createAssetImportJob(input: { sourceDirectory: string; uploadDirectory: string }): AssetImportJob {
  const now = new Date().toISOString();
  const jobId = randomUUID();
  db.prepare(
    `
      INSERT INTO asset_import_jobs
        (job_id, status, source_directory, upload_directory, phase, created_at, updated_at)
      VALUES (?, 'queued', ?, ?, 'queued', ?, ?)
    `,
  ).run(jobId, input.sourceDirectory, input.uploadDirectory, now, now);
  return getAssetImportJob(jobId)!;
}

export function updateAssetImportJob(jobId: string, patch: Partial<Omit<AssetImportJob, "jobId" | "sourceDirectory" | "uploadDirectory" | "createdAt" | "updatedAt">>): void {
  const current = getAssetImportJob(jobId);
  if (!current) throw new Error(`导入任务不存在: ${jobId}`);
  const next = assetImportJobSchema.parse({
    ...current,
    ...patch,
    percent: patch.percent ?? calculateImportPercent(patch.processed ?? current.processed, patch.total ?? current.total),
    items: patch.items ?? current.items,
  });
  db.prepare(
    `
      UPDATE asset_import_jobs
      SET status = ?, phase = ?, current_file = ?, total = ?, processed = ?, imported = ?, skipped = ?,
          failed = ?, percent = ?, message = ?, items_json = ?, updated_at = ?
      WHERE job_id = ?
    `,
  ).run(
    next.status,
    next.phase,
    next.currentFile,
    next.total,
    next.processed,
    next.imported,
    next.skipped,
    next.failed,
    next.percent,
    next.message,
    JSON.stringify(next.items),
    new Date().toISOString(),
    jobId,
  );
}

export function appendAssetImportJobItem(jobId: string, item: AssetImportItem): void {
  const current = getAssetImportJob(jobId);
  if (!current) throw new Error(`导入任务不存在: ${jobId}`);
  updateAssetImportJob(jobId, { items: [...current.items, item] });
}

export function getAssetImportJob(jobId: string): AssetImportJob | undefined {
  const row = db
    .prepare(
      `
        SELECT job_id AS jobId, status, source_directory AS sourceDirectory, upload_directory AS uploadDirectory,
               phase, current_file AS currentFile, total, processed, imported, skipped, failed, percent,
               message, items_json AS itemsJson, created_at AS createdAt, updated_at AS updatedAt
        FROM asset_import_jobs
        WHERE job_id = ?
      `,
    )
    .get(jobId) as (Omit<AssetImportJob, "items"> & { itemsJson: string }) | undefined;
  return row ? parseAssetImportJobRow(row) : undefined;
}

export function getActiveAssetImportJob(): AssetImportJob | undefined {
  const row = db
    .prepare(
      `
        SELECT job_id AS jobId, status, source_directory AS sourceDirectory, upload_directory AS uploadDirectory,
               phase, current_file AS currentFile, total, processed, imported, skipped, failed, percent,
               message, items_json AS itemsJson, created_at AS createdAt, updated_at AS updatedAt
        FROM asset_import_jobs
        WHERE status IN ('queued', 'running')
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get() as (Omit<AssetImportJob, "items"> & { itemsJson: string }) | undefined;
  return row ? parseAssetImportJobRow(row) : undefined;
}

export function findImportedAssetByHash(contentHash: string): ImportedAssetRecord | undefined {
  return db
    .prepare(
      `
        SELECT content_hash AS contentHash, source_path AS sourcePath, asset_id AS assetId,
               metadata_path AS metadataPath, preview_path AS previewPath, view_count AS viewCount,
               source_mtime_ms AS sourceMtimeMs, source_size AS sourceSize,
               created_at AS createdAt, updated_at AS updatedAt
        FROM imported_assets
        WHERE content_hash = ?
      `,
    )
    .get(contentHash) as ImportedAssetRecord | undefined;
}

export function findImportedAssetBySourcePath(sourcePath: string): ImportedAssetRecord | undefined {
  return db
    .prepare(
      `
        SELECT content_hash AS contentHash, source_path AS sourcePath, asset_id AS assetId,
               metadata_path AS metadataPath, preview_path AS previewPath, view_count AS viewCount,
               source_mtime_ms AS sourceMtimeMs, source_size AS sourceSize,
               created_at AS createdAt, updated_at AS updatedAt
        FROM imported_assets
        WHERE source_path = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(sourcePath) as ImportedAssetRecord | undefined;
}

export function saveImportedAsset(input: {
  contentHash: string;
  sourcePath: string;
  assetId: string;
  metadataPath?: string;
  previewPath?: string;
  viewCount?: number;
  sourceMtimeMs?: number;
  sourceSize?: number;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO imported_assets
        (content_hash, source_path, asset_id, metadata_path, preview_path, view_count, source_mtime_ms, source_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) DO UPDATE SET
        source_path = excluded.source_path,
        asset_id = excluded.asset_id,
        metadata_path = excluded.metadata_path,
        preview_path = excluded.preview_path,
        view_count = excluded.view_count,
        source_mtime_ms = excluded.source_mtime_ms,
        source_size = excluded.source_size,
        updated_at = excluded.updated_at
    `,
  ).run(
    input.contentHash,
    input.sourcePath,
    input.assetId,
    input.metadataPath ?? null,
    input.previewPath ?? null,
    input.viewCount ?? 0,
    input.sourceMtimeMs ?? null,
    input.sourceSize ?? null,
    now,
    now,
  );
}

export function clearKnowledgeSqliteRecords(): string[] {
  const tables = ["asset_import_jobs", "imported_assets", "scene_states", "visual_memories"];
  db.exec("BEGIN");
  try {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return tables;
}

export function readVisualEmbeddingCache(cacheKey: string): VisualEmbeddingCacheRecord | undefined {
  const row = db.prepare(
    "SELECT cache_key AS cacheKey, model, dimension, embedding_json AS embeddingJson, fallback_reason AS fallbackReason, created_at AS createdAt FROM visual_embedding_cache WHERE cache_key = ?",
  ).get(cacheKey) as { cacheKey: string; model: string; dimension: number; embeddingJson: string; fallbackReason?: string | null; createdAt: string } | undefined;
  if (!row) return undefined;
  return {
    cacheKey: row.cacheKey,
    model: row.model,
    dimension: row.dimension,
    embedding: JSON.parse(row.embeddingJson) as number[],
    fallbackReason: row.fallbackReason ?? undefined,
    createdAt: row.createdAt,
  };
}

export function writeVisualEmbeddingCache(input: {
  cacheKey: string;
  model: string;
  dimension: number;
  embedding: number[];
  fallbackReason?: string;
}): void {
  db.prepare(
    `
      INSERT INTO visual_embedding_cache (cache_key, model, dimension, embedding_json, fallback_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        model = excluded.model,
        dimension = excluded.dimension,
        embedding_json = excluded.embedding_json,
        fallback_reason = excluded.fallback_reason
    `,
  ).run(
    input.cacheKey,
    input.model,
    input.dimension,
    JSON.stringify(input.embedding),
    input.fallbackReason ?? null,
    new Date().toISOString(),
  );
}

export function deleteSession(sessionId: string): boolean {
  const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  return result.changes > 0;
}

function reconcileInflightRuns(): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE runs SET status = 'error', error = ?, updated_at = ? WHERE status IN ('pending', 'running')").run(
    "服务重启或进程中断，运行未正常完成。",
    now,
  );
}

function ensureImportedAssetColumns(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(imported_assets)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  const additions: Array<[string, string]> = [
    ["preview_path", "ALTER TABLE imported_assets ADD COLUMN preview_path TEXT"],
    ["view_count", "ALTER TABLE imported_assets ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0"],
    ["source_mtime_ms", "ALTER TABLE imported_assets ADD COLUMN source_mtime_ms REAL"],
    ["source_size", "ALTER TABLE imported_assets ADD COLUMN source_size INTEGER"],
  ];
  for (const [name, sql] of additions) {
    if (!columns.has(name)) db.exec(sql);
  }
}

function reconcileInflightAssetImportJobs(): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE asset_import_jobs SET status = 'interrupted', message = ?, updated_at = ? WHERE status IN ('queued', 'running')").run(
    "服务重启或进程中断，导入任务未正常完成。",
    now,
  );
}

function parseAssetImportJobRow(row: Omit<AssetImportJob, "items"> & { itemsJson: string }): AssetImportJob {
  return assetImportJobSchema.parse({
    jobId: row.jobId,
    status: row.status,
    sourceDirectory: row.sourceDirectory,
    uploadDirectory: row.uploadDirectory,
    phase: row.phase,
    currentFile: row.currentFile,
    total: row.total,
    processed: row.processed,
    imported: row.imported,
    skipped: row.skipped,
    failed: row.failed,
    percent: row.percent,
    message: row.message,
    items: safeParseItems(row.itemsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

type SceneStateRow = {
  stateId: string;
  sessionId: string;
  runId?: string | null;
  round: number;
  userGoal: string;
  sceneJson: string;
  qualityJson?: string | null;
  patchJson?: string | null;
  screenshotPathsJson: string;
  status: "draft" | "reviewed" | "final";
  createdAt: string;
};

type VisualMemoryRow = {
  memoryId: string;
  sessionId: string;
  runId?: string | null;
  stateId?: string | null;
  userGoal: string;
  sceneJson: string;
  screenshotPathsJson: string;
  assetUsageJson: string;
  score?: number | null;
  createdAt: string;
};

function parseSceneStateRow(row: SceneStateRow): SceneStateRecord {
  const quality = row.qualityJson ? qualityInspectionResultSchema.parse(JSON.parse(row.qualityJson)) : undefined;
  const patch = row.patchJson ? scenePatchSchema.parse(JSON.parse(row.patchJson)) : undefined;
  return {
    stateId: row.stateId,
    sessionId: row.sessionId,
    runId: row.runId ?? undefined,
    round: row.round,
    userGoal: row.userGoal,
    scene: sceneDslSchema.parse(JSON.parse(row.sceneJson)),
    quality,
    patch,
    screenshotPaths: safeParseRecord(row.screenshotPathsJson),
    status: row.status,
    createdAt: row.createdAt,
  };
}

function parseVisualMemoryRow(row: VisualMemoryRow): VisualMemoryRecord {
  return {
    memoryId: row.memoryId,
    sessionId: row.sessionId,
    runId: row.runId ?? undefined,
    stateId: row.stateId ?? undefined,
    userGoal: row.userGoal,
    scene: sceneDslSchema.parse(JSON.parse(row.sceneJson)),
    screenshotPaths: safeParseRecord(row.screenshotPathsJson),
    assetUsage: safeParseArray(row.assetUsageJson),
    score: row.score ?? undefined,
    createdAt: row.createdAt,
  };
}

function safeParseItems(value: string): AssetImportItem[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as AssetImportItem[] : [];
  } catch {
    return [];
  }
}

function safeParseRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function safeParseArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function calculateImportPercent(processed: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
}

function touchSession(sessionId: string, now = new Date().toISOString()): void {
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
}

function makeTitle(seed: string): string {
  const compact = seed.replace(/\s+/g, " ").trim();
  if (!compact) return "新的 three.js 会话";
  return compact.length > 32 ? `${compact.slice(0, 32)}...` : compact;
}
