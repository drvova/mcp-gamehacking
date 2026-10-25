import { afterAll, beforeAll, describe, expect, it } from "rstack/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  InitializeResult,
  ROOT,
  SERVER,
  SKILLS_DIR,
  callServer,
  listTools,
  reportSkipped,
  requireArchive,
  textOf,
  toolCall,
  toolNames,
} from "./helpers/mcp.js";

/**
 * Every capability the server can perform.
 *
 * These are NOT advertised as tools. They are reached from code inside `run`,
 * which is the only tool — so this list is used to prove they are reachable,
 * not that they are listed.
 */
const EXPECTED_CAPABILITIES = [
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

const PackageJson = z.object({ version: z.string() });

beforeAll(() => {
  if (!existsSync(SERVER)) {
    throw new Error(`Missing ${SERVER}. Run \`npm run build\` before \`npm test\`.`);
  }
});

// Surface what did not run, so a green suite never implies full coverage.
afterAll(reportSkipped);

describe("MCP server contract", () => {
  it("reports the version declared in package.json", async () => {
    const responses = await callServer([]);
    const info = InitializeResult.parse(responses.get(0)?.result);
    const declared = PackageJson.parse(
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")),
    ).version;

    expect(info.serverInfo.name).toBe("mcp-gamehacking");
    expect(info.serverInfo.version).toBe(declared);
  });

  it("publishes usage instructions at initialize", async () => {
    const responses = await callServer([]);
    const info = InitializeResult.parse(responses.get(0)?.result);

    expect(info.instructions).toBeTruthy();
    // The instructions have to say what the one tool is and that it runs code
    // with the server's authority, because that fact is not discoverable from
    // the schema alone.
    expect(info.instructions).toContain("`run`");
    expect(info.instructions).toMatch(/code/);
    expect(info.instructions).toMatch(/sandbox/i);
  });

  it("advertises one tool, and no capability as a tool", async () => {
    const responses = await callServer([listTools(1)]);
    const names = toolNames(responses.get(1));

    expect(names).toEqual(["run"]);
    for (const capability of EXPECTED_CAPABILITIES) expect(names).not.toContain(capability);
  });

  it("keeps every pre-existing capability reachable from code", async () => {
    // The contract: leave the capability functions defined and working, just do
    // not register them as tools. Reached through the harness, all of them are
    // still there.
    const responses = await callServer([
      toolCall(1, "run", {
        code: `const names = [${EXPECTED_CAPABILITIES.map((c) => `"${c}"`).join(", ")}];
const missing = names.filter((n) => typeof globalThis[n] !== "function");
missing.length === 0 ? "all reachable" : "missing: " + missing.join(", ")`,
      }),
    ]);

    expect(textOf(responses.get(1))).toBe("all reachable");
  });
});

describe("skill index", () => {
  it("indexes every SKILL.md on disk", async () => {
    if (!requireArchive("indexes every SKILL.md on disk")) return;
    const responses = await callServer([toolCall(1, "run", { code: "await skill_stats()" })]);
    const total = Number(textOf(responses.get(1)).match(/\*\*Total:\*\*\s*(\d+)/)?.[1]);

    // Ground truth: an indexed skill is a directory holding a SKILL.md.
    const onDisk = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(SKILLS_DIR, entry.name, "SKILL.md"))).length;

    expect(onDisk).toBeGreaterThan(0);
    expect(total).toBe(onDisk);
  });

  it("returns a stable total under concurrent calls", async () => {
    // Regression guard: an unbounded concurrent build plus a missing
    // single-flight guard previously produced 0, 4159 and 4030 from one process.
    if (!requireArchive("returns a stable total under concurrent calls")) return;
    const responses = await callServer([
      toolCall(1, "run", { code: "await skill_stats()" }),
      toolCall(2, "run", { code: "await skill_stats()" }),
      toolCall(3, "run", { code: "await skill_stats()" }),
      toolCall(4, "run", { code: "await skill_stats()" }),
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
    if (!requireArchive("parses metadata.type so type filters match")) return;
    const responses = await callServer([
      toolCall(1, "run", { code: "await list_skills({ type: 'reference', limit: 1 })" }),
      toolCall(2, "run", { code: "await skill_stats()" }),
    ]);

    expect(textOf(responses.get(1))).toMatch(/^Found [1-9]\d* skills/);
    expect(textOf(responses.get(2))).toMatch(/reference: [1-9]\d*/);
  });
});

describe("get_file_tree", () => {
  it("reads the drawn tree instead of markdown bullets", async () => {
    // Regression guard: the old fallback matched prose bullets, so a project
    // with a full tree reported a URL as its only "file".
    if (!requireArchive("reads the drawn tree instead of markdown bullets")) return;
    const project = "ags-kdmapper-1909";
    const output = textOf(
      (
        await callServer([
          toolCall(1, "run", {
            code: `await get_file_tree({ name: "${project}", max_entries: 10 })`,
          }),
        ])
      ).get(1),
    );

    expect(output).toContain(`# File Tree: ${project}`);
    expect(output).toMatch(/\d+ entries \(\d+ files, \d+ directories\)/);
    expect(output).not.toMatch(/https?:\/\//);
  });
});
