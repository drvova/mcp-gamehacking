import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readdir, readFile, stat } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createReadStream, readFileSync } from "fs";
import { createInterface } from "readline";
import { loadSurfaces, saveProfile, shippedIds } from "./profiles/registry.js";
import {
  getSessionSurface,
  resolveProfile,
  setSessionSurface,
  shapeTools,
  boundArgsFor,
  checkConstraint,
  compilePattern,
  describeStep,
  extractValues,
  hasChain,
  hasShaping,
  shapeOutput,
} from "./profiles/resolve.js";
import { ModelProfileSchema, PROFILE_ID_MESSAGE, PROFILE_ID_PATTERN } from "./profiles/types.js";
import type { ModelProfile } from "./profiles/types.js";

/**
 * The package root, derived from `import.meta.url`.
 *
 * `import.meta.dirname` would be shorter but is Node 20.11+, a patch-level floor
 * hidden inside a major-version range. The build tooling needs Node >= 20, so
 * that is what this package declares; the runtime floor is the MCP SDK's own
 * (>= 18) and this idiom keeps it there, so a prebuilt dist runs on more than
 * the tooling can build on.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const ROOT = resolve(HERE, "..");
const DIRS = {
  skills: join(ROOT, "skills"),
  agents: join(ROOT, "agents"),
  subagents: join(ROOT, "subagents"),
  plugins: join(ROOT, "plugins"),
  prompts: join(ROOT, "prompts"),
} as const;

// ============================================================
// TYPES
// ============================================================

interface ParsedMeta {
  name: string;
  description: string;
  type?: string;
  source?: string;
  topics?: string[];
  model?: string;
  games?: string[];
  engines?: string[];
}

interface ParsedFile {
  meta: ParsedMeta;
  body: string;
}

interface CategorizedFile extends ParsedFile {
  category?: string;
}

interface SkillIndex {
  name: string;
  description: string;
  type: string;
  topics: string[];
  hasSource: boolean;
  searchText: string;
}

// ============================================================
// IN-MEMORY INDEX
// ============================================================

let _index: Map<string, SkillIndex> | null = null;
let _indexTime = 0;
let _indexBuild: Promise<Map<string, SkillIndex>> | null = null;
const INDEX_TTL = 120_000;
const INDEX_CHUNK = 64;

async function buildIndex(): Promise<Map<string, SkillIndex>> {
  let entries;
  try {
    entries = await readdir(DIRS.skills, { withFileTypes: true });
  } catch (error) {
    // A checkout without the archive (sparse clone, CI) should get an
    // actionable message rather than a bare ENOENT, and must not be left
    // thinking the library is empty: a missing archive and an empty one are
    // different problems.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `The skill archive is not present at ${DIRS.skills}. It ships with the repository ` +
          "but is excluded from sparse checkouts and CI runs, which are 19 GB smaller without it. " +
          "The agent, subagent, plugin and prompt tools do not depend on it.",
        { cause: error },
      );
    }
    throw error;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const idx = new Map<string, SkillIndex>();

  // Bounded concurrency. A single Promise.all over ~4k directories opens
  // thousands of handles at once; reads that fail under that pressure are
  // swallowed by safeRead and the skill silently vanishes from the index.
  for (let i = 0; i < dirs.length; i += INDEX_CHUNK) {
    const chunk = dirs.slice(i, i + INDEX_CHUNK);
    await Promise.all(
      chunk.map(async (name) => {
        const content = await safeRead(join(DIRS.skills, name, "SKILL.md"));
        if (!content) return;
        const parsed = parseFrontmatter(content);
        const hasSource = await fileExists(join(DIRS.skills, name, "source.txt"));
        const topics = parsed.meta.topics ?? [];
        const searchText = [
          name,
          parsed.meta.name,
          parsed.meta.description,
          ...topics,
          ...(parsed.meta.games ?? []),
          ...(parsed.meta.engines ?? []),
        ]
          .join(" ")
          .toLowerCase();

        idx.set(name, {
          name,
          description: parsed.meta.description,
          type: parsed.meta.type ?? "unknown",
          topics,
          hasSource,
          searchText,
        });
      }),
    );
  }

  return idx;
}

async function getIndex(): Promise<Map<string, SkillIndex>> {
  const now = Date.now();
  if (_index && now - _indexTime < INDEX_TTL) return _index;
  // Single-flight: concurrent callers await the build already in progress
  // instead of each starting their own, which produced partial indexes.
  if (_indexBuild) return _indexBuild;

  _indexBuild = buildIndex();
  try {
    const idx = await _indexBuild;
    _index = idx;
    _indexTime = Date.now();
    return idx;
  } finally {
    _indexBuild = null;
  }
}

// Component caches
const _componentCache = new Map<string, { items: CategorizedFile[]; time: number }>();
const COMP_TTL = 60_000;

async function getCachedComponents(dir: string): Promise<CategorizedFile[]> {
  const now = Date.now();
  const cached = _componentCache.get(dir);
  if (cached && now - cached.time < COMP_TTL) return cached.items;
  const items = await listMdFiles(dir);
  _componentCache.set(dir, { items, time: now });
  return items;
}

// ============================================================
// CORE HELPERS
// ============================================================

function parseFrontmatter(content: string): ParsedFile {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: { name: "", description: "" }, body: content };

  const raw = match[1];
  const body = match[2].trim();

  // Keys may sit at column 0 (`name:`) or nested under `metadata:` (`  type:`),
  // so leading whitespace is allowed. Top-level keys still win because the regex
  // scans left-to-right and they precede the metadata block.
  const str = (key: string) =>
    raw.match(new RegExp(`^\\s*${key}:\\s*"?(.+?)"?$`, "m"))?.[1]?.trim();
  const arr = (key: string) => {
    const m = raw.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
    return m
      ? m[1]
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean)
      : undefined;
  };

  return {
    meta: {
      name: str("name") ?? "",
      description: str("description") ?? "",
      type: str("type"),
      source: str("source"),
      model: str("model"),
      topics: arr("topics"),
      games: arr("games"),
      engines: arr("engines"),
    },
    body,
  };
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listMdFiles(dir: string, category?: string): Promise<CategorizedFile[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: CategorizedFile[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = await listMdFiles(join(dir, e.name), e.name);
        results.push(...sub);
      } else if (e.name.endsWith(".md")) {
        const content = await safeRead(join(dir, e.name));
        if (content) {
          const parsed = parseFrontmatter(content);
          results.push({ ...parsed, category });
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function findMdByName(dir: string, name: string): Promise<string | null> {
  const direct = join(dir, `${name}.md`);
  if (await fileExists(direct)) return direct;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = join(dir, e.name, `${name}.md`);
        if (await fileExists(sub)) return sub;
      }
    }
  } catch {}
  return null;
}

async function readMdByName(dir: string, name: string): Promise<ParsedFile | null> {
  const path = await findMdByName(dir, name);
  if (!path) return null;
  const content = await safeRead(path);
  return content ? parseFrontmatter(content) : null;
}

async function readSkill(name: string): Promise<ParsedFile | null> {
  const content = await safeRead(join(DIRS.skills, name, "SKILL.md"));
  return content ? parseFrontmatter(content) : null;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function notFound(kind: string, name: string) {
  return err(
    `${kind} "${name}" not found. Use list_${kind.toLowerCase()}s to see available options.`,
  );
}

// ============================================================
// GREP ENGINE -- streaming line search through source.txt
// ============================================================

async function grepFile(
  filePath: string,
  pattern: RegExp,
  maxMatches: number,
  contextLines: number,
): Promise<{ line: number; text: string }[]> {
  return new Promise((resolve) => {
    const matches: { line: number; text: string }[] = [];
    let lineNum = 0;
    const buffer: string[] = [];

    try {
      const rl = createInterface({
        input: createReadStream(filePath, { encoding: "utf-8", highWaterMark: 64 * 1024 }),
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        lineNum++;
        buffer.push(line);
        if (buffer.length > contextLines * 2 + 1) buffer.shift();

        if (pattern.test(line)) {
          matches.push({ line: lineNum, text: line.trimEnd().slice(0, 200) });
          if (matches.length >= maxMatches) {
            rl.close();
            rl.removeAllListeners();
          }
        }
      });

      rl.on("close", () => resolve(matches));
      rl.on("error", () => resolve(matches));
    } catch {
      resolve(matches);
    }
  });
}

// ============================================================
// FORMATTERS
// ============================================================

function formatSkillCompact(
  name: string,
  meta: { description: string; type?: string },
  hasSrc: boolean,
): string {
  const tags = [meta.type ?? "unknown", hasSrc ? "has-source" : "no-source"].join(", ");
  return `- **${name}** [${tags}]: ${meta.description}`;
}

function formatSkillFull(name: string, parsed: ParsedFile, hasSrc: boolean): string {
  const lines = [
    `# ${parsed.meta.name || name}`,
    "",
    `**Description:** ${parsed.meta.description}`,
    `**Type:** ${parsed.meta.type ?? "unknown"}`,
    `**Source:** ${parsed.meta.source ?? "original"}`,
    `**Has source code:** ${hasSrc}`,
  ];
  if (parsed.meta.topics?.length) lines.push(`**Topics:** ${parsed.meta.topics.join(", ")}`);
  if (parsed.meta.games?.length) lines.push(`**Games:** ${parsed.meta.games.join(", ")}`);
  if (parsed.meta.engines?.length) lines.push(`**Engines:** ${parsed.meta.engines.join(", ")}`);
  lines.push("", "---", "", parsed.body);
  return lines.join("\n");
}

function formatComponentList(kind: string, items: CategorizedFile[]): string {
  if (!items.length) return `No ${kind}s found.`;
  const grouped = new Map<string, CategorizedFile[]>();
  for (const item of items) {
    const cat = item.category ?? "uncategorized";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(item);
  }
  const sections: string[] = [`Available ${kind}s (${items.length}):\n`];
  for (const [cat, catItems] of grouped) {
    sections.push(
      `### ${cat} (${catItems.length})\n${catItems.map((i) => `- **${i.meta.name}**: ${i.meta.description}`).join("\n")}\n`,
    );
  }
  return sections.join("\n");
}

function formatComponent(kind: string, parsed: ParsedFile): string {
  const lines = [
    `# ${kind}: ${parsed.meta.name}`,
    "",
    `**Description:** ${parsed.meta.description}`,
  ];
  if (parsed.meta.model) lines.push(`**Model:** ${parsed.meta.model}`);
  lines.push("", "---", "", parsed.body);
  return lines.join("\n");
}

// ============================================================
// SCORED SEARCH
// ============================================================

function scoreSkill(idx: SkillIndex, keywords: string[]): number {
  let score = 0;
  const nameLc = idx.name.toLowerCase();
  for (const kw of keywords) {
    if (nameLc.includes(kw)) score += 5;
    else if (idx.searchText.includes(kw)) score += 2;
  }
  return score;
}

// ============================================================
// SERVER
// ============================================================

// package.json is the source of truth for the version, so the MCP
// serverInfo cannot drift from the published package version.
const PKG_VERSION = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))).version;

const server = new McpServer(
  {
    name: "mcp-gamehacking",
    version: PKG_VERSION,
  },
  {
    instructions:
      "Knowledge base for game hacking and reverse engineering: 4,160 skills, 75 agents, 161 subagents, 114 plugins and 148 prompts, including full source archives for roughly 3,980 projects.\n\n" +
      "The tool surface is not fixed, and it is not chosen for you. Models do not work equally well on the same tools, so no base set suits everyone; you start with one tool and no working set. Call `surface` with no arguments to see every tool that exists, then build your own working set with `pick` and write it down with `save`.\n\n" +
      "Nothing is withheld in the meantime: a tool your surface does not carry stays callable by name, so a narrow surface is a presentation choice, never a lost capability.",
  },
);

// ============================================================
// MCP RESOURCES
// ============================================================

server.resource(
  "library-stats",
  "gamehacking://stats",
  { description: "Skill library statistics overview" },
  async () => {
    const idx = await getIndex();
    let withSource = 0;
    let agsCount = 0;
    const types: Record<string, number> = {};

    for (const [name, skill] of idx) {
      if (skill.hasSource) withSource++;
      if (name.startsWith("ags-")) agsCount++;
      types[skill.type] = (types[skill.type] ?? 0) + 1;
    }

    const typeStr = Object.entries(types)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

    return {
      contents: [
        {
          uri: "gamehacking://stats",
          mimeType: "text/markdown",
          text: `# Skill Library Stats\n\n- **Total:** ${idx.size}\n- **Hand-written:** ${idx.size - agsCount}\n- **Archived (ags-):** ${agsCount}\n- **With source:** ${withSource}\n\n**By type:**\n${typeStr}`,
        },
      ],
    };
  },
);

server.resource(
  "agent",
  new ResourceTemplate("gamehacking://agents/{name}", { list: undefined }),
  { description: "Agent definition by name" },
  async (uri, { name }) => {
    const parsed = await readMdByName(DIRS.agents, name as string);
    if (!parsed)
      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text: `Agent "${name}" not found.` }],
      };
    return {
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: formatComponent("Agent", parsed) },
      ],
    };
  },
);

server.resource(
  "subagent",
  new ResourceTemplate("gamehacking://subagents/{name}", { list: undefined }),
  { description: "Subagent definition by name" },
  async (uri, { name }) => {
    const parsed = await readMdByName(DIRS.subagents, name as string);
    if (!parsed)
      return {
        contents: [
          { uri: uri.href, mimeType: "text/plain", text: `Subagent "${name}" not found.` },
        ],
      };
    return {
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: formatComponent("Subagent", parsed) },
      ],
    };
  },
);

server.resource(
  "plugin",
  new ResourceTemplate("gamehacking://plugins/{name}", { list: undefined }),
  { description: "Plugin definition by name" },
  async (uri, { name }) => {
    const parsed = await readMdByName(DIRS.plugins, name as string);
    if (!parsed)
      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text: `Plugin "${name}" not found.` }],
      };
    return {
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: formatComponent("Plugin", parsed) },
      ],
    };
  },
);

server.resource(
  "skill",
  new ResourceTemplate("gamehacking://skills/{name}", { list: undefined }),
  { description: "Skill SKILL.md content by name" },
  async (uri, { name }) => {
    const n = name as string;
    const skill = await readSkill(n);
    if (!skill)
      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text: `Skill "${n}" not found.` }],
      };
    const hasSrc = await fileExists(join(DIRS.skills, n, "source.txt"));
    return {
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: formatSkillFull(n, skill, hasSrc) },
      ],
    };
  },
);

// ============================================================
// MCP PROMPTS (native)
// ============================================================

server.prompt(
  "analyze-cheat",
  "Full architecture analysis of a cheat project from the skill library",
  { project: z.string().describe("Skill/project name (kebab-case)") },
  async ({ project }) => {
    const skill = await readSkill(project);
    const hasSrc = skill ? await fileExists(join(DIRS.skills, project, "source.txt")) : false;
    const intro = skill
      ? formatSkillFull(project, skill, hasSrc)
      : `Project "${project}" not found in library.`;
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${intro}\n\nAnalyze this cheat project:\n1. Architecture (internal/external/overlay/DMA/hybrid)\n2. Engine target and version\n3. Memory access method (driver/DMA/hypervisor/direct)\n4. Injection chain\n5. Stealth measures\n6. Detection surface per anti-cheat\n7. Notable techniques worth extracting`,
          },
        },
      ],
    };
  },
);

server.prompt(
  "find-bypass",
  "Research bypass techniques for a specific anti-cheat system",
  {
    anticheat: z.string().describe("Anti-cheat name: battleye, eac, vanguard, vac, faceit, byfron"),
  },
  async ({ anticheat }) => {
    const idx = await getIndex();
    const kw = anticheat.toLowerCase();
    const relevant: string[] = [];
    for (const [name, skill] of idx) {
      if (skill.searchText.includes(kw)) relevant.push(`- **${name}**: ${skill.description}`);
      if (relevant.length >= 30) break;
    }
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# Bypass Research: ${anticheat}\n\nRelevant projects in library (${relevant.length}):\n${relevant.join("\n")}\n\nBased on these projects and your knowledge:\n1. Current detection vectors used by ${anticheat}\n2. Known bypass techniques (kernel, HV, DMA, usermode)\n3. Detection risk assessment per technique\n4. Recommended approach for 2024+\n5. Required tooling and prerequisites`,
          },
        },
      ],
    };
  },
);

server.prompt(
  "reverse-binary",
  "Structured workflow for reversing a game binary",
  {
    game: z.string().describe("Game name"),
    engine: z.string().optional().describe("Engine if known: unreal, unity, source, custom"),
  },
  async ({ game, engine }) => {
    const idx = await getIndex();
    const kws = [game.toLowerCase(), ...(engine ? [engine.toLowerCase()] : [])];
    const relevant: string[] = [];
    for (const [name, skill] of idx) {
      if (kws.some((k) => skill.searchText.includes(k))) {
        relevant.push(`- **${name}**: ${skill.description}`);
        if (relevant.length >= 20) break;
      }
    }
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# Reverse Engineering: ${game}${engine ? ` (${engine})` : ""}\n\nRelevant projects:\n${relevant.join("\n")}\n\nProvide a structured RE workflow:\n1. Static analysis setup (IDA/Ghidra config, SDK generation)\n2. Dynamic analysis (debugger attach, bypass anti-debug)\n3. Key structures to find (player, entity list, camera, world)\n4. Offset extraction methodology\n5. Validation and testing approach`,
          },
        },
      ],
    };
  },
);

server.prompt(
  "build-esp",
  "Design an ESP system for a specific game and engine",
  {
    game: z.string().describe("Target game"),
    render_method: z.string().optional().describe("Render method: overlay, internal, dxgi, canvas"),
  },
  async ({ game, render_method }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# ESP System Design: ${game}\nRender method: ${render_method ?? "auto-select"}\n\nDesign a complete ESP system:\n1. Entity scanning (world -> player array -> positions)\n2. World-to-screen projection\n3. Bone-based skeleton ESP\n4. Bounding boxes (2D and 3D)\n5. Health/shield bars\n6. Distance and name labels\n7. Visibility checks\n8. Render pipeline (${render_method ?? "recommend best approach"})\n9. Thread safety (scanner thread vs render thread)\n10. Performance optimization`,
        },
      },
    ],
  }),
);

server.prompt(
  "write-driver",
  "Design a kernel driver for game memory access",
  {
    method: z.string().optional().describe("Access method: ioctl, shared-memory, hypervisor, dma"),
  },
  async ({ method }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# Kernel Driver Design\nAccess method: ${method ?? "IOCTL-based"}\n\nDesign a kernel driver for game memory R/W:\n1. Driver entry and device creation\n2. IOCTL dispatch (read/write/get-module)\n3. Process attachment (KeStackAttachProcess vs MmCopyVirtualMemory vs physical)\n4. CR3-based physical memory translation\n5. Stealth loading (manual map, vulnerable driver chain, EFI)\n6. Anti-detection (PiDDB cleanup, MmUnloadedDrivers, BigPool)\n7. Communication channel security\n8. Cleanup and unload`,
        },
      },
    ],
  }),
);

server.prompt(
  "compare-projects",
  "Compare two cheat projects side by side",
  {
    project_a: z.string().describe("First project name"),
    project_b: z.string().describe("Second project name"),
  },
  async ({ project_a, project_b }) => {
    const a = await readSkill(project_a);
    const b = await readSkill(project_b);
    const aHas = a ? await fileExists(join(DIRS.skills, project_a, "source.txt")) : false;
    const bHas = b ? await fileExists(join(DIRS.skills, project_b, "source.txt")) : false;
    const aText = a ? formatSkillFull(project_a, a, aHas) : `"${project_a}" not found.`;
    const bText = b ? formatSkillFull(project_b, b, bHas) : `"${project_b}" not found.`;
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# Project Comparison\n\n## Project A\n${aText}\n\n## Project B\n${bText}\n\nCompare these projects:\n1. Architecture and design approach\n2. Engine/game targeting\n3. Memory access method\n4. Stealth and anti-detection\n5. Feature completeness\n6. Code quality and maintainability\n7. Which techniques from each are worth adopting`,
          },
        },
      ],
    };
  },
);

// ============================================================
// WORKFLOW TOOLS
// ============================================================

server.tool(
  "research_technique",
  "Research a game hacking technique: finds relevant skills by scored keyword search across the indexed library. Returns consolidated briefing.",
  {
    technique: z
      .string()
      .describe(
        "Technique to research, e.g. 'DMA memory read', 'EPT hook', 'silent aim', 'driver communication'",
      ),
    detail: z.enum(["concise", "detailed"]).default("concise").describe("Response detail level"),
    max_results: z.number().min(1).max(50).default(10).describe("Max skills to include"),
  },
  async ({ technique, detail, max_results }) => {
    const idx = await getIndex();
    const keywords = technique
      .toLowerCase()
      .split(/[\s,_-]+/)
      .filter((w) => w.length > 2);
    const scored: Array<{ name: string; score: number; idx: SkillIndex }> = [];

    for (const [name, skill] of idx) {
      const score = scoreSkill(skill, keywords);
      if (score > 0) scored.push({ name, score, idx: skill });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, max_results);

    if (!top.length) return err(`No skills found for "${technique}". Try broader keywords.`);

    let output = `# Research: ${technique}\n\nFound ${scored.length} relevant skills (showing top ${top.length}):\n\n`;

    if (detail === "detailed") {
      for (const { name } of top) {
        const parsed = await readSkill(name);
        if (parsed)
          output +=
            formatSkillFull(
              name,
              parsed,
              scored.find((s) => s.name === name)?.idx.hasSource ?? false,
            ) + "\n\n---\n\n";
      }
    } else {
      for (const { name, idx: skill } of top) {
        output +=
          formatSkillCompact(
            name,
            { description: skill.description, type: skill.type },
            skill.hasSource,
          ) + "\n";
      }
    }

    if (scored.length > max_results) {
      output += `\n_${scored.length - max_results} more results. Increase max_results or refine query._`;
    }

    return ok(output);
  },
);

server.tool(
  "analyze_project",
  "Deep-analyze an archived project: reads SKILL.md + source code, classifies technique, provides structured assessment.",
  {
    name: z.string().describe("Skill/project folder name (kebab-case)"),
    focus: z.enum(["architecture", "injection", "stealth", "detection", "all"]).default("all"),
    source_lines: z.number().min(50).max(2000).default(500).describe("Max source lines to include"),
  },
  async ({ name, focus, source_lines }) => {
    const skill = await readSkill(name);
    if (!skill) return notFound("Skill", name);

    const hasSrc = await fileExists(join(DIRS.skills, name, "source.txt"));
    let output = formatSkillFull(name, skill, hasSrc);

    if (hasSrc) {
      const src = await safeRead(join(DIRS.skills, name, "source.txt"));
      if (src) {
        const lines = src.split("\n").slice(0, source_lines);
        output += `\n\n## Source Code (first ${lines.length} lines)\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
      }
    }

    const focusMap: Record<string, string> = {
      architecture:
        "- Architecture type (internal/external/overlay/DMA/EFI/hybrid)\n- Engine target\n- Memory access method\n- Thread model",
      injection:
        "- Injection technique\n- Loading method\n- Privilege requirements\n- Vulnerable drivers used",
      stealth:
        "- Hiding techniques\n- Trace cleanup\n- Anti-debug/anti-analysis\n- Detection evasion",
      detection:
        "- Detection surface per AC (BE/EAC/Vanguard/VAC)\n- Risk rating\n- Detectable artifacts\n- Mitigation options",
      all: "- Full architecture classification\n- Injection and loading chain\n- Stealth measures\n- Detection surface\n- Notable techniques",
    };

    output += `\n\n## Analysis Focus: ${focus}\n\n${focusMap[focus] ?? focusMap.all}`;
    return ok(output);
  },
);

server.tool(
  "get_agent_briefing",
  "Load an agent definition with all available subagents and plugins listed. Returns a ready-to-use system prompt.",
  {
    agent: z
      .string()
      .describe("Agent name (kebab-case). Use list_agents to see all 75 available agents."),
  },
  async ({ agent }) => {
    const parsed = await readMdByName(DIRS.agents, agent);
    if (!parsed) return notFound("Agent", agent);

    const subagents = await getCachedComponents(DIRS.subagents);
    const plugins = await getCachedComponents(DIRS.plugins);

    let output = formatComponent("Agent", parsed);
    output += "\n\n## Available Subagents\n\n";
    output += subagents.map((s) => `- **${s.meta.name}**: ${s.meta.description}`).join("\n");
    output += "\n\n## Available Plugins\n\n";
    output += plugins.map((p) => `- **${p.meta.name}**: ${p.meta.description}`).join("\n");

    return ok(output);
  },
);

// ============================================================
// GREP / FULL-TEXT SEARCH
// ============================================================

server.tool(
  "grep_sources",
  "Full-text search across all 3,985 source code archives. Streams through source.txt files matching a regex pattern. Use for finding specific offsets, function names, patterns, struct definitions.",
  {
    pattern: z
      .string()
      .min(2)
      .describe(
        "Regex pattern to search. Examples: '0x447D410', 'ProcessEvent', 'class APlayerController', 'CR3'",
      ),
    case_sensitive: z.boolean().default(false),
    max_files: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe("Max files to search (stops after this many hits)"),
    max_matches_per_file: z.number().min(1).max(50).default(5).describe("Max matches per file"),
    filter: z.string().optional().describe("Only search skills whose name contains this substring"),
  },
  async ({ pattern, case_sensitive, max_files, max_matches_per_file, filter }) => {
    const idx = await getIndex();
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, case_sensitive ? "" : "i");
    } catch (e) {
      return err(`Invalid regex: ${e}`);
    }

    const results: Array<{ skill: string; matches: { line: number; text: string }[] }> = [];
    let filesSearched = 0;

    for (const [name, skill] of idx) {
      if (!skill.hasSource) continue;
      if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;

      const filePath = join(DIRS.skills, name, "source.txt");
      const matches = await grepFile(filePath, regex, max_matches_per_file, 0);

      if (matches.length > 0) {
        results.push({ skill: name, matches });
        if (results.length >= max_files) break;
      }
      filesSearched++;
    }

    if (!results.length)
      return err(`No matches for "${pattern}" in ${filesSearched} source archives.`);

    let output = `# Grep: \`${pattern}\`\n\nFound in ${results.length} projects (searched ${filesSearched}):\n\n`;
    for (const { skill, matches } of results) {
      output += `## ${skill}\n`;
      for (const m of matches) {
        output += `  L${m.line}: ${m.text}\n`;
      }
      output += "\n";
    }

    return ok(output);
  },
);

// ============================================================
// OFFSET CROSS-REFERENCE
// ============================================================

server.tool(
  "find_offset",
  "Cross-reference a game offset, pattern, or struct name across all archived source code. Finds every project that uses a specific offset value or field name.",
  {
    query: z
      .string()
      .describe("Offset hex value (0x4F0), field name (BoneMatrix), or pattern (CompSpaceBones)"),
    max_results: z.number().min(1).max(50).default(15),
  },
  async ({ query, max_results }) => {
    const idx = await getIndex();
    let regex: RegExp;
    try {
      regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch {
      regex = new RegExp(query, "i");
    }

    const results: Array<{ skill: string; matches: { line: number; text: string }[] }> = [];

    for (const [name, skill] of idx) {
      if (!skill.hasSource) continue;
      const filePath = join(DIRS.skills, name, "source.txt");
      const matches = await grepFile(filePath, regex, 3, 0);
      if (matches.length > 0) {
        results.push({ skill: name, matches });
        if (results.length >= max_results) break;
      }
    }

    if (!results.length) return err(`No projects reference "${query}".`);

    let output = `# Offset Cross-Reference: \`${query}\`\n\nFound in ${results.length} projects:\n\n`;
    for (const { skill, matches } of results) {
      output += `### ${skill}\n`;
      for (const m of matches) {
        output += `  L${m.line}: ${m.text}\n`;
      }
      output += "\n";
    }

    return ok(output);
  },
);

// ============================================================
// COMPARE PROJECTS TOOL
// ============================================================

server.tool(
  "compare_projects",
  "Side-by-side comparison of two cheat projects: architecture, techniques, features, detection surface.",
  {
    project_a: z.string().describe("First project name"),
    project_b: z.string().describe("Second project name"),
    include_source: z
      .boolean()
      .default(false)
      .describe("Include first 200 lines of source from each"),
  },
  async ({ project_a, project_b, include_source }) => {
    const a = await readSkill(project_a);
    const b = await readSkill(project_b);
    if (!a && !b) return err(`Neither "${project_a}" nor "${project_b}" found.`);

    let output = `# Comparison: ${project_a} vs ${project_b}\n\n`;

    const format = async (name: string, skill: ParsedFile | null) => {
      if (!skill) return `## ${name}\n\nNot found in library.\n`;
      const hasSrc = await fileExists(join(DIRS.skills, name, "source.txt"));
      let text = formatSkillFull(name, skill, hasSrc);
      if (include_source && hasSrc) {
        const src = await safeRead(join(DIRS.skills, name, "source.txt"));
        if (src) {
          const lines = src.split("\n").slice(0, 200);
          text += `\n\n### Source Preview\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
        }
      }
      return text;
    };

    output += await format(project_a, a);
    output += "\n\n---\n\n";
    output += await format(project_b, b);

    output += "\n\n---\n\n## Comparison Points\n\n";
    output +=
      "1. Architecture and design approach\n2. Engine/game targeting\n3. Memory access method\n4. Stealth measures\n5. Feature set\n6. Code quality\n7. Techniques worth extracting from each";

    return ok(output);
  },
);

// ============================================================
// FIND SIMILAR
// ============================================================

server.tool(
  "find_similar",
  "Find projects similar to a given one based on topic and description overlap. Great for finding alternative implementations of the same technique.",
  {
    name: z.string().describe("Skill/project name to find similars for"),
    limit: z.number().min(1).max(30).default(10),
  },
  async ({ name, limit }) => {
    const idx = await getIndex();
    const target = idx.get(name);
    if (!target) return notFound("Skill", name);

    const targetWords = new Set(target.searchText.split(/\s+/).filter((w) => w.length > 3));
    const scored: Array<{ name: string; score: number; desc: string }> = [];

    for (const [n, skill] of idx) {
      if (n === name) continue;
      let score = 0;
      const words = skill.searchText.split(/\s+/);
      for (const w of words) {
        if (w.length > 3 && targetWords.has(w)) score++;
      }
      for (const t of target.topics) {
        if (skill.topics.includes(t)) score += 3;
      }
      if (score > 0) scored.push({ name: n, score, desc: skill.description });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    if (!top.length) return err(`No similar projects found for "${name}".`);

    return ok(
      `# Similar to: ${name}\n\n${target.description}\n\nFound ${scored.length} similar (top ${top.length}):\n\n${top.map((m) => `- **${m.name}** (overlap:${m.score}): ${m.desc}`).join("\n")}`,
    );
  },
);

// ============================================================
// EXTRACT OFFSETS
// ============================================================

server.tool(
  "extract_offsets",
  "Parse a project's source code and extract all hex offsets (0x...) with surrounding context. Instant offset dump from any cheat.",
  {
    name: z.string().describe("Skill/project name"),
    min_value: z
      .number()
      .default(0x10)
      .describe("Min offset value to include (filters noise like 0x0, 0x1)"),
    limit: z.number().min(1).max(200).default(50).describe("Max offsets to return"),
  },
  async ({ name, min_value, limit }) => {
    const src = await safeRead(join(DIRS.skills, name, "source.txt"));
    if (!src) return err(`No source.txt for "${name}".`);

    const regex = /\b(0x[0-9A-Fa-f]{2,8})\b/g;
    const seen = new Map<string, string>();
    const lines = src.split("\n");

    for (let i = 0; i < lines.length && seen.size < limit; i++) {
      let match;
      while ((match = regex.exec(lines[i])) !== null) {
        const val = match[1];
        const num = parseInt(val, 16);
        if (num >= min_value && !seen.has(val.toLowerCase())) {
          seen.set(val.toLowerCase(), `L${i + 1}: ${lines[i].trim().slice(0, 150)}`);
        }
      }
    }

    if (!seen.size) return err(`No hex offsets found in "${name}".`);

    let output = `# Offsets: ${name}\n\nExtracted ${seen.size} unique offsets:\n\n`;
    for (const [offset, context] of seen) {
      output += `- \`${offset}\` -- ${context}\n`;
    }

    return ok(output);
  },
);

// ============================================================
// SEARCH BY GAME / ENGINE
// ============================================================

server.tool(
  "search_by_game",
  "Find all skills/projects targeting a specific game. Searches name, description, topics, and games metadata.",
  {
    game: z
      .string()
      .describe(
        "Game name: cs2, valorant, fortnite, apex, pubg, rust, eft, r6, overwatch, genshin, roblox, minecraft, cod, league, dayz",
      ),
    has_source: z.boolean().optional(),
    limit: z.number().min(1).max(200).default(30),
  },
  async ({ game, has_source, limit }) => {
    const idx = await getIndex();
    const kw = game.toLowerCase();
    const aliases: Record<string, string[]> = {
      cs2: ["cs2", "csgo", "counter-strike", "counterstrike", "cstrike"],
      valorant: ["valorant", "vanguard", "riot"],
      fortnite: ["fortnite", "fn", "fortnitegame"],
      apex: ["apex", "apex-legends", "apexlegends"],
      pubg: ["pubg", "playerunknown", "battlegrounds"],
      rust: ["rust-game", "rustgame", "facepunch"],
      eft: ["eft", "tarkov", "escape-from-tarkov"],
      r6: ["r6", "rainbow-six", "siege", "rainbow6"],
      overwatch: ["overwatch", "ow2"],
      genshin: ["genshin", "hoyoverse", "mihoyo"],
      roblox: ["roblox", "byfron"],
      cod: ["cod", "call-of-duty", "warzone", "modern-warfare"],
      league: ["league", "lol", "league-of-legends"],
      dayz: ["dayz", "day-z"],
      minecraft: ["minecraft", "mc-"],
    };

    const keywords = aliases[kw] ?? [kw];
    const matches: Array<{ name: string; desc: string }> = [];

    for (const [name, skill] of idx) {
      if (has_source !== undefined && skill.hasSource !== has_source) continue;
      if (keywords.some((k) => skill.searchText.includes(k))) {
        matches.push({ name, desc: skill.description });
        if (matches.length >= limit) break;
      }
    }

    if (!matches.length) return err(`No projects found for game "${game}".`);

    return ok(
      `# Game: ${game}\n\nFound ${matches.length} projects:\n\n${matches.map((m) => `- **${m.name}**: ${m.desc}`).join("\n")}`,
    );
  },
);

server.tool(
  "search_by_engine",
  "Find all skills/projects targeting a specific game engine.",
  {
    engine: z
      .string()
      .describe("Engine: unreal, unity, source, cryengine, frostbite, godot, idtech"),
    has_source: z.boolean().optional(),
    limit: z.number().min(1).max(200).default(30),
  },
  async ({ engine, has_source, limit }) => {
    const idx = await getIndex();
    const kw = engine.toLowerCase();
    const aliases: Record<string, string[]> = {
      unreal: ["unreal", "ue4", "ue5", "uobject", "gobjects", "gnames", "processevent", "uworld"],
      unity: ["unity", "il2cpp", "mono", "gameobject", "unityengine"],
      source: ["source-engine", "source2", "valve", "netvar", "clientclass", "convar"],
      cryengine: ["cryengine", "lumberyard"],
      frostbite: ["frostbite", "dice"],
      godot: ["godot"],
      idtech: ["idtech", "id-tech", "quake"],
    };

    const keywords = aliases[kw] ?? [kw];
    const matches: Array<{ name: string; desc: string }> = [];

    for (const [name, skill] of idx) {
      if (has_source !== undefined && skill.hasSource !== has_source) continue;
      if (keywords.some((k) => skill.searchText.includes(k))) {
        matches.push({ name, desc: skill.description });
        if (matches.length >= limit) break;
      }
    }

    if (!matches.length) return err(`No projects found for engine "${engine}".`);

    return ok(
      `# Engine: ${engine}\n\nFound ${matches.length} projects:\n\n${matches.map((m) => `- **${m.name}**: ${m.desc}`).join("\n")}`,
    );
  },
);

// ============================================================
// FILE TREE
// ============================================================

server.tool(
  "get_file_tree",
  "Parse a project's source.txt and show its file/directory tree structure (without file contents). Quick project structure overview.",
  {
    name: z.string().describe("Skill/project name"),
    max_entries: z.number().min(10).max(500).default(100).describe("Max tree entries to show"),
  },
  async ({ name, max_entries }) => {
    const src = await safeRead(join(DIRS.skills, name, "source.txt"));
    if (!src) return err(`No source.txt for "${name}".`);

    // source.txt embeds the tree in a fenced block right after a "Source Tree:" marker.
    const fenced = src.match(/Source Tree:\s*```[a-z]*\r?\n([\s\S]*?)\r?\n```/i);
    if (fenced) {
      const lines = fenced[1].split("\n").map((l) => l.replace(/\r$/, ""));
      const treeLines = lines.filter((l) => /[├└]──/.test(l));

      if (treeLines.length) {
        const root = (lines.find((l) => l.trim() && !/[├└]/.test(l)) ?? "").trim();
        // Tree indent is 4 columns per level; the prefix is drawn with │ ├ └ ─ and spaces.
        const indents = treeLines.map((l) => Math.floor(l.match(/^[│├└─\s]*/)![0].length / 4));

        // An entry is a directory when the next entry sits one level deeper.
        let dirs = 0;
        for (let i = 0; i < treeLines.length - 1; i++) {
          if (indents[i + 1] > indents[i]) dirs++;
        }

        const shown = treeLines.slice(0, max_entries);
        const truncated = treeLines.length > max_entries;
        const files = treeLines.length - dirs;

        return ok(
          `# File Tree: ${name}\n\n` +
            `${treeLines.length} entries (${files} files, ${dirs} directories)` +
            `${root ? `\nRoot: \`${root}\`` : ""}` +
            `${truncated ? `\nShowing first ${max_entries} of ${treeLines.length}.` : ""}\n\n` +
            "```\n" +
            (root ? root + "\n" : "") +
            shown.join("\n") +
            (truncated ? "\n…" : "") +
            "\n```",
        );
      }
    }

    // Fallback for sources that use explicit file markers instead of a drawn tree.
    // NOTE: a bare markdown bullet (`- http://host.net`) must NOT count as a path,
    // so the marker must be an explicit `file:`/`path:` label.
    const paths: string[] = [];
    const markerRegex =
      /^(?:={3,}|[/#;]+)\s*(?:File|PATH|file|path|source):\s*(.+?)(?:\s*={3,})?\s*$/gim;
    let match;
    while ((match = markerRegex.exec(src)) !== null) {
      paths.push(match[1].trim());
      if (paths.length >= max_entries) break;
    }

    if (!paths.length)
      return err(
        `Could not extract file tree from "${name}". Source may not use standard file markers.`,
      );

    const dirs = new Set<string>();
    for (const p of paths) {
      const parts = p.split(/[/\\]/);
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    }

    return ok(
      `# File Tree: ${name}\n\n${paths.length} files, ${dirs.size} directories:\n\n\`\`\`\n${paths.join("\n")}\n\`\`\``,
    );
  },
);

