import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdir, readFile, stat } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createReadStream, readFileSync, readdirSync } from "fs";
import { createHarness, harnessDir, type Capability } from "./harness.js";

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

/** Env-var prefix and default namespace name: `<ENV_PREFIX>_HARNESS_DIR`. */
const ENV_PREFIX = "GAMEHACKING";
const PROJECT = "gamehacking";
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

/**
 * Search one source archive, returning line-numbered matches.
 *
 * Scanned in 1 MB chunks with a TEST-FIRST rule: a chunk that does not match is
 * never split into lines, so a file that does not contain the pattern costs one
 * regex test and a newline count. Measured over 120 archives of a rare pattern,
 * that is 2.6x faster than the line-by-line reader it replaces (25ms vs 65ms per
 * file), which matters because a full scan is 17.8 GB.
 *
 * Line numbers stay correct across chunks, and a match straddling a chunk
 * boundary is handled by carrying the tail.
 */
async function grepFile(
  filePath: string,
  pattern: RegExp,
  maxMatches: number,
): Promise<{ line: number; text: string }[]> {
  return new Promise((resolve) => {
    const matches: { line: number; text: string }[] = [];
    let lineNum = 0;
    let tail = "";
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolve(matches);
    };

    try {
      const stream = createReadStream(filePath, { encoding: "utf-8", highWaterMark: 1024 * 1024 });

      stream.on("data", (chunk) => {
        if (done) return;
        // The stream is created with `encoding: "utf-8"`, so a chunk is a string
        // at runtime — Node decodes multi-byte sequences across boundaries
        // safely. Narrowing rather than casting keeps that guarantee explicit.
        const text = tail + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));

        if (!pattern.test(text)) {
          // No match anywhere in this chunk: count the newlines for the line
          // numbers and move on, without splitting anything.
          lineNum += (text.match(/\n/g) ?? []).length;
          tail = "";
          return;
        }

        const lines = text.split("\n");
        tail = lines.pop() ?? "";
        for (const line of lines) {
          lineNum++;
          if (pattern.test(line)) {
            matches.push({ line: lineNum, text: line.trimEnd().slice(0, 200) });
            if (matches.length >= maxMatches) {
              stream.destroy();
              finish();
              return;
            }
          }
        }
      });

      stream.on("end", () => {
        if (tail.length > 0) {
          lineNum++;
          if (pattern.test(tail)) {
            matches.push({ line: lineNum, text: tail.trimEnd().slice(0, 200) });
          }
        }
        finish();
      });
      stream.on("error", finish);
    } catch {
      finish();
    }
  });
}

/** What a scan of the source archives found, and how much of them it covered. */
type ScanResult = {
  matches: Array<{ skill: string; hits: { line: number; text: string }[] }>;
  searched: number;
  /** Archives that matched the scan's scope, counted UP FRONT. */
  inScope: number;
  /** True when the scan stopped early — by budget or by finding enough. */
  partial: boolean;
  seconds: number;
};

/**
 * Scan the source archives for a pattern.
 *
 * ONE implementation, because the same defect appeared in three capabilities:
 * a full pass is 17.8 GB and takes over a minute, which outlasts a host's request
 * timeout, so a scan without a budget returns NOTHING and the caller cannot even
 * tell whether the pattern exists. Every scan is bounded and reports its coverage.
 */
async function scanArchives(
  pattern: RegExp,
  options: {
    /** Only archives whose name contains this. */
    nameFilter?: string;
    /** Stop after this many archives matched. */
    maxMatches?: number;
    /** Matches kept per archive. */
    perFile?: number;
    /** How long to scan before returning what it has. */
    budgetMs: number;
  },
): Promise<ScanResult> {
  const idx = await getIndex();
  const started = Date.now();

  // Counted up front, so the report can say how much of the CORPUS was covered.
  // Counting as the loop goes would report the count reached, understating a
  // large corpus and reading as if the scan were nearly complete.
  const inScopeNames: string[] = [];
  for (const [name, skill] of idx) {
    if (!skill.hasSource) continue;
    if (options.nameFilter && !name.toLowerCase().includes(options.nameFilter.toLowerCase())) {
      continue;
    }
    inScopeNames.push(name);
  }

  const matches: ScanResult["matches"] = [];
  let searched = 0;
  let stopped = false;

  for (const name of inScopeNames) {
    if (Date.now() - started > options.budgetMs) {
      stopped = true;
      break;
    }
    const filePath = join(DIRS.skills, name, "source.txt");
    const hits = await grepFile(filePath, pattern, options.perFile ?? 3);
    searched++;
    if (hits.length > 0) {
      matches.push({ skill: name, hits });
      if (options.maxMatches !== undefined && matches.length >= options.maxMatches) {
        stopped = true;
        break;
      }
    }
  }

  return {
    matches,
    searched,
    inScope: inScopeNames.length,
    partial: stopped && searched < inScopeNames.length,
    seconds: (Date.now() - started) / 1000,
  };
}

