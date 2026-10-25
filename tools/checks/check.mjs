#!/usr/bin/env node
/**
 * Gate oracle for the mcp-gamehacking code harness.
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
 *
 * The harness directory is a temp dir for every gate, so the battery can never
 * read or write a real home directory.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A promise with its settle functions, without `Promise.withResolvers`.
 *
 * That helper is Node 22+ while this project supports Node 20. Using it in the
 * harness meant the suite passed on a modern local Node and failed on the
 * runner, which is the one place the declared floor should be exercised.
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
 * That property is Node 20.11+, and this package declares a floor the MCP SDK
 * also honours. Deriving it from `import.meta.url` keeps the declaration true
 * rather than quietly requiring a newer runtime than the package says it needs.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const ROOT = resolve(HERE, "../..");
const SERVER = join(ROOT, "dist", "index.js");
const SKILLS_DIR = join(ROOT, "skills");

const TOOL = "run";
const ENV_VAR = "GAMEHACKING_HARNESS_DIR";

/** A fresh temp harness directory, so no gate touches a real home directory. */
function tempHarnessDir() {
  return mkdtempSync(join(tmpdir(), "gamehacking-gate-"));
}

/** Ground truth for the skill count: a directory holding a SKILL.md. */
function skillsOnDisk() {
  if (!existsSync(SKILLS_DIR)) return 0;
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(SKILLS_DIR, entry.name, "SKILL.md"))).length;
}

function archivePresent() {
  return skillsOnDisk() > 0;
}

function skip(name, why) {
  if (process.env.GATES_REQUIRE_ARCHIVE === "1") {
    throw new Error(`${name}: ${why} (GATES_REQUIRE_ARCHIVE=1)`);
  }
  console.log(`gate-skipped:${name} (${why})`);
  process.exit(0);
}

function pass(name) {
  console.log(`gate-passed:${name}`);
  process.exit(0);
}

function fail(name, reason) {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

function assert(condition, reason) {
  if (!condition) throw new Error(reason);
}

/**
 * Spawn the built server and exchange one request at a time.
 *
 * Round-tripping matters: this SDK dispatches a pipelined batch CONCURRENTLY, so
 * response order is not arrival order, and an assertion meaning "do this, then
 * observe it" cannot be expressed as a batch.
 */
async function openSession({ env = {}, clientName = "gate" } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, [ENV_VAR]: tempHarnessDir(), ...env },
    signal: AbortSignal.timeout(120_000),
  });

  const pending = new Map();
  const notifications = [];
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
      // Checked before anything else: a notification has a method and no id, so
      // a filter that expects a reply would discard it and the announcement
      // would be invisible to this harness.
      if (typeof frame.method === "string" && frame.id === undefined) {
        notifications.push(frame.method);
        continue;
      }
      const settle = pending.get(frame.id);
      if (settle) {
        pending.delete(frame.id);
        settle(frame);
      }
    }
  });

  const exited = deferred();
  child.on("close", (code) => {
    exited.resolve(code);
    for (const [, settle] of pending) {
      settle({
        result: { isError: true, content: [{ text: `server exited (${code}) ${stderr}` }] },
      });
    }
    pending.clear();
  });

  const request = (message) => {
    const { promise, resolve: settle } = deferred();
    if (message.id === undefined) {
      // A notification has no reply, so there is nothing to await: returning an
      // unresolved promise here deadlocks the handshake.
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return Promise.resolve();
    }
    pending.set(message.id, settle);
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  };

  await request({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    },
  });
  await request({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    request,
    notifications,
    close: () => child.kill(),
    stderr: () => stderr,
  };
}

/** Text of a tools/call result. */
function textOf(frame) {
  const content = frame?.result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function wasRefused(frame) {
  return Boolean(frame?.result?.isError) || Boolean(frame?.error);
}

/** The names a tools/list returns. */
function toolNames(frame) {
  return (frame?.result?.tools ?? []).map((tool) => tool.name);
}

/** Run code through the tool. */
async function run(session, code, extra = {}) {
  return textOf(
    await session.request({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method: "tools/call",
      params: { name: TOOL, arguments: { code, ...extra } },
    }),
  );
}

async function callTool(session, args) {
  return session.request({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e9),
    method: "tools/call",
    params: { name: TOOL, arguments: args },
  });
}