// ============================================================
// FIND FUNCTION
// ============================================================

server.tool(
  "find_function",
  "Search for a function definition/declaration across all source archives. Matches C/C++ function signatures, class methods, NTSTATUS routines, etc.",
  {
    function_name: z
      .string()
      .min(2)
      .describe(
        "Function name to find. Examples: 'DriverEntry', 'ProcessEvent', 'WorldToScreen', 'GetBoneMatrix'",
      ),
    max_results: z.number().min(1).max(30).default(10),
  },
  async ({ function_name, max_results }) => {
    const idx = await getIndex();
    const escaped = function_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|\\s|\\*|>)${escaped}\\s*\\(`, "i");

    const results: Array<{ skill: string; matches: { line: number; text: string }[] }> = [];

    for (const [name, skill] of idx) {
      if (!skill.hasSource) continue;
      const filePath = join(DIRS.skills, name, "source.txt");
      const matches = await grepFile(filePath, regex, 3, 0);
      if (matches.length > 0) {
        results.push({ skill: name, matches });
        if (results.length >= max_results) break;
      }
    }

    if (!results.length) return err(`No definitions found for "${function_name}".`);

    let output = `# Function: ${function_name}\n\nFound in ${results.length} projects:\n\n`;
    for (const { skill, matches } of results) {
      output += `### ${skill}\n`;
      for (const m of matches) {
        output += `  L${m.line}: ${m.text}\n`;
      }
      output += "\n";
    }

    return ok(output);
  },
);