/** The sentence a partial scan must carry, so a partial answer is never read as whole. */
function coverageNote(
  result: ScanResult,
  nameFilter: string | undefined,
  budgetMs: number,
): string {
  if (!result.partial) return "";
  const scope = nameFilter ? ` matching \`${nameFilter}\`` : "";
  return (
    `**Partial:** searched ${result.searched} of ${result.inScope}${scope} archives ` +
    `(${result.seconds.toFixed(1)}s, budget ${budgetMs}ms). Raise \`budget_ms\`, or narrow with ` +
    `\`filter\` to be sure of full coverage — a pattern absent from these results may still exist in the rest.`
  );
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
    // The tool list is not fixed: a caller composes its own surface at runtime,
    // and a host has to re-list for that surface to be reachable. The SDK already
    // declares this, but it is stated here anyway: it is a load-bearing contract
    // for this server, not an incidental default, and a host that ignores the
    // announcement leaves a composed surface unreachable.
    capabilities: { tools: { listChanged: true } },
    instructions:
      "Knowledge base for game hacking and reverse engineering: 4,160 skills, 75 agents, 161 subagents, 114 plugins and 148 prompts, including full source archives for roughly 3,980 projects.\n\n" +
      "There is ONE tool: `run`. It runs code in a namespace that persists across calls and across restarts, and everything this server can do is reached from inside it as a function — the capabilities are not advertised as tools, because no fixed menu suits every model or every target.\n\n" +
      'Call `run` with empty code for the manual: the vocabulary, how to open a document, and every capability this server offers. Then write code — `await search_skills({ query: "EPT hook" })` — and define helpers, which are still there next call.\n\n' +
      "SECURITY: `run` executes code with this server's authority. That is what it is, not a mode it can be put into, so there is no code-free alternative and no enable/disable switch. Run this server sandboxed — a container or a VM — as you would a shell.",
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
// CAPABILITIES
// ============================================================

/**
 * Every capability the server can perform, captured rather than registered.
 *
 * These are not advertised as tools. They are reachable from code inside the one
 * tool that is (`run`), which is the design: a fixed catalog of typed verbs is
 * the wrong interface for a knowledge base whose callers and targets all differ.
 * The functions below stay exactly as they were — only their registration moved.
 */
const capabilities: Capability[] = [];

/**
 * Register a capability for the code harness instead of advertising it as a tool.
 *
 * A thin shim over the tool decorator: the existing capability functions are
 * untouched, and adding one still means writing one function. Arguments are
 * validated against the capability's own schema before the handler sees them, so
 * a call from code gets the same defaults and the same readable errors an MCP
 * call would — a model that passes a number where a string belongs is told so,
 * rather than failing somewhere inside.
 */
function capability<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  const shape = z.object(schema);
  capabilities.push({
    name,
    description,
    schema,
    prepare(args) {
      const parsed = shape.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
          .join("; ");
        throw new Error(`${name}: ${issues}`);
      }
      return parsed.data;
    },
    // The schema validates the arguments before the handler runs, so the
    // handler's narrower parameter type is satisfied by construction. The cast
    // states that boundary rather than widening every capability's own type.
    handler: handler as unknown as (args: Record<string, unknown>) => Promise<unknown>,
  });
}

/**
 * Open a document by name for the harness's `open()`.
 *
 * A skill is named directly; a component is named `kind/name` (`agent/x`,
 * `plugin/y`), because those share a namespace with skills otherwise.
 */
