import { beforeAll, describe, expect, it } from "rstack/test";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER = join(ROOT, "dist", "index.js");
const SKILLS = join(ROOT, "skills");

/** Every tool the server must expose. */
const EXPECTED_TOOLS = [
  "analyze_project",
  "compare_projects",
  "export_offsets",
  "extract_offsets",
  "find_function",
  "find_offset",
  "find_similar",
  "get_agent_briefing",
  "get_file_tree",
  "grep_sources",
  "list_agents",
  "list_plugins",
  "list_prompts",
  "list_skills",
  "list_subagents",
  "read_agent",
  "read_plugin",
  "read_prompt",
  "read_skill",
  "read_source",
  "read_subagent",
  "research_technique",
  "search_by_engine",
  "search_by_game",
  "search_skills",
  "skill_changelog",
  "skill_stats",
];

// Response shapes, validated at the boundary rather than asserted.
const InitializeResult = z.object({
  serverInfo: z.object({ name: z.string(), version: z.string() }),
});

const ToolsListResult = z.object({
  tools: z.array(z.object({ name: z.string() })),
});

const CallToolResult = z.object({
  content: z.array(z.object({ text: z.string() })).nonempty(),
});

const PackageJson = z.object({ version: z.string() });

/** A parsed JSON-RPC frame; `result` stays unvalidated until a use site parses it. */
const Frame = z.object({ id: z.number(), result: z.unknown() });

/** Text payload of a tools/call result. */
function textOf(frame: z.infer<typeof Frame> | undefined): string {
  if (!frame) return "";
  const parsed = CallToolResult.safeParse(frame.result);
  return parsed.success ? parsed.data.content[0].text : "";
}

/** Read the version this repository declares. */
function packageVersion(): string {
  return PackageJson.parse(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))).version;
}

function toolCall(id: number, name: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

const HANDSHAKE = [
  {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rstest", version: "1" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

/**
 * Drive the built server over stdio JSON-RPC and collect responses by id.
 * Spawning the real artifact is deliberate: it exercises module resolution and
 * `import.meta.dirname`, which an in-process import would not.
 */
function callServer(
  requests: object[],
  timeoutMs = 120_000,
): Promise<Map<number, z.infer<typeof Frame>>> {
  const {
    promise,
    resolve: settle,
    reject,
  } = Promise.withResolvers<Map<number, z.infer<typeof Frame>>>();

  // `signal` kills a wedged child so a hung server fails the test instead of
  // stalling the run. This is a process guard, not a pacing delay.
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(timeoutMs),
  });

  const responses = new Map<number, z.infer<typeof Frame>>();
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

  child.on("error", (error) => reject(error));
  child.on("close", () => {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(trimmed);
      } catch {
        continue; // Not JSON; the server also logs plain lines.
      }
      const frame = Frame.safeParse(decoded);
      if (frame.success) responses.set(frame.data.id, frame.data);
    }
    if (responses.size === 0) {
      reject(new Error(`no JSON-RPC responses. stderr: ${stderr.slice(0, 500)}`));
      return;
    }
    settle(responses);
  });

  child.stdin.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  child.stdin.end();

  return promise;
}

beforeAll(() => {
  if (!existsSync(SERVER)) {
    throw new Error(`Missing ${SERVER}. Run \`npm run build\` before \`npm test\`.`);
  }
});

describe("MCP server contract", () => {
  it("reports the version declared in package.json", async () => {
    const responses = await callServer(HANDSHAKE);
    const info = InitializeResult.parse(responses.get(0)?.result);

    expect(info.serverInfo.name).toBe("mcp-gamehacking");
    expect(info.serverInfo.version).toBe(packageVersion());
  });

  it("exposes the full tool surface", async () => {
    const responses = await callServer([
      ...HANDSHAKE,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    ]);

    const names = ToolsListResult.parse(responses.get(1)?.result).tools.map((tool) => tool.name);
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
    expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });
});

describe("skill index", () => {
  it("indexes every SKILL.md on disk", async () => {
    const responses = await callServer([...HANDSHAKE, toolCall(1, "skill_stats")]);
    const total = Number(textOf(responses.get(1)).match(/\*\*Total:\*\*\s*(\d+)/)?.[1]);

    // Ground truth: an indexed skill is a directory holding a SKILL.md.
    const onDisk = readdirSync(SKILLS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(SKILLS, entry.name, "SKILL.md"))).length;

    expect(onDisk).toBeGreaterThan(0);
    expect(total).toBe(onDisk);
  });

  it("returns a stable total under concurrent calls", async () => {
    // Regression guard: an unbounded concurrent build plus a missing
    // single-flight guard previously produced 0, 4159 and 4030 from one process.
    const responses = await callServer([
      ...HANDSHAKE,
      toolCall(1, "skill_stats"),
      toolCall(2, "skill_stats"),
      toolCall(3, "skill_stats"),
      toolCall(4, "skill_stats"),
    ]);

    const totals = [1, 2, 3, 4].map(
      (id) => textOf(responses.get(id)).match(/\*\*Total:\*\*\s*(\d+)/)?.[1],
    );
    expect(new Set(totals).size).toBe(1);
    expect(Number(totals[0])).toBeGreaterThan(0);
  });

  it("parses metadata.type so type filters match", async () => {
    // Regression guard: the scalar matcher was anchored and every skill nests
    // `type` under `metadata:`, so this filter used to return zero rows.
    const responses = await callServer([
      ...HANDSHAKE,
      toolCall(1, "list_skills", { type: "reference", limit: 1 }),
      toolCall(2, "skill_stats"),
    ]);

    expect(textOf(responses.get(1))).toMatch(/^Found [1-9]\d* skills/);
    expect(textOf(responses.get(2))).toMatch(/reference: [1-9]\d*/);
  });
});

describe("get_file_tree", () => {
  it("reads the drawn tree instead of markdown bullets", async () => {
    // Regression guard: the old fallback matched prose bullets, so a project
    // with a full tree reported a URL as its only "file".
    const project = "ags-kdmapper-1909";
    const responses = await callServer([
      ...HANDSHAKE,
      toolCall(1, "get_file_tree", { name: project, max_entries: 10 }),
    ]);

    const output = textOf(responses.get(1));
    expect(output).toContain(`# File Tree: ${project}`);
    expect(output).toMatch(/\d+ entries \(\d+ files, \d+ directories\)/);
    expect(output).not.toMatch(/https?:\/\//);
  });
});
