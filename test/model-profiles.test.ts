import { afterEach, beforeAll, describe, expect, it } from "rstack/test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  PROFILES_DIR,
  SERVER,
  callServer,
  listTools,
  openSession,
  profileIdOf,
  textOf,
  toolCall,
  toolNames,
  wasRefused,
} from "./helpers/mcp.js";

/** Registration order with the neutral profile. */
const DEFAULT_SURFACE = [
  "research_technique",
  "analyze_project",
  "get_agent_briefing",
  "grep_sources",
  "find_offset",
  "compare_projects",
  "find_similar",
  "extract_offsets",
  "search_by_game",
  "search_by_engine",
  "get_file_tree",
  "find_function",
  "export_offsets",
  "skill_changelog",
  "list_skills",
  "read_skill",
  "read_source",
  "search_skills",
  "skill_stats",
  "list_agents",
  "read_agent",
  "list_subagents",
  "read_subagent",
  "list_plugins",
  "read_plugin",
  "list_prompts",
  "read_prompt",
  "list_model_profiles",
  "get_model_profile",
  "set_model_profile",
  "define_model_profile",
];

const PROFILE_TOOLS = [
  "list_model_profiles",
  "get_model_profile",
  "set_model_profile",
  "define_model_profile",
];

const PROBE_ID = "test-probe-profile";

function cleanupProbe() {
  const path = join(PROFILES_DIR, `${PROBE_ID}.json`);
  if (existsSync(path)) rmSync(path, { force: true });
  return path;
}

beforeAll(() => {
  if (!existsSync(SERVER)) {
    throw new Error(`Missing ${SERVER}. Run \`npm run build\` before \`npm test\`.`);
  }
});

afterEach(cleanupProbe);

describe("model profile surface", () => {
  it("presents the unchanged surface to an unrecognised client", async () => {
    const names = toolNames(
      (await callServer([listTools(1)], { clientName: "unknown-client" })).get(1),
    );

    expect(names).toEqual(DEFAULT_SURFACE);
    for (const tool of PROFILE_TOOLS) expect(names).toContain(tool);
  });

  it("resolves a profile from the reported client name", async () => {
    const cases: Array<[string, string]> = [
      ["Claude Code", "claude"],
      ["gemini-cli", "gemini"],
      ["ollama-runner", "local"],
      ["totally-unknown-client", "default"],
    ];

    for (const [clientName, expected] of cases) {
      const responses = await callServer([toolCall(1, "get_model_profile")], { clientName });
      expect(profileIdOf(responses.get(1))).toBe(expected);
    }
  });
});

describe("per-request overrides", () => {
  it("honours _meta.profile and leaves the unshaped surface without it", async () => {
    const responses = await callServer([
      listTools(1, { profile: "compact" }),
      listTools(2),
      listTools(3, { profile: "not-a-real-profile" }),
    ]);

    expect(toolNames(responses.get(1))).toEqual([
      "search_skills",
      "read_skill",
      "skill_stats",
      "list_skills",
      "get_file_tree",
    ]);
    expect(toolNames(responses.get(2))).toEqual(DEFAULT_SURFACE);
    // An unknown id must fall through rather than blank the surface.
    expect(toolNames(responses.get(3))).toEqual(DEFAULT_SURFACE);
  });

  it("honours _meta.model", async () => {
    const responses = await callServer([
      toolCall(1, "get_model_profile", {}, { model: "claude-opus-4" }),
      toolCall(2, "get_model_profile", {}, { model: "gpt-5" }),
    ]);

    expect(profileIdOf(responses.get(1))).toBe("claude");
    expect(profileIdOf(responses.get(2))).toBe("gpt");
  });
});

describe("session override", () => {
  it("reshapes the listing after set_model_profile", async () => {
    const session = await openSession();
    try {
      const set = await session.request(toolCall(1, "set_model_profile", { id: "local" }));
      expect(textOf(set)).toContain("`local`");

      const narrowed = await session.request(listTools(2));
      expect(toolNames(narrowed)).toEqual([
        "search_skills",
        "read_skill",
        "skill_stats",
        "get_file_tree",
      ]);

      const cleared = await session.request(toolCall(3, "set_model_profile", { id: "auto" }));
      expect(textOf(cleared)).toContain("cleared");

      const restored = await session.request(listTools(4));
      expect(toolNames(restored)).toEqual(DEFAULT_SURFACE);
    } finally {
      session.close();
    }
  });

  it("refuses an unknown profile and keeps the previous state", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "set_model_profile", { id: "no-such-profile" }),
      );
      expect(textOf(refused)).toMatch(/Unknown profile/);

      const listing = await session.request(listTools(2));
      expect(toolNames(listing)).toEqual(DEFAULT_SURFACE);
    } finally {
      session.close();
    }
  });
});