/** Run one gate in its own temp harness dir, and clean up after. */
async function gate(name, body) {
  const dir = tempHarnessDir();
  try {
    await body(dir);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The env that points a spawned server at a specific harness dir. */
const envFor = (dir) => ({ [ENV_VAR]: dir });

const gates = {
  // --------------------------------------------------------------- the shape

  async "single-tool"() {
    await gate("single-tool", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        const listed = await session.request({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        });
        const names = toolNames(listed);
        assert(names.length === 1, `expected exactly one tool, got ${names.join(", ")}`);
        assert(names[0] === TOOL, `the one tool is ${names[0]}, not ${TOOL}`);

        // A capability advertised as a tool would be the typed-verb catalog this
        // design removes.
        for (const capability of ["search_skills", "read_skill", "skill_stats", "get_file_tree"]) {
          assert(!names.includes(capability), `${capability} is advertised as a tool`);
        }
      } finally {
        session.close();
      }
      pass("single-tool");
    });
  },

  async "no-per-model-branching"() {
    await gate("no-per-model-branching", async (dir) => {
      // Adaptation is emergent: each deployment's model accretes its own helpers.
      // A tool set that varies by caller identity would be a per-model switch.
      const surfaces = [];
      for (const clientName of ["claude-3-5-sonnet", "gpt-4o", "gemini-2.0", ""]) {
        const session = await openSession({ env: envFor(dir), clientName });
        try {
          const listed = await session.request({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          });
          surfaces.push(toolNames(listed).join(","));
        } finally {
          session.close();
        }
      }
      const unique = new Set(surfaces);
      assert(unique.size === 1, `the surface differs by client: ${[...unique].join(" | ")}`);
      pass("no-per-model-branching");
    });
  },

  async "no-toggle"() {
    await gate("no-toggle", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        const listed = await session.request({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        });
        const schema = JSON.stringify(listed?.result?.tools?.[0]?.inputSchema ?? {});
        assert(
          !/enable|disable|allow_code|safe_mode|read_only/i.test(schema),
          "the tool publishes an enable/disable-style flag",
        );
        // Running code IS the tool; there is no code-free alternative to select.
        assert(schema.includes("code"), "the tool does not publish `code`");

        // And the common case needs no arguments at all.
        const bare = await callTool(session, {});
        assert(!wasRefused(bare), `a no-argument call was refused: ${textOf(bare).slice(0, 120)}`);
      } finally {
        session.close();
      }
      pass("no-toggle");
    });
  },

  // ---------------------------------------------------------- discovery

  async manual() {
    await gate("manual", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        const manual = await run(session, "");
        // The manual has to name the vocabulary and say what the project offers,
        // or a model has nothing to bootstrap from.
        for (const word of ["describe", "kept", "forget", "S", "open"]) {
          assert(manual.includes(word), `the manual does not name ${word}`);
        }
        assert(/search_skills/.test(manual), "the manual does not name a capability");
        assert(/capabilit|offers/i.test(manual), "the manual does not say what is offered");
      } finally {
        session.close();
      }
      pass("manual");
    });
  },

  async "describe-real-types"() {
    await gate("describe-real-types", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        const described = await run(session, "describe(search_skills)");
        assert(described.includes("search_skills"), "describe did not name the capability");
        assert(
          /query: string/.test(described),
          `describe did not report a real type: ${described}`,
        );
        assert(!/query: any/.test(described), "describe reported `any` for a real type");

        // An object reports its public members, so a model can navigate.
        const object = await run(session, "describe(kb)");
        assert(object.includes("skills"), "describe(kb) did not report its members");
      } finally {
        session.close();
      }
      pass("describe-real-types");
    });
  },

  // ------------------------------------------------- one long-lived namespace

  async "persist-calls"() {
    await gate("persist-calls", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        await run(session, "const tag = (s) => `[${s}]`;");
        const reused = await run(session, 'tag("second call")');
        assert(reused === "[second call]", `a helper did not persist: ${JSON.stringify(reused)}`);

        // Refining a helper is the main thing a persistent namespace is for.
        const refined = await run(session, 'const tag = (s) => `<<${s}>>`; tag("third")');
        assert(refined === "<<third>>", `redefinition failed: ${JSON.stringify(refined)}`);

        // Variables, functions and classes all persist.
        await run(
          session,
          "const n = 42; function hello(w){ return 'hi ' + w; } class Box { m(){ return 7 } }",
        );
        assert((await run(session, "n")) === "42", "a variable did not persist");
        assert((await run(session, "hello('x')")) === "hi x", "a function did not persist");
        assert((await run(session, "new Box().m()")) === "7", "a class did not persist");
      } finally {
        session.close();
      }
      pass("persist-calls");
    });
  },

  async "helper-identity"() {
    await gate("helper-identity", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        // Found by driving the live host: the helper worked but had lost its
        // name, and `describe` reported a body line as documentation. Both make
        // the discovery surface lie about the model's own tools.
        await run(session, "/** Build a short briefing. */\nconst briefing = async (q) => q;");
        const described = await run(session, "describe(briefing)");
        assert(/^briefing\(/.test(described), `the helper lost its name: ${described}`);
        assert(
          described.includes("Build a short briefing."),
          `the author's description was dropped: ${described}`,
        );
        assert(!/=>/.test(described), `a body line was reported as documentation: ${described}`);

        // A helper with no description reports none, rather than borrowing one.
        await run(session, "const undescribed = (x) => x;");
        const bare = await run(session, "describe(undescribed)");
        assert(!/=>|return|const /.test(bare), `a body line was reported: ${bare}`);

        // And a comment above an EARLIER statement is not stolen.
        await run(session, "const earlier = 1;\n/** Belongs to later. */\nconst later = (x) => x;");
        assert(
          !(await run(session, "describe(earlier)")).includes("Belongs to later."),
          "a comment was attached to the wrong declaration",
        );

        // A statement between a comment and a definition means the comment is
        // not that definition's: only whitespace may separate them.
        await run(
          session,
          "/** Documents first. */\nconst first = 1;\nconst between = 2;\nconst after = 3;",
        );
        assert(
          (await run(session, "describe(first)")).includes("Documents first."),
          "a comment was not attached to its own declaration",
        );
        for (const name of ["between", "after"]) {
          assert(
            !(await run(session, `describe(${name})`)).includes("Documents first."),
            `a comment was stolen by ${name}`,
          );
        }
      } finally {
        session.close();
      }

      // The description survives a restart, and forget drops it.
      const second = await openSession({ env: envFor(dir) });
      try {
        assert(
          (await run(second, "describe(briefing)")).includes("Build a short briefing."),
          "the description did not survive a restart",
        );
        await run(second, 'forget("briefing")');
        await run(second, "const briefing = (q) => q;");
        assert(
          !(await run(second, "describe(briefing)")).includes("Build a short briefing."),
          "a redefined name inherited the previous description",
        );
      } finally {
        second.close();
      }
      pass("helper-identity");
    });
  },

  async "run-semantics"() {
    await gate("run-semantics", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        const printed = await run(session, 'console.log("printed"); 6 * 7');
        assert(printed.includes("printed"), "captured output was not returned");
        assert(printed.includes("42"), "the trailing expression was not returned");

        // console.log returns undefined, like the real thing: a trailing call
        // must not report a value.
        const trailing = await run(session, 'console.log("only")');
        assert(trailing === "only", `console.log leaked a value: ${JSON.stringify(trailing)}`);

        assert((await run(session, 'result = "assigned"')) === "assigned", "result was ignored");
        assert(
          (await run(session, "const v = await Promise.resolve(7); v * 2")) === "14",
          "await failed",
        );

        const strings = await run(session, "S.blob", { strings: { blob: 'a "quoted" \\n blob' } });
        assert(strings === 'a "quoted" \\n blob', `S did not carry the literal: ${strings}`);

        // A failure is reported, and the namespace survives it.
        assert(
          (await run(session, 'throw new Error("boom")')).includes("boom"),
          "an error was hidden",
        );
        await run(session, "const after = 1;");
        assert((await run(session, "after")) === "1", "the namespace did not survive an error");
        assert(
          (await run(session, "const = ;")).includes("Syntax error"),
          "a syntax error was not reported",
        );
      } finally {
        session.close();
      }
      pass("run-semantics");
    });
  },

  // ----------------------------------------------------- persistence on disk

  async "persist-restart"() {
    await gate("persist-restart", async (dir) => {
      const first = await openSession({ env: envFor(dir) });
      try {
        await run(first, "const persisted = (x) => x + 1;");
      } finally {
        first.close();
      }

      // A genuinely fresh process pointed at the same directory.
      const second = await openSession({ env: envFor(dir) });
      try {
        const value = await run(second, "persisted(41)");
        assert(value === "42", `a definition did not survive a restart: ${JSON.stringify(value)}`);
      } finally {
        second.close();
      }

      // forget removes it live and on disk, and it stays gone after a restart.
      const third = await openSession({ env: envFor(dir) });
      try {
        const forgotten = await run(third, 'forget("persisted")\nkept().join(", ")');
        assert(!forgotten.includes("persisted"), "forget left the name in kept()");
        assert((await run(third, "typeof persisted")) === "undefined", "forget left it live");
        assert(!existsSync(join(dir, "persisted.js")), "forget left the file on disk");
      } finally {
        third.close();
      }

      const fourth = await openSession({ env: envFor(dir) });
      try {
        assert(
          (await run(fourth, "typeof persisted")) === "undefined",
          "a forgotten name came back after a restart",
        );
      } finally {
        fourth.close();
      }
      pass("persist-restart");
    });
  },

  async "definitions-only"() {
    await gate("definitions-only", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        await run(session, "const alpha = 1; const beta = 2;");
        // A side-effecting statement is work, not a definition: persisting it
        // would replay work on every boot.
        await run(session, 'console.log("this must not be saved"); const gamma = 3;');

        const files = readdirSync(dir).sort();
        assert(
          JSON.stringify(files) === JSON.stringify(["alpha.js", "beta.js", "gamma.js"]),
          `unexpected files saved: ${files.join(", ")}`,
        );

        // A declaration that awaits cannot run at the top level and cannot be
        // persisted without re-running its initializer, so it is call-local.
        await run(session, "const hits = await Promise.resolve(5);");
        assert(
          !readdirSync(dir).includes("hits.js"),
          "an await-initialised declaration was persisted",
        );

        // A name defined and forgotten in ONE call is not written back.
        const same = await run(session, "const gone = 1; forget('gone')");
        assert(
          !readdirSync(dir).includes("gone.js"),
          "a name forgotten in the same call was saved",
        );
        assert(
          (await run(session, "typeof gone")) === "undefined",
          "forget did not remove the binding",
        );
        void same;
      } finally {
        session.close();
      }
      pass("definitions-only");
    });
  },

  async "broken-definition-survivable"() {
    await gate("broken-definition-survivable", async (dir) => {
      const first = await openSession({ env: envFor(dir) });
      try {
        await run(first, "const fine = 1;");
      } finally {
        first.close();
      }

      // A broken saved definition must not stop the server from booting.
      writeFileSync(join(dir, "broken.js"), "this is not valid javascript (((\n", "utf8");

      const second = await openSession({ env: envFor(dir) });
      try {
        const value = await run(second, "fine");
        assert(value === "1", `the server did not boot cleanly: ${JSON.stringify(value)}`);
        // Named, not swallowed: the model cannot fix what it cannot see.
        assert(
          /broken/.test(second.stderr()),
          "a broken saved definition was not reported on stderr",
        );
      } finally {
        second.close();
      }
      pass("broken-definition-survivable");
    });
  },

  // -------------------------------------------------------- the capabilities

  async "capabilities-reachable"() {
    await gate("capabilities-reachable", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        // Read from the manual rather than restated here: a copy would be a
        // second source of truth that drifts from the server's own list.
        const manual = await run(session, "");
        const names = [...manual.matchAll(/^ {2}([a-z_]+) {2,}/gm)].map((match) => match[1]);
        assert(names.length >= 15, `the manual listed only ${names.length} capabilities`);

        const missing = await run(
          session,
          `const names = ${JSON.stringify(names)};
const missing = names.filter((n) => typeof globalThis[n] !== "function");
missing.length === 0 ? "all reachable" : "missing: " + missing.join(", ")`,
        );
        assert(missing === "all reachable", missing);
      } finally {
        session.close();
      }
      pass("capabilities-reachable");
    });
  },

  async "capability-works"() {
    if (!archivePresent()) skip("capability-works", "archive data absent");
    await gate("capability-works", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        const found = await run(session, "await search_skills({ query: 'kdmapper' })");
        assert(
          /kdmapper/i.test(found),
          `a capability returned nothing useful: ${found.slice(0, 120)}`,
        );

        const stats = await run(session, "await kb.skills.stats()");
        assert(/Total/i.test(stats), "the grouped namespace did not reach the capability");

        // A wrong type is named by the capability's OWN schema, so the model is
        // told what to fix instead of failing inside the handler.
        const wrong = await run(session, "await search_skills({ query: 123 })");
        assert(
          /query/.test(wrong) && /string/.test(wrong),
          `bad arguments were not explained: ${wrong}`,
        );

        // And a document can be opened and worked on in-process.
        const opened = await run(
          session,
          "const d = await open('ags-eddeeh-kdmapper'); d.headings().length",
        );
        assert(Number(opened) > 0, `open() returned nothing usable: ${opened}`);
      } finally {
        session.close();
      }
      pass("capability-works");
    });
  },

  async "index-stability"() {
    if (!archivePresent()) skip("index-stability", "archive data absent");
    await gate("index-stability", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        // Regression guard: an unbounded concurrent build plus a missing
        // single-flight guard once produced 0, 4159 and 4030 from one process.
        // The calls are issued WITHOUT awaiting between them, because the defect
        // only appears under concurrency — a sequential loop would pass even with
        // the guard removed, and prove nothing.
        const totals = await Promise.all([
          run(session, "await skill_stats()"),
          run(session, "await skill_stats()"),
          run(session, "await skill_stats()"),
          run(session, "await skill_stats()"),
        ]);
        const counts = totals.map((text) => Number(text.match(/\*\*Total:\*\*\s*(\d+)/)?.[1]));
        assert(new Set(counts).size === 1, `the index total varied: ${counts.join(", ")}`);
        assert(
          counts[0] === skillsOnDisk(),
          `indexed ${counts[0]} but ${skillsOnDisk()} are on disk`,
        );
      } finally {
        session.close();
      }
      pass("index-stability");
    });
  },
};

