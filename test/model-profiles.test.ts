import { afterAll, afterEach, beforeAll, describe, expect, it } from "rstack/test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROFILES_DIR,
  ROOT,
  SERVER,
  archivePresent,
  callServer,
  listTools,
  openSession,
  reportSkipped,
  requireArchive,
  textOf,
  toolCall,
  toolNames,
  wasRefused,
} from "./helpers/mcp.js";

/**
 * The design is read from the same data the server reads.
 *
 * Restating the catalogue here would create a second source of truth: the list
 * would keep passing after the manifest changed. The manifest supplies the seed
 * and the core; the server is asked for the catalogue.
 */
const MANIFEST: { seed: string; surfaceCore: string[]; pickedId: string } = JSON.parse(
  readFileSync(join(ROOT, "profiles", "manifest.json"), "utf8"),
);

/** The tools the seed surface declares. */
const SEED_SURFACE: string[] = JSON.parse(
  readFileSync(join(ROOT, "profiles", `${MANIFEST.seed}.json`), "utf8"),
).tools.include;

/** Every tool the server registers, asked of the server. */
async function fullCatalog(): Promise<string[]> {
  const responses = await callServer([toolCall(1, "surface", { list: "tools" })]);
  const text = textOf(responses.get(1));
  const header = /\((\d+) registered\)/.exec(text);
  expect(header).not.toBeNull();
  return [...text.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]);
}

const PROBE_ID = "test-probe-surface";

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

// Surface what did not run, so a green suite never implies full coverage.
afterAll(reportSkipped);

describe("the seed is one tool", () => {
  it("presents exactly one tool to an unrecognised caller", async () => {
    const names = toolNames(
      (await callServer([listTools(1)], { clientName: "unknown-client" })).get(1),
    );

    // Not a base set: there is no set that suits every model, so the floor is
    // the one tool that lets a caller see everything and choose.
    expect(names).toEqual(SEED_SURFACE);
    expect(names).toHaveLength(1);
  });

  it("ships no surfaces for a model to pick from", async () => {
    // The whole point: if a model builds its own tooling, there is nothing for
    // the server to pre-author. Only the seed ships, and it is not a choice.
    const shipped = readdirSync(join(ROOT, "profiles"))
      .filter((name) => name.endsWith(".json") && name !== "manifest.json")
      .map((name) => name.replace(/\.json$/, ""));

    expect(shipped).toEqual([MANIFEST.seed]);
  });

  it("shows the whole catalogue from the seed, so there is something to choose from", async () => {
    const report = textOf((await callServer([toolCall(1, "surface")])).get(1));

    expect(report).toMatch(/## Not carried \(\d+\)/);
    const catalog = await fullCatalog();
    expect(catalog.length).toBeGreaterThan(10);
    for (const name of catalog) expect(report).toContain(`\`${name}\``);
  });

  it("does not register a separate tool for authoring surfaces", async () => {
    // Authoring was folded into `surface` and `save`: one tool, one path.
    const catalog = await fullCatalog();
    expect(catalog).not.toContain("define_model_profile");
  });
});

describe("composing your own surface", () => {
  it("builds a surface from chosen names, in the caller's order", async () => {
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
      expect(toolNames(await session.request(listTools(2)))).toEqual(["surface"]);
    } finally {
      session.close();
    }
  });

  it("always carries the surface core, whatever was picked", async () => {
    const session = await openSession();
    try {
      await session.request(toolCall(1, "surface", { pick: ["search_skills"] }));
      const names = toolNames(await session.request(listTools(2)));

      for (const tool of MANIFEST.surfaceCore) expect(names).toContain(tool);
    } finally {
      session.close();
    }
  });
});

describe("keeping a surface", () => {
  it("saves what was composed, and a later process can recall it", async () => {
    const probe = cleanupProbe();
    try {
      const session = await openSession();
      try {
        await session.request(
          toolCall(1, "surface", { pick: ["search_skills", "read_skill", "find_offset"] }),
        );
        const saved = await session.request(
          toolCall(2, "surface", {
            save: PROBE_ID,
            guidance:
              "This surface was built and saved by a test, and must never survive a run. It exists to prove that a model's own tooling persists.",
          }),
        );
        expect(wasRefused(saved)).toBe(false);
      } finally {
        session.close();
      }

      expect(existsSync(probe)).toBe(true);
      const persisted = JSON.parse(readFileSync(probe, "utf8"));
      expect(persisted.tools.include).toEqual(
        expect.arrayContaining(["search_skills", "read_skill", "find_offset"]),
      );

      // A separate process must see it, which proves persistence rather than cache.
      const reopened = await openSession();
      try {
        const listed = await reopened.request(toolCall(1, "surface", { list: "surfaces" }));
        expect(textOf(listed)).toContain(PROBE_ID);

        const recalled = await reopened.request(toolCall(2, "surface", { set: PROBE_ID }));
        expect(wasRefused(recalled)).toBe(false);

        const names = toolNames(await reopened.request(listTools(3)));
        for (const tool of ["search_skills", "read_skill", "find_offset"]) {
          expect(names).toContain(tool);
        }
      } finally {
        reopened.close();
      }
    } finally {
      cleanupProbe();
    }
    expect(existsSync(probe)).toBe(false);
  });

  it("revises a surface under the same id rather than refusing to change it", async () => {
    // A model must be able to change its own tooling. Refusing a re-save would
    // leave no way to revise it, which is worse than the clobber it guards.
    const probe = cleanupProbe();
    try {
      const session = await openSession();
      try {
        await session.request(toolCall(1, "surface", { pick: ["search_skills"] }));
        const first = await session.request(
          toolCall(2, "surface", {
            save: PROBE_ID,
            guidance:
              "First save, to establish a surface that the next call must be able to revise rather than refuse.",
          }),
        );
        expect(wasRefused(first)).toBe(false);
        expect(textOf(first)).toMatch(/Saved as/i);

        await session.request(toolCall(3, "surface", { pick: ["search_skills", "skill_stats"] }));
        const second = await session.request(
          toolCall(4, "surface", {
            save: PROBE_ID,
            guidance:
              "Second save under the same id, which must replace the first rather than being refused outright.",
          }),
        );
        expect(wasRefused(second)).toBe(false);
        expect(textOf(second)).toMatch(/Replaced/i);
      } finally {
        session.close();
      }

      const revised = JSON.parse(readFileSync(probe, "utf8"));
      expect(revised.tools.include).toContain("skill_stats");
    } finally {
      cleanupProbe();
    }
  });

  it("rejects a hostile id without writing outside the profiles directory", async () => {
    const before = existsSync(PROFILES_DIR) ? readdirSync(PROFILES_DIR).length : 0;

    const responses = await callServer(
      ["../escape", "..", "a/b", "UPPER", "has space"].map((candidate, index) =>
        toolCall(index + 1, "surface", { save: candidate, guidance: "x".repeat(90) }),
      ),
    );

    for (let index = 0; index < 5; index++) {
      expect(wasRefused(responses.get(index + 1))).toBe(true);
    }

    const after = existsSync(PROFILES_DIR) ? readdirSync(PROFILES_DIR).length : 0;
    expect(after).toBe(before);
    expect(existsSync(join(PROFILES_DIR, "..", "escape.json"))).toBe(false);
  });
});

