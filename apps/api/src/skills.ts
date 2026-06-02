import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import OpenAI from "openai";
import {
  type AppSettings,
  type ImageInput,
  type SkillCreateRequest,
  skillCreateRequestSchema,
  skillInferRequestSchema,
  skillInstallRequestSchema,
} from "@agentic-three/shared";
import { projectRoot } from "./memory.js";
import { resolveModelConfig } from "./settings.js";

const execFileAsync = promisify(execFile);
const CORE_SKILL_ORDER = ["three-scene", "camera-light", "material-animation", "performance-safety"];
const MAX_SELECTED_SKILLS = 4;
const MAX_SKILL_CONTENT_CHARS = 1800;
const MAX_SKILL_CONTEXT_CHARS = 8000;
const MAX_SKILL_SAVE_CHARS = 12000;

export type SkillCard = {
  id: string;
  title: string;
  description: string;
  content: string;
};
type SkillSelection = {
  skillIds: string[];
  reason?: string;
};

const SKILLS_DIR = resolve(projectRoot, "skills");

export function listSkills(): SkillCard[] {
  try {
    return readdirSync(SKILLS_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => {
        const content = readFileSync(join(SKILLS_DIR, name), "utf8");
        return parseSkillMarkdown(content, name.replace(/\.md$/, ""));
      });
  } catch {
    return [];
  }
}

export function createSkill(input: unknown): SkillCard {
  const parsed = skillCreateRequestSchema.parse(input);
  const filePath = join(SKILLS_DIR, `${parsed.id}.md`);
  if (existsSync(filePath)) {
    throw new Error(`Skill 已存在: ${parsed.id}`);
  }
  const content = skillMarkdown(parsed);
  writeFileSync(filePath, content, "utf8");
  return { ...parsed, content };
}