// ============================================================
// EXPORT OFFSETS
// ============================================================

server.tool(
  "export_offsets",
  "Collect all hex offsets for a specific game across all skills and export as a C++ header. Aggregates offsets from every project targeting that game.",
  {
    game: z.string().describe("Game name: cs2, valorant, fortnite, apex, etc."),
    max_projects: z.number().min(1).max(50).default(15).describe("Max projects to scan"),
  },
  async ({ game, max_projects }) => {
    const idx = await getIndex();
    const kw = game.toLowerCase();
    const gameProjects: string[] = [];

    for (const [name, skill] of idx) {
      if (!skill.hasSource) continue;
      if (skill.searchText.includes(kw)) {
        gameProjects.push(name);
        if (gameProjects.length >= max_projects) break;
      }
    }

    if (!gameProjects.length) return err(`No projects with source code found for "${game}".`);

    const allOffsets = new Map<string, { value: string; contexts: string[] }>();
    const offsetRegex = /\b(\w+)\s*[=:]\s*(0x[0-9A-Fa-f]{3,8})\b/g;

    for (const proj of gameProjects) {
      const src = await safeRead(join(DIRS.skills, proj, "source.txt"));
      if (!src) continue;
      const lines = src.split("\n");
      for (const line of lines) {
        let match;
        while ((match = offsetRegex.exec(line)) !== null) {
          const name = match[1];
          const value = match[2];
          const key = `${name}=${value}`.toLowerCase();
          if (!allOffsets.has(key)) {
            allOffsets.set(key, { value: `${name} = ${value}`, contexts: [] });
          }
          const entry = allOffsets.get(key)!;
          if (!entry.contexts.includes(proj)) entry.contexts.push(proj);
        }
      }
    }

    if (!allOffsets.size)
      return err(`No offsets extracted for "${game}" from ${gameProjects.length} projects.`);

    const sorted = [...allOffsets.values()].sort((a, b) => b.contexts.length - a.contexts.length);

    let header = `// ${game.toUpperCase()} offsets -- aggregated from ${gameProjects.length} projects\n`;
    header += `// Generated by mcp-gamehacking\n`;
    header += `// Offsets found in multiple projects are more likely current\n\n`;
    header += `#pragma once\n\nnamespace ${game.replace(/[^a-zA-Z0-9]/g, "_")}_offsets {\n\n`;

    for (const entry of sorted.slice(0, 100)) {
      const refs =
        entry.contexts.length > 1 ? ` // found in ${entry.contexts.length} projects` : "";
      header += `    constexpr auto ${entry.value};${refs}\n`;
    }

    header += `\n} // namespace ${game.replace(/[^a-zA-Z0-9]/g, "_")}_offsets\n`;

    return ok(
      `# Exported Offsets: ${game}\n\nScanned ${gameProjects.length} projects, found ${allOffsets.size} unique offset assignments.\n\n\`\`\`cpp\n${header}\`\`\``,
    );
  },
);