describe("recalling and clearing", () => {
  it("clears back to the seed, and a saved surface can be recalled", async () => {
    const session = await openSession();
    try {
      await session.request(toolCall(1, "surface", { pick: ["search_skills"] }));
      expect(toolNames(await session.request(listTools(2)))).toEqual(["search_skills", "surface"]);

      const cleared = await session.request(toolCall(3, "surface", { set: "auto" }));
      expect(textOf(cleared)).toContain("Seed");
      expect(toolNames(await session.request(listTools(4)))).toEqual(SEED_SURFACE);
    } finally {
      session.close();
    }
  });

  it("refuses an unknown surface and keeps the previous state", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(toolCall(1, "surface", { set: "no-such-surface" }));
      expect(wasRefused(refused)).toBe(true);

      expect(toolNames(await session.request(listTools(2)))).toEqual(SEED_SURFACE);
    } finally {
      session.close();
    }
  });
});

describe("omission is presentation only", () => {
  it("keeps an omitted tool callable by name", async () => {
    // A surface shapes what is listed, never what is callable. The probe uses
    // tools whose data ships in every checkout, so this holds without the archive.
    const responses = await callServer([
      listTools(1),
      toolCall(2, "list_agents", {}, { profile: MANIFEST.seed }),
      toolCall(3, "read_agent", { name: "exploit-developer" }, { profile: MANIFEST.seed }),
    ]);

    const listed = toolNames(responses.get(1));
    expect(listed).not.toContain("list_agents");
    expect(listed).not.toContain("read_agent");

    expect(wasRefused(responses.get(2))).toBe(false);
    expect(textOf(responses.get(2))).toMatch(/Available agents \(\d+\)/);
    expect(wasRefused(responses.get(3))).toBe(false);
    expect(textOf(responses.get(3))).toContain("# Agent: exploit-developer");
  });

  it("keeps archive-backed tools callable while a narrow surface omits them", async () => {
    if (!requireArchive("keeps archive-backed tools callable")) return;

    const responses = await callServer([
      toolCall(1, "grep_sources", {
        pattern: "DriverEntry",
        max_files: 1,
        max_matches_per_file: 1,
      }),
      toolCall(2, "read_source", { name: "ags-kdmapper-1909", limit: 3 }),
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
});

describe("defining your own tools", () => {
  /** The full definitions a session currently lists. */
  const definitionsOf = async (session: Awaited<ReturnType<typeof openSession>>) =>
    (await session.request(listTools(1)))?.result?.tools ?? [];

  it("removes a bound argument from the schema, so it cannot be got wrong", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "read_pinned", args: { name: "exploit-developer" } }],
        }),
      );

      const mine = (await definitionsOf(session)).find((tool) => tool.name === "read_pinned");
      expect(mine).toBeDefined();
      expect(Object.keys(mine?.inputSchema?.properties ?? {})).not.toContain("name");
      expect(mine?.inputSchema?.required ?? []).not.toContain("name");
    } finally {
      session.close();
    }
  });

  it("works when called with nothing at all", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "read_pinned", args: { name: "exploit-developer" } }],
        }),
      );

      // The whole point: a tool the caller cannot call correctly becomes one it
      // cannot call incorrectly.
      const called = await session.request(toolCall(2, "read_pinned", {}));
      expect(wasRefused(called)).toBe(false);
      expect(textOf(called)).toContain("exploit-developer");
    } finally {
      session.close();
    }
  });

  it("keeps a bound argument when the caller sends a different value", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "read_pinned", args: { name: "exploit-developer" } }],
        }),
      );

      // A bound argument left the schema, so a caller sending it is reaching
      // past what it was shown. Honouring that would undo the binding.
      const called = await session.request(toolCall(2, "read_pinned", { name: "something-else" }));
      expect(textOf(called)).toContain("exploit-developer");
    } finally {
      session.close();
    }
  });

  it("keeps the arguments it did not bind, and re-words them", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "search_skills",
              as: "find",
              args: { limit: 5 },
              argDescriptions: { query: "What you are looking for, in your own words." },
            },
          ],
        }),
      );

      const mine = (await definitionsOf(session)).find((tool) => tool.name === "find");
      const properties = mine?.inputSchema?.properties ?? {};
      expect(Object.keys(properties)).toContain("query");
      expect(Object.keys(properties)).not.toContain("limit");
      expect(properties.query?.description).toBe("What you are looking for, in your own words.");
    } finally {
      session.close();
    }
  });

  it("survives being saved and recalled in a fresh process", async () => {
    const probe = cleanupProbe();
    try {
      const builder = await openSession();
      try {
        await builder.request(
          toolCall(1, "surface", {
            pick: [
              {
                tool: "read_agent",
                as: "read_pinned",
                args: { name: "exploit-developer" },
                description: "My own agent reader, already pointed at the one I use.",
              },
            ],
          }),
        );
        const saved = await builder.request(
          toolCall(2, "surface", {
            save: PROBE_ID,
            guidance:
              "A surface carrying a tool this test defined by binding an argument. Must never survive a run.",
          }),
        );
        expect(wasRefused(saved)).toBe(false);
      } finally {
        builder.close();
      }

      const persisted = JSON.parse(readFileSync(probe, "utf8"));
      expect(persisted.tools.derived).toHaveLength(1);

      // A separate process must restore the call shape, not merely the name.
      const recalled = await openSession();
      try {
        await recalled.request(toolCall(1, "surface", { set: PROBE_ID }));
        const mine = (await definitionsOf(recalled)).find((tool) => tool.name === "read_pinned");
        expect(mine).toBeDefined();
        expect(Object.keys(mine?.inputSchema?.properties ?? {})).not.toContain("name");

        const called = await recalled.request(toolCall(2, "read_pinned", {}));
        expect(textOf(called)).toContain("exploit-developer");
      } finally {
        recalled.close();
      }
    } finally {
      cleanupProbe();
    }
  });

  it("refuses a binding of a tool that does not exist", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", { pick: [{ tool: "no_such_tool", as: "ghost", args: {} }] }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(toolNames(await session.request(listTools(2)))).toEqual(SEED_SURFACE);
    } finally {
      session.close();
    }
  });
});

