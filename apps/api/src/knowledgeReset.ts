import { existsSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  type KnowledgeClearResult,
  knowledgeClearRequestSchema,
  knowledgeClearResultSchema,
} from "@agentic-three/shared";
import { clearKnowledgeSqliteRecords, projectRoot } from "./memory.js";
import { resetAircraftRagSyncState } from "./rag.js";
import { dropRagCollectionIfExists } from "./ragDb.js";

export async function clearKnowledgeBase(input: unknown): Promise<KnowledgeClearResult> {
  const request = knowledgeClearRequestSchema.parse(input);
  let deletedFiles = 0;
  const clearedTables: string[] = [];
  let milvusDropped = false;
  const messages: string[] = [];
  resetAircraftRagSyncState();

  if (request.clearImportedFiles) {
    const uploadRoot = resolveProjectPath(request.uploadDirectory);
    if (existsSync(uploadRoot)) {
      rmSync(uploadRoot, { recursive: true, force: true });
      deletedFiles = 1;
      messages.push(`已删除导入目录: ${relative(projectRoot, uploadRoot).replace(/\\/g, "/")}`);
    } else {
      messages.push("导入目录不存在，跳过文件删除。");
    }
  }

  if (request.clearSqlite) {
    clearedTables.push(...clearKnowledgeSqliteRecords());
    messages.push(`已清空 SQLite 表: ${clearedTables.join(", ")}`);
  }

  if (request.clearMilvus) {
    milvusDropped = await dropRagCollectionIfExists();
    messages.push(milvusDropped ? "已删除 Milvus RAG collection。" : "Milvus 未连接或 collection 不存在，跳过删除。");
  }
  resetAircraftRagSyncState();

  return knowledgeClearResultSchema.parse({
    ok: true,
    deletedFiles,
    clearedTables,
    milvusDropped,
    message: messages.join(" "),
  });
}

function resolveProjectPath(relativePath: string): string {
  const fullPath = resolve(projectRoot, relativePath);
  const project = resolve(projectRoot);
  if (fullPath === project || (!fullPath.startsWith(`${project}\\`) && !fullPath.startsWith(`${project}/`))) {
    throw new Error(`清理目录必须在项目内且不能是项目根目录: ${relativePath}`);
  }
  return fullPath;
}