// ============================================================
// SKILL CHANGELOG (offset diff between two game projects)
// ============================================================

server.tool(
  "skill_changelog",
  "Compare offsets between two projects targeting the same game. Shows which offsets changed, were added, or removed. Useful for tracking game updates.",
  {
    project_old: z.string().describe("Older project name"),
    project_new: z.string().describe("Newer project name"),
  },
  async ({ project_old, project_new }) => {
    const extractOffsets = async (name: string): Promise<Map<string, string>> => {
      const src = await safeRead(join(DIRS.skills, name, "source.txt"));
      if (!src) return new Map();
      const offsets = new Map<string, string>();
      const regex = /\b(\w+)\s*[=:]\s*(0x[0-9A-Fa-f]{3,8})\b/g;
      for (const line of src.split("\n")) {
        let match;
        while ((match = regex.exec(line)) !== null) {
          offsets.set(match[1].toLowerCase(), match[2]);
        }
      }
      return offsets;
    };

    const oldOff = await extractOffsets(project_old);
    const newOff = await extractOffsets(project_new);

    if (!oldOff.size && !newOff.size) return err(`No offsets found in either project.`);

    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];

    for (const [name, val] of newOff) {
      const oldVal = oldOff.get(name);
      if (!oldVal) {
        added.push(`+ ${name} = ${val}`);
      } else if (oldVal !== val) {
        changed.push(`~ ${name}: ${oldVal} -> ${val}`);
      }
    }

    for (const [name, val] of oldOff) {
      if (!newOff.has(name)) {
        removed.push(`- ${name} = ${val}`);
      }
    }

    let output = `# Offset Changelog: ${project_old} -> ${project_new}\n\n`;
    output += `Old: ${oldOff.size} offsets | New: ${newOff.size} offsets\n\n`;

    if (changed.length)
      output += `## Changed (${changed.length})\n\`\`\`\n${changed.join("\n")}\n\`\`\`\n\n`;
    if (added.length)
      output += `## Added (${added.length})\n\`\`\`\n${added.join("\n")}\n\`\`\`\n\n`;
    if (removed.length)
      output += `## Removed (${removed.length})\n\`\`\`\n${removed.join("\n")}\n\`\`\`\n\n`;

    if (!changed.length && !added.length && !removed.length)
      output += "No offset differences found.\n";

    return ok(output);
  },
);

// ============================================================
// ADDITIONAL NATIVE PROMPTS
// ============================================================

server.prompt(
  "build-aimbot",
  "Design an aimbot system for a specific game",
  {
    game: z.string().describe("Target game"),
    type: z.string().optional().describe("Aimbot type: rage, legit, silent, psilent"),
  },
  async ({ game, type }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# Aimbot Design: ${game}\nType: ${type ?? "legit + rage modes"}\n\nDesign a complete aimbot:\n1. Target selection (FOV circle, distance weight, visibility)\n2. Bone targeting (head/neck/chest, configurable)\n3. Aim smoothing (linear, bezier, humanized)\n4. Recoil compensation (pattern-based vs real-time read)\n5. Silent aim (server-side angle override)\n6. Backtracking (tick-based position history)\n7. Prediction (velocity extrapolation for moving targets)\n8. Trigger conditions (key hold, FOV threshold, visibility)\n9. Anti-detection (mouse input simulation, jitter, deadzone)\n10. Configuration (sensitivity, FOV, bone priority, smooth factor)`,
        },
      },
    ],
  }),
);

server.prompt(
  "build-triggerbot",
  "Design a triggerbot with color/pixel or crosshair-based detection",
  {
    game: z.string().describe("Target game"),
    method: z.string().optional().describe("Detection: color, crosshair, trace, memory"),
  },
  async ({ game, method }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# Triggerbot Design: ${game}\nMethod: ${method ?? "color + memory hybrid"}\n\nDesign a triggerbot:\n1. Screen capture method (DXGI duplication, BitBlt, GPU readback)\n2. Target detection (HSV color range, crosshair entity ID, ray trace)\n3. FOV region (circular scan from center)\n4. Reaction delay (humanized random range)\n5. Cooldown between shots\n6. Bone filtering (head-only, body, any)\n7. Confidence threshold (pixel count ratio)\n8. Input method (SendInput, driver mouse, hardware mouse)\n9. Anti-detection (randomized delays, movement patterns)\n10. Performance (scan rate, threading model)`,
        },
      },
    ],
  }),
);

server.prompt(
  "write-injector",
  "Design a DLL injector with specified injection technique",
  {
    technique: z
      .string()
      .optional()
      .describe("Injection: manual-map, reflective, apc, thread-hijack, efi"),
  },
  async ({ technique }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# DLL Injector Design\nTechnique: ${technique ?? "manual map"}\n\nDesign a complete injector:\n1. Process discovery and handle acquisition\n2. PE parsing (headers, sections, imports, relocations, TLS)\n3. Memory allocation in target process\n4. Section mapping with correct protections\n5. Import resolution (LoadLibrary/GetProcAddress or manual)\n6. Relocation fixups (delta-based)\n7. TLS callback execution\n8. Entry point invocation (DllMain or custom)\n9. Header erasure and cleanup\n10. Exception handler registration\n11. Stealth considerations (no LoadLibrary trace, PEB cleanup)\n12. Error handling and rollback`,
        },
      },
    ],
  }),
);

server.prompt(
  "spoof-hardware",
  "Design an HWID spoofing system",
  {
    target_ac: z
      .string()
      .optional()
      .describe("Anti-cheat to evade: battleye, eac, vanguard, ricochet"),
  },
  async ({ target_ac }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# HWID Spoofing Design${target_ac ? `\nTarget AC: ${target_ac}` : ""}\n\nDesign a comprehensive HWID spoofer:\n1. Disk serial (SMART data, StorPort miniport hook, SCSI inquiry)\n2. NIC MAC address (NDIS filter driver, registry)\n3. SMBIOS/DMI (physical memory patch or EFI runtime)\n4. GPU serial (registry + driver IOCTL)\n5. Windows product ID / install ID (registry)\n6. TPM endorsement key\n7. Monitor EDID serial\n8. USB device serials\n9. CPU serial / CPUID\n10. Registry cleanup (past HWID traces)\n11. Persistence across reboots\n12. Detection vectors per anti-cheat${target_ac ? ` (focus on ${target_ac})` : ""}`,
        },
      },
    ],
  }),
);

server.prompt("bypass-battleye", "Research and design BattlEye bypass strategies", {}, async () => {
  const idx = await getIndex();
  const relevant: string[] = [];
  for (const [name, skill] of idx) {
    if (
      skill.searchText.includes("battleye") ||
      skill.searchText.includes("be_") ||
      name.includes("battleye")
    ) {
      relevant.push(`- **${name}**: ${skill.description}`);
      if (relevant.length >= 20) break;
    }
  }
  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# BattlEye Bypass Research\n\nProjects in library:\n${relevant.join("\n")}\n\nAnalyze BattlEye and provide bypass strategies:\n1. BEService/BEClient/BEDaisy architecture\n2. Kernel driver (BEDaisy.sys) detection methods\n3. User-mode module scanning and integrity checks\n4. Memory scanning patterns and timing\n5. Heartbeat/packet encryption\n6. Known bypass vectors (DMA, HV, EFI, driver)\n7. Detection timeline (what gets caught, when)\n8. Current recommended approach`,
        },
      },
    ],
  };
});

server.prompt(
  "bypass-eac",
  "Research and design Easy Anti-Cheat bypass strategies",
  {},
  async () => {
    const idx = await getIndex();
    const relevant: string[] = [];
    for (const [name, skill] of idx) {
      if (
        skill.searchText.includes("eac") ||
        skill.searchText.includes("easy anti") ||
        skill.searchText.includes("easyanticheat")
      ) {
        relevant.push(`- **${name}**: ${skill.description}`);
        if (relevant.length >= 20) break;
      }
    }
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# EAC Bypass Research\n\nProjects in library:\n${relevant.join("\n")}\n\nAnalyze Easy Anti-Cheat and provide bypass strategies:\n1. EAC architecture (service, driver, user-mode module)\n2. Kernel-level detection (driver verification, memory scanning)\n3. User-mode integrity checks (module whitelist, CRC)\n4. System call monitoring\n5. Hypervisor detection\n6. DMA detection improvements\n7. Known bypass vectors\n8. Current recommended approach`,
          },
        },
      ],
    };
  },
);