describe("a surface cannot lie", () => {
  // Every case here was a real defect: the surface said one thing and did
  // another, or made a tool unreachable while claiming it was fine.
  it("refuses a duplicate alias, so an alias means one thing", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [
            { tool: "read_agent", as: "dup", args: { name: "exploit-developer" } },
            { tool: "list_agents", as: "dup" },
          ],
        }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toContain("dup");
    } finally {
      session.close();
    }
  });

  it("refuses an alias that steals a registered tool's name", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "search_skills", args: { name: "exploit-developer" } }],
        }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toMatch(/already a registered tool/);
    } finally {
      session.close();
    }
  });

  it("refuses a bound argument that does not exist, and says what does", async () => {
    const session = await openSession();
    try {
      // A typo here would otherwise be advertised as bound and then fail at
      // call time with a raw validation error.
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "typo", args: { nmae: "exploit-developer" } }],
        }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toContain("nmae");
      expect(textOf(refused)).toContain("`name`");
    } finally {
      session.close();
    }
  });

  it("reports every problem in one call, not one per round trip", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [
            { tool: "read_agent", as: "dup", args: { nmae: "x" } },
            { tool: "list_agents", as: "dup" },
            { tool: "read_agent", as: "search_skills" },
          ],
        }),
      );
      const text = textOf(refused);
      expect(text).toContain("nmae");
      expect(text).toContain("dup");
      expect(text).toContain("search_skills");
    } finally {
      session.close();
    }
  });

  it("keeps the legitimate redefinition under the tool's own name working", async () => {
    const session = await openSession();
    try {
      const composed = await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", args: { name: "exploit-developer" } }],
        }),
      );
      expect(wasRefused(composed)).toBe(false);

      // Redefining a tool under its own name is the documented case; only
      // taking a DIFFERENT tool's name is refused.
      const called = await session.request(toolCall(2, "read_agent", {}));
      expect(textOf(called)).toContain("exploit-developer");
    } finally {
      session.close();
    }
  });

  it("holds the same rules for a profile hand-edited on disk", async () => {
    // A hand-written file never passes through `pick`, so the shaper has to
    // enforce the same rules or the guards are bypassable.
    const path = join(PROFILES_DIR, "test-liar-probe.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          id: "test-liar-probe",
          label: "Liar probe",
          description: "Hand-edited entries that pick would refuse. Must never survive a run.",
          match: { clientNames: [], models: [] },
          tools: {
            include: ["list_agents", "dup"],
            order: ["list_agents", "dup"],
            exclude: [],
            descriptions: {},
            derived: [
              {
                as: "list_agents",
                tool: "read_agent",
                args: { name: "exploit-developer" },
                argDescriptions: {},
              },
              {
                as: "dup",
                tool: "read_agent",
                args: { name: "exploit-developer" },
                argDescriptions: {},
              },
              { as: "dup", tool: "list_agents", args: {}, argDescriptions: {} },
              { as: "typo", tool: "read_agent", args: { nmae: "x" }, argDescriptions: {} },
            ],
          },
          guidance:
            "Written directly to disk to prove the shaper fails closed on entries pick would refuse.",
          workflow: [],
        }),
        "utf8",
      );

      const meta = { profile: "test-liar-probe" };
      const listed = await callServer([listTools(1, meta)]);
      const names = toolNames(listed.get(1));

      // A stolen name must still be the real tool. Both probes read the committed
      // agents/ tree rather than the skill archive, which a CI checkout cannot
      // materialise and which this suite must not depend on.
      const real = await callServer([toolCall(1, "list_agents", {}, meta)]);
      expect(textOf(real.get(1))).toMatch(/Available agents \(\d+\)/);

      // An entry that cannot be honoured is dropped, not approximated.
      expect(names).not.toContain("typo");

      // The listing and the call must agree about which duplicate won.
      const shown = (listed.get(1)?.result?.tools ?? []).find((tool) => tool.name === "dup");
      const called = await callServer([toolCall(1, "dup", {}, meta)]);
      const describesRead = /full definition and system prompt/.test(shown?.description ?? "");
      const describesList = /grouped by category/.test(shown?.description ?? "");
      const callsRead = textOf(called.get(1)).includes("# Agent:");
      const callsList = /Available agents \(\d+\)/.test(textOf(called.get(1)));

      // Unambiguous on both sides: a loose match would pass on either branch,
      // which is how the first version of this check missed the duplicate bug.
      expect(describesRead).not.toBe(describesList);
      expect(callsRead).not.toBe(callsList);
      expect(describesRead).toBe(callsRead);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("defaults and constraints", () => {
  // These use `read_agent`, which reads the committed agents/ tree. Anything
  // archive-backed would assert against "not present" on a CI checkout, which
  // is exactly how an earlier version of these checks failed the runner while
  // passing locally.
  it("uses a default when the argument is omitted, and yields to the caller", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "mine", defaults: { name: "exploit-developer" } }],
        }),
      );

      const mine = ((await session.request(listTools(2)))?.result?.tools ?? []).find(
        (tool) => tool.name === "mine",
      );
      // The argument stays, so it can still be overridden: that is the
      // difference between a default and a fixed argument.
      expect(Object.keys(mine?.inputSchema?.properties ?? {})).toContain("name");
      expect(mine?.inputSchema?.properties?.name?.default).toBe("exploit-developer");
      expect(mine?.inputSchema?.required ?? []).not.toContain("name");

      expect(textOf(await session.request(toolCall(3, "mine", {})))).toContain(
        "# Agent: exploit-developer",
      );

      const explicit = await session.request(toolCall(4, "mine", { name: "anti-cheat-analyst" }));
      expect(textOf(explicit)).toContain("# Agent: anti-cheat-analyst");
    } finally {
      session.close();
    }
  });

  it("enforces an enum constraint, naming the allowed values when it refuses", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "read_agent",
              as: "mine",
              constrain: { name: { enum: ["exploit-developer", "anti-cheat-analyst"] } },
            },
          ],
        }),
      );

      const mine = ((await session.request(listTools(2)))?.result?.tools ?? []).find(
        (tool) => tool.name === "mine",
      );
      expect(mine?.inputSchema?.properties?.name?.enum).toEqual([
        "exploit-developer",
        "anti-cheat-analyst",
      ]);

      expect(
        wasRefused(await session.request(toolCall(3, "mine", { name: "anti-cheat-analyst" }))),
      ).toBe(false);

      // A schema that advertises an enum while the server accepts anything is a
      // lie, so the constraint is enforced rather than only shown.
      const refused = await session.request(toolCall(4, "mine", { name: "not-in-the-list" }));
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toContain("exploit-developer");
    } finally {
      session.close();
    }
  });

  it("enforces a numeric range before the tool runs", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "search_skills",
              as: "find",
              defaults: { limit: 3 },
              constrain: { limit: { minimum: 1, maximum: 3 } },
            },
          ],
        }),
      );

      // The refusal happens in the surface layer, before the tool executes, so
      // this holds without the skill archive.
      const refused = await session.request(toolCall(2, "find", { query: "kdmapper", limit: 99 }));
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toContain("at most 3");
    } finally {
      session.close();
    }
  });

  it("refuses a constraint the tool's own default would break", async () => {
    const session = await openSession();
    try {
      // search_skills defaults limit to 20. Narrowing the maximum to 3 while
      // leaving that default in place would advertise a limit it does not keep.
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "search_skills", as: "find", constrain: { limit: { maximum: 3 } } }],
        }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toMatch(/already defaults/i);
    } finally {
      session.close();
    }
  });

  it("refuses a default that breaks its own constraint", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "search_skills",
              as: "find",
              defaults: { limit: 99 },
              constrain: { limit: { maximum: 3 } },
            },
          ],
        }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toMatch(/your default/i);
    } finally {
      session.close();
    }
  });

  it("refuses a default or constraint on a fixed argument, which would be inert", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "read_agent",
              as: "pinned",
              args: { name: "exploit-developer" },
              defaults: { name: "other" },
            },
          ],
        }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toMatch(/fixed/i);
    } finally {
      session.close();
    }
  });

  it("survives a save and a fresh process", async () => {
    const probe = cleanupProbe();
    try {
      const builder = await openSession();
      try {
        await builder.request(
          toolCall(1, "surface", {
            pick: [
              {
                tool: "read_agent",
                as: "mine",
                defaults: { name: "exploit-developer" },
                argDescriptions: { name: "Which agent to read." },
              },
            ],
          }),
        );
        expect(
          wasRefused(
            await builder.request(
              toolCall(2, "surface", {
                save: PROBE_ID,
                guidance:
                  "A surface carrying a default, saved to prove it survives a process boundary rather than living in memory.",
              }),
            ),
          ),
        ).toBe(false);
      } finally {
        builder.close();
      }

      const recalled = await openSession();
      try {
        await recalled.request(toolCall(1, "surface", { set: PROBE_ID }));
        const mine = ((await recalled.request(listTools(2)))?.result?.tools ?? []).find(
          (tool) => tool.name === "mine",
        );
        expect(mine?.inputSchema?.properties?.name?.default).toBe("exploit-developer");
        expect(mine?.inputSchema?.properties?.name?.description).toBe("Which agent to read.");
        expect(textOf(await recalled.request(toolCall(3, "mine", {})))).toContain(
          "# Agent: exploit-developer",
        );
      } finally {
        recalled.close();
      }
    } finally {
      cleanupProbe();
    }
  });
});

