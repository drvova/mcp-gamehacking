import { afterEach, beforeAll, describe, expect, it } from "rstack/test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  PROFILES_DIR,
  SERVER,
  archivePresent,
  callServer,
  listTools,
  openSession,
  profileIdOf,
  requireArchive,
  textOf,
  toolCall,
  toolNames,
  wasRefused,
} from "./helpers/mcp.js";

/**
 * The seed surface an unrecognised caller starts on.
 *
 * This is deliberately not the whole catalogue: a base that fits no model in
 * particular fits every model badly. The complete set is discoverable via
 * `surface` and selectable with the `full` profile.
 */
const SEED_SURFACE = ["surface"];

/** Every tool the server registers, in registration order. */
const FULL_CATALOG = [
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
  "surface",
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
  it("presents a seed surface, not the whole catalogue, to an unrecognised client", async () => {
    const names = toolNames(
      (await callServer([listTools(1)], { clientName: "unknown-client" })).get(1),
    );

    expect(names).toEqual(SEED_SURFACE);
    expect(names.length).toBeLessThan(FULL_CATALOG.length);
  });

  it("keeps every tool reachable from the seed, since a profile only shapes presentation", async () => {
    // The seed carries a fraction of the catalogue. Every tool it omits must
    // still work by name, so a narrow surface never costs a capability.
    if (!requireArchive("keeps every tool reachable from the seed")) return;
    const omitted = FULL_CATALOG.filter((name) => !SEED_SURFACE.includes(name));
    expect(omitted.length).toBeGreaterThan(0);

    const responses = await callServer([
      toolCall(1, "skill_stats"),
      toolCall(2, "get_file_tree", { name: "ags-kdmapper-1909", max_entries: 10 }),
    ]);

    expect(wasRefused(responses.get(1))).toBe(false);
    expect(textOf(responses.get(1))).toMatch(/\*\*Total:\*\*/);
    expect(wasRefused(responses.get(2))).toBe(false);
  });

  it("publishes the whole catalogue and marks what the active profile carries", async () => {
    const responses = await callServer([toolCall(1, "surface", { list: "tools" })]);
    const catalog = textOf(responses.get(1));

    for (const name of FULL_CATALOG) expect(catalog).toContain(`\`${name}\``);
    expect(catalog).toContain(`(${FULL_CATALOG.length} registered)`);
    expect(catalog).toContain(`(${SEED_SURFACE.length})`);
    expect(catalog).toMatch(/callable by name/);
  });

  it("resolves a profile from the reported client name", async () => {
    const cases: Array<[string, string]> = [
      ["Claude Code", "claude"],
      ["gemini-cli", "gemini"],
      ["ollama-runner", "local"],
      ["totally-unknown-client", "default"],
    ];

    for (const [clientName, expected] of cases) {
      const responses = await callServer([toolCall(1, "surface")], { clientName });
      expect(profileIdOf(responses.get(1))).toBe(expected);
    }
  });
});

