#!/usr/bin/env node
/**
 * Gate oracle for the mcp-gamehacking per-model profile layer.
 *
 * Run a single check by name, or `all` for the whole battery. A check whose data
 * is absent declares itself skipped rather than passing quietly, so a green
 * battery never implies coverage it did not have. Set GATES_REQUIRE_ARCHIVE=1
 * to make an absent archive a failure instead of a skip.
 *
 * Every subcommand spawns the BUILT server (dist/index.js) and drives it over
 * stdio JSON-RPC, so the checks exercise the shipped artifact rather than the
 * sources. Each subcommand prints exactly one `gate-passed:<name>` token on
 * success and exits non-zero with a reason otherwise.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SERVER = join(ROOT, "dist", "index.js");
const PROFILES_DIR = join(ROOT, "model-profiles");
const SKILLS_DIR = join(ROOT, "skills");

/**
 * Read the design from the data the server reads.
 *
 * The catalogue and the seed are NOT restated here: a copy would be a second
 * source of truth that drifts from the manifest and the shipped surfaces. The
 * manifest supplies the seed and the core; the server supplies the catalogue.
 */
function readManifest() {
  return JSON.parse(readFileSync(join(ROOT, "profiles", "manifest.json"), "utf8"));
}

const MANIFEST = readManifest();

/** Read a shipped surface's definition from the data directory. */
function readSurface(id) {
  return JSON.parse(readFileSync(join(ROOT, "profiles", `${id}.json`), "utf8"));
}

/**
 * The tools an unrecognised caller starts with: whatever the manifest's seed
 * surface declares, minus nothing. Read from data, never restated here.
 */
const SEED_SURFACE = readSurface(MANIFEST.seed).tools.include ?? [];

/** Every tool the server registers, asked of the server itself. */
async function fullCatalog() {
  const responses = await callServer([listTools(1, { profile: "full" })]);
  const names = toolNames(responses.get(1));
  assert(names.length > 0, "the full surface presented no tools");
  return names;
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function pass(token) {
  console.log(`gate-passed:${token}`);
}

/** Spawn the built server, send requests, and collect responses by id. */
function callServer(requests, clientName = "gate-probe") {
  const { promise, resolve: settle, reject } = Promise.withResolvers();

  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(120_000),
  });

  const responses = new Map();
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  child.on("error", reject);
  child.on("close", () => {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let frame;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof frame.id === "number") responses.set(frame.id, frame);
    }
    if (responses.size === 0) {
      reject(new Error(`no JSON-RPC responses from ${SERVER}. stderr: ${stderr.slice(0, 600)}`));
      return;
    }
    settle(responses);
  });

  const init = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    },
  };
  child.stdin.write(
    [init, { jsonrpc: "2.0", method: "notifications/initialized" }, ...requests]
      .map((request) => JSON.stringify(request))
      .join("\n") + "\n",
  );
  child.stdin.end();

  return promise;
}

function toolCall(id, name, args = {}, meta) {
  const params = { name, arguments: args };
  if (meta) params._meta = meta;
  return { jsonrpc: "2.0", id, method: "tools/call", params };
}

/**
 * A session that exchanges one request at a time.
 *
 * `callServer` batches requests, and the SDK processes a batch concurrently, so
 * response order is not arrival order. Any check that means "set this, then
 * observe it" must round-trip instead of pipelining.
 */