describe("model-authored profiles", () => {
  it("persists a profile that a later process can select", async () => {
    const path = cleanupProbe();

    const created = await callServer([
      toolCall(1, "define_model_profile", {
        id: PROBE_ID,
        label: "Test Probe",
        description: "Written by the test suite",
        guidance:
          "This profile exists to prove a model can author and persist its own tooling surface across processes.",
        models: ["test-probe-model"],
        tool_include: ["skill_stats", "search_skills"],
      }),
    ]);
    expect(textOf(created.get(1))).toContain(PROBE_ID);
    expect(existsSync(path)).toBe(true);

    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted.id).toBe(PROBE_ID);
    expect(persisted.tools.include).toEqual(["skill_stats", "search_skills"]);

    // A separate process must see it, which proves persistence rather than cache.
    const session = await openSession();
    try {
      const listed = await session.request(toolCall(1, "list_model_profiles"));
      expect(textOf(listed)).toContain(PROBE_ID);

      const selected = await session.request(toolCall(2, "set_model_profile", { id: PROBE_ID }));
      expect(textOf(selected)).toContain(PROBE_ID);

      const listing = await session.request(listTools(3));
      expect(toolNames(listing)).toEqual(["skill_stats", "search_skills"]);
    } finally {
      session.close();
    }
  });

  it("rejects hostile profile ids without touching the filesystem", async () => {
    const hostile = ["../escape", "..", "a/b", "UPPER", "has space", ".hidden", "con", "trailing-"];
    const before = existsSync(PROFILES_DIR) ? readdirSync(PROFILES_DIR).length : 0;

    const responses = await callServer(
      hostile.map((candidate, index) =>
        toolCall(index + 1, "define_model_profile", {
          id: candidate,
          label: "Hostile",
          description: "Must never be written",
          guidance:
            "A hostile identifier must be refused outright and must never reach the filesystem layer.",
        }),
      ),
    );

    for (let index = 0; index < hostile.length; index++) {
      const response = responses.get(index + 1);
      expect(wasRefused(response), `hostile id "${hostile[index]}" was accepted`).toBe(true);
    }

    const after = existsSync(PROFILES_DIR) ? readdirSync(PROFILES_DIR).length : 0;
    expect(after).toBe(before);
    expect(existsSync(join(PROFILES_DIR, "..", "escape.json"))).toBe(false);
  });
});

describe("profile semantics", () => {
  it("keeps filtered-out tools callable", async () => {
    // A profile shapes presentation only, so a narrow profile must never
    // remove a capability.
    const responses = await callServer([
      listTools(1, { profile: "compact" }),
      toolCall(
        2,
        "grep_sources",
        { pattern: "DriverEntry", max_files: 1, max_matches_per_file: 1 },
        {
          profile: "compact",
        },
      ),
      toolCall(3, "read_source", { name: "ags-kdmapper-1909", limit: 3 }, { profile: "compact" }),
    ]);

    const listed = toolNames(responses.get(1));
    expect(listed).not.toContain("grep_sources");
    expect(listed).not.toContain("read_source");

    expect(textOf(responses.get(2)).length).toBeGreaterThan(0);
    expect(textOf(responses.get(3))).toContain("Source:");
  });

  it("carries distinct, substantive guidance per model", async () => {
    const ids = ["claude", "gpt", "gemini", "compact", "local"];
    const responses = await callServer(
      ids.map((id, index) => toolCall(index + 1, "get_model_profile", {}, { profile: id })),
    );

    const guidances = ids.map((_, index) => {
      const text = textOf(responses.get(index + 1));
      return text.split("## Guidance")[1]?.split("Note:")[0]?.trim() ?? "";
    });

    for (const guidance of guidances) expect(guidance.length).toBeGreaterThanOrEqual(200);
    expect(new Set(guidances).size).toBe(ids.length);
  });
});