describe("per-tool wording", () => {
  it("words a shared tool differently per profile, and leaves unoverridden ones alone", async () => {
    const responses = await callServer([
      listTools(1, { profile: "claude" }),
      listTools(2, { profile: "gpt" }),
      listTools(3, { profile: "full" }),
    ]);

    const described = (index: number) => {
      const tools = responses.get(index)?.result?.tools;
      return new Map(
        (Array.isArray(tools) ? tools : []).map((tool) => [
          String(tool.name),
          String(tool.description ?? ""),
        ]),
      );
    };

    const claude = described(1);
    const gpt = described(2);
    const full = described(3);

    // Both carry read_source; each is told about it in its own terms.
    expect(claude.get("read_source")).toBeTruthy();
    expect(gpt.get("read_source")).toBeTruthy();
    expect(claude.get("read_source")).not.toBe(gpt.get("read_source"));

    // `full` declares no overrides, so it shows the server's own wording.
    expect(full.get("read_source")).not.toBe(claude.get("read_source"));

    // gpt re-words search_skills; claude does not, so no override leaked.
    expect(gpt.get("search_skills")).not.toBe(full.get("search_skills"));
    expect(claude.get("search_skills")).toBe(full.get("search_skills"));
  });

  it("lets a model author the wording of its own surface", async () => {
    const probe = cleanupProbe();
    try {
      const created = await callServer([
        toolCall(1, "define_model_profile", {
          id: PROBE_ID,
          label: "Wording Probe",
          description: "Temporary profile used to prove authored wording",
          guidance:
            "This profile exists only to prove that a model can write the descriptions it reads. It must never survive a test run.",
          tool_include: ["skill_stats", "search_skills"],
          tool_descriptions: { search_skills: "PROBE WORDING: one distinctive word." },
        }),
      ]);
      expect(wasRefused(created.get(1))).toBe(false);

      const onDisk = JSON.parse(readFileSync(probe, "utf8"));
      expect(onDisk.tools?.descriptions?.search_skills).toContain("PROBE WORDING");

      const session = await openSession();
      try {
        await session.request(toolCall(1, "surface", { set: PROBE_ID }));
        const listing = await session.request(listTools(2));

        const tools = listing?.result?.tools ?? [];
        // The author's own tools first, then the surface core the server
        // guarantees so a profile can never trap a model.
        expect(tools.map((tool) => tool.name)).toEqual(["skill_stats", "search_skills", "surface"]);

        const described = tools.find((tool) => tool.name === "search_skills");
        expect(String(described?.description ?? "")).toContain("PROBE WORDING");
      } finally {
        session.close();
      }
    } finally {
      cleanupProbe();
    }
    expect(existsSync(probe)).toBe(false);
  });
});

describe("per-request overrides", () => {
  it("honours _meta.profile and falls back to the seed without it", async () => {
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
      "surface",
    ]);
    expect(toolNames(responses.get(2))).toEqual(SEED_SURFACE);
    // An unknown id must fall through rather than blank the surface.
    expect(toolNames(responses.get(3))).toEqual(SEED_SURFACE);
  });

  it("honours _meta.model", async () => {
    const responses = await callServer([
      toolCall(1, "surface", {}, { model: "claude-opus-4" }),
      toolCall(2, "surface", {}, { model: "gpt-5" }),
    ]);

    expect(profileIdOf(responses.get(1))).toBe("claude");
    expect(profileIdOf(responses.get(2))).toBe("gpt");
  });

  it("lets a caller take the whole catalogue instead of the seed", async () => {
    const responses = await callServer([listTools(1, { profile: "full" })]);

    // Nothing is lost by seeding: the complete surface is one request away.
    expect(toolNames(responses.get(1))).toEqual(FULL_CATALOG);
  });
});

describe("session override", () => {
  it("reshapes the listing after switching surface", async () => {
    const session = await openSession();
    try {
      const set = await session.request(toolCall(1, "surface", { set: "local" }));
      expect(textOf(set)).toContain("`local`");

      const narrowed = await session.request(listTools(2));
      expect(toolNames(narrowed)).toEqual([
        "search_skills",
        "read_skill",
        "skill_stats",
        "get_file_tree",
        "surface",
      ]);

      const cleared = await session.request(toolCall(3, "surface", { set: "auto" }));
      // Clearing falls through to the report, so the caller immediately sees
      // which surface it landed on rather than being told to ask again.
      expect(textOf(cleared)).toContain("Seed");

      const restored = await session.request(listTools(4));
      expect(toolNames(restored)).toEqual(SEED_SURFACE);
    } finally {
      session.close();
    }
  });

  it("refuses an unknown profile and keeps the previous state", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(toolCall(1, "surface", { set: "no-such-profile" }));
      expect(textOf(refused)).toMatch(/Unknown surface/);

      const listing = await session.request(listTools(2));
      expect(toolNames(listing)).toEqual(SEED_SURFACE);
    } finally {
      session.close();
    }
  });
});