server.prompt(
  "bypass-vanguard",
  "Research and design Vanguard (Valorant) bypass strategies",
  {},
  async () => {
    const idx = await getIndex();
    const relevant: string[] = [];
    for (const [name, skill] of idx) {
      if (
        skill.searchText.includes("vanguard") ||
        skill.searchText.includes("vgk") ||
        skill.searchText.includes("valorant")
      ) {
        relevant.push(`- **${name}**: ${skill.description}`);
        if (relevant.length >= 20) break;
      }
    }
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# Vanguard Bypass Research\n\nProjects in library:\n${relevant.join("\n")}\n\nAnalyze Riot Vanguard and provide bypass strategies:\n1. vgk.sys kernel driver architecture\n2. Boot-time loading and SecureBoot enforcement\n3. HWID collection and banning system\n4. Hypervisor detection methods\n5. DMA/FPGA detection\n6. UEFI NVRAM scanning\n7. Module integrity verification\n8. Known bypass vectors (HV, EFI, DMA)\n9. Current recommended approach`,
          },
        },
      ],
    };
  },
);

server.prompt(
  "implement-backtrack",
  "Design a backtracking/lag compensation system",
  {
    game: z.string().describe("Target game"),
    engine: z.string().optional().describe("Engine: unreal, source, unity"),
  },
  async ({ game, engine }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# Backtracking System: ${game}${engine ? ` (${engine})` : ""}\n\nDesign a complete backtracking system:\n1. Tick/timestamp-based position recording\n2. Circular buffer per entity (configurable window: 50-200ms)\n3. Interpolation between recorded positions\n4. Best record selection (closest to crosshair or oldest valid)\n5. Latency compensation (local vs server tick delta)\n6. Integration with aimbot (bone position override)\n7. Choke cycle exploitation (if applicable)\n8. Visual representation (backtrack skeleton/ghost)\n9. Validity checks (max time window, distance sanity)\n10. Anti-detection (realistic tick manipulation)`,
        },
      },
    ],
  }),
);

server.prompt(
  "implement-autowall",
  "Design a wall penetration calculation system",
  {
    game: z.string().describe("Target game"),
  },
  async ({ game }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# Autowall System: ${game}\n\nDesign a wall penetration calculation system:\n1. Ray tracing from source to target\n2. Material/surface type detection (metal, wood, concrete, etc.)\n3. Penetration depth calculation per material\n4. Damage falloff through walls\n5. Multi-wall penetration (recursive trace)\n6. Weapon penetration power values\n7. Minimum damage threshold (configurable)\n8. Integration with aimbot (skip unpenetrable targets)\n9. Performance optimization (cache traces, limit depth)\n10. Visual feedback (penetration indicator, damage preview)`,
        },
      },
    ],
  }),
);

// ============================================================
// SKILL TOOLS -- direct access
// ============================================================

server.tool(
  "list_skills",
  "List skills with optional filtering. Uses in-memory index for fast lookup.",
  {
    filter: z.string().optional().describe("Filter by name substring (case-insensitive)"),
    type: z.string().optional().describe("Filter by type: 'reference', 'redirect', etc."),
    has_source: z.boolean().optional().describe("Filter to only skills with/without source.txt"),
    limit: z.number().min(1).max(500).default(50),
  },
  async ({ filter, type, has_source, limit }) => {
    const idx = await getIndex();
    let results: SkillIndex[] = [...idx.values()];

    if (filter) {
      const lc = filter.toLowerCase();
      results = results.filter((s) => s.name.toLowerCase().includes(lc));
    }
    if (type) results = results.filter((s) => s.type === type);
    if (has_source !== undefined) results = results.filter((s) => s.hasSource === has_source);

    const sliced = results.slice(0, limit);
    const text = `Found ${results.length} skills${results.length > limit ? ` (showing first ${limit})` : ""}:\n\n${sliced.map((s) => formatSkillCompact(s.name, { description: s.description, type: s.type }, s.hasSource)).join("\n")}`;

    return ok(text);
  },
);

server.tool(
  "read_skill",
  "Read a skill's SKILL.md content with full metadata.",
  {
    name: z.string().describe("Skill folder name (kebab-case)"),
  },
  async ({ name }) => {
    const skill = await readSkill(name);
    if (!skill) return notFound("Skill", name);
    const hasSrc = await fileExists(join(DIRS.skills, name, "source.txt"));
    return ok(formatSkillFull(name, skill, hasSrc));
  },
);

server.tool(
  "read_source",
  "Read a project's source code snapshot with pagination.",
  {
    name: z.string().describe("Skill folder name"),
    offset: z.number().min(0).default(0).describe("Start line (0-based)"),
    limit: z.number().min(1).max(2000).default(200).describe("Max lines"),
  },
  async ({ name, offset, limit }) => {
    const content = await safeRead(join(DIRS.skills, name, "source.txt"));
    if (!content) return err(`No source.txt for "${name}".`);

    const lines = content.split("\n");
    const slice = lines.slice(offset, offset + limit);

    return ok(
      `Source: ${name} (lines ${offset}-${offset + slice.length} of ${lines.length})\n\n${slice.join("\n")}${offset + limit < lines.length ? `\n\n_${lines.length - offset - limit} more lines. Use offset=${offset + limit} to continue._` : ""}`,
    );
  },
);

server.tool(
  "search_skills",
  "Scored keyword search across the indexed skill library (name + description + topics + games + engines).",
  {
    query: z
      .string()
      .min(2)
      .describe("Search query. Examples: 'kdmapper', 'DMA', 'valorant aimbot'"),
    has_source: z.boolean().optional().describe("Filter to skills with/without source code"),
    limit: z.number().min(1).max(100).default(20),
  },
  async ({ query, has_source, limit }) => {
    const idx = await getIndex();
    const keywords = query
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((w) => w.length >= 2);
    const matches: Array<{ name: string; desc: string; score: number }> = [];

    for (const [, skill] of idx) {
      if (has_source !== undefined && skill.hasSource !== has_source) continue;
      const score = scoreSkill(skill, keywords);
      if (score > 0) matches.push({ name: skill.name, desc: skill.description, score });
    }

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, limit);

    if (!top.length) return err(`No skills matching "${query}".`);

    return ok(
      `Found ${matches.length} skills for "${query}" (top ${top.length}):\n\n${top.map((m) => `- **${m.name}** (score:${m.score}): ${m.desc}`).join("\n")}${matches.length > limit ? `\n\n_${matches.length - limit} more. Increase limit or refine._` : ""}`,
    );
  },
);

server.tool("skill_stats", "Library statistics from the in-memory index.", {}, async () => {
  const idx = await getIndex();
  let withSource = 0;
  let agsCount = 0;
  const types: Record<string, number> = {};
  const topicCount: Record<string, number> = {};

  for (const [name, skill] of idx) {
    if (skill.hasSource) withSource++;
    if (name.startsWith("ags-")) agsCount++;
    types[skill.type] = (types[skill.type] ?? 0) + 1;
    for (const t of skill.topics) {
      topicCount[t] = (topicCount[t] ?? 0) + 1;
    }
  }

  const typeStr = Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const topTopics = Object.entries(topicCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  return ok(
    `# Skill Library Stats\n\n- **Total:** ${idx.size}\n- **Hand-written:** ${idx.size - agsCount}\n- **Archived (ags-):** ${agsCount}\n- **With source:** ${withSource}\n\n**By type:**\n${typeStr}\n\n**Top 20 topics:**\n${topTopics}`,
  );
});

// ============================================================
// COMPONENT TOOLS
// ============================================================

const componentTools = [
  { singular: "agent", plural: "agents", dir: DIRS.agents },
  { singular: "subagent", plural: "subagents", dir: DIRS.subagents },
  { singular: "plugin", plural: "plugins", dir: DIRS.plugins },
  { singular: "prompt", plural: "prompts", dir: DIRS.prompts },
] as const;

for (const { singular, plural, dir } of componentTools) {
  server.tool(
    `list_${plural}`,
    `List all available ${plural} grouped by category.`,
    {
      category: z.string().optional().describe("Filter by category/subdirectory name"),
    },
    async ({ category }: { category?: string }) => {
      let items = await getCachedComponents(dir);
      if (category) {
        const lc = category.toLowerCase();
        items = items.filter((i) => i.category?.toLowerCase() === lc);
      }
      return ok(formatComponentList(singular, items));
    },
  );

  server.tool(
    `read_${singular}`,
    `Read a ${singular}'s full definition and system prompt.`,
    {
      name: z
        .string()
        .describe(
          `${singular} name (without .md extension). Use list_${plural} to see available options.`,
        ),
    },
    async ({ name }: { name: string }) => {
      const parsed = await readMdByName(dir, name);
      if (!parsed) return notFound(singular.charAt(0).toUpperCase() + singular.slice(1), name);
      return ok(formatComponent(singular.charAt(0).toUpperCase() + singular.slice(1), parsed));
    },
  );
}

// ============================================================
// MODEL PROFILES
// ============================================================

/** Root that holds the archive data and the model-authored profiles. */
const PROFILE_ROOT = ROOT;

type ToolListResult = {
  tools: Array<{
    name: string;
    description?: string;
    /** Present on every SDK-registered tool; the shaper narrows it for aliases. */
    inputSchema?: Record<string, unknown>;
  }>;
};
type ToolListHandler = (
  request: unknown,
  extra: unknown,
) => ToolListResult | Promise<ToolListResult>;

/** A content block as the SDK serves it, narrowed to what shaping touches. */
type ContentBlock = { type?: string; text?: string; [key: string]: unknown };
type ToolCallResult = { content?: ContentBlock[]; isError?: boolean };
type ToolCallHandler = (
  request: unknown,
  extra: unknown,
) => ToolCallResult | Promise<ToolCallResult>;

/**
 * The SDK's own `tools/list` handler, kept so the catalogue stays readable even
 * before any client has listed tools.
 */
let rawToolListHandler: ToolListHandler | null = null;

/** Every registered tool, unshaped by any profile. */
async function listRegisteredTools(): Promise<ToolListResult["tools"]> {
  if (!rawToolListHandler) return [];
  // The SDK validates the request before dispatching, so pass a well-formed one
  // even though the handler itself ignores it.
  const base = await rawToolListHandler({ method: "tools/list", params: {} }, {});
  return base.tools;
}

/**
 * Re-present `tools/list` in the order and scope the active profile declares.
 *
 * McpServer keeps its handlers in a private map with no public accessor, so the
 * existing handler is read through a narrow structural type and wrapped, instead
 * of reimplementing the SDK's own schema conversion. If that internal shape is
 * ever absent the SDK handler is left untouched and the raw surface is served:
 * the profile layer degrades to a no-op rather than breaking the server.
 */
function installProfileAwareToolList(mcp: McpServer): boolean {
  const protocol = mcp.server as unknown as {
    _requestHandlers?: Map<string, ToolListHandler>;
    removeRequestHandler?: (method: string) => void;
  };

  const handlers = protocol._requestHandlers;
  if (!(handlers instanceof Map) || typeof protocol.removeRequestHandler !== "function") {
    return false;
  }

  const original = handlers.get("tools/list");
  if (typeof original !== "function") return false;
  rawToolListHandler = original;

  protocol.removeRequestHandler("tools/list");
  mcp.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    // Snapshot request-scoped inputs before awaiting anything, so a later
    // pipelined request cannot change what this one resolves to.
    const meta = extra?._meta;
    const clientName = mcp.server.getClientVersion()?.name ?? null;
    const session = getSessionSurface();

    const base = await original(request, extra);
    const resolved = await resolveProfile(PROFILE_ROOT, { meta, clientName, session });

    return {
      ...base,
      tools: shapeTools(base.tools, resolved.profile, resolved.core, resolved.mutatingArgs),
    };
  });

  return true;
}

/** The text of a result, before any shaping is applied to it. */
function rawTextOf(result: ToolCallResult): string {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item !== null && typeof item === "object" && item.type === "text")
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

/**
 * Run a chain: each step is fed values extracted from the previous answer.
 *
 * The four ways this can fail are all reported the same way — loudly, with the
 * step named — because a chain that half-runs and says nothing useful is the
 * worst outcome available. A model cannot debug a sequence it cannot see, so:
 *
 * - a step that returns an error stops the chain and reports that step;
 * - an extraction that matches nothing stops the chain and shows the pattern
 *   together with the start of the answer it was matched against, which is what
 *   the model needs to fix the pattern;
 * - a pattern that does not compile is refused before anything runs;
 * - fewer matches than `take` is not a failure, but it IS reported, because
 *   silently reading one of the three things you asked for is the kind of lie
 *   this whole design keeps refusing to tell.
 */