async function openDocumentForHarness(
  name: string,
): Promise<{ text: string; path: string | null; source: string | null } | null> {
  const slash = name.indexOf("/");
  if (slash > 0) {
    const kind = name.slice(0, slash).toLowerCase();
    const rest = name.slice(slash + 1);
    const dir = (DIRS as Record<string, string | undefined>)[`${kind}s`];
    if (dir) {
      const parsed = await readMdByName(dir, rest);
      if (parsed) return { text: parsed.body, path: join(dir, `${rest}.md`), source: null };
    }
    return null;
  }

  const skill = await readSkill(name);
  if (skill) {
    // A project's source dump sits beside its SKILL.md and is usually the thing
    // worth working on, so the path travels with the document.
    const source = join(DIRS.skills, name, "source.txt");
    return {
      text: skill.body,
      path: join(DIRS.skills, name, "SKILL.md"),
      source: (await fileExists(source)) ? source : null,
    };
  }

  // Fall back to the component directories, so a bare name still resolves.
  for (const dir of [DIRS.agents, DIRS.subagents, DIRS.plugins, DIRS.prompts]) {
    const parsed = await readMdByName(dir, name);
    if (parsed) return { text: parsed.body, path: join(dir, `${name}.md`), source: null };
  }
  return null;
}

/** The names this project offers, for the harness manual. */
function offersForHarnessSync(): string[] {
  const names: string[] = [];
  try {
    for (const dir of [DIRS.skills, DIRS.agents, DIRS.subagents, DIRS.plugins, DIRS.prompts]) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/, "");
        names.push(name);
      }
    }
  } catch {
    // A missing data directory is a deployment fact, not a reason to fail the
    // manual: the capability list is still correct.
  }
  return names.sort();
}

// ============================================================
// WORKFLOW TOOLS
// ============================================================