describe("surface escape guarantee", () => {
  const CORE = ["surface"];

  it("carries the surface core on every built-in profile, however narrow", async () => {
    const responses = await callServer([
      listTools(1, { profile: "default" }),
      listTools(2, { profile: "full" }),
      listTools(3, { profile: "claude" }),
      listTools(4, { profile: "gpt" }),
      listTools(5, { profile: "gemini" }),
      listTools(6, { profile: "compact" }),
      listTools(7, { profile: "local" }),
    ]);

    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      const names = toolNames(responses.get(id));
      expect(names.length).toBeGreaterThan(0);
      for (const tool of CORE) {
        expect(names, `profile at request ${id} does not carry ${tool}`).toContain(tool);
      }
    }
  });

  it("refuses to let an authored profile exclude the surface core", async () => {
    const probe = cleanupProbe();
    try {
      const created = await callServer([
        toolCall(1, "define_model_profile", {
          id: PROBE_ID,
          label: "Trap Probe",
          description: "Attempts to exclude the surface core",
          guidance:
            "This profile exists only to prove the surface core cannot be excluded, and must never survive a test run.",
          tool_include: ["search_skills"],
          tool_exclude: CORE,
        }),
      ]);
      expect(wasRefused(created.get(1))).toBe(false);

      const persisted = JSON.parse(readFileSync(probe, "utf8"));
      for (const tool of CORE) {
        expect(persisted.tools.exclude).not.toContain(tool);
        expect(persisted.tools.include).toContain(tool);
      }

      const listing = await callServer([listTools(1, { profile: PROBE_ID })]);
      for (const tool of CORE) expect(toolNames(listing.get(1))).toContain(tool);
    } finally {
      cleanupProbe();
    }
  });

  it("lets a model on the narrowest surface actually widen it", async () => {
    const session = await openSession();
    try {
      await session.request(toolCall(1, "surface", { set: "local" }));
      const narrow = toolNames(await session.request(listTools(2)));

      await session.request(toolCall(3, "surface", { set: "full" }));
      const wide = toolNames(await session.request(listTools(4)));

      expect(wide.length).toBeGreaterThan(narrow.length);
    } finally {
      session.close();
    }
  });
});