async function runChain(
  entry: ModelProfile["tools"]["derived"][number],
  profile: ModelProfile,
  registered: ToolListResult["tools"],
  mutating: Record<string, string[]>,
  first: string,
  call: (name: string, args: Record<string, unknown>) => ToolCallResult | Promise<ToolCallResult>,
): Promise<{ failure: string } | { text: string; trace: string[] }> {
  const trace: string[] = [];
  // Two views of the same data, kept apart on purpose:
  //
  //   raw     — what extraction reads. Always the unshaped answer, so a rule
  //             meant for the reader can never decide what flows between steps.
  //   display — what the caller reads: shaped, and labelled for fan-out.
  //
  // These were one variable once, which made extraction read the RAW answer for
  // step 2 and the SHAPED one for step 3 — the same chain behaving differently
  // by position, and the opposite of what this file promises.
  let raw = first;
  let display = first;

  for (const [index, step] of entry.then.entries()) {
    // Steps are numbered from 2: the tool this chain belongs to is step 1.
    const position = index + 2;
    const names = Object.keys(step.extract);

    // A step may call a tool this surface defined. Its fixed arguments apply,
    // and its own chain does not: nesting chains would make the sequence
    // something to work out rather than read.
    const alias = boundArgsFor(profile, step.tool, registered, mutating);
    const targetName = alias?.tool ?? step.tool;

    const perArgument = new Map<string, string[]>();
    const capped: string[] = [];
    for (const name of names) {
      const outcome = extractValues(raw, step.extract[name] ?? "");
      if ("problem" in outcome) {
        return { failure: `Step ${position} (${step.tool}): ${outcome.problem}` };
      }
      if (outcome.capped) capped.push(name);
      perArgument.set(name, outcome.values);
    }

    // A capped extraction is reported rather than swallowed: the pattern matched
    // more than the cap, so the values in hand are the first fifty and the model
    // needs to know that before reasoning about them.
    if (capped.length > 0) {
      trace.push(
        `[${position}] ${step.tool}: ${capped.join(", ")} matched more than 50 values, ` +
          "so only the first 50 are available — narrow the pattern to see the rest",
      );
    }

    const matched =
      names.length === 0 ? 1 : Math.min(...[...perArgument.values()].map((v) => v.length));

    if (names.length > 0 && matched === 0) {
      const patterns = names.map((name) => `\`${name}\` ← \`${step.extract[name]}\``).join(", ");
      return {
        failure:
          `Step ${position} (${step.tool}) cannot run: nothing matched ${patterns} in the previous ` +
          `answer, which began:\n\n${raw.slice(0, 400)}`,
      };
    }

    const wanted = Math.min(step.take, matched);
    if (matched < step.take) {
      trace.push(
        `[${position}] ${step.tool}: asked for ${step.take}, only ${matched} matched — running ${wanted}`,
      );
    }

    const raws: string[] = [];
    const showns: string[] = [];
    for (let pickIndex = 0; pickIndex < wanted; pickIndex++) {
      const args: Record<string, unknown> = { ...(alias?.args ?? {}) };
      for (const name of names) args[name] = perArgument.get(name)?.[pickIndex];

      const answered = await call(targetName, args);
      const text = rawTextOf(answered);
      trace.push(describeStep(position, targetName, args, text.length));

      if (answered?.isError === true) {
        return {
          failure: `Step ${position} (${targetName}) failed, so the chain stopped. Its error:\n\n${text}`,
        };
      }

      raws.push(text);

      // Shape each result BEFORE labelling it. A label is structure, not
      // content: a `sections` rule that stripped it would leave several results
      // with no way to tell which is which, which is the exact class of lie this
      // design keeps refusing to tell. Shaping per result also means the note
      // reports each result's own reduction rather than the total.
      const shown = hasShaping(entry.output) ? shapeOutput(text, entry.output) : text;
      showns.push(wanted > 1 ? `--- ${briefArgs(args)} ---\n${shown}` : shown);
    }

    // Extraction reads the unshaped answers; the caller reads the shaped ones.
    raw = raws.join("\n\n");
    display = showns.join("\n\n");
  }

  return { text: display, trace };
}

/** A step's arguments written short, to label one of several fanned-out results. */
function briefArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

/**
 * Make a derived tool work when it is called.
 *
 * A surface that only narrowed the listing would be a lie: the caller would see
 * a tool with two arguments and get a failure for omitting the other four. So
 * the bound arguments are merged here, at the single point every call passes
 * through, and the base tool is invoked with them.
 *
 * Bound arguments win over anything the caller sends. They left the schema, so a
 * caller that sends one is reaching past what it was shown, and honouring that
 * would undo the binding the model asked for.
 */
function installProfileAwareCall(mcp: McpServer): boolean {
  const protocol = mcp.server as unknown as {
    _requestHandlers?: Map<string, ToolListHandler>;
    removeRequestHandler?: (method: string) => void;
  };

  const handlers = protocol._requestHandlers;
  if (!(handlers instanceof Map) || typeof protocol.removeRequestHandler !== "function") {
    return false;
  }

  // The map is typed for `tools/list`; `tools/call` answers with content blocks,
  // so it is narrowed to its own shape here rather than widening the shared type
  // to the union of both.
  const original = handlers.get("tools/call") as ToolCallHandler | undefined;
  if (typeof original !== "function") return false;

  protocol.removeRequestHandler("tools/call");
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Snapshot request-scoped inputs before awaiting anything, so a later
    // pipelined request cannot change what this one resolves to.
    const meta = extra?._meta;
    const clientName = mcp.server.getClientVersion()?.name ?? null;
    const session = getSessionSurface();

    const resolved = await resolveProfile(PROFILE_ROOT, { meta, clientName, session });
    // Resolved against the same registered list the listing was shaped from, so
    // an alias is callable exactly while the surface defines it.
    const entry = boundArgsFor(
      resolved.profile,
      request.params.name,
      await listRegisteredTools(),
      resolved.mutatingArgs,
    );
    if (entry === null) return original(request, extra);

    const supplied = request.params.arguments ?? {};
    const merged: Record<string, unknown> = { ...supplied };

    // A default applies only where the caller said nothing. This is the
    // difference from a fixed argument, which wins regardless.
    for (const [key, value] of Object.entries(entry.defaults)) {
      if (!(key in merged)) merged[key] = value;
    }

    // A constraint narrows what the caller may send, so it is enforced here
    // rather than only written into the schema: a schema that lists an enum
    // while the server accepts anything is a lie.
    const violations: string[] = [];
    for (const [key, rule] of Object.entries(entry.constrain)) {
      if (!(key in merged)) continue;
      const problem = checkConstraint(merged[key], rule);
      if (problem !== null) violations.push(`\`${key}\` ${problem}`);
    }
    if (violations.length > 0) {
      return err(
        `\`${request.params.name}\` refused that call:\n` +
          violations.map((line) => `- ${line}`).join("\n"),
      );
    }

    // A fixed argument wins last, so nothing the caller sends can undo it.
    Object.assign(merged, entry.args);

    const registered = await listRegisteredTools();
    const result = await original(
      { ...request, params: { ...request.params, name: entry.tool, arguments: merged } },
      extra,
    );

    // A chain replaces the answer: the tool the caller named is step one, and
    // what they read is where the sequence ended up.
    if (hasChain(entry)) {
      const chain = await runChain(
        entry,
        resolved.profile,
        registered,
        resolved.mutatingArgs,
        rawTextOf(result),
        (name, args) =>
          original({ ...request, params: { ...request.params, name, arguments: args } }, extra),
      );

      if ("failure" in chain)
        return err(`\`${request.params.name}\` could not finish:\n\n${chain.failure}`);

      const header = `[chain] ${entry.tool} → ${entry.then.map((step) => step.tool).join(" → ")}`;
      const footer = [header, ...chain.trace].join("\n");

      // No shaping here: each result was shaped as it was produced, so the
      // labels and the trace stay outside it. The trace is what makes a chain
      // debuggable, and a content rule must not be able to eat it.
      return ok(`${footer}\n\n${chain.text}`);
    }

    // Shape what came back, never how it failed: a truncated error hides the
    // reason for the failure, which is the one thing a caller must not lose.
    if (!hasShaping(entry.output) || result?.isError === true) return result;

    const content = result?.content;
    if (!Array.isArray(content) || content.length === 0) return result;

    const shaped: ContentBlock[] = [];
    const notes = new Set<string>();

    for (const item of content) {
      if (item === null || typeof item !== "object" || item.type !== "text") {
        shaped.push(item);
        continue;
      }

      const text = typeof item.text === "string" ? item.text : "";
      const next = shapeOutput(text, entry.output);

      // The shaping note is collected rather than kept inline, so a result made
      // of several blocks states the same rule once instead of per block.
      const note = /\n?\[shaped: [^\]]*\]$/.exec(next);
      if (note === null) {
        shaped.push({ ...item, text: next });
        continue;
      }

      const withoutNote = next.slice(0, next.length - note[0].length).trimEnd();
      if (withoutNote.length === 0) {
        // The note IS the answer here: everything was removed, so it stands
        // alone rather than being lifted out and re-attached as a footer.
        shaped.push({ ...item, text: next.trim() });
        continue;
      }

      notes.add(note[0].trim());
      shaped.push({ ...item, text: withoutNote });
    }

    if (notes.size === 0) return { ...result, content: shaped };

    // Attach the note to the last text block, so the reduction is stated once at
    // the end of the answer rather than repeated beside every part of it.
    const lastText = shaped.map((item) => item.type === "text").lastIndexOf(true);
    if (lastText >= 0) {
      const target = shaped[lastText];
      shaped[lastText] = { ...target, text: `${target.text ?? ""}\n\n${[...notes].join("\n")}` };
    }

    return { ...result, content: shaped };
  });

  return true;
}

/**
 * A tool the caller asked for: a registered name, or one of its own with
 * arguments bound.
 */
type PickEntry =
  | string
  | {
      tool: string;
      as?: string;
      args?: Record<string, unknown>;
      defaults?: Record<string, unknown>;
      constrain?: Record<string, Record<string, unknown>>;
      output?: {
        sections?: string[];
        filter?: string;
        reject?: string;
        head?: number;
        tail?: number;
        maxChars?: number;
      };
      then?: Array<{
        tool: string;
        extract?: Record<string, string>;
        take?: number;
      }>;
      description?: string;
      argDescriptions?: Record<string, string>;
    };

/**
 * Compose an ad-hoc surface from the caller's own choices.
 *
 * Session-scoped and never written to disk: `pick` is the fast path for "these
 * tools, now", while `save` writes it down for later sessions. Unknown names
 * are reported rather than silently dropped, so a typo does not quietly produce
 * a smaller surface than the caller asked for.
 *
 * An entry may bind arguments, which is how a caller builds a tool it can call
 * without getting the call shape wrong: `{ tool: "read_source", as: "read_x",
 * args: { name: "x" } }` lists `read_x` with `name` gone from its schema.
 */