export async function inferSkill(input: unknown): Promise<SkillCreateRequest> {
  const parsed = skillInferRequestSchema.parse(input);
  const heuristic = inferSkillHeuristic(parsed.content);
  try {
    const model = resolveModelConfig("default");
    const apiKey = process.env[model.apiKeyEnvName];
    if (!apiKey) return heuristic;
    const client = new OpenAI({ apiKey, baseURL: model.baseURL });
    const response = await client.chat.completions.create({
      model: model.model,
      messages: [
        {
          role: "system",
          content:
            "你是 three.js skills 元数据提取器。只返回 JSON: {\"id\":\"kebab-case\",\"title\":\"简体中文标题\",\"description\":\"简体中文一句话描述\",\"content\":\"原正文\"}。id 必须是英文 kebab-case，title 和 description 必须使用简体中文。",
        },
        {
          role: "user",
          content: `请根据以下 skill 正文生成 id、title、description。content 必须原样返回，不要翻译正文。\n\n${parsed.content}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 1600,
    } as never);
    const text = response.choices[0]?.message?.content || "";
    const objectText = extractJsonObject(text);
    return skillCreateRequestSchema.parse({ ...JSON.parse(objectText), content: parsed.content });
  } catch {
    return heuristic;
  }
}

export async function installSkillsFromUrl(input: unknown): Promise<SkillCard[]> {
  const { url } = skillInstallRequestSchema.parse(input);
  const repoUrl = normalizeRepoUrl(url);
  const tempRoot = mkdtempSync(join(tmpdir(), "agentic-three-skills-"));
  const repoDir = join(tempRoot, "repo");
  try {
    await execFileAsync("git", ["clone", "--depth", "1", repoUrl, repoDir], { timeout: 120000 });
    const candidates = findMarkdownSkillFiles(repoDir);
    const installed: SkillCard[] = [];
    for (const filePath of candidates) {
      const raw = readFileSync(filePath, "utf8");
      const importContent = stripFrontmatter(raw).trim().slice(0, MAX_SKILL_SAVE_CHARS);
      const parsed = await inferSkill({ content: importContent });
      const id = parsed.id === "skill" || parsed.id === "custom-skill" ? slugify(parsed.title) : parsed.id;
      const content = skillMarkdown({
        id,
        title: parsed.title,
        description: parsed.description || "从远程仓库导入的 three.js skill。",
        content: parsed.content,
      });
      const target = join(SKILLS_DIR, `${id}.md`);
      writeFileSync(target, content, "utf8");
      installed.push(parseSkillMarkdown(content, id));
    }
    return installed;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function selectSkillContext(message: string, enabledSkillIds?: string[]): string {
  return formatSkillContext(selectSkillsHeuristic(message, enabledSkillIds));
}

export async function selectSkillContextDynamic(input: {
  message: string;
  enabledSkillIds?: string[];
  images?: ImageInput[];
  settings?: AppSettings;
}): Promise<{ context: string; selectedSkillIds: string[]; reason: string; source: "direct" | "llm" | "heuristic" | "none" }> {
  const all = listSkills();
  const enabled = filterEnabledSkills(all, input.enabledSkillIds);
  if (!enabled.length) {
    return {
      context: "",
      selectedSkillIds: [],
      reason: input.enabledSkillIds?.length === 0 ? "用户未启用 skill。" : "没有可用 skill。",
      source: "none",
    };
  }

  if (input.enabledSkillIds !== undefined && input.enabledSkillIds.length <= MAX_SELECTED_SKILLS) {
    return {
      context: formatSkillContext(enabled),
      selectedSkillIds: enabled.map((skill) => skill.id),
      reason: `用户启用了 ${enabled.length} 个 skill，未超过 ${MAX_SELECTED_SKILLS} 个，直接加载。`,
      source: "direct",
    };
  }

  const fallback = selectSkillsHeuristic(input.message, input.enabledSkillIds);
  const fallbackIds = fallback.map((skill) => skill.id);

  try {
    const model = resolveModelConfig("coder_agent", input.settings);
    const apiKey = process.env[model.apiKeyEnvName];
    if (!apiKey) {
      return {
        context: formatSkillContext(fallback),
        selectedSkillIds: fallbackIds,
        reason: `缺少 ${model.apiKeyEnvName}，使用规则选择。`,
        source: "heuristic",
      };
    }

    const catalog = enabled
      .map((skill) => ({
        id: skill.id,
        title: skill.title,
        description: skill.description,
      }))
      .map((skill) => `- id: ${skill.id}\n  title: ${skill.title}\n  description: ${skill.description}`)
      .join("\n")
      .slice(0, 12000);

    const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    for (const image of input.images ?? []) {
      userContent.push({ type: "image_url", image_url: { url: image.dataUrl } });
      userContent.push({
        type: "text",
        text: `参考图: ${image.name}${image.dimension ? ` (${image.dimension})` : ""}`,
      });
    }
    userContent.push({
      type: "text",
      text: `根据用户需求和参考图，从 skill 目录中选择最多 ${MAX_SELECTED_SKILLS} 个最有用的 skill。只返回 JSON，不要解释额外文本。\n\n用户需求:\n${input.message}\n\nskill 目录:\n${catalog}\n\n返回格式:\n{"skillIds":["id-1","id-2"],"reason":"一句中文理由"}`,
    });

    const client = new OpenAI({
      apiKey,
      baseURL: model.baseURL,
      defaultHeaders: { "X-Failover-Enabled": "true" },
    });
    const response = await client.chat.completions.create({
      model: model.model,
      messages: [
        {
          role: "system",
          content:
            "你是 three.js skill 动态选择器。你只能从给定目录中选 skill id，最多选择 4 个。优先选择能帮助当前图片建模、线稿、相机、材质和安全渲染的 skill。只输出 JSON。",
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      temperature: 0.1,
      max_tokens: 500,
      top_p: 0.7,
      top_k: 50,
      frequency_penalty: 1,
    } as never);

    const text = response.choices[0]?.message?.content || "";
    const selection = parseSkillSelection(text, enabled);
    const selected = selection.skillIds
      .map((id) => enabled.find((skill) => skill.id === id))
      .filter((skill): skill is SkillCard => Boolean(skill))
      .slice(0, MAX_SELECTED_SKILLS);
    const finalSelected = selected.length ? selected : fallback;

    return {
      context: formatSkillContext(finalSelected),
      selectedSkillIds: finalSelected.map((skill) => skill.id),
      reason: selected.length ? selection.reason || "LLM 按需选择 skill。" : "LLM 未选中有效 skill，使用规则选择。",
      source: selected.length ? "llm" : "heuristic",
    };
  } catch (error) {
    return {
      context: formatSkillContext(fallback),
      selectedSkillIds: fallbackIds,
      reason: `动态 skill 选择失败，使用规则选择: ${error instanceof Error ? error.message : String(error)}`,
      source: "heuristic",
    };
  }
}

function selectSkillsHeuristic(message: string, enabledSkillIds?: string[]): SkillCard[] {
  const lower = message.toLowerCase();
  const all = listSkills();
  const enabled = filterEnabledSkills(all, enabledSkillIds);
  const selected = enabled
    .map((skill) => ({ skill, score: scoreSkill(skill.id, lower) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SELECTED_SKILLS);

  const fallback = selected.length
    ? selected
    : CORE_SKILL_ORDER
        .map((id, index) => {
          const skill = enabled.find((item) => item.id === id);
          return skill ? { skill, score: CORE_SKILL_ORDER.length - index } : undefined;
        })
        .filter((item): item is { skill: SkillCard; score: number } => Boolean(item))
        .slice(0, MAX_SELECTED_SKILLS);

  return fallback.map(({ skill }) => skill);
}

function filterEnabledSkills(all: SkillCard[], enabledSkillIds?: string[]): SkillCard[] {
  const enabled = new Set(enabledSkillIds === undefined ? all.map((skill) => skill.id) : enabledSkillIds);
  return all.filter((skill) => enabled.has(skill.id));
}

function formatSkillContext(skills: SkillCard[]): string {
  return skills
    .map((skill) => `## ${skill.title}\n${truncateSkillContent(skill.content)}`)
    .join("\n\n")
    .slice(0, MAX_SKILL_CONTEXT_CHARS);
}

function parseSkillSelection(text: string, enabledSkills: SkillCard[]): SkillSelection {
  const objectText = extractJsonObject(text);
  const parsed = JSON.parse(objectText) as Partial<SkillSelection>;
  const allowed = new Set(enabledSkills.map((skill) => skill.id));
  return {
    skillIds: Array.isArray(parsed.skillIds)
      ? parsed.skillIds
          .filter((id): id is string => typeof id === "string" && allowed.has(id))
          .slice(0, MAX_SELECTED_SKILLS)
      : [],
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

function scoreSkill(id: string, lowerMessage: string): number {
  const lowerId = id.toLowerCase();
  const coreIndex = CORE_SKILL_ORDER.indexOf(lowerId);
  let score = coreIndex >= 0 ? 100 - coreIndex * 5 : 0;

  if (lowerMessage.includes(lowerId)) score += 60;
  if ((lowerMessage.includes("camera") || lowerMessage.includes("相机") || lowerMessage.includes("视角")) && lowerId.includes("camera")) {
    score += 40;
  }
  if ((lowerMessage.includes("light") || lowerMessage.includes("lighting") || lowerMessage.includes("光照")) && lowerId.includes("light")) {
    score += 40;
  }
  if ((lowerMessage.includes("material") || lowerMessage.includes("材质") || lowerMessage.includes("白图") || lowerMessage.includes("黑线")) && lowerId.includes("material")) {
    score += 35;
  }
  if ((lowerMessage.includes("geometry") || lowerMessage.includes("mesh") || lowerMessage.includes("结构") || lowerMessage.includes("线稿") || lowerMessage.includes("工程草图")) && lowerId.includes("geometry")) {
    score += 45;
  }
  if ((lowerMessage.includes("animation") || lowerMessage.includes("动画")) && lowerId.includes("animation")) {
    score += 35;
  }
  if (lowerMessage.includes("webgpu") && lowerId.includes("webgpu")) score += 35;
  if ((lowerMessage.includes("performance") || lowerMessage.includes("性能")) && lowerId.includes("performance")) score += 30;

  return score;
}

function truncateSkillContent(content: string): string {
  const compact = stripFrontmatter(content).trim();
  if (compact.length <= MAX_SKILL_CONTENT_CHARS) return compact;
  return `${compact.slice(0, MAX_SKILL_CONTENT_CHARS).trim()}\n\n[skill 内容已截断，仅保留与当前任务最相关的前段说明]`;
}

export function listLocalTools() {
  return [
    {
      name: "replace_file",
      category: "patch",
      description: "替换浏览器 Sandpack 内存中的白名单文件。",
      safety: "不在服务端执行代码；补丁会经过危险 API 拦截。",
    },
    {
      name: "inspect_runtime_errors",
      category: "review",
      description: "读取 Sandpack 运行错误文本，用于生成修复补丁。",
      safety: "只读取前端提供的错误上下文。",
    },
    {
      name: "load_three_skill",
      category: "skill",
      description: "加载本地 three.js 场景、相机、材质、动画、WebGPU 和性能技能说明。",
      safety: "只读取固定 skills 目录下的 Markdown 文件。",
    },
  ];
}

function parseSkillMarkdown(content: string, fallbackId: string): SkillCard {
  const frontmatter = readFrontmatter(content);
  const body = stripFrontmatter(content);
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const firstText = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("```"));
  return {
    id: slugify(frontmatter.name || fallbackId),
    title: frontmatter.title || h1 || titleFromId(fallbackId),
    description: frontmatter.description || firstText || "",
    content,
  };
}

function inferSkillHeuristic(content: string): SkillCreateRequest {
  const parsed = parseSkillMarkdown(content, "custom-skill");
  return {
    id: parsed.id === "custom-skill" ? slugify(parsed.title) : parsed.id,
    title: parsed.title,
    description: parsed.description || "自定义 three.js skill。",
    content,
  };
}

function skillMarkdown(skill: SkillCreateRequest): string {
  return `---\nname: ${skill.id}\ndescription: ${skill.description}\n---\n\n# ${skill.title}\n\n${skill.content.trim()}\n`;
}

function normalizeRepoUrl(value: string): string {
  const url = new URL(value);
  if (!["github.com", "gitee.com"].includes(url.hostname.toLowerCase())) {
    throw new Error("只支持 github.com 或 gitee.com 仓库链接。");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("仓库链接格式不正确。");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) throw new Error("仓库链接格式不正确。");
  return `${url.protocol}//${url.hostname}/${owner}/${repo.replace(/\\.git$/, "")}.git`;
}

function findMarkdownSkillFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
        visit(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        result.push(fullPath);
      }
    }
  };
  visit(root);
  if (result.length) return result;
  const rootMarkdown = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
    .map((entry) => join(root, entry.name));
  return rootMarkdown;
}

function readFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const body = match?.[1];
  if (!body) return {};
  return Object.fromEntries(
    body
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
      .filter((item): item is RegExpMatchArray => Boolean(item))
      .map((item) => [item[1] ?? "", (item[2] ?? "").replace(/^["']|["']$/g, "")]),
  );
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/, "");
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  throw new Error("模型没有返回 JSON");
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "skill";
}
