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
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

  async "source-in-process"() {
    if (!archivePresent()) skip("source-in-process", "archive data absent");
    await gate("source-in-process", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        // A project's source is usually the thing worth working on, so it comes
        // with the document rather than needing another paginated call.
        const size = await run(
          session,
          "const d = await open('ags-kdmapper-1909'); JSON.stringify(await d.sourceSize())",
        );
        const parsed = JSON.parse(size);
        assert(parsed && parsed.lines > 1000, `sourceSize reported nothing useful: ${size}`);

        const range = await run(
          session,
          "const d = await open('ags-kdmapper-1909'); (await d.sourceLines(0, 3)).join('|')",
        );
        assert(
          range.includes("Source Tree"),
          `a line range returned nothing: ${range.slice(0, 80)}`,
        );

        const hits = await run(
          session,
          "const d = await open('ags-kdmapper-1909'); (await d.grepSource(/iqvw64e/i, 2)).join('|')",
        );
        assert(/iqvw64e/.test(hits), `grepSource found nothing: ${hits.slice(0, 120)}`);

        // A capped answer says so, or a partial set reads as the whole truth.
        const capped = await run(
          session,
          "const d = await open('ags-kdmapper-1909'); (await d.grepSource(/./, 2)).slice(-1)[0]",
        );
        assert(/more of \d+ matches/.test(capped), `a capped search was silent: ${capped}`);

        // A skill with no dump says so plainly, and refuses rather than
        // returning nothing.
        const none = await run(session, "const s = await open('byovd'); s.hasSource");
        assert(none === "false", `hasSource was wrong: ${none}`);
        const refused = await run(
          session,
          "const s = await open('byovd'); await s.grepSource(/x/)",
        );
        assert(/no source dump/.test(refused), `a missing dump was not explained: ${refused}`);

        // And the largest dump is read LAZILY. The harness reports its own
        // footprint, so this measures the server rather than the checker — and a
        // 100 MB file read eagerly would show up here immediately.
        const before = JSON.parse(await run(session, "JSON.stringify(stats())")).peakMB;
        const big = await run(
          session,
          "const b = await open('ags-game-engine-from-scratch'); (await b.sourceLines(0, 5)).join('|').slice(0, 60)",
        );
        assert(big.length > 0, "a ranged read of the largest dump returned nothing");
        const after = JSON.parse(await run(session, "JSON.stringify(stats())")).peakMB;
        assert(
          after - before < 30,
          `a ranged read of a 100 MB dump grew the harness by ${Math.round(after - before)} MB`,
        );
      } finally {
        session.close();
      }
      pass("source-in-process");
    });
  },

  async "manual-is-true"() {
    await gate("manual-is-true", async (dir) => {
      // The manual is what a model reads to decide what to write, so every claim
      // it makes about persistence is checked against what actually happens. A
      // manual that misdescribes the rules is worse than no manual: the model
      // writes code that silently loses its tools.
      const session = await openSession({ env: envFor(dir) });
      try {
        const manual = await run(session, "");
        assert(/WHAT IS SAVED/.test(manual), "the manual does not state the persistence rule");

        // The manual's OWN table is the assertion: every line it prints is read
        // back and executed, so a manual that describes the rules wrongly fails
        // here rather than misleading a model. Checking a hand-written list
        // instead would let the manual drift while the gate stayed green.
        // The manual prints a two-column table; the code is the first column.
        // Split on the column gap rather than a lazy capture, which would match
        // the first single space and yield nothing usable.
        const rows = manual
          .split("\n")
          .map((line) => /^\s{4}(saved|NOT saved)\s+(.*)$/.exec(line))
          .filter((match) => match !== null)
          .map((match) => ({
            saves: match[1] === "saved",
            code: match[2].split(/\s{2,}/)[0].trim(),
          }))
          .filter((row) => row.code.length > 0);

        assert(rows.length >= 8, `the manual's table has only ${rows.length} usable rows`);

        for (const row of rows) {
          // The claimed code may carry an inline comment; run just the code.
          const code = row.code.replace(/\s{2,}.*$/, "").trim();
          // The DECLARED name, not a parameter: `const f = (n) => n * 2` binds `f`,
          // and reading `n` here would look for the wrong file.
          const name = /(?:const|let|var|function|class)\s+([a-zA-Z_$][\w$]*)/.exec(code)?.[1];
          if (name === undefined) continue;

          await run(session, code);
          const present = readdirSync(dir).includes(`${name}.js`);
          assert(
            present === row.saves,
            `the manual says \`${code}\` is ${row.saves ? "saved" : "NOT saved"}, but it was ${present ? "saved" : "not saved"}`,
          );
        }

        // The claim about shadowing, which is the one a model is most likely to
        // get wrong when reading code back.
        await run(
          session,
          "const perCall = await Promise.resolve({ n: 1 });\nconst reader = (perCall) => perCall.n;",
        );
        assert(
          readdirSync(dir).includes("reader.js"),
          "a helper whose parameter shadows a per-call value was not saved, though the manual says it is",
        );
      } finally {
        session.close();
      }
      pass("manual-is-true");
    });
  },

  async "asi-accident"() {
    await gate("asi-accident", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        // ASI merges `f()` followed by a template into a tagged template, so the
        // raw failure is "f(...) is not a function" — a message that says nothing
        // about the missing semicolon. Found by driving the live host.
        const accident = await run(session, "const x = 1;\nforget('x')\n`kept: ${kept()}`");
        assert(
          /TAGGED TEMPLATE/.test(accident),
          `the accident was not explained: ${accident.slice(0, 100)}`,
        );
        assert(/semicolon/i.test(accident), "the explanation does not say how to fix it");
        assert(/Nothing ran/.test(accident), "the explanation does not say nothing ran");

        const line = await run(session, "const x = 1\n`value ${x}`");
        assert(/Line 2/.test(line), `the line number is wrong: ${line.slice(0, 60)}`);

        // Real template tags must still work: a name or member tag is real code.
        const tag = await run(session, "const tag = (p, v) => p[0] + v;\ntag`hi ${'x'}`");
        assert(tag === "hi x", `a real template tag broke: ${tag}`);
        const member = await run(session, "const sql = { run: (p) => p[0] };\nsql.run`select`");
        assert(member === "select", `a member template tag broke: ${member}`);

        // And the semicolon fixes it.
        const fixed = await run(session, "const x = 1;\n`value ${x}`");
        assert(fixed === "value 1", `the semicolon did not fix it: ${fixed}`);
      } finally {
        session.close();
      }
      pass("asi-accident");
    });
  },

  async "errors-are-described"() {
    await gate("errors-are-described", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        // A thrown non-Error is legal and common, and reading `.name`/`.message`
        // off it produced "undefined: undefined" — a message that says nothing.
        const string = await run(session, "throw 'plain string'");
        assert(
          /Thrown: plain string/.test(string),
          `a thrown string was not described: ${string.slice(0, 60)}`,
        );
        const number = await run(session, "throw 42");
        assert(
          /Thrown: 42/.test(number),
          `a thrown number was not described: ${number.slice(0, 60)}`,
        );

        // A real Error must report its name and message. The check is duck-typed
        // because the vm context has its own realm: an `instanceof Error` from
        // this realm is FALSE for an error made there, which silently rendered a
        // real error as "Thrown: {}".
        const real = await run(session, "throw new Error('real')");
        assert(/Error: real/.test(real), `an Error was not described: ${real.slice(0, 60)}`);
        assert(!/Thrown: \{\}/.test(real), "an Error was rendered as an opaque object");

        const type = await run(session, "null.x");
        assert(/TypeError:/.test(type), `a TypeError was not described: ${type.slice(0, 60)}`);
        const reference = await run(session, "nope");
        assert(
          /ReferenceError:/.test(reference),
          `a ReferenceError was not described: ${reference.slice(0, 60)}`,
        );

        const custom = await run(
          session,
          "class MyErr extends Error { constructor(m) { super(m); this.name = 'MyErr'; } }\nthrow new MyErr('custom')",
        );
        assert(
          /MyErr: custom/.test(custom),
          `a custom error was not described: ${custom.slice(0, 60)}`,
        );
      } finally {
        session.close();
      }
      pass("errors-are-described");
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

  async "call-local-dependency"() {
    await gate("call-local-dependency", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        // A model writing a pipeline must get source-order semantics. The step
        // that derives from an earlier value is per-call data, not a saved tool:
        // classified as a definition it would run BEFORE the work that produces
        // its input, and fail with "x is not defined".
        const pipeline = await run(
          session,
          "const rows = await Promise.resolve([1,2,3]);\n" +
            "const doubled = rows.map((n) => n * 2);\n" +
            "const total = doubled.reduce((a, b) => a + b, 0);\n" +
            "total",
        );
        assert(pipeline === "12", `a pipeline did not run in source order: ${pipeline}`);

        const files = readdirSync(dir).sort();
        assert(files.length === 0, `a derived value was persisted as a tool: ${files.join(", ")}`);

        // A helper that depends on nothing is still saved, with its description.
        await run(
          session,
          "const data = await Promise.resolve([1,2]);\n" +
            "/** Double every number. */\n" +
            "const doubleAll = (list) => list.map((n) => n * 2);",
        );
        const after = readdirSync(dir).sort();
        assert(after.includes("doubleAll.js"), `a real tool was not saved: ${after.join(", ")}`);
        assert(!after.includes("data.js"), "per-call data was saved as a tool");

        // A value its initializer COMPUTED is not a tool: saving it would re-run
        // the call on every load, and the stored snapshot would be meaningless.
        await run(session, "const before = stats().peakMB;\nconst after = stats().peakMB;");
        const computed = readdirSync(dir).sort();
        assert(
          !computed.includes("before.js") && !computed.includes("after.js"),
          `a computed value was persisted as a tool: ${computed.join(", ")}`,
        );

        // But a function, a class and a literal are tools, even beside it.
        await run(
          session,
          "const triple = (n) => n * 3;\nclass Crate { m(){ return 1 } }\nconst limits = { retries: 2 };",
        );
        const tools = readdirSync(dir).sort();
        for (const expected of ["triple.js", "Crate.js", "limits.js"]) {
          assert(tools.includes(expected), `${expected} was not saved: ${tools.join(", ")}`);
        }

        // A helper whose BODY calls is still a tool: the calls happen when it is
        // called, not when it is loaded.
        await run(session, "const fetchTop = async (q) => await q;");
        assert(readdirSync(dir).includes("fetchTop.js"), "a helper whose body calls was not saved");

        // A TOOL is callable, constructible, or a literal the author keeps. A
        // VALUE that computes is for this call only — persisting it would replay
        // the computation at every load — and a MUTABLE binding is scratch, since
        // it would carry a stale value into the next call.
        const valueCases = [
          { name: "computeSum", code: "const computeSum = 1 + 2;", saves: false },
          { name: "computeTemplate", code: "const computeTemplate = `x${1}`;", saves: false },
          { name: "computeMapped", code: "const computeMapped = [1].map((n) => n);", saves: false },
          { name: "computePick", code: "const computePick = true ? 1 : 2;", saves: false },
          { name: "scratchLet", code: "let scratchLet = 0;\nscratchLet += 1;", saves: false },
          { name: "scratchVar", code: "var scratchVar = 1;", saves: false },
          { name: "toolArrow", code: "const toolArrow = (n) => n;", saves: true },
          { name: "toolClass", code: "class toolClass { }", saves: true },
          {
            name: "toolConfig",
            code: "const toolConfig = { retries: 3, deep: { a: [1] } };",
            saves: true,
          },
          { name: "toolList", code: "const toolList = ['a', 'b'];", saves: true },
          { name: "toolLimit", code: "const toolLimit = 50;", saves: true },
          {
            name: "toolStaticTemplate",
            code: "const toolStaticTemplate = `skills/a`;",
            saves: true,
          },
          { name: "toolApi", code: "const toolApi = { ping: () => 'pong' };", saves: true },
        ];
        for (const valueCase of valueCases) {
          await run(session, valueCase.code);
          const present = readdirSync(dir).includes(`${valueCase.name}.js`);
          assert(
            present === valueCase.saves,
            `${valueCase.name} was ${present ? "saved" : "skipped"} but should be ${valueCase.saves ? "saved" : "skipped"}`,
          );
        }

        // SHADOWING decides this correctly in both directions. A parameter, or a
        // local declared at the top of the body, shadows the outer name, so the
        // helper is a tool; a default value or a nested block does not, so it is
        // not. Getting the first direction wrong discards a usable helper, which
        // is silent — the tool is simply absent next call.
        const shadowCases = [
          {
            name: "shadowParam",
            code: "const sd = await Promise.resolve(1);\nconst shadowParam = (sd) => sd;",
            saves: true,
          },
          {
            name: "shadowLocal",
            code: "const sk = await Promise.resolve(1);\nconst shadowLocal = () => { const sk = 2; return sk; };",
            saves: true,
          },
          {
            name: "defaultReads",
            code: "const dv = await Promise.resolve(1);\nconst defaultReads = (x = dv) => x;",
            saves: false,
          },
          {
            name: "blockReads",
            code: "const bq = await Promise.resolve(1);\nconst blockReads = () => { { const bq = 2; } return bq; };",
            saves: false,
          },
        ];
        for (const shadowCase of shadowCases) {
          await run(session, shadowCase.code);
          const present = readdirSync(dir).includes(`${shadowCase.name}.js`);
          assert(
            present === shadowCase.saves,
            `${shadowCase.name} was ${present ? "saved" : "skipped"} but should be ${shadowCase.saves ? "saved" : "skipped"}`,
          );
        }

        // A helper whose BODY reads per-call data is per-call data too, because
        // saving it would persist a tool that breaks on the next call.
        await run(
          session,
          "const seed = await Promise.resolve([5,6]);\nconst lengthOf = () => seed.length;",
        );
        assert(
          !readdirSync(dir).includes("lengthOf.js"),
          "a helper reading per-call data was persisted",
        );

        // And the saved tool still works alongside fresh per-call data.
        const combined = await run(
          session,
          "const rows2 = await Promise.resolve([10, 20]);\n`${doubleAll(rows2)}`",
        );
        assert(combined === "20,40", `a saved tool did not combine with new data: ${combined}`);
      } finally {
        session.close();
      }
      pass("call-local-dependency");
    });
  },

  async "calls-serialized"() {
    await gate("calls-serialized", async (dir) => {
      const session = await openSession({ env: envFor(dir) });
      try {
        // The namespace is one shared mutable thing, so two calls at once would
        // interleave their captured output — and a host is free to pipeline.
        // Measured before the queue existed: 3 of 4 concurrent calls returned
        // another call's output.
        const tags = ["A", "B", "C", "D"];
        const responses = await Promise.all(
          tags.map((tag, index) =>
            session.request({
              jsonrpc: "2.0",
              id: 500 + index,
              method: "tools/call",
              params: {
                name: TOOL,
                arguments: {
                  code:
                    `console.log('start-${tag}');\n` +
                    `await new Promise((r) => setTimeout(r, ${30 - index * 6}));\n` +
                    `console.log('end-${tag}');\n` +
                    `'value-${tag}'`,
                  session_id: `concurrent-${index}`,
                },
              },
            }),
          ),
        );

        responses.forEach((response, index) => {
          const tag = tags[index];
          const text = textOf(response);
          assert(
            text.includes(`start-${tag}`),
            `call ${tag} lost its own start line: ${text.slice(0, 80)}`,
          );
          assert(text.includes(`end-${tag}`), `call ${tag} lost its own end line`);
          assert(text.includes(`value-${tag}`), `call ${tag} lost its own value`);
          for (const other of tags.filter((t) => t !== tag)) {
            assert(!text.includes(other), `call ${tag} saw call ${other}'s output`);
          }
        });

        // The globals a model expects, and not the ones that reach the server.
        const missing = await run(
          session,
          "const want = ['setTimeout','URL','TextEncoder','atob','fetch','structuredClone','crypto','Buffer'];\n" +
            "want.filter((n) => typeof globalThis[n] === 'undefined').join(', ') || 'all present'",
        );
        assert(missing === "all present", `globals missing from the context: ${missing}`);

        const escapes = await run(
          session,
          "['process','require','module'].filter((n) => typeof globalThis[n] !== 'undefined').join(', ') || 'none reachable'",
        );
        assert(
          escapes === "none reachable",
          `the server's own environment is reachable: ${escapes}`,
        );
      } finally {
        session.close();
      }
      pass("calls-serialized");
    });
  },

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

/**
 * Refuse to run against a stale build.
 *
 * Every gate drives `dist/index.js`, so a gate that runs after a FAILED build
 * tests the previous artifact and can report a pass for code that no longer
 * exists. That happened while writing this battery: a broken injection left the
 * old dist in place and the gate passed, which is worse than no gate at all.
 */
function assertBuildIsFresh() {
  const sources = readdirSync(join(ROOT, "src"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(ROOT, "src", name));
  const built = join(ROOT, "dist", "index.js");

  if (!existsSync(built)) {
    console.error(
      `FAIL: ${built} does not exist. Run \`npm run build\` before the gates — they drive the built server.`,
    );
    process.exit(1);
  }

  const builtAt = statSync(built).mtimeMs;
  const stale = sources.filter((file) => statSync(file).mtimeMs > builtAt);
  if (stale.length > 0) {
    console.error(
      `FAIL: the build is older than ${stale.length} source file(s):\n` +
        `${stale.map((file) => `  ${file}`).join("\n")}\n` +
        `Run \`npm run build\` — a gate against a stale artifact tests code that is not here.`,
    );
    process.exit(1);
  }
}

assertBuildIsFresh();

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