async function pickSurface(
  entries: PickEntry[],
  mutatingArgs: Record<string, string[]>,
): Promise<{ failure: string } | { profile: ModelProfile; unknown: string[] }> {
  const all = await listRegisteredTools();
  if (all.length === 0) return { failure: "The tool catalogue is unavailable in this build." };

  // Normalise once, so the rest of the function has a single shape to reason
  // about: a bare name is an entry with nothing bound.
  const wanted = entries
    .map((entry) =>
      typeof entry === "string"
        ? { tool: entry.trim() }
        : {
            tool: entry.tool.trim(),
            alias: entry.as?.trim(),
            args: entry.args,
            defaults: entry.defaults,
            constrain: entry.constrain,
            output: entry.output,
            then: entry.then,
            description: entry.description,
            argDescriptions: entry.argDescriptions,
          },
    )
    .filter((entry) => entry.tool.length > 0);

  if (wanted.length === 0) {
    return { failure: "`pick` needs at least one tool name. Call `surface` to see the catalogue." };
  }

  const available = new Set(all.map((tool) => tool.name));
  const unknown = [...new Set(wanted.map((entry) => entry.tool))].filter(
    (name) => !available.has(name),
  );
  const known = wanted.filter((entry) => available.has(entry.tool));
  if (known.length === 0) {
    return {
      failure:
        `None of those tools exist: ${unknown.join(", ")}. ` +
        "Call `surface` with no arguments to see the catalogue.",
    };
  }

  // Validate every entry before building anything, so one call reports all the
  // problems at once instead of one per round trip.
  const definitions = new Map(all.map((tool) => [tool.name, tool]));
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of known) {
    const alias = entry.alias || entry.tool;

    if (seen.has(alias)) {
      problems.push(`\`${alias}\` is defined twice; each name may appear once`);
      continue;
    }
    seen.add(alias);

    // Stealing a different tool's name would make that tool unreachable and the
    // listing dishonest about what it does. Redefining a tool under its own name
    // is the documented case, so only a collision with ANOTHER name is refused.
    if (alias !== entry.tool && available.has(alias)) {
      problems.push(
        `\`${alias}\` is already a registered tool, so it cannot be redefined to wrap \`${entry.tool}\`; ` +
          `name it something else, or omit \`as\` to redefine \`${entry.tool}\` itself`,
      );
      continue;
    }

    // A bound argument that is not a real argument binds nothing: the tool would
    // advertise the binding and then fail when called. Refuse it and say what
    // the tool actually takes.
    const properties = definitions.get(entry.tool)?.inputSchema?.properties;
    if (properties && typeof properties === "object") {
      const named = [
        ...Object.keys(entry.args ?? {}),
        ...Object.keys(entry.defaults ?? {}),
        ...Object.keys(entry.constrain ?? {}),
      ];
      const bogus = [...new Set(named)].filter((key) => !(key in properties));
      if (bogus.length > 0) {
        const real = Object.keys(properties);
        problems.push(
          `\`${entry.tool}\` has no argument ${bogus.map((key) => `\`${key}\``).join(", ")}; ` +
            (real.length > 0
              ? `it takes ${real.map((key) => `\`${key}\``).join(", ")}`
              : "it takes no arguments"),
        );
        continue;
      }
    }

    // A fixed argument always wins, so a default or a constraint for the same
    // argument would be inert. Say so rather than accepting a no-op.
    const fixed = new Set(Object.keys(entry.args ?? {}));
    const inert = [
      ...Object.keys(entry.defaults ?? {}),
      ...Object.keys(entry.constrain ?? {}),
    ].filter((key) => fixed.has(key));
    if (inert.length > 0) {
      problems.push(
        `${inert.map((key) => `\`${key}\``).join(", ")} on \`${entry.tool}\` is fixed and also ` +
          "given a default or a constraint; a fixed argument wins, so pick one",
      );
      continue;
    }

    // A constraint has to hold for the value that will ACTUALLY be used, not
    // only for what the caller sends. If the tool's own default falls outside
    // the narrowed range, the schema would advertise a limit it does not keep,
    // so the conflict is reported rather than left to surprise a call.
    const conflict: string[] = [];
    for (const [key, rule] of Object.entries(entry.constrain ?? {})) {
      const preset = entry.defaults?.[key];
      if (preset !== undefined) {
        const problem = checkConstraint(preset, rule);
        if (problem !== null) conflict.push(`your default for \`${key}\` ${problem}`);
        continue;
      }
      const baseDefault = (properties as Record<string, { default?: unknown }>)[key]?.default;
      if (baseDefault !== undefined) {
        const problem = checkConstraint(baseDefault, rule);
        if (problem !== null) {
          conflict.push(
            `\`${entry.tool}\` already defaults \`${key}\` to ${JSON.stringify(baseDefault)}, ` +
              `which ${problem} — set a \`defaults\` for it that fits, or loosen the constraint`,
          );
        }
      }
    }
    if (conflict.length > 0) {
      problems.push(...conflict);
      continue;
    }

    // A chain step that names nothing, cannot compile its pattern, or fills an
    // argument that does not exist would fail after the chain had already run
    // partway. Each is refused here with the reason, so nothing is half-executed
    // and nothing is silently dropped.
    for (const [stepIndex, step] of (entry.then ?? []).entries()) {
      const position = stepIndex + 2;

      // A step may name a tool this same pick defines, so resolve through it.
      const stepAlias = known
        .filter(
          (candidate): candidate is Extract<typeof candidate, { tool: string }> =>
            typeof candidate !== "string",
        )
        .find((candidate) => (candidate.alias ?? candidate.tool) === step.tool);

      const targetTool = stepAlias?.tool ?? step.tool;
      if (!available.has(targetTool)) {
        problems.push(
          `step ${position} calls \`${step.tool}\`, which is neither a registered tool nor one ` +
            "this surface defines",
        );
        continue;
      }

      // A step may call a defined tool, but not a chain: a fixed sequence is
      // something a model can read and debug, and nesting makes it a program.
      if (stepAlias?.then !== undefined && stepAlias.then.length > 0) {
        problems.push(
          `step ${position} calls \`${step.tool}\`, which is itself a chain; chains cannot nest, ` +
            "because a sequence you can read is the point",
        );
        continue;
      }

      // A step may not fill an argument that changes session state. The chain
      // would reconfigure the caller's own tooling as a side effect of a tool
      // call, and would change what the remaining steps resolve against, so a
      // fixed sequence would stop being deterministic. Refused rather than
      // dropped, because a model that asked for a step and silently did not get
      // one has been lied to.
      const mutating = mutatingArgs[targetTool] ?? [];
      const filled = [...Object.keys(step.extract ?? {}), ...Object.keys(stepAlias?.args ?? {})];
      const offender = filled.find((name) => mutating.includes(name));
      if (offender !== undefined) {
        problems.push(
          `step ${position} fills \`${offender}\` of \`${targetTool}\`, which changes session ` +
            "state; a chain must not reconfigure the surface it is running under. Read it instead, " +
            "or call it outside a chain",
        );
        continue;
      }

      const targetProperties = definitions.get(targetTool)?.inputSchema?.properties;
      const names = Object.keys(step.extract ?? {});
      if (
        targetProperties !== undefined &&
        targetProperties !== null &&
        typeof targetProperties === "object"
      ) {
        const bogus = names.filter((key) => !(key in targetProperties));
        if (bogus.length > 0) {
          const real = Object.keys(targetProperties);
          problems.push(
            `step ${position} extracts into ${bogus.map((key) => `\`${key}\``).join(", ")}, which ` +
              `\`${targetTool}\` does not take; ` +
              (real.length > 0
                ? `it takes ${real.map((key) => `\`${key}\``).join(", ")}`
                : "it takes no arguments"),
          );
          continue;
        }
      }

      const badPattern = Object.values(step.extract ?? {})
        .map((pattern) => compilePattern(pattern))
        .find((compiled) => "problem" in compiled);
      if (badPattern !== undefined && "problem" in badPattern) {
        problems.push(`step ${position}: ${badPattern.problem}`);
        continue;
      }
    }

    // A rule that cannot do what it says is worse than no rule: a pattern that
    // will not compile shapes nothing, and head with tail is ambiguous about
    // which end wins. Both are refused with the reason.
    const shaping = entry.output;
    if (shaping !== undefined) {
      if (shaping.head !== undefined && shaping.tail !== undefined) {
        problems.push(
          `\`${alias}\` sets both \`head\` and \`tail\`, which is ambiguous about which end of the ` +
            "answer to keep; set one",
        );
        continue;
      }

      const badPattern = [shaping.filter, shaping.reject]
        .filter((pattern): pattern is string => pattern !== undefined)
        .map((pattern) => compilePattern(pattern))
        .find((compiled) => "problem" in compiled);
      if (badPattern !== undefined && "problem" in badPattern) {
        problems.push(`\`${alias}\`: ${badPattern.problem}`);
        continue;
      }
    }
  }

  if (problems.length > 0) {
    return {
      failure: `That surface cannot be built:\n${problems.map((line) => `- ${line}`).join("\n")}`,
    };
  }

  const derived: ModelProfile["tools"]["derived"] = [];
  const names: string[] = [];
  for (const entry of known) {
    const alias = entry.alias || entry.tool;
    const definesSomething =
      alias !== entry.tool ||
      entry.args !== undefined ||
      entry.defaults !== undefined ||
      entry.constrain !== undefined ||
      entry.output !== undefined ||
      entry.then !== undefined ||
      entry.description !== undefined;
    if (definesSomething) {
      derived.push({
        as: alias,
        tool: entry.tool,
        args: entry.args ?? {},
        defaults: entry.defaults ?? {},
        constrain: entry.constrain ?? {},
        output: entry.output ?? {},
        then: (entry.then ?? []).map((step) => ({
          tool: step.tool,
          extract: step.extract ?? {},
          take: step.take ?? 1,
        })),
        ...(entry.description === undefined ? {} : { description: entry.description }),
        argDescriptions: entry.argDescriptions ?? {},
      });
    }
    names.push(alias);
  }

  const { manifest } = await loadSurfaces(PROFILE_ROOT);
  const profile = ModelProfileSchema.parse({
    id: manifest.pickedId,
    label: "Picked",
    description: `Composed for this session: ${names.length} tools.`,
    guidance:
      `You composed this surface yourself, from the catalogue, and it holds ${names.length} tools: ` +
      `${names.join(", ")}. It is session-scoped and nothing was written to disk.\n\n` +
      "Recompose it with `surface` and `pick` whenever the task changes shape — a surface is a working " +
      "set, not a commitment. If it turns out to be right, `save` writes it down so later " +
      "sessions start there.",
    tools: { include: names, order: names, exclude: [], descriptions: {}, derived },
    workflow: [],
  });

  return { profile, unknown };
}

async function applySurface(id: string): Promise<string | null> {
  if (id === "auto") {
    setSessionSurface(null);
    return null;
  }

  // Apply the override before the first await so a pipelined tools/list cannot
  // resolve ahead of it, then roll back if the id turns out to be unknown.
  const previous = getSessionSurface();
  setSessionSurface({ kind: "id", id });

  const { profiles } = await loadSurfaces(PROFILE_ROOT);
  if (!profiles.has(id)) {
    // Only roll back if nothing newer has taken over in the meantime.
    if (getSessionSurface()?.kind === "id") setSessionSurface(previous);
    return `Unknown surface "${id}". Available: ${[...profiles.keys()].sort().join(", ")}.`;
  }
  return null;
}

/** Enumerate the surfaces, marking the one governing this session. */
async function renderSurfaces(activeId: string): Promise<string> {
  const { profiles, invalid } = await loadSurfaces(PROFILE_ROOT, { fresh: true });
  const shipped = await shippedIds(PROFILE_ROOT);

  const rows = [...profiles.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((profile) => {
      const origin = shipped.has(profile.id) ? "shipped" : "model-authored";
      const mark = profile.id === activeId ? " (active)" : "";
      const scope =
        profile.tools.include && profile.tools.include.length > 0
          ? `${profile.tools.include.length} tools`
          : "every tool";
      return `- **${profile.id}**${mark} [${origin}] — ${profile.description}\n  Carries: ${scope}`;
    });

  const problems = invalid.length
    ? `\n\nUnusable profile files:\n${invalid.map((entry) => `- ${entry.file}: ${entry.reason}`).join("\n")}`
    : "";

  const wiring = [
    PROFILES_WIRED
      ? "Tool listing is profile-aware."
      : "Tool listing is NOT profile-aware in this build, so every surface presents the full catalogue.",
    CALLS_WIRED
      ? "Defined tools resolve when called."
      : "Defined tools are NOT resolved when called in this build, so a bound argument would not be applied.",
  ].join(" ");

  return (
    `# Surfaces (${profiles.size})\n\n${rows.join("\n")}${problems}\n\n${wiring}\n\n` +
    "Compose your own with `surface` and `pick`, or recall one you saved with `set`."
  );
}

/**
 * A tool's arguments, written short enough to sit beside its name.
 *
 * The catalogue used to list names and descriptions only, which meant writing
 * `args`, `constrain` or a chain's `extract` was guesswork until a refusal
 * taught you the argument names. A model building its own tooling needs to see
 * what it is building against, so the shape is published where the tool is.
 */
function summariseArgs(schema: Record<string, unknown> | undefined): string {
  const properties = schema?.properties;
  if (properties === undefined || properties === null || typeof properties !== "object") return "";

  const required = new Set(
    Array.isArray(schema?.required)
      ? (schema.required as unknown[]).filter((key): key is string => typeof key === "string")
      : [],
  );

  const parts = Object.entries(properties as Record<string, Record<string, unknown>>).map(
    ([name, definition]) => {
      const type = typeof definition?.type === "string" ? definition.type : "any";
      const optional = required.has(name) ? "" : "?";
      const preset = definition?.default;
      const shown = preset === undefined ? "" : `=${JSON.stringify(preset)}`;
      return `${name}${optional}: ${type}${shown}`;
    },
  );

  return parts.length === 0 ? " (no arguments)" : ` (${parts.join(", ")})`;
}

/** One argument explained, for the detail view. */
function describeArgument(
  name: string,
  definition: Record<string, unknown>,
  required: boolean,
): string {
  const type = typeof definition?.type === "string" ? definition.type : "any";
  const bits = [type, required ? "required" : "optional"];

  const preset = definition?.default;
  if (preset !== undefined) bits.push(`default ${JSON.stringify(preset)}`);
  if (Array.isArray(definition?.enum)) {
    bits.push(`one of ${(definition.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`);
  }
  if (typeof definition?.minimum === "number") bits.push(`min ${definition.minimum}`);
  if (typeof definition?.maximum === "number") bits.push(`max ${definition.maximum}`);
  if (typeof definition?.minLength === "number") bits.push(`minLength ${definition.minLength}`);
  if (typeof definition?.maxLength === "number") bits.push(`maxLength ${definition.maxLength}`);

  const text = typeof definition?.description === "string" ? ` — ${definition.description}` : "";
  return `- \`${name}\` (${bits.join(", ")})${text}`;
}

/**
 * Everything known about one tool, so a model can build against it without
 * discovering its shape by being refused.
 */
async function renderToolDetail(name: string): Promise<string> {
  const all = await listRegisteredTools();
  const tool = all.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    const names = all.map((candidate) => candidate.name).join(", ");
    return `No tool named \`${name}\`. Registered: ${names}`;
  }

  const schema = tool.inputSchema;
  const properties = schema?.properties;
  const required = new Set(
    Array.isArray(schema?.required)
      ? (schema.required as unknown[]).filter((key): key is string => typeof key === "string")
      : [],
  );

  const lines = [`# ${name}`, "", tool.description ?? "(no description)", ""];

  if (properties === undefined || properties === null || typeof properties !== "object") {
    lines.push("## Arguments", "", "This tool takes no arguments.");
  } else {
    const entries = Object.entries(properties as Record<string, Record<string, unknown>>);
    lines.push(
      "## Arguments",
      "",
      entries.length === 0
        ? "This tool takes no arguments."
        : entries
            .map(([key, definition]) => describeArgument(key, definition, required.has(key)))
            .join("\n"),
    );
  }

  // A worked example beats a schema: it shows how this tool is carried, not just
  // what it accepts.
  const first = Object.keys((properties ?? {}) as Record<string, unknown>)[0];
  lines.push(
    "",
    "## Carrying it",
    "",
    "```",
    first === undefined
      ? `surface { pick: [{ tool: "${name}", as: "mine" }] }`
      : `surface { pick: [{ tool: "${name}", as: "mine", args: { ${first}: ... } }] }`,
    "```",
    "",
    "Omit `as` to redefine the tool under its own name. Add `defaults`, `constrain`,",
    "`output` or `then` to shape how it is called, what it returns, or what runs after it.",
  );

  return lines.join("\n");
}