describe("shaping the answer", () => {
  // The mirror of shaping the call. The property that matters most: a shaped
  // answer must never read as the whole truth, so every reduction is reported.
  const readWith = async (output: Record<string, unknown>) => {
    const session = await openSession();
    try {
      const composed = await session.request(
        toolCall(1, "surface", { pick: [{ tool: "read_agent", as: "mine", output }] }),
      );
      expect(wasRefused(composed)).toBe(false);
      return {
        text: textOf(await session.request(toolCall(2, "mine", { name: "exploit-developer" }))),
      };
    } finally {
      session.close();
    }
  };

  it("keeps the first N lines and says how much it kept", async () => {
    const full = await readWith({});
    const { text } = await readWith({ head: 5 });

    // What matters: the answer is a strict prefix of the whole, and the note
    // says how much was kept. Without the note a model reads five lines as the
    // whole document, which is the failure this feature exists to avoid.
    const answer = text.split("\n\n[shaped:")[0] ?? "";
    expect(full.text.startsWith(answer)).toBe(true);
    expect(answer.length).toBeLessThan(full.text.length);
    expect(answer.split("\n").length).toBeLessThanOrEqual(5);
    expect(text).toMatch(/\[shaped: 5 of \d+ lines — head: 5\]/);
  });

  it("keeps the last N lines", async () => {
    const { text } = await readWith({ tail: 4 });
    expect(text).toMatch(/\[shaped: 4 of \d+ lines — tail: 4\]/);
  });

  it("keeps only lines matching a pattern", async () => {
    const { text } = await readWith({ filter: "##" });

    for (const line of text.split("\n")) {
      if (line.length === 0 || line.startsWith("[shaped:")) continue;
      expect(line).toContain("##");
    }
    expect(text).toMatch(/\[shaped: \d+ of \d+ lines — filter: `##`\]/);
  });

  it("drops lines matching a pattern", async () => {
    const { text } = await readWith({ reject: "^\\s*$" });
    expect(text).toMatch(/\[shaped: \d+ of \d+ lines — reject: `\^\\s\*\$`\]/);
  });

  it("keeps only the named sections, heading included", async () => {
    const { text } = await readWith({ sections: ["Workflow"] });

    expect(text).toContain("## Workflow");
    expect(text).not.toContain("## Available Subagents");
    expect(text).toMatch(/sections: Workflow/);
  });

  it("applies rules in a fixed order and names every one that acted", async () => {
    const { text } = await readWith({ sections: ["Workflow"], head: 4 });
    expect(text).toMatch(/sections: Workflow; head: 4/);
  });

  it("caps characters without leaving half a word", async () => {
    const { text } = await readWith({ maxChars: 300 });
    expect(text).toMatch(/maxChars: 300/);
    expect(text.length).toBeLessThan(420);
  });

  it("states plainly that nothing matched, rather than returning nothing", async () => {
    const { text } = await readWith({ filter: "ZZZ_NO_SUCH_THING" });

    // A blank answer would read as "the tool returned nothing". Saying so is the
    // difference between a model knowing to loosen the rule and it guessing.
    expect(text).toMatch(/nothing matched/);
    expect(text).toMatch(/0 of \d+ lines/);
  });

  it("adds no note when a rule removed nothing", async () => {
    // A note claiming a reduction that did not happen would be its own small
    // lie, so a rule that fits inside the answer is silent.
    const { text } = await readWith({ head: 10000 });
    expect(text).not.toContain("[shaped:");
  });

  it("never shapes how a call failed", async () => {
    const session = await openSession();
    try {
      // The rule removes everything it is applied to, so if an error were shaped
      // its reason would vanish. A milder rule proves nothing: a one-line error
      // survives `head: 1` untouched.
      await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "mine", output: { filter: "ZZZ_NEVER_MATCHES" } }],
        }),
      );

      // The reason for a failure is the one thing a caller must not lose, so an
      // error is passed through untouched however destructive the shaping is.
      const failed = await session.request(toolCall(2, "mine", { name: "no-such-agent-xyz" }));
      expect(wasRefused(failed)).toBe(true);
      expect(textOf(failed)).toContain("no-such-agent-xyz");
      expect(textOf(failed)).not.toContain("[shaped:");
      expect(textOf(failed)).not.toContain("nothing matched");
    } finally {
      session.close();
    }
  });

  it("refuses head with tail, which is ambiguous about which end wins", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "mine", output: { head: 2, tail: 2 } }],
        }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toMatch(/ambiguous/);
    } finally {
      session.close();
    }
  });

  it("refuses a pattern that will not compile, naming it", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "mine", output: { filter: "[unclosed" } }],
        }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toContain("[unclosed");
    } finally {
      session.close();
    }
  });

  it("survives a save and a fresh process", async () => {
    const probe = cleanupProbe();
    try {
      const builder = await openSession();
      try {
        await builder.request(
          toolCall(1, "surface", {
            pick: [{ tool: "read_agent", as: "mine", output: { sections: ["Workflow"] } }],
          }),
        );
        expect(
          wasRefused(
            await builder.request(
              toolCall(2, "surface", {
                save: PROBE_ID,
                guidance:
                  "A surface carrying an output rule, saved to prove the shaping survives a process boundary.",
              }),
            ),
          ),
        ).toBe(false);
      } finally {
        builder.close();
      }

      const recalled = await openSession();
      try {
        await recalled.request(toolCall(1, "surface", { set: PROBE_ID }));
        const text = textOf(
          await recalled.request(toolCall(2, "mine", { name: "exploit-developer" })),
        );
        expect(text).toContain("## Workflow");
        expect(text).not.toContain("## Available Subagents");
      } finally {
        recalled.close();
      }
    } finally {
      cleanupProbe();
    }
  });
});