async function openSession(clientName = "gate-probe") {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(120_000),
  });

  const pending = new Map();
  let buffer = "";
  let stderr = "";

  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("{")) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      const settle = pending.get(frame.id);
      if (settle) {
        pending.delete(frame.id);
        settle(frame);
      }
    }
  });

  const request = (outgoing) => {
    const { promise, resolve } = Promise.withResolvers();
    pending.set(outgoing.id, resolve);
    child.stdin.write(`${JSON.stringify(outgoing)}\n`);
    return promise;
  };

  const init = await request({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    },
  });
  if (!init?.result?.serverInfo) {
    throw new Error(`session failed to initialize. stderr: ${stderr.slice(0, 400)}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return { request, close: () => child.kill() };
}

function listTools(id, meta) {
  const params = {};
  if (meta) params._meta = meta;
  return { jsonrpc: "2.0", id, method: "tools/list", params };
}

function textOf(response) {
  const content = response?.result?.content;
  return Array.isArray(content) && content[0] && typeof content[0].text === "string"
    ? content[0].text
    : "";
}

function toolNames(response) {
  const tools = response?.result?.tools;
  assert(Array.isArray(tools), "tools/list returned no tools array");
  return tools.map((tool) => tool.name);
}

/** Read the profile id out of a `surface` report. */
function profileIdOf(response) {
  const match = textOf(response).match(/^# Surface: .*\(`([a-z0-9-]+)`\)/m);
  assert(match, `could not read a profile id from: ${textOf(response).slice(0, 160)}`);
  return match[1];
}

/** Independent ground truth for the indexed skill count. */
function skillsOnDisk() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(SKILLS_DIR, entry.name, "SKILL.md"))).length;
}

/** Remove a profile file if a previous run left one behind. */
function cleanupProfile(id) {
  const path = join(PROFILES_DIR, `${id}.json`);
  if (existsSync(path)) rmSync(path, { force: true });
  return path;
}

const CHECKS = {
  async "build-artifact"() {
    assert(existsSync(SERVER), `missing build artifact at ${SERVER}`);
    const responses = await callServer([]);
    const init = responses.get(0);
    assert(
      init?.result?.serverInfo?.name === "mcp-gamehacking",
      "initialize returned no serverInfo",
    );
    const instructions = init.result.instructions;
    assert(typeof instructions === "string" && instructions.length > 100, "no usable instructions");
    assert(
      instructions.includes("`surface`"),
      "instructions do not point a model at the tool catalogue",
    );

    const tools = await callServer([listTools(1)]);
    const names = toolNames(tools.get(1));
    assert(
      names.includes("surface"),
      `the seed does not carry \`surface\`, so it cannot compose anything: ${names.join(",")}`,
    );
    pass("build-artifact");
  },

  async "seed-surface"() {
    // The seed is ONE tool. Not a base working set: there is no set that suits
    // every model, so the only defensible floor is the tool that lets a caller
    // see the catalogue and compose its own surface from it.
    const responses = await callServer([listTools(1)], "totally-unknown-client");
    const names = toolNames(responses.get(1));

    assert(
      names.length === SEED_SURFACE.length,
      `expected a ${SEED_SURFACE.length}-tool seed, got ${names.length}: ${names.join(",")}`,
    );
    assert(
      JSON.stringify(names) === JSON.stringify(SEED_SURFACE),
      `unexpected seed surface: ${names.join(",")}`,
    );

    // It must be sufficient to decide with: the report has to show the whole
    // catalogue, or the model has nothing to choose from.
    const report = await callServer([toolCall(1, "surface")]);
    const text = textOf(report.get(1));
    assert(!report.get(1)?.result?.isError, "the seed tool failed");
    assert(/## Not carried \(\d+\)/.test(text), "the seed report does not show what exists");

    const catalog = await fullCatalog();
    for (const name of catalog) {
      assert(text.includes(`\`${name}\``), `the seed report omits ${name} from the catalogue`);
    }
    pass("seed-surface");
  },

  async "compose-pick"() {
    // `pick` is the intended path: a model composes its own working set rather
    // than being handed one. It must be session-scoped, must honour the caller's
    // order, and must report a typo instead of silently shrinking the surface.
    const session = await openSession();
    try {
      const picked = await session.request(
        toolCall(1, "surface", { pick: ["find_offset", "search_skills", "read_skill"] }),
      );
      assert(!picked?.result?.isError, `pick failed: ${textOf(picked).slice(0, 160)}`);

      const listing = toolNames(await session.request(listTools(2)));
      assert(
        JSON.stringify(listing) ===
          JSON.stringify(["find_offset", "search_skills", "read_skill", "surface"]),
        `pick did not honour the caller's order: ${listing.join(",")}`,
      );

      // A typo must be reported, and the valid names must still take effect.
      const typo = await session.request(
        toolCall(3, "surface", { pick: ["search_skills", "no_such_tool"] }),
      );
      assert(textOf(typo).includes("no_such_tool"), "an unknown tool name was accepted silently");
      const after = toolNames(await session.request(listTools(4)));
      assert(
        JSON.stringify(after) === JSON.stringify(["search_skills", "surface"]),
        `pick with a typo produced the wrong surface: ${after.join(",")}`,
      );

      // Picking nothing usable must fail rather than leave an empty surface.
      const empty = await session.request(toolCall(5, "surface", { pick: ["nope"] }));
      assert(
        Boolean(empty?.error) || Boolean(empty?.result?.isError),
        "a pick of only-unknown names was accepted",
      );
    } finally {
      session.close();
    }
    pass("compose-pick");
  },

  async "catalog-complete"() {
    // Nothing may be silently unreachable: the catalogue must list every
    // registered tool and agree with what tools/list actually serves.
    const responses = await callServer([toolCall(1, "surface", { list: "tools" }), listTools(2)]);

    const catalog = textOf(responses.get(1));
    const listed = toolNames(responses.get(2));

    const expected = await fullCatalog();
    for (const name of expected) {
      assert(catalog.includes(`\`${name}\``), `catalogue omits ${name}`);
    }
    assert(
      catalog.includes(`(${expected.length} registered)`),
      `catalogue header does not report ${expected.length} registered tools`,
    );
    assert(
      catalog.includes(`(${SEED_SURFACE.length})`),
      "catalogue does not report how many the seed carries",
    );

    // Every tool this profile omits must still be callable, so the omission is
    // presentation only. The probes use tools whose data ships in every
    // checkout, so this runs even where the skill archive is absent.
    const omitted = (await fullCatalog()).filter((name) => !listed.includes(name));
    assert(omitted.length > 0, "the seed carries everything, so this check proves nothing");

    const probe = await callServer([
      toolCall(1, "list_agents"),
      toolCall(2, "read_agent", { name: "exploit-developer" }),
    ]);
    for (const id of [1, 2]) {
      assert(!probe.get(id)?.result?.isError, `omitted tool ${id} was not callable`);
      assert(textOf(probe.get(id)).length > 0, `omitted tool ${id} returned nothing`);
    }
    pass("catalog-complete");
  },

  async "descriptions-apply"() {
    // A profile owns how its tools are WORDED, not just which it carries. Two
    // models can both carry read_source and still need telling in different terms.
    const responses = await callServer([
      listTools(1, { profile: "claude" }),
      listTools(2, { profile: "gpt" }),
      listTools(3, { profile: "full" }),
    ]);

    const byProfile = (frame) => {
      const tools = frame?.result?.tools;
      assert(Array.isArray(tools), "tools/list returned no tools");
      return new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));
    };

    const claude = byProfile(responses.get(1));
    const gpt = byProfile(responses.get(2));
    const full = byProfile(responses.get(3));

    const claudeRead = claude.get("read_source") ?? "";
    const gptRead = gpt.get("read_source") ?? "";
    assert(claudeRead.length > 0 && gptRead.length > 0, "read_source missing from a profile");
    assert(
      claudeRead !== gptRead,
      "two profiles describe read_source identically, so per-tool wording is not applied",
    );

    // `full` carries no overrides, so it must fall back to the server's wording.
    const fullRead = full.get("read_source") ?? "";
    assert(
      fullRead !== claudeRead && fullRead !== gptRead,
      "the unoverridden profile picked up another profile's wording",
    );

    // An override must never leak into a profile that did not ask for it.
    // `gpt` re-words search_skills; `claude` does not, so claude must still be
    // showing the server's own wording.
    const gptSearch = gpt.get("search_skills") ?? "";
    const claudeSearch = claude.get("search_skills") ?? "";
    const fullSearch = full.get("search_skills") ?? "";
    assert(gptSearch !== fullSearch, "gpt's search_skills wording did not apply");
    assert(claudeSearch === fullSearch, "claude picked up another profile's search_skills wording");
    pass("descriptions-apply");
  },

  async "data-driven"() {
    // The design must live in data, not in the engine. Two things are proven
    // here: no shipped surface id is written into the source, and a surface
    // added as a file takes effect with no rebuild.
    const shipped = readdirSync(join(ROOT, "profiles"))
      .filter((name) => name.endsWith(".json") && name !== "manifest.json")
      .map((name) => name.replace(/\.json$/, ""));
    assert(shipped.length > 1, "expected several shipped surfaces");

    // Strip comments so prose mentioning an id is not mistaken for logic.
    const stripComments = (text) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const sources = readdirSync(join(ROOT, "src", "profiles"))
      .filter((name) => name.endsWith(".ts"))
      .concat(["../index.ts"]);

    for (const id of shipped) {
      for (const file of sources) {
        const text = stripComments(readFileSync(join(ROOT, "src", "profiles", file), "utf8"));
        assert(
          !text.includes(`"${id}"`) && !text.includes(`'${id}'`),
          `shipped surface "${id}" is hardcoded in src/profiles/${file}; it belongs in profiles/`,
        );
      }
    }

    // A surface dropped in as a file must be live immediately, with the built
    // artifact untouched: that is what "the design is data" has to mean.
    const probeId = "gate-probe-dropin";
    const probePath = join(ROOT, "profiles", `${probeId}.json`);
    const builtBefore = readFileSync(SERVER, "utf8");

    try {
      writeFileSync(
        probePath,
        JSON.stringify({
          id: probeId,
          label: "Drop-in probe",
          description: "Written by the data-driven gate; must never survive a run.",
          match: { clientNames: ["gate-dropin-client"], models: [] },
          tools: {
            include: ["list_agents", "read_agent"],
            order: ["list_agents", "read_agent"],
            exclude: [],
            descriptions: { list_agents: "DROPIN PROBE WORDING" },
          },
          guidance:
            "This surface exists only to prove that adding a file is enough to extend the system, with no rebuild and no source change.",
          workflow: [],
        }),
        "utf8",
      );

      const byId = await callServer([listTools(1, { profile: probeId })]);
      const names = toolNames(byId.get(1));
      assert(
        names.includes("list_agents") && names.includes(MANIFEST.surfaceCore[0]),
        `a drop-in surface did not take effect: ${names.join(",")}`,
      );

      // Auto-selection from the file must work too, not just an explicit id.
      const byClient = await callServer([listTools(1)], "gate-dropin-client");
      assert(
        toolNames(byClient.get(1)).includes("list_agents"),
        "a drop-in surface's client match was ignored",
      );

      assert(
        readFileSync(SERVER, "utf8") === builtBefore,
        "the build artifact changed during this check, so it proves nothing",
      );
    } finally {
      rmSync(probePath, { force: true });
    }

    assert(!existsSync(probePath), "cleanup failed to remove the drop-in probe");
    pass("data-driven");
  },

  async "surface-escape"() {
    // A narrow profile must never be a trap. Whatever a profile drops, it has to
    // carry the tools that report and change the surface, or a model auto-detected
    // into it cannot discover the catalogue or leave. That would be a capability
    // loss caused by withheld knowledge, landing hardest on the smallest models.
    const CORE = MANIFEST.surfaceCore;
    const ids = [
      "default",
      "full",
      "claude",
      "gpt",
      "gemini",
      "compact",
      "local",
      // An authored profile that tries to exclude the core outright.
      "gate-probe-trapped",
    ];

    const trapped = cleanupProfile("gate-probe-trapped");
    try {
      const created = await callServer([
        toolCall(1, "define_model_profile", {
          id: "gate-probe-trapped",
          label: "Trap Probe",
          description: "Attempts to exclude the surface core",
          guidance:
            "This profile exists only to prove that the surface core cannot be excluded, and must never survive a gate run.",
          tool_include: ["search_skills"],
          tool_exclude: CORE,
        }),
      ]);
      assert(!created.get(1)?.result?.isError, "the trap probe profile was refused outright");

      for (const id of ids) {
        const responses = await callServer([listTools(1, { profile: id })]);
        const names = toolNames(responses.get(1));
        assert(names.length > 0, `profile ${id} presented nothing`);

        for (const tool of CORE) {
          assert(names.includes(tool), `profile "${id}" cannot escape: it does not carry ${tool}`);
        }
      }

      // The escape must actually work, not merely be advertised: a model on the
      // narrowest surface switches out and sees more.
      const session = await openSession();
      try {
        await session.request(toolCall(1, "surface", { set: "local" }));
        const narrow = toolNames(await session.request(listTools(2)));

        await session.request(toolCall(3, "surface", { set: "full" }));
        const wide = toolNames(await session.request(listTools(4)));

        assert(
          wide.length > narrow.length,
          `switching from local (${narrow.length}) to full (${wide.length}) did not widen the surface`,
        );
      } finally {
        session.close();
      }
    } finally {
      cleanupProfile("gate-probe-trapped");
    }

    assert(!existsSync(trapped), "cleanup failed to remove the trap probe profile");
    pass("surface-escape");
  },

  async "detect-client"() {
    const cases = [
      ["Claude Code", "claude"],
      ["gemini-cli", "gemini"],
      ["ollama-runner", "local"],
      ["some-gpt-client", "gpt"],
      ["totally-unknown-client", "default"],
    ];

    for (const [clientName, expected] of cases) {
      const responses = await callServer([toolCall(1, "surface")], clientName);
      const actual = profileIdOf(responses.get(1));
      assert(
        actual === expected,
        `client "${clientName}" resolved to "${actual}", expected "${expected}"`,
      );
    }
    pass("detect-client");
  },

  async "meta-override"() {
    const overridden = await callServer([
      listTools(1, { profile: "compact" }),
      toolCall(2, "surface", {}, { model: "claude-opus-4" }),
      listTools(3),
    ]);

    const compactNames = toolNames(overridden.get(1));
    assert(
      compactNames.length > 0 && compactNames.length < (await fullCatalog()).length,
      `compact profile listed ${compactNames.length} tools, expected fewer than the full catalogue`,
    );
    assert(
      JSON.stringify(compactNames) ===
        JSON.stringify([
          "search_skills",
          "read_skill",
          "skill_stats",
          "list_skills",
          "get_file_tree",
          "surface",
        ]),
      `unexpected compact ordering: ${compactNames.join(",")}`,
    );

    assert(
      profileIdOf(overridden.get(2)) === "claude",
      "a _meta.model of claude-opus-4 did not select the claude profile",
    );

    const control = toolNames(overridden.get(3));
    assert(
      control.length === SEED_SURFACE.length,
      `control request without _meta listed ${control.length} tools, expected the ${SEED_SURFACE.length}-tool seed`,
    );
    pass("meta-override");
  },

  async "filter-advisory"() {
    // A profile shapes presentation only: a tool it does not list must still
    // work when called by name. Probed with data that ships in every checkout.
    const responses = await callServer([
      listTools(1, { profile: "compact" }),
      toolCall(2, "list_agents", {}, { profile: "compact" }),
      toolCall(3, "read_agent", { name: "exploit-developer" }, { profile: "compact" }),
    ]);

    const listed = toolNames(responses.get(1));
    for (const name of ["list_agents", "read_agent"]) {
      assert(!listed.includes(name), `${name} should be omitted from the compact listing`);
    }

    assert(!responses.get(2)?.result?.isError, "an omitted tool was not callable");
    assert(/Available agents \(\d+\)/.test(textOf(responses.get(2))), "no agent listing returned");
    assert(!responses.get(3)?.result?.isError, "an omitted tool was not callable");
    assert(textOf(responses.get(3)).includes("# Agent: exploit-developer"), "agent body missing");
    pass("filter-advisory");
  },

  async "author-profile"() {
    const id = "gate-probe-profile";
    const path = cleanupProfile(id);

    try {
      const created = await callServer([
        toolCall(1, "define_model_profile", {
          id,
          label: "Gate Probe",
          description: "Temporary profile written by the gate harness",
          guidance:
            "This profile exists only to prove that a model can author and persist its own tooling. It narrows the listing to two tools and must never survive a gate run.",
          client_names: [],
          models: ["gate-probe-model"],
          tool_include: ["skill_stats", "search_skills"],
          tool_descriptions: {
            search_skills: "GATE PROBE WORDING: one distinctive word, then stop.",
          },
          workflow: ["Check stats.", "Search."],
        }),
      ]);
      const createText = textOf(created.get(1));
      assert(
        !created.get(1)?.result?.isError,
        `define_model_profile failed: ${createText.slice(0, 200)}`,
      );
      assert(existsSync(path), `profile file was not written to ${path}`);

      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      assert(onDisk.id === id, "persisted profile id mismatch");
      assert(
        onDisk.tools?.descriptions?.search_skills?.startsWith("GATE PROBE WORDING"),
        "the authored tool description was not persisted",
      );

      // A brand-new process must see it, proving persistence rather than cache.
      const session = await openSession();
      try {
        const listed = await session.request(toolCall(1, "surface", { list: "surfaces" }));
        assert(
          textOf(listed).includes(id),
          "a fresh server process did not list the authored profile",
        );

        const selected = await session.request(toolCall(2, "surface", { set: id }));
        assert(
          !selected?.result?.isError,
          `surface refused the authored profile: ${textOf(selected).slice(0, 160)}`,
        );

        const listing = await session.request(listTools(3));
        const names = toolNames(listing);
        // The author's order first, then the surface core the server guarantees.
        assert(
          JSON.stringify(names) === JSON.stringify(["skill_stats", "search_skills", "surface"]),
          `session override did not reshape the listing: ${names.join(",")}`,
        );

        // The model's own wording must reach the listing, not just the disk.
        const described = (listing?.result?.tools ?? []).find(
          (tool) => tool.name === "search_skills",
        );
        assert(
          String(described?.description ?? "").startsWith("GATE PROBE WORDING"),
          "the authored description did not reach tools/list",
        );
      } finally {
        session.close();
      }
    } finally {
      cleanupProfile(id);
    }

    assert(!existsSync(path), "cleanup failed to remove the probe profile");
    pass("author-profile");
  },

  async "id-safety"() {
    const hostile = [
      "../escape",
      "..",
      "a/b",
      "UPPER",
      "has space",
      ".hidden",
      "trailing-",
      "-leading",
      "con",
      "nul",
    ];
    const before = existsSync(PROFILES_DIR) ? readdirSync(PROFILES_DIR).length : 0;

    const responses = await callServer(
      hostile.map((candidate, index) =>
        toolCall(index + 1, "define_model_profile", {
          id: candidate,
          label: "Hostile",
          description: "Should never be written",
          guidance:
            "A hostile identifier must be refused outright and must never reach the filesystem.",
        }),
      ),
    );

    for (let index = 0; index < hostile.length; index++) {
      const response = responses.get(index + 1);
      const refused = Boolean(response?.error) || Boolean(response?.result?.isError);
      assert(refused, `hostile id "${hostile[index]}" was accepted`);
    }

    // Nothing may have appeared anywhere outside the profiles directory.
    for (const stray of [
      "escape.json",
      "hidden.json",
      "UPPER.json",
      "a.json",
      "con.json",
      "nul.json",
    ]) {
      assert(!existsSync(join(ROOT, stray)), `hostile write escaped to ${stray}`);
    }
    const after = existsSync(PROFILES_DIR) ? readdirSync(PROFILES_DIR).length : 0;
    assert(
      after === before,
      `profile directory changed during hostile attempts (${before} -> ${after})`,
    );

    // Positive control: the same call path accepts a valid id.
    const id = "gate-probe-control";
    const path = cleanupProfile(id);
    try {
      const control = await callServer([
        toolCall(1, "define_model_profile", {
          id,
          label: "Control",
          description: "Positive control for the id-safety check",
          guidance:
            "This control proves the rejection above came from the identifier rules and not from a broken tool path.",
        }),
      ]);
      assert(!control.get(1)?.result?.isError, "positive control was refused");
      assert(existsSync(path), "positive control did not write its profile");
    } finally {
      cleanupProfile(id);
    }
    pass("id-safety");
  },

  async "profile-content"() {
    const ids = ["claude", "gpt", "gemini", "compact", "local"];
    const responses = await callServer(
      ids.map((id, index) => toolCall(index + 1, "surface", {}, { profile: id })),
    );

    const guidances = [];
    for (let index = 0; index < ids.length; index++) {
      const text = textOf(responses.get(index + 1));
      assert(text.includes(`(\`${ids[index]}\`)`), `profile ${ids[index]} did not resolve`);

      const guidance = text.split("## Guidance")[1]?.split("Note:")[0]?.trim() ?? "";
      assert(
        guidance.length >= 200,
        `profile ${ids[index]} guidance is only ${guidance.length} chars; expected substantive text`,
      );
      guidances.push(guidance);
    }

    const unique = new Set(guidances);
    assert(
      unique.size === ids.length,
      `expected ${ids.length} distinct guidance bodies, found ${unique.size}`,
    );
    pass("profile-content");
  },

  async "tool-smoke"() {
    if (!archivePresent()) return skipped("tool-smoke");
    const expected = skillsOnDisk();
    assert(expected > 0, "no skills found on disk; cannot measure the index independently");

    const responses = await callServer([
      toolCall(1, "skill_stats"),
      toolCall(2, "get_file_tree", { name: "ags-kdmapper-1909", max_entries: 10 }),
      toolCall(3, "search_skills", { query: "EPT hook", limit: 3 }),
    ]);

    const total = Number(textOf(responses.get(1)).match(/\*\*Total:\*\*\s*(\d+)/)?.[1]);
    assert(
      total === expected,
      `skill_stats reported ${total} but ${expected} SKILL.md files exist on disk`,
    );

    const tree = textOf(responses.get(2));
    assert(
      /\d+ entries \(\d+ files, \d+ directories\)/.test(tree),
      "get_file_tree lost its summary",
    );
    assert(!/https?:\/\//.test(tree), "get_file_tree regressed to listing URLs");

    assert(
      /Found \d+ skills/.test(textOf(responses.get(3))),
      "search_skills returned nothing usable",
    );
    pass("tool-smoke");
  },
  ledger: checkLedger,
};