/** Every registered tool, marking what the active surface carries. */
async function renderCatalogue(
  profile: ModelProfile,
  core: readonly string[],
  mutatingArgs: Record<string, string[]>,
): Promise<string> {
  const all = await listRegisteredTools();
  if (all.length === 0) return "The tool catalogue is unavailable in this build.";

  const carried = new Set(shapeTools(all, profile, core, mutatingArgs).map((tool) => tool.name));
  const render = (tools: ToolListResult["tools"]) =>
    tools
      .map(
        (tool) =>
          `- \`${tool.name}\`${summariseArgs(tool.inputSchema)}` +
          `${tool.description ? ` — ${tool.description}` : ""}`,
      )
      .join("\n");

  const inside = all.filter((tool) => carried.has(tool.name));
  const outside = all.filter((tool) => !carried.has(tool.name));

  const rest = outside.length
    ? `\n\n## Not carried by \`${profile.id}\` (${outside.length})\n` +
      "Registered and callable by name; the surface simply does not present them.\n\n" +
      render(outside)
    : "";

  return (
    `# Tool catalogue (${all.length} registered)\n\n` +
    `\`${profile.id}\` carries ${inside.length} of them.\n\n` +
    `## Carried by \`${profile.id}\` (${inside.length})\n${render(inside)}${rest}\n\n` +
    "Build your working set from these with `surface` and `pick`, then keep it with `save`." +
    '\n\n`surface` with `detail: "<tool>"` explains one tool in full — every argument, what it accepts, and how to carry it.'
  );
}

/** Report the governing surface: why, its guidance, and what it carries. */
async function renderSurface(
  profile: ModelProfile,
  source: string,
  matched: string | null,
  clientName: string | null,
  core: readonly string[],
  mutatingArgs: Record<string, string[]>,
): Promise<string> {
  const why = matched
    ? `selected by \`${source}\` matching \`${matched}\``
    : "no signal matched, so the seed surface applies";

  const steps = profile.workflow.length
    ? `\n\n## Recommended workflow\n${profile.workflow.map((step, i) => `${i + 1}. ${step}`).join("\n")}`
    : "";

  const all = await listRegisteredTools();
  const carried = shapeTools(all, profile, core, mutatingArgs).map((tool) => tool.name);
  const carriedSet = new Set(carried);
  const rest = all.filter((tool) => !carriedSet.has(tool.name));

  // Carried tools are already in the caller's own tool list, so their schemas
  // are in hand and repeating them here would be noise.
  const carries = carried.length
    ? `\n\n## Carried (${carried.length})\n${carried.map((name) => `\`${name}\``).join(", ")}`
    : "";

  // The delta is the decision input, so it carries the arguments too. A model
  // deciding what to pick needs to know what each tool takes, and a list of bare
  // names forces a second call to find out.
  const missing = rest.length
    ? `\n\n## Not carried (${rest.length})\n` +
      rest
        .map(
          (tool) =>
            `- \`${tool.name}\`${summariseArgs(tool.inputSchema)}` +
            `${tool.description ? ` — ${tool.description}` : ""}`,
        )
        .join("\n") +
      "\n\nAll of these work if you call them by name. To carry them, `pick` the set you want; " +
      '`surface` with `detail: "<tool>"` explains one in full.'
    : "";

  return (
    `# Surface: ${profile.label} (\`${profile.id}\`)\n\n` +
    `${profile.description}\n\n` +
    `Selected because ${why}. Client reported: \`${clientName ?? "unknown"}\`.\n\n` +
    `## Guidance\n${profile.guidance}${steps}${carries}${missing}\n\n` +
    "A surface shapes which tools are listed, never which are callable: any tool works by name. " +
    "Use `surface` with `list` to enumerate, `pick` to compose your own set, or `set` to switch."
  );
}

/**
 * Persist the surface the caller built, so a later session can start there.
 *
 * There is no shipped catalogue of surfaces to choose from: the model composes
 * its own with `pick` and this writes that down. The tools come from what was
 * composed, not from a parameter, because a surface is something built and then
 * remembered — not a form to fill in.
 */
async function saveSurface(
  id: string,
  guidance: string | undefined,
  current: ModelProfile,
  core: readonly string[],
  mutatingArgs: Record<string, string[]>,
): Promise<{ failure: string } | { profile: ModelProfile; replaced: boolean }> {
  const { profiles } = await loadSurfaces(PROFILE_ROOT, { fresh: true });
  const replaced = profiles.has(id);

  const tools = shapeTools(await listRegisteredTools(), current, core, mutatingArgs)
    .map((tool) => tool.name)
    .filter((name) => name !== "");

  const parsed = ModelProfileSchema.safeParse({
    id,
    label: id,
    description: `Saved by the model: ${tools.length} tools.`,
    match: { clientNames: [], models: [] },
    tools: {
      include: tools,
      order: tools,
      exclude: [],
      descriptions: current.tools.descriptions,
      // A derived tool is part of what the caller built, so it is part of what
      // is written down: recalling the surface must restore the call shapes too.
      derived: current.tools.derived.filter((entry) => tools.includes(entry.as)),
    },
    guidance:
      guidance ??
      `You saved this surface yourself and it holds ${tools.length} tools: ${tools.join(", ")}.\n\n` +
        "It is yours to change. Recompose with `pick` and save again under the same id whenever " +
        "the task changes shape; nothing here was chosen for you.",
    workflow: current.workflow,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { failure: `${issue?.path.join(".") || "profile"}: ${issue?.message}` };
  }

  try {
    await saveProfile(PROFILE_ROOT, parsed.data);
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
  return { profile: parsed.data, replaced };
}

server.tool(
  "surface",
  "Your tooling, and the only tool that manages it. No arguments reports where you are and lists every tool that exists. `pick` builds your own surface from that list, `save` writes it down for later sessions, `set` recalls one, `list` enumerates.",
  {
    list: z
      .enum(["tools", "surfaces"])
      .optional()
      .describe(
        "Every registered tool with its arguments and description, or the surfaces you have saved",
      ),
    detail: z
      .string()
      .optional()
      .describe(
        "Explain one tool in full: every argument, what it accepts, and how to carry it. Use this before writing `args`, `constrain` or a chain's `extract`, instead of discovering the shape by being refused.",
      ),
    pick: z
      .array(
        z.union([
          z.string(),
          z.object({
            tool: z.string().min(1).describe("The registered tool to carry"),
            as: z
              .string()
              .min(1)
              .optional()
              .describe(
                "Name it this instead, to keep the base tool available as well. Defaults to the tool's own name, which redefines it for you.",
              ),
            args: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                "Arguments fixed for you. They leave the schema, so you cannot get them wrong when you call, and they win over anything you send.",
              ),
            defaults: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                "Values used when you omit an argument. Unlike `args`, the argument stays visible and you can still override it.",
              ),
            constrain: z
              .record(z.string(), z.record(z.string(), z.unknown()))
              .optional()
              .describe(
                "Narrow what an argument may be: enum, minimum, maximum, minLength, maxLength, pattern. Written into the schema and enforced on the call.",
              ),
            output: z
              .object({
                sections: z.array(z.string().min(1)).optional(),
                filter: z.string().optional(),
                reject: z.string().optional(),
                head: z.number().int().positive().optional(),
                tail: z.number().int().positive().optional(),
                maxChars: z.number().int().min(50).optional(),
              })
              .optional()
              .describe(
                "Keep only part of the answer: named markdown sections, lines matching (or not matching) a pattern, the first or last N lines, or a character cap. The result always says how much was kept, so a shaped answer never reads as the whole truth.",
              ),
            then: z
              .array(
                z.object({
                  tool: z
                    .string()
                    .min(1)
                    .describe("The tool to run on what the previous step produced"),
                  extract: z
                    .record(z.string(), z.string())
                    .optional()
                    .describe(
                      "Values to pull out of the previous answer, keyed by the argument they fill. Use a capture group to target part of a line. Extraction runs on the raw answer, never on shaped text.",
                    ),
                  take: z
                    .number()
                    .int()
                    .min(1)
                    .max(3)
                    .optional()
                    .describe(
                      "How many matches to run this step for. Two or more fans out, one call per match — this is how 'read the top three' is expressed.",
                    ),
                }),
              )
              .max(3)
              .optional()
              .describe(
                "Steps to run after this tool, feeding each step the previous answer. Fixed sequence, no branching: a model can debug a sequence it can read, and cannot debug a program it did not write.",
              ),
            description: z.string().min(1).optional().describe("Wording to use for it"),
            argDescriptions: z
              .record(z.string(), z.string().min(1))
              .optional()
              .describe("Wording for the arguments that remain, if you want them said differently"),
          }),
        ]),
      )
      .optional()
      .describe(
        "Build your own surface, for this session. A bare name carries that tool; an object carries it with arguments already set, which is how you define a tool whose call shape you cannot get wrong. This is the path: no working set is chosen for you, here or anywhere else.",
      ),
    save: z
      .string()
      .regex(PROFILE_ID_PATTERN, PROFILE_ID_MESSAGE)
      .optional()
      .describe(
        "Persist the surface you composed under this id, so later sessions can start there. Must match the id pattern.",
      ),
    guidance: z
      .string()
      .optional()
      .describe("What you want to be told each time this saved surface loads"),
    set: z
      .string()
      .optional()
      .describe("Take a surface you saved earlier, or 'auto' to clear the override"),
  },
  async ({ list, detail, pick, save, guidance, set }, extra) => {
    const meta = extra?._meta;
    const clientName = server.server.getClientVersion()?.name ?? null;
    const notes: string[] = [];

    // Apply any change before resolving, so the report describes the surface the
    // caller now has rather than the one they just left.
    if (pick !== undefined) {
      // The mutating-argument rule is manifest data, not session state, so it is
      // read directly: the resolution below describes the surface AFTER this
      // change, and would not be available yet.
      const { manifest } = await loadSurfaces(PROFILE_ROOT);
      const outcome = await pickSurface(pick, manifest.mutatingArgs);
      if ("failure" in outcome) return err(outcome.failure);
      setSessionSurface({ kind: "picked", profile: outcome.profile });
      if (outcome.unknown.length) {
        notes.push(`Ignored unknown tool names: ${outcome.unknown.join(", ")}.`);
      }
    } else if (set !== undefined) {
      const failure = await applySurface(set);
      if (failure !== null) return err(failure);
    }

    const session = getSessionSurface();
    const resolved = await resolveProfile(PROFILE_ROOT, { meta, clientName, session });
    const { profile, core } = resolved;

    if (save !== undefined) {
      const outcome = await saveSurface(save, guidance, profile, core, resolved.mutatingArgs);
      if ("failure" in outcome) return err(outcome.failure);
      notes.push(
        outcome.replaced
          ? `Replaced the saved surface \`${save}\` with what you are carrying now.`
          : `Saved as \`${save}\`. Recall it in a later session with \`surface\` and \`set: "${save}"\`.`,
      );
    }

    if (detail !== undefined) return ok(await renderToolDetail(detail));
    if (list === "surfaces") return ok(await renderSurfaces(profile.id));
    if (list === "tools") return ok(await renderCatalogue(profile, core, resolved.mutatingArgs));

    const report = await renderSurface(
      profile,
      resolved.source,
      resolved.matched,
      clientName,
      core,
      resolved.mutatingArgs,
    );
    return ok(notes.length ? `${notes.join("\n")}\n\n${report}` : report);
  },
);

const PROFILES_WIRED = installProfileAwareToolList(server);
const CALLS_WIRED = installProfileAwareCall(server);

// ============================================================
// MAIN
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