capability(
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

capability(
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

capability(
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

capability(
  "grep_sources",
  "Full-text search across the source archives (17.8 GB). Streams through source.txt files matching a regex pattern — use it for offsets, function names, patterns, struct definitions. A full scan takes over a minute, so it returns partial results with a note after `budget_ms`; narrow with `filter` to be sure of full coverage.",
  {
    pattern: z
      .string()
      .describe("Regex pattern, e.g. '0x140001000', 'NTSTATUS.*Create', 'BoneMatrix'"),
    case_sensitive: z.boolean().default(false).describe("Case-sensitive matching"),
    max_files: z
      .number()
      .min(1)
      .max(200)
      .default(20)
      .describe("Stop after this many projects match"),
    max_matches_per_file: z.number().min(1).max(50).default(5).describe("Max matches per file"),
    filter: z
      .string()
      .optional()
      .describe("Only search projects whose name contains this — makes a complete scan fast"),
    budget_ms: z
      .number()
      .min(500)
      .max(120_000)
      .default(20_000)
      .describe(
        "How long to scan before returning what it has. A full scan is ~70s over 17.8 GB, which outlasts a host's request timeout — so this returns partial results with a note instead of timing out with nothing.",
      ),
  },
  async ({ pattern, case_sensitive, max_files, max_matches_per_file, filter, budget_ms }) => {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, case_sensitive ? "" : "i");
    } catch (e) {
      return err(`Invalid regex: ${e}`);
    }

    const result = await scanArchives(regex, {
      nameFilter: filter,
      maxMatches: max_files,
      perFile: max_matches_per_file,
      budgetMs: budget_ms,
    });
    const note = coverageNote(result, filter, budget_ms);

    if (!result.matches.length) {
      return err(
        `No matches for "${pattern}" in ${result.searched} of ${result.inScope} archives.` +
          (note ? `\n\n${note}` : ""),
      );
    }

    let output = `# Grep: \`${pattern}\`\n\nFound in ${result.matches.length} projects (searched ${result.searched} of ${result.inScope}):\n\n${note}\n\n`;
    for (const { skill, hits } of result.matches) {
      output += `## ${skill}\n`;
      for (const m of hits) {
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

capability(
  "find_offset",
  "Cross-reference a game offset, pattern, or struct name across all archived source code. Finds every project that uses a specific offset value or field name.",
  {
    query: z
      .string()
      .describe("Offset hex value (0x4F0), field name (BoneMatrix), or pattern (CompSpaceBones)"),
    max_results: z.number().min(1).max(50).default(15),
    filter: z
      .string()
      .optional()
      .describe("Only search projects whose name contains this — makes a complete scan fast"),
    budget_ms: z
      .number()
      .min(500)
      .max(120_000)
      .default(20_000)
      .describe("How long to scan before returning what it has, with a note saying so"),
  },
  async ({ query, max_results, filter, budget_ms }) => {
    let regex: RegExp;
    try {
      regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch {
      regex = new RegExp(query, "i");
    }

    const result = await scanArchives(regex, {
      nameFilter: filter,
      maxMatches: max_results,
      perFile: 3,
      budgetMs: budget_ms,
    });
    const note = coverageNote(result, filter, budget_ms);

    if (!result.matches.length) {
      return err(
        `No projects reference "${query}" in ${result.searched} of ${result.inScope} archives.` +
          (note ? `\n\n${note}` : ""),
      );
    }

    let output = `# Offset Cross-Reference: \`${query}\`\n\nFound in ${result.matches.length} projects (searched ${result.searched} of ${result.inScope}):\n\n${note}\n\n`;
    for (const { skill, hits } of result.matches) {
      output += `### ${skill}\n`;
      for (const m of hits) {
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

capability(
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

capability(
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

capability(
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

capability(
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

capability(
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

capability(
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

capability(
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
    filter: z
      .string()
      .optional()
      .describe("Only search projects whose name contains this — makes a complete scan fast"),
    budget_ms: z
      .number()
      .min(500)
      .max(120_000)
      .default(20_000)
      .describe("How long to scan before returning what it has, with a note saying so"),
  },
  async ({ function_name, max_results, filter, budget_ms }) => {
    const escaped = function_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|\\s|\\*|>)${escaped}\\s*\\(`, "i");

    const result = await scanArchives(regex, {
      nameFilter: filter,
      maxMatches: max_results,
      perFile: 3,
      budgetMs: budget_ms,
    });
    const note = coverageNote(result, filter, budget_ms);

    if (!result.matches.length) {
      return err(
        `No definitions found for "${function_name}" in ${result.searched} of ${result.inScope} archives.` +
          (note ? `\n\n${note}` : ""),
      );
    }

    let output = `# Function: ${function_name}\n\nFound in ${result.matches.length} projects (searched ${result.searched} of ${result.inScope}):\n\n${note}\n\n`;
    for (const { skill, hits } of result.matches) {
      output += `### ${skill}\n`;
      for (const m of hits) {
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

capability(
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

capability(
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

capability(
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

capability(
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

capability(
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

capability(
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

capability("skill_stats", "Library statistics from the in-memory index.", {}, async () => {
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
  capability(
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

  capability(
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
// THE TOOL
// ============================================================

const harness = createHarness(capabilities, {
  dir: harnessDir(ENV_PREFIX, PROJECT),
  open: async (name) => {
    const found = await openDocumentForHarness(name);
    return found;
  },
  offers: () => offersForHarnessSync(),
});

server.tool(
  "run",
  "Run code against this server's API in a persistent namespace — this is the only tool, and the whole interface.\n\n" +
    'Write code, not tool calls: `await search_skills({ query: "ept hook" })`, then build on what you find. ' +
    "Definitions you write persist across calls and across restarts; work does not.\n\n" +
    "Call with empty code for the manual: the vocabulary, how to open a document, and every capability this " +
    "server offers. `describe(x)` shows one function's arguments or an object's members.\n\n" +
    "SECURITY: this executes code with the server's authority. That is what it is, not a mode it can be put " +
    "into — there is no code-free alternative here, and no enable/disable switch. Run the server sandboxed " +
    "(container or VM), as you would a shell.",
  {
    code: z
      .string()
      .default("")
      .describe("Code to run. Empty returns the manual. A trailing expression is returned."),
    session_id: z
      .string()
      .default("")
      .describe("Working-object scope. Omit for the default session."),
    strings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Named strings available as S, so long or literal text (payloads, code, blobs) is passed as data instead of being escaped inside code.",
      ),
  },
  async ({
    code,
    session_id,
    strings,
  }: {
    code: string;
    session_id: string;
    strings?: Record<string, unknown>;
  }) => {
    try {
      return ok(await harness.run(code, session_id, strings ?? {}));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  },
);

// ============================================================
// MAIN
// ============================================================

async function main() {
  // Rebuild the model's tools before serving a single request. A definition it
  // saved last session is part of its toolkit, not scratch state.
  const broken = harness.load();
  if (broken.length > 0) {
    // Named, not swallowed: a saved definition that no longer loads is the
    // model's problem to fix, and it cannot fix what it cannot see. Loading
    // continues either way, so one bad file never stops the server booting.
    process.stderr.write(
      `harness: ${broken.length} saved definition(s) failed to load:\n${broken
        .map((entry) => `  ${entry}`)
        .join("\n")}\n`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
