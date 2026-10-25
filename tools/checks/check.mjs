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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A promise with its settle functions, without `Promise.withResolvers`.
 *
 * That helper is Node 22+ while this project supports Node 20. Using it
 * in the harness meant the suite passed on a modern local Node and failed on
 * the runner, which is the one place the declared floor should be exercised.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * This module's directory, without `import.meta.dirname`.
 *
 * That property is Node 20.11+, and this package declares `engines: >=18`
 * (the MCP SDK's own floor). Deriving it from `import.meta.url` keeps the
 * declaration true rather than quietly requiring a newer runtime than the
 * package says it needs.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const ROOT = resolve(HERE, "../..");
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
  const responses = await callServer([toolCall(1, "surface", { list: "tools" })]);
  const text = textOf(responses.get(1));
  assert(text.includes("registered"), `catalogue did not render: ${text.slice(0, 160)}`);
  return [...text.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]);
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
  const { promise, resolve: settle, reject } = deferred();

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
    const { promise, resolve } = deferred();
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
    assert(instructions.includes("`surface`"), "instructions do not point a model at `surface`");

    const tools = await callServer([listTools(1)]);
    const names = toolNames(tools.get(1));
    assert(names.includes("surface"), `the seed does not carry \`surface\`: ${names.join(",")}`);
    pass("build-artifact");
  },

  async "no-pre-authored-base"() {
    // The premise this design rests on: if a model builds its own tooling, there
    // is nothing for the server to pre-author. Exactly one surface ships — the
    // seed — and it is not a choice. Any further file here is the server
    // guessing on the model's behalf, which is the thing being avoided.
    const shipped = readdirSync(join(ROOT, "profiles"))
      .filter((name) => name.endsWith(".json") && name !== "manifest.json")
      .map((name) => name.replace(/\.json$/, ""));

    assert(
      shipped.length === 1 && shipped[0] === MANIFEST.seed,
      `expected only the seed to ship, found: ${shipped.join(", ") || "none"}`,
    );

    const authored = existsSync(PROFILES_DIR)
      ? readdirSync(PROFILES_DIR).filter((name) => name.endsWith(".json"))
      : [];
    assert(
      authored.length === 0,
      `surfaces are already saved before any check wrote one: ${authored.join(", ")}`,
    );
    pass("no-pre-authored-base");
  },

  async "seed-surface"() {
    // One tool, and it must be sufficient to decide with: the report has to show
    // the whole catalogue, or there is nothing to choose from.
    const responses = await callServer([listTools(1)], "totally-unknown-client");
    const names = toolNames(responses.get(1));

    assert(names.length === 1, `expected a one-tool seed, got ${names.length}: ${names.join(",")}`);
    assert(
      JSON.stringify(names) === JSON.stringify(SEED_SURFACE),
      `seed does not match profiles/${MANIFEST.seed}.json: ${names.join(",")}`,
    );

    const report = await callServer([toolCall(1, "surface")]);
    const text = textOf(report.get(1));
    assert(!report.get(1)?.result?.isError, "the seed tool failed");
    assert(/## Not carried \(\d+\)/.test(text), "the seed report does not show what exists");

    const catalog = await fullCatalog();
    assert(catalog.length > 10, `catalogue looks empty: ${catalog.length} tools`);
    for (const name of catalog) {
      assert(text.includes(`\`${name}\``), `the seed report omits ${name} from the catalogue`);
    }

    // The guidance is the first thing a model reads, so it must say how to build
    // a surface rather than being a placeholder.
    assert(text.includes("pick"), "the seed guidance does not mention composing a surface");
    assert(text.length > 800, `the seed guidance is too thin to be useful (${text.length} chars)`);
    pass("seed-surface");
  },

  async "compose-pick"() {
    // `pick` is the path: a model builds its own working set rather than being
    // handed one. It must honour the caller's order, report a typo instead of
    // silently shrinking the surface, and refuse a pick naming nothing real.
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

      const typo = await session.request(
        toolCall(3, "surface", { pick: ["search_skills", "no_such_tool"] }),
      );
      assert(textOf(typo).includes("no_such_tool"), "an unknown tool name was accepted silently");
      const after = toolNames(await session.request(listTools(4)));
      assert(
        JSON.stringify(after) === JSON.stringify(["search_skills", "surface"]),
        `pick with a typo produced the wrong surface: ${after.join(",")}`,
      );

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

    const omitted = expected.filter((name) => !listed.includes(name));
    assert(omitted.length > 0, "the seed carries everything, so this check proves nothing");

    // A tool the seed omits must still be callable, so omission is presentation
    // only. The probes use data that ships in every checkout.
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

  async "save-recall"() {
    // A model builds a surface and keeps it. Persistence must survive the
    // process, and the saved surface must be recallable by name and by `_meta`.
    const id = "gate-probe-surface";
    const path = cleanupProfile(id);

    try {
      const session = await openSession();
      try {
        await session.request(
          toolCall(1, "surface", { pick: ["search_skills", "read_skill", "find_offset"] }),
        );
        const saved = await session.request(
          toolCall(2, "surface", {
            save: id,
            guidance:
              "Written by the gate harness to prove a model's own tooling persists across processes. Must never survive a run.",
          }),
        );
        assert(!saved?.result?.isError, `save failed: ${textOf(saved).slice(0, 200)}`);
      } finally {
        session.close();
      }

      assert(existsSync(path), `the surface was not written to ${path}`);
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      assert(onDisk.id === id, "persisted id mismatch");
      for (const tool of ["search_skills", "read_skill", "find_offset"]) {
        assert(onDisk.tools.include.includes(tool), `saved surface lost ${tool}`);
      }

      // A brand-new process must see it, proving persistence rather than cache.
      const reopened = await openSession();
      try {
        const listed = await reopened.request(toolCall(1, "surface", { list: "surfaces" }));
        assert(textOf(listed).includes(id), "a fresh process did not list the saved surface");

        const recalled = await reopened.request(toolCall(2, "surface", { set: id }));
        assert(!recalled?.result?.isError, `set refused the saved surface: ${textOf(recalled)}`);

        const names = toolNames(await reopened.request(listTools(3)));
        for (const tool of ["search_skills", "read_skill", "find_offset"]) {
          assert(names.includes(tool), `recalled surface is missing ${tool}`);
        }
      } finally {
        reopened.close();
      }

      // `_meta.profile` must reach a saved surface too, without a session call.
      const byMeta = await callServer([listTools(1, { profile: id })]);
      const metaNames = toolNames(byMeta.get(1));
      assert(metaNames.includes("find_offset"), "`_meta.profile` did not select the saved surface");

      // Re-saving your own id updates that surface: it is how a model revises
      // its tooling, and refusing would leave no way to change it.
      const reviser = await openSession();
      try {
        await reviser.request(toolCall(1, "surface", { set: id }));
        await reviser.request(toolCall(2, "surface", { pick: ["search_skills", "skill_stats"] }));
        const updated = await reviser.request(
          toolCall(3, "surface", {
            save: id,
            guidance:
              "Re-saved by the gate harness to prove that a model can revise its own surface rather than being stuck with the first version.",
          }),
        );
        assert(!updated?.result?.isError, `re-saving your own id failed: ${textOf(updated)}`);
      } finally {
        reviser.close();
      }

      const revised = JSON.parse(readFileSync(path, "utf8"));
      assert(revised.tools.include.includes("skill_stats"), "the revision did not reach disk");

      // Revising again must say it replaced rather than created, so a model can
      // tell an update from a first save.
      const again = await callServer([
        toolCall(
          1,
          "surface",
          {
            save: id,
            guidance:
              "A third save under the same id, which must report that it replaced the previous version rather than claiming a fresh save.",
          },
          { profile: "picked" },
        ),
      ]);
      assert(!again.get(1)?.result?.isError, "revising the surface failed");
      assert(/Replaced/i.test(textOf(again.get(1))), "an update was not reported as a replacement");
    } finally {
      cleanupProfile(id);
    }

    assert(!existsSync(path), "cleanup failed to remove the probe surface");
    pass("save-recall");
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
        toolCall(index + 1, "surface", {
          save: candidate,
          guidance:
            "A hostile identifier must be refused outright and must never reach the filesystem, whatever else this run does.",
        }),
      ),
    );

    for (let index = 0; index < hostile.length; index++) {
      const response = responses.get(index + 1);
      assert(
        Boolean(response?.error) || Boolean(response?.result?.isError),
        `hostile id "${hostile[index]}" was accepted`,
      );
    }

    const after = existsSync(PROFILES_DIR) ? readdirSync(PROFILES_DIR).length : 0;
    assert(after === before, `the profiles directory changed: ${before} -> ${after}`);
    assert(!existsSync(join(PROFILES_DIR, "..", "escape.json")), "a file escaped the directory");
    pass("id-safety");
  },

  async "surface-escape"() {
    // A narrow surface must never be a trap: whatever it drops, it carries the
    // tool that reports and changes it. Otherwise a model cannot see that a
    // surface governs it, cannot discover the catalogue, and cannot leave.
    const CORE = MANIFEST.surfaceCore;
    const id = "gate-probe-escape";
    const dropIn = join(ROOT, "profiles", `${id}.json`);
    cleanupProfile(id);

    try {
      writeFileSync(
        dropIn,
        JSON.stringify({
          id,
          label: "Escape probe",
          description: "Tries to drop the surface core; must never survive a run.",
          match: { clientNames: [], models: [] },
          tools: {
            include: ["search_skills"],
            order: ["search_skills"],
            exclude: CORE,
            descriptions: {},
          },
          guidance:
            "This surface exists only to prove that the core cannot be dropped by a profile, hand-written or otherwise.",
          workflow: [],
        }),
        "utf8",
      );

      const cases = [
        [MANIFEST.seed, "the seed"],
        [id, "a hand-written profile that excludes the core"],
      ];

      for (const [profileId, label] of cases) {
        const responses = await callServer([listTools(1, { profile: profileId })]);
        const names = toolNames(responses.get(1));
        assert(names.length > 0, `${label} presented nothing`);
        for (const tool of CORE) {
          assert(names.includes(tool), `${label} cannot escape: it does not carry ${tool}`);
        }
      }

      // The escape must work, not merely be advertised.
      const session = await openSession();
      try {
        await session.request(toolCall(1, "surface", { pick: ["search_skills"] }));
        const narrow = toolNames(await session.request(listTools(2)));
        assert(narrow.includes("surface"), "a composed surface dropped the core");

        await session.request(toolCall(3, "surface", { set: "auto" }));
        const seed = toolNames(await session.request(listTools(4)));
        assert(seed.includes("surface"), "clearing did not leave the core in place");
      } finally {
        session.close();
      }
    } finally {
      rmSync(dropIn, { force: true });
      cleanupProfile(id);
    }

    assert(!existsSync(dropIn), "cleanup failed to remove the escape probe");
    pass("surface-escape");
  },

  async "detect-client"() {
    // With nothing pre-authored there is nothing to match, so every client must
    // land on the seed. This is the control proving detection is not secretly
    // handing some clients a base set.
    const clients = ["Claude Code", "gemini-cli", "ollama-runner", "some-gpt-client", "gate-probe"];

    for (const clientName of clients) {
      const responses = await callServer([toolCall(1, "surface")], clientName);
      const id = profileIdOf(responses.get(1));
      assert(id === MANIFEST.seed, `client "${clientName}" resolved to "${id}", expected the seed`);
    }
    pass("detect-client");
  },

  async "filter-advisory"() {
    // A surface shapes presentation only: a tool it does not carry must still
    // work when called by name. Probed with data that ships in every checkout.
    const responses = await callServer([
      listTools(1),
      toolCall(2, "list_agents"),
      toolCall(3, "read_agent", { name: "exploit-developer" }),
    ]);

    const listed = toolNames(responses.get(1));
    for (const name of ["list_agents", "read_agent"]) {
      assert(!listed.includes(name), `${name} should be omitted from the seed listing`);
    }

    assert(!responses.get(2)?.result?.isError, "an omitted tool was not callable");
    assert(/Available agents \(\d+\)/.test(textOf(responses.get(2))), "no agent listing returned");
    assert(!responses.get(3)?.result?.isError, "an omitted tool was not callable");
    assert(textOf(responses.get(3)).includes("# Agent: exploit-developer"), "agent body missing");
    pass("filter-advisory");
  },

  async "engines-honoured"() {
    // The declared runtime floor must be true. A source or harness file that
    // reaches for a newer API than package.json promises passes on a modern
    // local Node and fails on the runner — which is exactly how this project
    // shipped a `Promise.withResolvers` (Node 22) into a package declaring
    // `engines: >=18` while its build tooling needed 20. This check makes that
    // class of bug local, not remote.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const raw = String(pkg.engines?.node ?? "");
    const floor = Number.parseFloat(raw.replace(/[^0-9.]/g, ""));
    assert(Number.isFinite(floor), `package.json declares no usable engines.node (got "${raw}")`);

    // The table is data, read here rather than embedded: a list inside the
    // check that consumes it would be found by the check's own scan.
    const table = JSON.parse(
      readFileSync(join(ROOT, "tools", "checks", "node-api-floors.json"), "utf8"),
    );
    const FLOORS = Object.entries(table.floors).map(([api, min]) => [
      table.patterns[api] ?? api,
      min,
      api,
    ]);

    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
        return /\.(ts|mjs|js)$/.test(entry.name) ? [full] : [];
      });

    // Root-level config counts too: rstack.config.ts runs in Node during a build.
    const rootConfig = readdirSync(ROOT)
      .filter((name) => /\.(ts|mjs|js)$/.test(name))
      .map((name) => join(ROOT, name));

    const files = [
      ...rootConfig,
      ...[join(ROOT, "src"), join(ROOT, "test"), join(ROOT, "tools")]
        .filter((dir) => existsSync(dir))
        .flatMap(walk),
    ];
    assert(files.length > 0, "found no source files to scan");

    // Strip comments: prose naming an API is documentation, not a call.
    const strip = (text) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const violations = [];
    for (const [pattern, min, name] of FLOORS) {
      if (min <= floor) continue;
      for (const file of files) {
        if (strip(readFileSync(file, "utf8")).includes(pattern)) {
          violations.push(
            `${name} (needs Node ${min}) in ${file.replace(ROOT, ".").replace(/\\/g, "/")}`,
          );
        }
      }
    }

    assert(
      violations.length === 0,
      `declared engines.node is >=${floor}, but: ${violations.join("; ")}`,
    );
    pass("engines-honoured");
  },

  async "data-driven"() {
    // The design must live in data, not in the engine. Two things are proven
    // here: no shipped surface id is written into the source, and a surface
    // added as a file takes effect with no rebuild.
    const shipped = readdirSync(join(ROOT, "profiles"))
      .filter((name) => name.endsWith(".json") && name !== "manifest.json")
      .map((name) => name.replace(/\.json$/, ""));
    assert(shipped.length >= 1, "no shipped surface found at all");

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
    // A surface a model drops in belongs in the authored directory, which is
    // read at runtime exactly like the shipped one.
    const probeId = "gate-probe-dropin";
    const probePath = join(ROOT, "model-profiles", `${probeId}.json`);
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

  async "derived-tools"() {
    // A model may define its own tools by binding arguments of registered ones.
    // This is about the call shape, not the capability: a tool it cannot call
    // correctly becomes one it cannot call incorrectly, which is what a weaker
    // model needs most.
    const session = await openSession();
    try {
      const composed = await session.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "read_pinned", args: { name: "exploit-developer" } }],
        }),
      );
      assert(
        !composed?.result?.isError,
        `binding a tool failed: ${textOf(composed).slice(0, 200)}`,
      );

      const listed = (await session.request(listTools(2)))?.result?.tools ?? [];
      const mine = listed.find((tool) => tool.name === "read_pinned");
      assert(mine, "the derived tool was not listed under its own name");

      // The bound argument must leave the schema, or the caller can still get it wrong.
      const properties = mine.inputSchema?.properties ?? {};
      assert(!("name" in properties), "a bound argument is still in the schema");
      assert(
        !(mine.inputSchema?.required ?? []).includes("name"),
        "a bound argument is still required",
      );

      // And it must work with nothing sent at all.
      const called = await session.request(toolCall(3, "read_pinned", {}));
      assert(!called?.result?.isError, `calling the derived tool failed: ${textOf(called)}`);
      assert(
        textOf(called).includes("exploit-developer"),
        "the bound argument did not reach the base tool",
      );

      // Binding is a decision: what the caller sends must not undo it.
      const overridden = await session.request(
        toolCall(4, "read_pinned", { name: "something-else" }),
      );
      assert(
        textOf(overridden).includes("exploit-developer"),
        "a caller-supplied value overrode a bound argument",
      );

      // A partial binding must keep the arguments it did not bind.
      await session.request(
        toolCall(5, "surface", {
          pick: [{ tool: "search_skills", as: "find", args: { limit: 5 } }],
        }),
      );
      const partial = ((await session.request(listTools(6)))?.result?.tools ?? []).find(
        (tool) => tool.name === "find",
      );
      assert(partial, "the partially bound tool was not listed");
      assert(
        "query" in (partial.inputSchema?.properties ?? {}),
        "a partial binding removed an argument it did not bind",
      );
      assert(
        !("limit" in (partial.inputSchema?.properties ?? {})),
        "a partially bound argument stayed in the schema",
      );
    } finally {
      session.close();
    }

    // A tool the model defined is part of what it built, so it has to survive
    // the process, not just the session.
    const id = "gate-probe-derived";
    const path = cleanupProfile(id);
    try {
      const session = await openSession();
      try {
        await session.request(
          toolCall(1, "surface", {
            pick: [{ tool: "read_agent", as: "read_pinned", args: { name: "exploit-developer" } }],
          }),
        );
        const saved = await session.request(
          toolCall(2, "surface", {
            save: id,
            guidance:
              "A gate probe carrying a tool defined by binding an argument. Must never survive a run.",
          }),
        );
        assert(!saved?.result?.isError, `saving a derived tool failed: ${textOf(saved)}`);
      } finally {
        session.close();
      }

      const persisted = JSON.parse(readFileSync(path, "utf8"));
      assert(
        persisted.tools.derived.some((entry) => entry.as === "read_pinned"),
        "the binding was not written to disk",
      );

      const reopened = await openSession();
      try {
        await reopened.request(toolCall(1, "surface", { set: id }));
        const tools = (await reopened.request(listTools(2)))?.result?.tools ?? [];
        const mine = tools.find((tool) => tool.name === "read_pinned");
        assert(mine, "a recalled surface lost the tool it defined");
        assert(
          !("name" in (mine.inputSchema?.properties ?? {})),
          "a recalled surface lost the binding",
        );
        const called = await reopened.request(toolCall(3, "read_pinned", {}));
        assert(
          textOf(called).includes("exploit-developer"),
          "the recalled tool did not apply its bound argument",
        );
      } finally {
        reopened.close();
      }
    } finally {
      cleanupProfile(id);
    }

    // A binding that names nothing must be refused, not listed as a tool that
    // cannot work.
    const bogus = await callServer([
      toolCall(1, "surface", { pick: [{ tool: "no_such_tool", as: "ghost", args: {} }] }),
    ]);
    const response = bogus.get(1);
    assert(
      Boolean(response?.error) || Boolean(response?.result?.isError),
      "a binding of a nonexistent tool was accepted",
    );
    pass("derived-tools");
  },

  async "derived-guards"() {
    // A surface must never be able to lie: not about what an alias does, not
    // about which argument it bound, and not by making a real tool unreachable.
    // Every one of these was a real defect before this gate existed.
    const bad = await callServer([
      toolCall(1, "surface", {
        pick: [
          { tool: "read_agent", as: "dup", args: { name: "exploit-developer" } },
          { tool: "list_agents", as: "dup" },
        ],
      }),
      toolCall(2, "surface", {
        pick: [{ tool: "read_agent", as: "search_skills", args: { name: "exploit-developer" } }],
      }),
      toolCall(3, "surface", {
        pick: [{ tool: "read_agent", as: "typo", args: { nmae: "exploit-developer" } }],
      }),
    ]);

    for (const [id, what] of [
      [1, "a duplicate alias"],
      [2, "an alias stealing a registered tool's name"],
      [3, "a bound argument that does not exist"],
    ]) {
      const response = bad.get(id);
      assert(
        Boolean(response?.error) || Boolean(response?.result?.isError),
        `${what} was accepted`,
      );
    }

    // A typo must name the real arguments, or the caller cannot fix it.
    assert(
      textOf(bad.get(3)).includes("`name`"),
      "a rejected bound argument did not say what the tool actually takes",
    );

    // All problems at once, not one per round trip.
    const many = await callServer([
      toolCall(1, "surface", {
        pick: [
          { tool: "read_agent", as: "dup", args: { nmae: "x" } },
          { tool: "list_agents", as: "dup" },
          { tool: "read_agent", as: "search_skills" },
        ],
      }),
    ]);
    const report = textOf(many.get(1));
    assert(
      report.includes("nmae") && report.includes("dup") && report.includes("search_skills"),
      `one call did not report every problem: ${report.slice(0, 200)}`,
    );

    // The same rules must hold for a profile that was hand-edited on disk, which
    // never passes through `pick` at all.
    const id = "gate-probe-liar";
    const path = join(ROOT, "model-profiles", `${id}.json`);
    cleanupProfile(id);

    try {
      writeFileSync(
        path,
        JSON.stringify({
          id,
          label: "Liar probe",
          description: "Hand-edited entries that pick would refuse; must never survive a run.",
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
            "Written directly to disk to prove the shaper fails closed on entries that pick would refuse.",
          workflow: [],
        }),
        "utf8",
      );

      const meta = { profile: id };
      const listed = await callServer([listTools(1, meta)]);
      const names = toolNames(listed.get(1));

      // The stolen name must still be the real tool. Both probes read the
      // committed agents/ tree rather than the skill archive, which a CI
      // checkout cannot materialise.
      const real = await callServer([toolCall(1, "list_agents", {}, meta)]);
      assert(!real.get(1)?.result?.isError, "the real tool was not callable");
      assert(
        /Available agents \(\d+\)/.test(textOf(real.get(1))),
        "a hand-edited file hijacked a registered tool's name",
      );

      // An entry that cannot be honoured is dropped, not approximated.
      assert(!names.includes("typo"), "an entry with a bogus argument was still defined");

      // And for a duplicated alias, the listing and the call must agree about
      // which entry won: they disagreed before this was resolved from one place.
      assert(names.includes("dup"), "the duplicated alias vanished entirely");
      const shown = (listed.get(1)?.result?.tools ?? []).find((tool) => tool.name === "dup");
      const called = await callServer([toolCall(1, "dup", {}, meta)]);

      // The markers must be unambiguous: read_agent answers with an agent body,
      // list_agents with a category listing, and neither description mentions
      // the other's business. A loose match here would pass on either branch,
      // which is how the first version of this check missed the duplicate bug.
      const describesRead = /full definition and system prompt/.test(shown?.description ?? "");
      const describesList = /grouped by category/.test(shown?.description ?? "");
      const callsRead = textOf(called.get(1)).includes("# Agent:");
      const callsList = /Available agents \(\d+\)/.test(textOf(called.get(1)));

      assert(
        describesRead !== describesList,
        `the listing describes neither entry cleanly: ${(shown?.description ?? "").slice(0, 80)}`,
      );
      assert(callsRead !== callsList, "the call matched neither entry cleanly");
      assert(
        describesRead === callsRead,
        `the listing and the call disagree about \`dup\`: listing says read_agent=${describesRead}, ` +
          `call says read_agent=${callsRead}`,
      );
    } finally {
      rmSync(path, { force: true });
      cleanupProfile(id);
    }

    pass("derived-guards");
  },

  async "derived-narrowing"() {
    // Four things can happen to an argument, and they are deliberately distinct:
    // fixed (leaves the schema), defaulted (stays, omittable, shows the value),
    // constrained (stays, narrows, and is ENFORCED), re-worded (stays, renamed).
    // This proves the middle two, which is where a surface most easily lies: a
    // default that is ignored, or a range that is advertised but not kept.
    //
    // Everything here runs without the skill archive. The success paths use
    // `read_agent`, which reads the committed agents/ tree, and the numeric
    // range is proven by its REFUSAL, which the surface layer decides before the
    // tool executes. A check that needs absent data would fail on CI while
    // passing locally, which is how an earlier version of this gate behaved.
    const session = await openSession();
    try {
      const composed = await session.request(
        toolCall(1, "surface", {
          pick: [
            {
              tool: "read_agent",
              as: "mine",
              defaults: { name: "exploit-developer" },
              constrain: { name: { enum: ["exploit-developer", "anti-cheat-analyst"] } },
              argDescriptions: { name: "Which agent to read." },
            },
          ],
        }),
      );
      assert(!composed?.result?.isError, `default + constraint refused: ${textOf(composed)}`);

      const mine = ((await session.request(listTools(2)))?.result?.tools ?? []).find(
        (tool) => tool.name === "mine",
      );
      assert(mine, "the narrowed tool was not listed");
      const name = mine.inputSchema?.properties?.name ?? {};

      // The schema must say what will happen: the value it will use, the set it
      // will enforce, and the argument must stay overridable.
      assert(name.default === "exploit-developer", "the default is not visible in the schema");
      assert(
        Array.isArray(name.enum) && name.enum.length === 2,
        "the constraint is not written into the schema",
      );
      assert(
        !(mine.inputSchema?.required ?? []).includes("name"),
        "an argument with a default must not still be required",
      );

      // Omitted: the default applies.
      const omitted = await session.request(toolCall(3, "mine", {}));
      assert(!omitted?.result?.isError, `the defaulted call failed: ${textOf(omitted)}`);
      assert(
        textOf(omitted).includes("# Agent: exploit-developer"),
        `the default was not applied: ${textOf(omitted).slice(0, 60)}`,
      );

      // Supplied and allowed: the caller wins over the default.
      const allowed = await session.request(toolCall(4, "mine", { name: "anti-cheat-analyst" }));
      assert(!allowed?.result?.isError, "a value inside the enum was refused");
      assert(
        textOf(allowed).includes("# Agent: anti-cheat-analyst"),
        "the caller's value did not override the default",
      );

      // Supplied and outside the enum: refused, and the refusal names the set.
      const refused = await session.request(toolCall(5, "mine", { name: "not-in-the-list" }));
      assert(Boolean(refused?.result?.isError), "a value outside the enum was accepted");
      assert(
        textOf(refused).includes("exploit-developer"),
        "the refusal did not list the allowed values",
      );
    } finally {
      session.close();
    }

    // A numeric range is enforced too, and the refusal names the bound.
    const numeric = await openSession();
    try {
      await numeric.request(
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
      const outOfRange = await numeric.request(
        toolCall(2, "find", { query: "kdmapper", limit: 99 }),
      );
      assert(Boolean(outOfRange?.result?.isError), "a value outside the range was accepted");
      assert(textOf(outOfRange).includes("at most 3"), "the refusal did not say what the range is");
    } finally {
      numeric.close();
    }

    // The contradictions. Each would leave the surface saying something it does
    // not do, so each is refused rather than accepted as a no-op.
    const conflicts = await callServer([
      // The tool's own default (20) is outside the narrowed range.
      toolCall(1, "surface", {
        pick: [{ tool: "search_skills", as: "c1", constrain: { limit: { maximum: 3 } } }],
      }),
      // A default outside its own constraint.
      toolCall(2, "surface", {
        pick: [
          {
            tool: "search_skills",
            as: "c2",
            defaults: { limit: 99 },
            constrain: { limit: { maximum: 3 } },
          },
        ],
      }),
      // A default or constraint on a fixed argument is inert.
      toolCall(3, "surface", {
        pick: [
          {
            tool: "read_agent",
            as: "c3",
            args: { name: "exploit-developer" },
            defaults: { name: "other" },
          },
        ],
      }),
    ]);

    for (const [id, what] of [
      [1, "a constraint the tool's own default breaks"],
      [2, "a default that breaks its own constraint"],
      [3, "a default on a fixed argument"],
    ]) {
      const response = conflicts.get(id);
      assert(
        Boolean(response?.error) || Boolean(response?.result?.isError),
        `${what} was accepted`,
      );
    }
    assert(
      /already defaults/i.test(textOf(conflicts.get(1))),
      "the conflicting constraint did not explain which default it breaks",
    );

    // And it must survive the process, because it is part of what was built.
    const id = "gate-probe-narrowing";
    const path = cleanupProfile(id);
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
        const saved = await builder.request(
          toolCall(2, "surface", {
            save: id,
            guidance:
              "A gate probe carrying a default, to prove it survives a process boundary rather than living in memory.",
          }),
        );
        assert(!saved?.result?.isError, `saving failed: ${textOf(saved)}`);
      } finally {
        builder.close();
      }

      const reopened = await openSession();
      try {
        await reopened.request(toolCall(1, "surface", { set: id }));
        const mine = ((await reopened.request(listTools(2)))?.result?.tools ?? []).find(
          (tool) => tool.name === "mine",
        );
        assert(
          mine?.inputSchema?.properties?.name?.default === "exploit-developer",
          "the default was lost",
        );
        assert(
          mine?.inputSchema?.properties?.name?.description === "Which agent to read.",
          "the re-wording was lost",
        );
        assert(
          textOf(await reopened.request(toolCall(3, "mine", {}))).includes(
            "# Agent: exploit-developer",
          ),
          "the recalled default was not applied",
        );
      } finally {
        reopened.close();
      }
    } finally {
      cleanupProfile(id);
    }

    assert(!existsSync(path), "cleanup failed to remove the probe surface");
    pass("derived-narrowing");
  },

  async "output-shaping"() {
    // The mirror of shaping the call. The property that matters most is honesty:
    // a shaped answer must never read as the whole truth, so every reduction is
    // reported, and a failure is never shaped at all because a truncated error
    // hides the reason for the failure.
    //
    // Uses `read_agent`, which reads the committed agents/ tree, so this holds on
    // a runner without the skill archive.
    const shape = async (output) => {
      const session = await openSession();
      try {
        const composed = await session.request(
          toolCall(1, "surface", { pick: [{ tool: "read_agent", as: "mine", output }] }),
        );
        assert(!composed?.result?.isError, `shaping refused: ${textOf(composed).slice(0, 160)}`);
        const answered = await session.request(toolCall(2, "mine", { name: "exploit-developer" }));
        assert(!answered?.result?.isError, `the shaped call failed: ${textOf(answered)}`);
        return textOf(answered);
      } finally {
        session.close();
      }
    };

    const whole = await (async () => {
      const responses = await callServer([
        toolCall(1, "read_agent", { name: "exploit-developer" }),
      ]);
      return textOf(responses.get(1));
    })();

    // The LISTING has to say a tool truncates, not only the result. A model that
    // learns the rule from the note has already read a partial answer as whole.
    // Round-tripped, not batched: a batch is dispatched concurrently, so the
    // listing can run before the compose it is meant to observe.
    const declaredSession = await openSession();
    try {
      await declaredSession.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "who", output: { sections: ["Workflow"], head: 10 } }],
        }),
      );
      const who = ((await declaredSession.request(listTools(2)))?.result?.tools ?? []).find(
        (tool) => tool.name === "who",
      );
      assert(who, "the shaped tool was not listed");
      assert(
        /Workflow/.test(who.description ?? "") && /first 10 lines/.test(who.description ?? ""),
        `the listing does not declare the shaping: ${(who.description ?? "").slice(0, 120)}`,
      );
    } finally {
      declaredSession.close();
    }

    // head: a prefix of the whole, and the note says how much was kept.
    const headed = await shape({ head: 5 });
    const answer = headed.split("\n\n[shaped:")[0] ?? "";
    assert(whole.startsWith(answer), "head did not return a prefix of the answer");
    assert(answer.length < whole.length, "head returned the whole answer, so it proves nothing");
    assert(
      /\[shaped: 5 of \d+ lines — head: 5\]/.test(headed),
      `head did not report the reduction: ${headed.slice(-90)}`,
    );

    // filter: only matching lines survive, and the rule is named.
    const filtered = await shape({ filter: "##" });
    for (const line of filtered.split("\n")) {
      if (line.length === 0 || line.startsWith("[shaped:")) continue;
      assert(line.includes("##"), `a line survived the filter that does not match: ${line}`);
    }
    assert(/filter: `##`/.test(filtered), "the filter was not named in the note");

    // sections: the named section only, heading included.
    const sectioned = await shape({ sections: ["Workflow"] });
    assert(sectioned.includes("## Workflow"), "the requested section is missing");
    assert(
      !sectioned.includes("## Available Subagents"),
      "a section that was not requested survived",
    );

    // Order is fixed and every rule that acted is named.
    const combined = await shape({ sections: ["Workflow"], head: 4 });
    assert(
      /sections: Workflow; head: 4/.test(combined),
      `the note does not name both rules in order: ${combined.slice(-90)}`,
    );

    // Nothing matched is stated, not returned as a blank answer.
    const nothing = await shape({ filter: "ZZZ_NO_SUCH_THING" });
    assert(/nothing matched/.test(nothing), `an empty result was not explained: ${nothing}`);
    assert(/0 of \d+ lines/.test(nothing), "the empty result did not say what it kept");

    // A rule that removed nothing must NOT claim a reduction, or the note is its
    // own small lie.
    const noop = await shape({ head: 100000 });
    assert(!noop.includes("[shaped:"), "a rule that removed nothing still reported a reduction");

    // A failure is never shaped: the reason must survive intact.
    //
    // The rule here REMOVES EVERYTHING it is applied to, so if an error were
    // shaped the reason would vanish entirely. A milder rule would not prove
    // this: a one-line error survives `head: 1` untouched, which is how an
    // earlier version of this check passed while errors were being shaped.
    const failureSession = await openSession();
    try {
      await failureSession.request(
        toolCall(1, "surface", {
          pick: [{ tool: "read_agent", as: "mine", output: { filter: "ZZZ_NEVER_MATCHES" } }],
        }),
      );
      const failed = await failureSession.request(
        toolCall(2, "mine", { name: "no-such-agent-xyz" }),
      );
      assert(Boolean(failed?.result?.isError), "the failing call was not reported as an error");
      assert(
        textOf(failed).includes("no-such-agent-xyz"),
        "shaping removed the reason for a failure",
      );
      assert(!textOf(failed).includes("[shaped:"), "a failure was shaped");
      assert(
        !textOf(failed).includes("nothing matched"),
        "a failure was filtered away by the shaping rule",
      );
    } finally {
      failureSession.close();
    }

    // A rule that cannot do what it says is refused with the reason.
    const bad = await callServer([
      toolCall(1, "surface", {
        pick: [{ tool: "read_agent", as: "b1", output: { head: 2, tail: 2 } }],
      }),
      toolCall(2, "surface", {
        pick: [{ tool: "read_agent", as: "b2", output: { filter: "[unclosed" } }],
      }),
    ]);
    for (const [id, what] of [
      [1, "head together with tail"],
      [2, "a pattern that will not compile"],
    ]) {
      const response = bad.get(id);
      assert(
        Boolean(response?.error) || Boolean(response?.result?.isError),
        `${what} was accepted`,
      );
    }
    assert(
      textOf(bad.get(2)).includes("[unclosed"),
      "the invalid pattern was not named in the refusal",
    );

    // And the rule is part of what was built, so it survives the process.
    const id = "gate-probe-output";
    const path = cleanupProfile(id);
    try {
      const builder = await openSession();
      try {
        await builder.request(
          toolCall(1, "surface", {
            pick: [{ tool: "read_agent", as: "mine", output: { sections: ["Workflow"] } }],
          }),
        );
        const saved = await builder.request(
          toolCall(2, "surface", {
            save: id,
            guidance:
              "A gate probe carrying an output rule, to prove the shaping survives a process boundary.",
          }),
        );
        assert(!saved?.result?.isError, `saving failed: ${textOf(saved)}`);
      } finally {
        builder.close();
      }

      const reopened = await openSession();
      try {
        await reopened.request(toolCall(1, "surface", { set: id }));
        const recalled = await reopened.request(toolCall(2, "mine", { name: "exploit-developer" }));
        assert(
          textOf(recalled).includes("## Workflow"),
          "the recalled surface lost the section rule",
        );
        assert(
          !textOf(recalled).includes("## Available Subagents"),
          "the recalled surface did not apply the section rule",
        );
      } finally {
        reopened.close();
      }
    } finally {
      cleanupProfile(id);
    }

    assert(!existsSync(path), "cleanup failed to remove the probe surface");
    pass("output-shaping");
  },

  async chain() {
    // A chain is a declaration, not a program: fixed sequence, no branching,
    // every failure names the step, and the trace says what ran. Chains
    // `list_agents` into `read_agent`, which read the committed agents/ tree, so
    // this holds on a runner without the 19 GB skill archive.
    const AGENT_NAME = "- \\*\\*([^*]+)\\*\\*";
    const id = "gate-probe-chain";
    const path = cleanupProfile(id);

    try {
      // The trace: which step ran, with what, and how much came back.
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
        assert(!composed?.result?.isError, `composing the chain failed: ${textOf(composed)}`);

        const answered = await session.request(toolCall(2, "first_agent", {}));
        assert(!answered?.result?.isError, `the chain failed: ${textOf(answered)}`);
        const text = textOf(answered);

        assert(
          text.includes("[chain] list_agents → read_agent"),
          `the answer does not open with the chain: ${text.slice(0, 120)}`,
        );
        assert(
          /\[2\] read_agent\(name=[a-z0-9-]+\) → \d+ chars/.test(text),
          "the trace does not name the second step, its arguments and its size",
        );
        assert(text.includes("# Agent: "), "the second step's answer did not arrive");
      } finally {
        session.close();
      }

      // Fan-out: one call per match, each labelled. A content rule must not be
      // able to strip the labels, or the model cannot tell the results apart.
      const fanned = await openSession();
      try {
        await fanned.request(
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
        const text = textOf(await fanned.request(toolCall(2, "two_agents", {})));
        const labels = text.match(/--- name=[a-z0-9-]+ ---/g) ?? [];
        assert(
          labels.length === 2,
          `fan-out did not label both results (found ${labels.length}); a content rule must not strip them`,
        );
      } finally {
        fanned.close();
      }

      // Fewer matches than asked is not a failure, but it IS reported: silently
      // reading one of the three things you asked for is a lie.
      const short = await openSession();
      try {
        await short.request(
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
        const text = textOf(await short.request(toolCall(2, "short", {})));
        assert(
          /asked for 3, only 1 matched/.test(text),
          `a short fan-out was not reported: ${text.slice(0, 160)}`,
        );
      } finally {
        short.close();
      }

      // A step that fails stops the chain and names itself, with the error.
      const broken = await openSession();
      try {
        await broken.request(
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
        const failed = await broken.request(toolCall(2, "broken", {}));
        assert(Boolean(failed?.result?.isError), "a failing step did not stop the chain");
        assert(
          /Step 2 \(read_agent\) failed/.test(textOf(failed)),
          `the failing step was not named: ${textOf(failed).slice(0, 160)}`,
        );
      } finally {
        broken.close();
      }

      // An extraction that matches nothing stops the chain and shows the pattern
      // AND the answer, which is what the model needs to fix the pattern.
      const nomatch = await openSession();
      try {
        await nomatch.request(
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
        const failed = await nomatch.request(toolCall(2, "nomatch", {}));
        assert(Boolean(failed?.result?.isError), "an unmatched extraction did not stop the chain");
        assert(textOf(failed).includes("NOPE"), "the failing pattern was not shown");
        assert(
          textOf(failed).includes("Available agents"),
          "the answer the pattern was matched against was not shown",
        );
      } finally {
        nomatch.close();
      }

      // A step may call a tool this surface defined; the trace names the tool
      // that actually ran, so an alias never hides what happened.
      const aliased = await openSession();
      try {
        await aliased.request(
          toolCall(1, "surface", {
            pick: [
              { tool: "read_agent", as: "read_pinned", args: { name: "exploit-developer" } },
              { tool: "list_agents", as: "flow", then: [{ tool: "read_pinned" }] },
            ],
          }),
        );
        const text = textOf(await aliased.request(toolCall(2, "flow", {})));
        assert(text.includes("[chain] list_agents → read_pinned"), "the chain header is wrong");
        assert(
          /\[2\] read_agent\(name=exploit-developer\)/.test(text),
          "the trace did not name the tool that actually ran",
        );
      } finally {
        aliased.close();
      }

      // The listing declares the chain before it is called, so a model is not
      // surprised by a search tool that returns a document.
      const declared = await openSession();
      try {
        await declared.request(
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
        const tool = ((await declared.request(listTools(2)))?.result?.tools ?? []).find(
          (entry) => entry.name === "two_agents",
        );
        assert(
          /Runs a chain/.test(tool?.description ?? ""),
          `the listing does not declare the chain: ${(tool?.description ?? "").slice(0, 120)}`,
        );
      } finally {
        declared.close();
      }

      // Everything a bad chain can get wrong is refused with a reason, in one
      // call, rather than failing after the chain has already run partway.
      const bad = await callServer([
        toolCall(1, "surface", {
          pick: [
            {
              tool: "list_agents",
              as: "inner",
              then: [{ tool: "read_agent", extract: { name: AGENT_NAME } }],
            },
            { tool: "list_agents", as: "outer", then: [{ tool: "inner" }] },
          ],
        }),
        toolCall(2, "surface", {
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
      ]);

      for (const [index, what] of [
        [1, "a chain nested inside a chain"],
        [2, "a chain with three separate faults"],
      ]) {
        const response = bad.get(index);
        assert(
          Boolean(response?.error) || Boolean(response?.result?.isError),
          `${what} was accepted`,
        );
      }
      assert(
        /chains cannot nest/.test(textOf(bad.get(1))),
        "nesting was refused without saying why",
      );

      const many = textOf(bad.get(2));
      for (const named of ["no_such_tool", "nmae", "[bad"]) {
        assert(
          many.includes(named),
          `the refusal did not report \`${named}\`: ${many.slice(0, 200)}`,
        );
      }

      // And the chain is part of what was built, so it survives the process.
      const builder = await openSession();
      try {
        await builder.request(
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
        const saved = await builder.request(
          toolCall(2, "surface", {
            save: id,
            guidance:
              "A gate probe carrying a chain, to prove the sequence survives a process boundary.",
          }),
        );
        assert(!saved?.result?.isError, `saving the chain failed: ${textOf(saved)}`);
      } finally {
        builder.close();
      }

      const reopened = await openSession();
      try {
        await reopened.request(toolCall(1, "surface", { set: id }));
        const text = textOf(await reopened.request(toolCall(2, "two_agents", {})));
        assert(
          text.includes("[chain] list_agents → read_agent"),
          "a recalled chain lost its sequence",
        );
        assert(
          (text.match(/--- name=[a-z0-9-]+ ---/g) ?? []).length === 2,
          "a recalled chain lost its fan-out",
        );
      } finally {
        reopened.close();
      }
    } finally {
      cleanupProfile(id);
    }

    assert(!existsSync(path), "cleanup failed to remove the probe surface");
    pass("chain");
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
