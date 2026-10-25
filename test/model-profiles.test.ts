import { afterAll, afterEach, beforeAll, describe, expect, it } from "rstack/test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
