import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  type AppSettings,
  type CompactSummary,
  type FileMap,
  appSettingsSchema,
  compactSummarySchema,
  fileMapSchema,
  modelNodeSchema,
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
`);

reconcileInflightRuns();

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

export function getSessionState(sessionId: string) {
  return {
    summary: getSummary(sessionId),
    latestRun: getLatestRun(sessionId),
    latestStableSnapshot: getLatestStableSnapshot(sessionId),
  };
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

function touchSession(sessionId: string, now = new Date().toISOString()): void {
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
}

function makeTitle(seed: string): string {
  const compact = seed.replace(/\s+/g, " ").trim();
  if (!compact) return "新的 three.js 会话";
  return compact.length > 32 ? `${compact.slice(0, 32)}...` : compact;
}
