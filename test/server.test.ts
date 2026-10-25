import { beforeAll, describe, expect, it } from "rstack/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  InitializeResult,
  ROOT,
  SERVER,
  SKILLS_DIR,
  callServer,
  requireArchive,
  textOf,
  toolCall,
} from "./helpers/mcp.js";

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

const PackageJson = z.object({ version: z.string() });

beforeAll(() => {
  if (!existsSync(SERVER)) {
    throw new Error(`Missing ${SERVER}. Run \`npm run build\` before \`npm test\`.`);
  }
});

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
    expect(info.instructions).toContain("`surface`");
  });

  it("registers every pre-existing tool", async () => {
    // The default listing is a seed now, so presence is asserted against the
    // catalogue rather than the presented surface: a tool may be unlisted and
    // still be registered and callable by name.
    const catalog = textOf((await callServer([toolCall(1, "surface", { list: "tools" })])).get(1));
    for (const tool of EXPECTED_TOOLS) expect(catalog).toContain(`\`${tool}\``);
  });
});

describe("skill index", () => {
  it("indexes every SKILL.md on disk", async () => {
    if (!requireArchive("indexes every SKILL.md on disk")) return;
    const responses = await callServer([toolCall(1, "skill_stats")]);
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
    if (!requireArchive("parses metadata.type so type filters match")) return;
    const responses = await callServer([
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
    if (!requireArchive("reads the drawn tree instead of markdown bullets")) return;
    const project = "ags-kdmapper-1909";
    const output = textOf(
      (await callServer([toolCall(1, "get_file_tree", { name: project, max_entries: 10 })])).get(1),
    );

    expect(output).toContain(`# File Tree: ${project}`);
    expect(output).toMatch(/\d+ entries \(\d+ files, \d+ directories\)/);
    expect(output).not.toMatch(/https?:\/\//);
  });
});