describe("the listing declares what a tool does", () => {
  it("says a shaped tool truncates, before it is ever called", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "read_agent",
              as: "who",
              args: { name: "exploit-developer" },
              output: { sections: ["Workflow"], head: 10 },
            },
          ],
        }),
      );

      const who = ((await session.request(listTools(2)))?.result?.tools ?? []).find(
        (tool) => tool.name === "who",
      );

      // A model that learns the rule from the result note has already read a
      // partial answer as if it were whole, so the listing states it up front.
      expect(who?.description).toContain("Workflow");
      expect(who?.description).toContain("first 10 lines");
      expect(who?.description).toMatch(/how much it kept/);
    } finally {
      session.close();
    }
  });

  it("says nothing about shaping when there is none", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", { pick: [{ tool: "read_agent", as: "plain" }] }),
      );

      const plain = ((await session.request(listTools(2)))?.result?.tools ?? []).find(
        (tool) => tool.name === "plain",
      );
      expect(plain?.description).not.toMatch(/how much it kept/);
    } finally {
      session.close();
    }
  });
});

describe("chains", () => {
  // A chain is a declaration, not a program: fixed sequence, no branching, and
  // every failure names the step. A model can debug a sequence it can read.
  //
  // These chain `list_agents` into `read_agent`, which read the committed
  // agents/ tree. An archive-backed pair would assert against "not present" on a
  // CI checkout, which is how an earlier suite failed the runner while passing
  // locally.
  const AGENT_NAME = "- \\*\\*([^*]+)\\*\\*";

  it("feeds one tool's answer into the next and shows what ran", async () => {
    const session = await openSession();
    try {
      const composed = await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "first_agent",
              then: [{ tool: "read_agent", extract: { name: AGENT_NAME } }],
              output: { head: 6 },
            },
          ],
        }),
      );
      expect(wasRefused(composed)).toBe(false);

      const answered = await session.request(toolCall(2, "first_agent", {}));
      const text = textOf(answered);

      // The trace is what makes a chain debuggable: which step ran, with what,
      // and how much came back.
      expect(text).toContain("[chain] list_agents → read_agent");
      expect(text).toMatch(/\[2\] read_agent\(name=[a-z0-9-]+\) → \d+ chars/);
      expect(text).toContain("# Agent: ");
    } finally {
      session.close();
    }
  });

  it("fans out when take is more than one, labelling each result", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "two_agents",
              then: [{ tool: "read_agent", extract: { name: AGENT_NAME }, take: 2 }],
              output: { sections: ["Core Capabilities"] },
            },
          ],
        }),
      );

      const text = textOf(await session.request(toolCall(2, "two_agents", {})));

      // Each fanned-out result carries a label. A content rule must not be able
      // to strip it: without labels the model cannot tell which is which.
      const labels = text.match(/--- name=[a-z0-9-]+ ---/g) ?? [];
      expect(labels).toHaveLength(2);
      expect(text).toMatch(/\[2\] read_agent\(name=[a-z0-9-]+\)/);
    } finally {
      session.close();
    }
  });

  it("stops and names the step when a step fails", async () => {
    const session = await openSession();
    try {
      // "Available" is not an agent, so the step errors rather than the
      // extraction failing — a different failure path from the one below.
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "broken",
              then: [{ tool: "read_agent", extract: { name: "(Available)" } }],
            },
          ],
        }),
      );

      const failed = await session.request(toolCall(2, "broken", {}));
      expect(wasRefused(failed)).toBe(true);
      expect(textOf(failed)).toMatch(/Step 2 \(read_agent\) failed/);
      expect(textOf(failed)).toContain("Available");
    } finally {
      session.close();
    }
  });

  it("stops and shows the answer when an extraction matches nothing", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "nomatch",
              then: [{ tool: "read_agent", extract: { name: "- NOPE ([^*]+)" } }],
            },
          ],
        }),
      );

      const failed = await session.request(toolCall(2, "nomatch", {}));
      expect(wasRefused(failed)).toBe(true);

      // The pattern AND the answer it was matched against, because that is what
      // the model needs in order to fix the pattern.
      expect(textOf(failed)).toContain("NOPE");
      expect(textOf(failed)).toContain("Available agents");
    } finally {
      session.close();
    }
  });

  it("runs what it has and says so when fewer matched than asked", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "short",
              then: [
                {
                  tool: "read_agent",
                  extract: { name: "- \\*\\*(anti-cheat-analyst)\\*\\*" },
                  take: 3,
                },
              ],
              output: { head: 2 },
            },
          ],
        }),
      );

      const text = textOf(await session.request(toolCall(2, "short", {})));
      expect(text).toMatch(/asked for 3, only 1 matched/);
    } finally {
      session.close();
    }
  });

  it("can call a tool this same surface defined", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            { tool: "read_agent", as: "read_pinned", args: { name: "exploit-developer" } },
            {
              tool: "list_agents",
              as: "flow",
              then: [{ tool: "read_pinned" }],
            },
          ],
        }),
      );

      const text = textOf(await session.request(toolCall(2, "flow", {})));

      // The trace names the RESOLVED tool, so what actually ran is never hidden
      // behind an alias.
      expect(text).toContain("[chain] list_agents → read_pinned");
      expect(text).toMatch(/\[2\] read_agent\(name=exploit-developer\)/);
      expect(text).toContain("# Agent: exploit-developer");
    } finally {
      session.close();
    }
  });

  it("declares the chain in the listing, before it is called", async () => {
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "two_agents",
              then: [{ tool: "read_agent", extract: { name: AGENT_NAME }, take: 2 }],
            },
          ],
        }),
      );

      const tool = ((await session.request(listTools(2)))?.result?.tools ?? []).find(
        (entry) => entry.name === "two_agents",
      );
      expect(tool?.description).toContain("Runs a chain");
      expect(tool?.description).toContain("read_agent(name)");
    } finally {
      session.close();
    }
  });

  it("refuses a chain that nests inside another chain", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "inner",
              then: [{ tool: "read_agent", extract: { name: AGENT_NAME } }],
            },
            {
              tool: "list_agents",
              as: "outer",
              then: [{ tool: "inner" }],
            },
          ],
        }),
      );
      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toMatch(/chains cannot nest/);
    } finally {
      session.close();
    }
  });

  it("refuses a step naming nothing, a bad pattern, and a bad argument — all at once", async () => {
    const session = await openSession();
    try {
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "many",
              then: [
                { tool: "no_such_tool" },
                { tool: "read_agent", extract: { nmae: "x" } },
                { tool: "read_agent", extract: { name: "[bad" } },
              ],
            },
          ],
        }),
      );

      const text = textOf(refused);
      expect(wasRefused(refused)).toBe(true);
      expect(text).toContain("no_such_tool");
      expect(text).toContain("nmae");
      expect(text).toContain("[bad");
    } finally {
      session.close();
    }
  });

  it("survives a save and a fresh process", async () => {
    const probe = cleanupProbe();
    try {
      const builder = await openSession();
      try {
        await builder.request(
          toolCall(1, "surface", {
            pick: [
              {
                tool: "list_agents",
                as: "two_agents",
                then: [{ tool: "read_agent", extract: { name: AGENT_NAME }, take: 2 }],
                output: { sections: ["Core Capabilities"] },
              },
            ],
          }),
        );
        expect(
          wasRefused(
            await builder.request(
              toolCall(2, "surface", {
                save: PROBE_ID,
                guidance:
                  "A chain saved to prove it survives a process boundary rather than living in memory.",
              }),
            ),
          ),
        ).toBe(false);
      } finally {
        builder.close();
      }

      const recalled = await openSession();
      try {
        await recalled.request(toolCall(1, "surface", { set: PROBE_ID }));
        const text = textOf(await recalled.request(toolCall(2, "two_agents", {})));

        expect(text).toContain("[chain] list_agents → read_agent");
        expect(text.match(/--- name=[a-z0-9-]+ ---/g) ?? []).toHaveLength(2);
      } finally {
        recalled.close();
      }
    } finally {
      cleanupProbe();
    }
  });

  it("chains the realistic case when the skill archive is present", async () => {
    if (!requireArchive("chains the realistic search-then-read case")) return;

    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "search_skills",
              as: "find_and_read",
              args: { limit: 3 },
              then: [{ tool: "read_skill", extract: { name: "- \\*\\*([^*]+)\\*\\*" } }],
              output: { head: 6 },
            },
          ],
        }),
      );

      const text = textOf(
        await session.request(toolCall(2, "find_and_read", { query: "kdmapper" })),
      );
      expect(text).toContain("[chain] search_skills → read_skill");
      expect(text).toContain("# ags-");
    } finally {
      session.close();
    }
  });
});