/**
 * Declare a check skipped because the data it needs is absent.
 *
 * Returning rather than silently passing keeps a skip from being counted as a
 * pass, which is the failure mode that matters: a green battery must never
 * imply coverage it did not have.
 */
function skipped(name) {
  console.log(`gate-skipped:${name}`);
  return "skipped";
}

/**
 * Checks that read the skill archive.
 *
 * The archive is 19 GB, so a CI checkout cannot materialise it. These three
 * compare real data from disk (skill counts, tree sizes, archive greps) and are
 * meaningless without it, so they are skipped rather than faked. The skip is
 * printed and counted: a skip must never be mistakable for a pass.
 */
function archivePresent() {
  return existsSync(SKILLS_DIR) && readdirSync(SKILLS_DIR).length > 0;
}

/**
 * Validate GATES.md against this harness.
 *
 * Catches the failure modes that actually bite: a gate referencing a check that
 * does not exist, numbering that has drifted, and a gate silently left unmet.
 */
async function checkLedger() {
  const path = join(ROOT, "GATES.md");
  assert(existsSync(path), "GATES.md is missing");

  const text = readFileSync(path, "utf8");

  // Parse gate blocks: a heading line plus the indented lines that follow it.
  const blocks = text
    .split(/\n(?=- \[[ x]\] G\d+:)/)
    .filter((block) => /^- \[[ x]\] G\d+:/.test(block))
    .map((block) => {
      const heading = /^- \[([ x])\] (G\d+): (.+)$/m.exec(block);
      const check = /CHECK: (.+)$/m.exec(block);
      return {
        done: heading?.[1] === "x",
        id: heading?.[2] ?? "",
        title: (heading?.[3] ?? "").trim(),
        command: (check?.[1] ?? "").trim(),
      };
    });

  assert(blocks.length > 0, "GATES.md declares no gates");

  for (const [index, gate] of blocks.entries()) {
    assert(gate.id === `G${index + 1}`, `gate ${index + 1} is numbered ${gate.id}`);
    assert(gate.title.length > 0, `${gate.id} has no title`);
    assert(gate.command.length > 0, `${gate.id} has no CHECK line`);
  }

  // Every CHECK line must name a command this harness can actually run, so a
  // renamed or removed check cannot leave the ledger pointing at nothing.
  for (const gate of blocks) {
    const named = /check\.mjs (\S+)/.exec(gate.command);
    if (named) {
      assert(named[1] in CHECKS, `GATES.md references unknown check "${named[1]}"`);
    }
  }

  // This check is its own gate's evidence, so it must not fail on its own
  // checkbox: the run that proves it cannot pass until a previous run has
  // marked it, which cannot happen while it is failing. Every other gate must
  // be met.
  const unmet = blocks
    .filter((gate) => !gate.done && !/check\.mjs ledger/.test(gate.command))
    .map((gate) => gate.id);

  assert(unmet.length === 0, `unmet gates: ${unmet.join(", ")}`);

  pass("ledger");
}

async function runAll() {
  const ran = [];
  const didNotRun = [];

  for (const name of Object.keys(CHECKS)) {
    const outcome = await CHECKS[name]();
    if (outcome === "skipped") didNotRun.push(name);
    else ran.push(name);
  }

  console.log("");
  console.log(`battery: ${ran.length} passed`);

  if (didNotRun.length > 0) {
    console.log(`NOT RUN (${didNotRun.length}, data absent): ${didNotRun.join(", ")}`);
    if (process.env.GATES_REQUIRE_ARCHIVE === "1") {
      fail(
        `GATES_REQUIRE_ARCHIVE=1 but ${didNotRun.length} check(s) could not run: ${didNotRun.join(", ")}`,
      );
    }
  }
}

const command = process.argv[2];
if (command === "all") {
  try {
    await runAll();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
} else {
  const check = CHECKS[command];
  if (!check) {
    console.error(
      `unknown check "${command ?? ""}". Known: ${Object.keys(CHECKS).join(", ")}, all`,
    );
    process.exit(2);
  }

  try {
    await check();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