const requested = process.argv[2] ?? "all";

if (requested === "all") {
  const names = Object.keys(gates);
  let passed = 0;
  let skipped = 0;
  const failures = [];
  for (const name of names) {
    const result = await new Promise((settle) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => (err += chunk.toString("utf8")));
      child.on("close", (code) => settle({ code, out, err }));
    });
    const line = (result.out.match(/gate-passed:[a-z-]+|gate-skipped:[a-z-]+/) ?? [])[0];
    if (result.code === 0 && line?.startsWith("gate-passed")) {
      passed += 1;
      process.stdout.write(`  ${line}\n`);
    } else if (line?.startsWith("gate-skipped")) {
      skipped += 1;
      process.stdout.write(`  ${line}\n`);
    } else {
      failures.push(
        `${name}: ${(result.err.trim().split("\n").pop() ?? "no output").slice(0, 160)}`,
      );
      process.stdout.write(`  FAIL ${name}\n`);
    }
  }
  process.stdout.write(`\nbattery: ${passed} passed${skipped ? ` (${skipped} skipped)` : ""}\n`);
  if (failures.length > 0) {
    process.stdout.write(`\n${failures.map((line) => `  ${line}`).join("\n")}\n`);
    process.exit(1);
  }
  process.exit(0);
}

const gateFn = gates[requested];
if (!gateFn) {
  console.error(`no gate named ${requested}. Available: ${Object.keys(gates).join(", ")}`);
  process.exit(2);
}

await gateFn();