describe("the catalogue is a catalogue, not a list of names", () => {
  // The model has to build against these tools. Publishing names without their
  // arguments made writing `args`, `constrain` or a chain's `extract` guesswork
  // until a refusal taught you the names.
  it("shows every tool's arguments where the tool is listed", async () => {
    const session = await openSession();
    try {
      const report = textOf(await session.request(toolCall(1, "surface")));

      // read_agent takes exactly one argument, and it must be visible without a
      // second call or a failed one.
      expect(report).toMatch(/`read_agent` \(name: string\)/);
      expect(report).toMatch(/`read_skill` \(name: string\)/);

      // Optional arguments are marked, and their defaults shown.
      expect(report).toMatch(/limit\?: number=20/);
      expect(report).toMatch(/`skill_stats` \(no arguments\)/);
    } finally {
      session.close();
    }
  });

  it("explains one tool in full on request", async () => {
    const session = await openSession();
    try {
      const detail = textOf(
        await session.request(toolCall(1, "surface", { detail: "read_agent" })),
      );

      expect(detail).toContain("# read_agent");
      expect(detail).toContain("## Arguments");
      expect(detail).toMatch(/`name` \(string, required\)/);
      // A worked example beats a schema: it shows how the tool is carried.
      expect(detail).toContain("## Carrying it");
      expect(detail).toContain('tool: "read_agent"');
    } finally {
      session.close();
    }
  });

  it("says so plainly when asked about a tool that does not exist", async () => {
    const session = await openSession();
    try {
      const detail = textOf(
        await session.request(toolCall(1, "surface", { detail: "no_such_tool" })),
      );

      expect(detail).toMatch(/No tool named/);
      expect(detail).toContain("read_agent");
    } finally {
      session.close();
    }
  });

  it("publishes a shape that can actually be built against", async () => {
    const session = await openSession();
    try {
      const detail = textOf(
        await session.request(toolCall(1, "surface", { detail: "search_skills" })),
      );

      // Every argument the detail view names must be accepted by `pick`, or the
      // catalogue is describing a tool that does not exist.
      const named = [...detail.matchAll(/^- `([a-z_]+)` \(/gm)].map((match) => match[1]);
      expect(named.length).toBeGreaterThan(0);

      const composed = await session.request(
        toolCall(2, "surface", {
          pick: [
            {
              tool: "search_skills",
              as: "mine",
              args: Object.fromEntries(named.map((name) => [name, "kdmapper"])),
              defaults: {},
              constrain: {},
            },
          ],
        }),
      );

      // `args` for every published name, so nothing the catalogue advertised is
      // rejected as unknown.
      expect(wasRefused(composed)).toBe(false);
    } finally {
      session.close();
    }
  });

  it("says what a tool takes in the delta, since that is the decision input", async () => {
    const session = await openSession();
    try {
      const report = textOf(await session.request(toolCall(1, "surface")));

      // Choosing what to carry needs the arguments; a bare name forces a second
      // call before the model can even decide.
      expect(report).toMatch(/`find_offset` \(query: string, max_results\?: number=15\)/);
      expect(report).toContain('detail: "<tool>"');
    } finally {
      session.close();
    }
  });
});

describe("the chain runner's own edges", () => {
  // Found by auditing the runner rather than trusting that it worked. All three
  // are the same shape as everything else fixed this session: the surface said
  // one thing and the code did another.
  const AGENT_NAME = "- \\*\\*([^*]+)\\*\\*";

  it("reads the RAW answer for extraction, at every position", async () => {
    // Step 2 is a long answer whose bullets sit past line 3. With `head: 3` the
    // DISPLAY is cut, but extraction must read the whole thing: shaping is for
    // the reader, and a rule meant for eyes must not decide what data flows.
    //
    // This was position-dependent once — step 2 read raw, step 3 read shaped —
    // which made the same chain behave differently depending on where a step sat.
    const session = await openSession();
    try {
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "decisive",
              then: [
                { tool: "list_agents" },
                { tool: "read_agent", extract: { name: AGENT_NAME } },
              ],
              output: { head: 3 },
            },
          ],
        }),
      );

      const text = textOf(await session.request(toolCall(2, "decisive", {})));

      // If extraction had read the shaped text, step 3 could not have found a
      // name: `head: 3` removes every bullet.
      expect(text).toMatch(/\[3\] read_agent\(name=[a-z0-9-]+\)/);
      expect(text).toContain("# Agent: ");
    } finally {
      session.close();
    }
  });

  it("refuses a step that fills an argument which changes session state", async () => {
    const session = await openSession();
    try {
      // A step calling `surface` with `pick` would reconfigure the caller's own
      // tooling as a side effect of a tool call, and would change what the
      // remaining steps resolve against.
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "sneaky",
              then: [{ tool: "surface", extract: { pick: "(Available)" } }],
            },
          ],
        }),
      );

      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toMatch(/changes session state/);
    } finally {
      session.close();
    }
  });

  it("refuses a step calling a defined tool that carries a mutating argument", async () => {
    const session = await openSession();
    try {
      // The same rule has to hold when the argument is fixed on the alias rather
      // than extracted, or the guard is trivially bypassed.
      const refused = await session.request(
        toolCall(1, "surface", {
          pick: [
            { tool: "surface", as: "writer", args: { pick: ["read_agent"] } },
            { tool: "list_agents", as: "uses", then: [{ tool: "writer" }] },
          ],
        }),
      );

      expect(wasRefused(refused)).toBe(true);
      expect(textOf(refused)).toMatch(/changes session state/);
    } finally {
      session.close();
    }
  });

  it("still allows READING the surface tool as a step", async () => {
    const session = await openSession();
    try {
      // Only the mutating arguments are forbidden. Refusing the whole tool would
      // block a legitimate read, and a rule that is broader than its reason is
      // its own kind of wrong.
      const composed = await session.request(
        toolCall(1, "surface", {
          pick: [
            { tool: "list_agents", as: "peek", then: [{ tool: "surface" }], output: { head: 2 } },
          ],
        }),
      );
      expect(wasRefused(composed)).toBe(false);

      const text = textOf(await session.request(toolCall(2, "peek", {})));
      expect(text).toContain("[chain] list_agents → surface");
    } finally {
      session.close();
    }
  });

  it("says so when an extraction matched more than the cap", async () => {
    const session = await openSession();
    try {
      // 75 agents match, the cap is 50, so the values in hand are the first
      // fifty. A model that cannot tell fifty from seventy-five reasons about
      // the wrong set — the same silent-truncation defect output shaping exists
      // to avoid, and it was swallowed here until this test.
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "broad",
              then: [{ tool: "read_agent", extract: { name: AGENT_NAME }, take: 1 }],
            },
          ],
        }),
      );

      const text = textOf(await session.request(toolCall(2, "broad", {})));
      expect(text).toMatch(/matched more than 50 values/);
      expect(text).toMatch(/narrow the pattern/);
    } finally {
      session.close();
    }
  });

  it("stays silent when nothing was capped", async () => {
    const session = await openSession();
    try {
      // A note that cries wolf is its own small lie, so a narrow pattern must
      // not carry the warning.
      await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "narrow",
              then: [
                {
                  tool: "read_agent",
                  extract: { name: "- \\*\\*(anti-cheat-analyst)\\*\\*" },
                },
              ],
            },
          ],
        }),
      );

      const text = textOf(await session.request(toolCall(2, "narrow", {})));
      expect(text).not.toMatch(/matched more than 50/);
      expect(text).toContain("# Agent: anti-cheat-analyst");
    } finally {
      session.close();
    }
  });

  it("does not let a chain change the surface it is running under", async () => {
    const session = await openSession();
    try {
      const before = toolNames(await session.request(listTools(1)));
      expect(before).toEqual(["surface"]);

      // The refusal must leave the surface untouched, not half-applied.
      await session.request(
        toolCall(2, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "sneaky",
              then: [{ tool: "surface", extract: { pick: "(Available)" } }],
            },
          ],
        }),
      );

      expect(toolNames(await session.request(listTools(3)))).toEqual(["surface"]);
    } finally {
      session.close();
    }
  });
});