describe("composing your own surface", () => {
  it("starts with one tool and no working set", async () => {
    const names = toolNames((await callServer([listTools(1)], { clientName: "unknown" })).get(1));

    // Not a base set: there is no set that suits every model, so the floor is
    // the one tool that lets a caller see everything and choose.
    expect(names).toEqual(["surface"]);
  });

  it("shows the whole catalogue from the seed, so there is something to choose from", async () => {
    const report = textOf((await callServer([toolCall(1, "surface")])).get(1));

    expect(report).toMatch(/## Not carried \(\d+\)/);
    for (const name of FULL_CATALOG) expect(report).toContain(`\`${name}\``);
  });

  it("composes a surface from chosen names, in the caller's order", async () => {
    const session = await openSession();
    try {
      const picked = await session.request(
        toolCall(1, "surface", { pick: ["find_offset", "search_skills", "read_skill"] }),
      );
      expect(wasRefused(picked)).toBe(false);

      expect(toolNames(await session.request(listTools(2)))).toEqual([
        "find_offset",
        "search_skills",
        "read_skill",
        "surface",
      ]);
    } finally {
      session.close();
    }
  });

  it("reports an unknown name rather than silently shrinking the surface", async () => {
    const session = await openSession();
    try {
      const typo = await session.request(
        toolCall(1, "surface", { pick: ["search_skills", "no_such_tool"] }),
      );
      expect(textOf(typo)).toContain("no_such_tool");
      expect(toolNames(await session.request(listTools(2)))).toEqual(["search_skills", "surface"]);
    } finally {
      session.close();
    }
  });

  it("refuses a pick that names nothing real, instead of presenting an empty surface", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(toolCall(1, "surface", { pick: ["nope"] }));
      expect(wasRefused(refused)).toBe(true);
      // The refusal must leave the previous surface intact.
      expect(toolNames(await session.request(listTools(2)))).toEqual(["surface"]);
    } finally {
      session.close();
    }
  });

  it("lets a composed surface be replaced by a ready-made one and cleared", async () => {
    const session = await openSession();
    try {
      await session.request(toolCall(1, "surface", { pick: ["search_skills"] }));
      expect(toolNames(await session.request(listTools(2)))).toEqual(["search_skills", "surface"]);

      await session.request(toolCall(3, "surface", { set: "full" }));
      expect(toolNames(await session.request(listTools(4)))).toEqual(FULL_CATALOG);

      await session.request(toolCall(5, "surface", { set: "auto" }));
      expect(toolNames(await session.request(listTools(6)))).toEqual(["surface"]);
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
    // The author's tools first, then the surface core the server guarantees.
    expect(persisted.tools.include).toEqual(["skill_stats", "search_skills", "surface"]);

    // A separate process must see it, which proves persistence rather than cache.
    const session = await openSession();
    try {
      const listed = await session.request(toolCall(1, "surface", { list: "surfaces" }));
      expect(textOf(listed)).toContain(PROBE_ID);

      const selected = await session.request(toolCall(2, "surface", { set: PROBE_ID }));
      expect(textOf(selected)).toContain(PROBE_ID);

      const listing = await session.request(listTools(3));
      expect(toolNames(listing)).toEqual(["skill_stats", "search_skills", "surface"]);
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
  it("lists a narrow surface but keeps omitted tools callable", async () => {
    // A profile shapes presentation only, so a narrow profile must never
    // remove a capability. The listing half needs no data; the callable half
    // uses `list_agents`, which reads the agents directory that ships in every
    // checkout, so this holds even where the skill archive is absent.
    const responses = await callServer([
      listTools(1, { profile: "compact" }),
      toolCall(2, "list_agents", {}, { profile: "compact" }),
      toolCall(3, "read_agent", { name: "exploit-developer" }, { profile: "compact" }),
    ]);

    const listed = toolNames(responses.get(1));
    expect(listed).not.toContain("list_agents");
    expect(listed).not.toContain("read_agent");

    expect(wasRefused(responses.get(2))).toBe(false);
    expect(textOf(responses.get(2))).toMatch(/Available agents \(\d+\)/);
    expect(wasRefused(responses.get(3))).toBe(false);
    expect(textOf(responses.get(3))).toContain("# Agent: exploit-developer");
  });

  it("keeps archive-backed tools callable while a narrow profile omits them", async () => {
    if (!requireArchive("keeps archive-backed tools callable")) return;

    const responses = await callServer([
      toolCall(
        1,
        "grep_sources",
        { pattern: "DriverEntry", max_files: 1, max_matches_per_file: 1 },
        {
          profile: "compact",
        },
      ),
      toolCall(2, "read_source", { name: "ags-kdmapper-1909", limit: 3 }, { profile: "compact" }),
    ]);

    expect(wasRefused(responses.get(1))).toBe(false);
    expect(textOf(responses.get(1)).length).toBeGreaterThan(0);
    expect(textOf(responses.get(2))).toContain("Source:");
  });

  it("says the archive is missing rather than reporting an empty library", async () => {
    if (archivePresent()) return;

    const response = await callServer([toolCall(1, "skill_stats")]);
    expect(wasRefused(response.get(1))).toBe(true);
    const text = textOf(response.get(1));
    expect(text).toMatch(/skill archive is not present/i);
    expect(text).not.toMatch(/ENOENT/);
  });

  it("carries distinct, substantive guidance per model", async () => {
    const ids = ["claude", "gpt", "gemini", "compact", "local"];
    const responses = await callServer(
      ids.map((id, index) => toolCall(index + 1, "surface", {}, { profile: id })),
    );

    const guidances = ids.map((_, index) => {
      const text = textOf(responses.get(index + 1));
      return text.split("## Guidance")[1]?.split("Note:")[0]?.trim() ?? "";
    });

    for (const guidance of guidances) expect(guidance.length).toBeGreaterThanOrEqual(200);
    expect(new Set(guidances).size).toBe(ids.length);
  });
});
