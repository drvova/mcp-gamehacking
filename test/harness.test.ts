/**
 * The code harness contract.
 *
 * One tool, a persistent namespace, definitions that survive a restart. These
 * tests spawn the built server rather than importing sources, because the thing
 * under test is the shipped artifact and its stdio transport.
 *
 * State is isolated to a temp directory through `GAMEHACKING_HARNESS_DIR`:
 * a test must never read or write a real home directory.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "rstack/test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ToolsListResult,
  callServer,
  listTools,
  openSession,
  reportSkipped,
  requireArchive,
  textOf,
  toolCall,
  toolNames,
  wasRefused,
  type Session,
} from "./helpers/mcp.js";

// A green suite must never imply full coverage: archive-dependent tests skip
// loudly when the archive is absent, and the summary says how many did not run.
afterAll(reportSkipped);

let harnessDir = "";
let session: Session | null = null;

/** The env every spawned server gets, so no test touches a real home dir. */
const env = () => ({ GAMEHACKING_HARNESS_DIR: harnessDir });

beforeEach(() => {
  harnessDir = mkdtempSync(join(tmpdir(), "gamehacking-harness-"));
});

afterEach(() => {
  session?.close();
  session = null;
  rmSync(harnessDir, { recursive: true, force: true });
});

/** Run code through the tool and return what the model would see. */
async function run(
  code: string,
  sessionIdOrStrings?: string | Record<string, unknown>,
): Promise<string> {
  if (!session) session = await openSession({ env: env() });
  const args: Record<string, unknown> = { code };
  if (typeof sessionIdOrStrings === "string") args.session_id = sessionIdOrStrings;
  else if (sessionIdOrStrings) args.strings = sessionIdOrStrings;
  const id = nextId();
  return textOf(await session.request(toolCall(id, "run", args)));
}

let counter = 0;
const nextId = () => (counter += 1);

describe("one tool, and only one", () => {
  it("advertises exactly the code tool", async () => {
    const responses = await callServer([listTools(1)], { env: env() });

    expect(toolNames(responses.get(1))).toEqual(["run"]);
  });

  it("advertises one tool for any client, with no per-client branching", async () => {
    // Adaptation is emergent — each deployment's model accretes its own helpers.
    // A tool set that varies by client identity would be a per-model switch, so
    // this asserts the surface is the SAME for two different callers.
    const one = await callServer([listTools(1)], { clientName: "claude-3-5", env: env() });
    const two = await callServer([listTools(1)], { clientName: "gpt-4o", env: env() });

    expect(toolNames(one.get(1))).toEqual(["run"]);
    expect(toolNames(two.get(1))).toEqual(["run"]);
  });

  it("names no capability as a tool", async () => {
    const responses = await callServer([listTools(1)], { env: env() });
    const names = toolNames(responses.get(1));

    // The capabilities still exist and still work — they are simply reached from
    // code. Advertising them would be the typed-verb catalog this design removes.
    for (const capability of ["search_skills", "read_skill", "skill_stats", "get_file_tree"]) {
      expect(names).not.toContain(capability);
    }
  });
});

describe("discovery is in-language", () => {
  it("returns a manual for empty code", async () => {
    const manual = await run("");

    // The manual has to name the vocabulary and say what the project offers, or a
    // model has nothing to bootstrap from.
    for (const word of ["describe", "kept", "forget", "S", "open"]) {
      expect(manual).toContain(word);
    }
    expect(manual).toContain("search_skills");
    expect(manual).toMatch(/capabilit|offers/i);
  });

  it("describes a capability's arguments with real types", async () => {
    const described = await run("describe(search_skills)");

    expect(described).toContain("search_skills");
    // A type of "any" where a real type exists is a lie that costs a round trip.
    expect(described).toMatch(/query: string/);
    expect(described).not.toMatch(/query: any/);
  });

  it("describes an object's public members", async () => {
    const described = await run("describe(kb)");

    expect(described).toContain("skills");
    expect(described).toContain("agents");
  });
});

describe("a helper keeps its own identity", () => {
  // Found by driving the live host: the helper worked but had lost its name, and
  // `describe` reported a BODY LINE as if it were documentation. Both are the
  // discovery surface lying about the model's own tools.
  it("keeps the name it was defined with", async () => {
    await run("const briefing = async (q) => q;");

    // Assignment through a property does not infer a function's name the way a
    // declaration does, so this is set explicitly when the definition is saved.
    expect(await run("briefing.name")).toBe("briefing");
  });

  it("reports the description the author wrote, not a line of its body", async () => {
    await run("/** Build a short briefing for a query. */\nconst documented = async (q) => q;");
    const described = await run("describe(documented)");

    expect(described).toContain("Build a short briefing for a query.");
    expect(described).not.toContain("async (q) => q");
  });

  it("reports no description at all when none was written", async () => {
    await run("const undescribed = (x) => x;");
    const described = await run("describe(undescribed)");

    // A body line presented as a description reads as the author's intent, which
    // is worse than saying nothing.
    expect(described).toContain("undescribed(x)");
    expect(described).not.toMatch(/=>|return|const /);
  });

  it("does not attach a comment that belongs to an earlier statement", async () => {
    await run("const earlier = 1;\n/** Describes the later one. */\nconst later = (x) => x;");

    expect(await run("describe(earlier)")).not.toContain("Describes the later one.");
    expect(await run("describe(later)")).toContain("Describes the later one.");
  });

  it("does not attach a comment when a statement sits between it and the definition", async () => {
    // The comment documents `first`, and `between` follows it before `after`.
    // Attaching it to `after` would misattribute the author's words, so the rule
    // is that ONLY whitespace may separate a comment from its declaration.
    await run("/** Documents first. */\nconst first = 1;\nconst between = 2;\nconst after = 3;");

    expect(await run("describe(first)")).toContain("Documents first.");
    expect(await run("describe(between)")).not.toContain("Documents first.");
    expect(await run("describe(after)")).not.toContain("Documents first.");
  });

  it("keeps the description across a restart, and drops it on forget", async () => {
    await run("/** Survives a restart. */\nconst durable = (x) => x;");
    session?.close();
    session = null;

    expect(await run("describe(durable)")).toContain("Survives a restart.");

    await run('forget("durable")');
    await run("const durable = (x) => x;");
    // A redefined name must not inherit the previous author's words.
    expect(await run("describe(durable)")).not.toContain("Survives a restart.");
  });
});

describe("one long-lived namespace", () => {
  it("reuses a helper defined in an earlier call without redefining it", async () => {
    await run("const tag = (s) => `[${s}]`;");
    const reused = await run('tag("second call")');

    expect(reused).toBe("[second call]");
  });

  it("refines a definition by defining it again", async () => {
    await run("const tag = (s) => `[${s}]`;");
    const refined = await run('const tag = (s) => `<<${s}>>`; tag("third")');

    // Redefinition must not throw: refining a helper is the main thing a
    // persistent namespace is for.
    expect(refined).toBe("<<third>>");
  });

  it("keeps variables, functions and classes", async () => {
    await run("const n = 42; function hello(w){ return 'hi ' + w; } class Box { m(){ return 7 } }");

    expect(await run("n")).toBe("42");
    expect(await run("hello('there')")).toBe("hi there");
    expect(await run("new Box().m()")).toBe("7");
  });

  it("returns a trailing expression and captured output", async () => {
    const output = await run('console.log("printed"); 6 * 7');

    expect(output).toContain("printed");
    expect(output).toContain("42");
  });

  it("returns an assigned result", async () => {
    expect(await run('result = "assigned"')).toBe("assigned");
  });

  it("awaits in code", async () => {
    const output = await run("const v = await Promise.resolve(7); v * 2");

    expect(output).toBe("14");
  });

  it("exposes the strings dict as S", async () => {
    // Long or literal text is passed as data instead of being escaped inside
    // code, which is the whole point of the parameter.
    const output = await run("S.blob", { blob: 'a payload with "quotes" and \\nnewlines' });

    expect(output).toBe('a payload with "quotes" and \\nnewlines');
  });

  it("reports a failure without losing the namespace", async () => {
    const failed = await run('throw new Error("boom")');
    expect(failed).toContain("boom");

    await run("const after = 1;");
    expect(await run("after")).toBe("1");
  });

  it("explains a template literal joined to the line above, instead of a type error", async () => {
    // ASI parses `forget('x')` followed by a template as a TAGGED TEMPLATE, so the
    // call's result is used as a tag. The raw error ("forget(...) is not a
    // function") says nothing about the missing semicolon.
    const accident = await run("const x = 1;\nforget('x')\n`kept: ${kept()}`");

    expect(accident).toMatch(/TAGGED TEMPLATE/);
    expect(accident).toMatch(/semicolon/i);
    expect(accident).toMatch(/Nothing ran/);
  });

  it("names the line the template is on", async () => {
    const accident = await run("const x = 1\n`value ${x}`");

    expect(accident).toMatch(/Line 2/);
  });

  it("still runs real template tags and member tags", async () => {
    // A name or a member expression as the tag is real code, so the check must
    // not reject it.
    expect(await run("const tag = (p, v) => p[0] + v;\ntag`hi ${'x'}`")).toBe("hi x");
    expect(await run("const sql = { run: (p) => p[0] };\nsql.run`select`")).toBe("select");
  });

  it("reports a syntax error without running anything", async () => {
    const failed = await run("const = ;");

    expect(failed).toMatch(/Syntax error/);
    expect(failed).toMatch(/Nothing ran/);
  });
});

describe("the session binds its working objects", () => {
  it("keeps a document open across calls within one session", async () => {
    if (!requireArchive("keeps a document open across calls within one session")) return;
    await run("(await open('ags-eddeeh-kdmapper')).name", "A");
    // Bound fresh each call, so a document opened in one call is usable in the
    // next rather than having to be reopened.
    expect(await run("doc.name", "A")).toBe("ags-eddeeh-kdmapper");
    expect(await run("docs.length", "A")).toBe("1");
  });

  it("does not leak one session's documents into another", async () => {
    if (!requireArchive("does not leak one session's documents into another")) return;
    await run("await open('ags-eddeeh-kdmapper')", "A");

    expect(await run("docs.length", "B")).toBe("0");
    expect(await run("typeof doc", "B")).toBe("undefined");
    // And the first session still has it.
    expect(await run("docs.length", "A")).toBe("1");
  });

  it("shares definitions across sessions, because the namespace is the process's", async () => {
    // Sessions scope WORKING OBJECTS, not the toolkit: a helper written once is
    // the model's, whichever session asks for it.
    await run("const shared = 7", "A");

    expect(await run("shared", "B")).toBe("7");
  });
});

describe("a definition that depends on this call stays in this call", () => {
  // Found by driving the live host: a model wrote a pipeline, and the step that
  // derived from an earlier value was classified as a saved definition and run
  // BEFORE the work that produced its input — so it failed with "src is not
  // defined". A value derived from per-call data is per-call data, not a tool.
  it("runs a pipeline in source order", async () => {
    const output = await run(
      "const rows = await Promise.resolve([1,2,3]);\n" +
        "const doubled = rows.map((n) => n * 2);\n" +
        "const total = doubled.reduce((a, b) => a + b, 0);\n" +
        "total",
    );

    expect(output).toBe("12");
  });

  it("saves none of a pipeline, because none of it is a tool", async () => {
    await run(
      "const rows = await Promise.resolve([1,2]);\n" +
        "const doubled = rows.map((n) => n * 2);\n" +
        "const total = doubled.reduce((a, b) => a + b, 0);",
    );

    expect(readdirSync(harnessDir)).toHaveLength(0);
  });

  it("still saves a helper that depends on nothing", async () => {
    await run(
      "const data = await Promise.resolve([1,2]);\n" +
        "/** Double every number. */\n" +
        "const doubleAll = (list) => list.map((n) => n * 2);",
    );

    expect(readdirSync(harnessDir)).toContain("doubleAll.js");
    // And the call-local value is not saved beside it.
    expect(readdirSync(harnessDir)).not.toContain("data.js");
  });

  it("treats a helper that reads per-call data as per-call data", async () => {
    const output = await run(
      "const data = await Promise.resolve([5,6]);\n" + "const len = () => data.length;\n" + "len()",
    );

    expect(output).toBe("2");
    // Its body reads `data`, so saving it would persist a tool that breaks on
    // the next call — dependency inside a function body still counts.
    expect(readdirSync(harnessDir)).not.toContain("len.js");
  });

  it("does not save a value its initializer computed", async () => {
    // `const before = stats().peakMB` computes a snapshot now. Saving it would
    // re-run the call on every load — the work the contract says never to
    // replay — and the stored number would be meaningless.
    await run("const before = stats().peakMB;\nconst after = stats().peakMB;");

    expect(readdirSync(harnessDir)).toHaveLength(0);
  });

  it("saves a function, a class and a literal, but not a call", async () => {
    await run(
      "const double = (n) => n * 2;\n" +
        "class Box { m(){ return 1 } }\n" +
        "const config = { retries: 3 };\n" +
        "const names = ['a','b'];\n" +
        "const now = Date.now();",
    );

    const files = readdirSync(harnessDir).sort();
    expect(files).toEqual(["Box.js", "config.js", "double.js", "names.js"]);
  });

  it("saves a helper whose body calls something", async () => {
    // The calls happen when the helper is CALLED, so it is still a tool.
    await run("const fetchTop = async (q) => await q;");

    expect(readdirSync(harnessDir)).toContain("fetchTop.js");
  });

  it("saves a tool and not a value", async () => {
    // A tool is callable, constructible, or a literal the author keeps. Anything
    // that COMPUTES is a value for this call: persisting it would replay the
    // computation at every load.
    await run(
      "const double = (n) => n * 2;\n" +
        "class Box { }\n" +
        "const config = { retries: 3, deep: { a: [1, 2] } };\n" +
        "const names = ['a', 'b'];\n" +
        "const limit = 50;\n" +
        "const sum = 1 + 2;\n" +
        "const label = `x${1}`;\n" +
        "const mapped = [1, 2].map((n) => n);\n" +
        "const picked = true ? 1 : 2;",
    );

    const files = readdirSync(harnessDir).sort();
    expect(files).toEqual(["Box.js", "config.js", "double.js", "limit.js", "names.js"]);
  });

  it("treats a mutable binding as scratch, not as a tool", async () => {
    // `let total = 0` then `total += 1` would carry a stale value into the next
    // call, so a mutable binding is never saved.
    await run("let total = 0;\ntotal += 1;\nvar scratch = 1;\nconst kept = () => total;");

    const files = readdirSync(harnessDir).sort();
    expect(files).not.toContain("total.js");
    expect(files).not.toContain("scratch.js");
  });

  it("keeps a helper whose parameter shadows the call-local name", async () => {
    // `(d) => d` binds its own `d`; it does not read the call's. Skipping it
    // would be the quieter failure: nothing breaks, the tool is simply gone.
    await run("const d = await Promise.resolve(1);\nconst takesD = (d) => d;");

    expect(readdirSync(harnessDir)).toContain("takesD.js");
  });

  it("keeps a helper whose body declares a local of that name", async () => {
    await run(
      "const k = await Promise.resolve(1);\nconst usesLocal = () => { const k = 2; return k; };",
    );

    expect(readdirSync(harnessDir)).toContain("usesLocal.js");
  });

  it("still treats a default value as a dependency", async () => {
    // `(x = outer) => x` reads `outer` when called, so it does depend on this
    // call even though `x` is bound.
    await run("const outer = await Promise.resolve(1);\nconst defs = (x = outer) => x;");

    expect(readdirSync(harnessDir)).not.toContain("defs.js");
  });

  it("does not treat a declaration in a nested block as shadowing the body", async () => {
    // The inner `{ const q = 2 }` only shadows inside that block, so `return q`
    // still reads the call's value.
    await run(
      "const q = await Promise.resolve(1);\nconst readsOuter = () => { { const q = 2; } return q; };",
    );

    expect(readdirSync(harnessDir)).not.toContain("readsOuter.js");
  });

  it("uses a saved tool and per-call data together", async () => {
    await run("/** Sum a list. */\nconst sum = (list) => list.reduce((a, b) => a + b, 0);");
    const output = await run(
      "const rows = await Promise.resolve([10, 20]);\n" + "`${sum(rows)} from ${rows.length} rows`",
    );

    expect(output).toBe("30 from 2 rows");
  });
});

describe("calls run one at a time", () => {
  // The namespace is a single shared mutable thing, so two calls executing at
  // once would interleave their captured output. A host is free to pipeline
  // requests, so this is not hypothetical — measured: without serialization, 3
  // of 4 concurrent calls returned another call's output.
  it("keeps concurrent calls out of each other's output", async () => {
    if (!session) session = await openSession({ env: env() });
    const tags = ["A", "B", "C", "D"];

    const results = await Promise.all(
      tags.map((tag, index) =>
        session
          .request(
            toolCall(100 + index, "run", {
              code:
                `console.log('start-${tag}');\n` +
                `await new Promise((r) => setTimeout(r, ${30 - index * 6}));\n` +
                `console.log('end-${tag}');\n` +
                `'value-${tag}'`,
              session_id: `concurrent-${index}`,
            }),
          )
          .then((frame) => textOf(frame)),
      ),
    );

    results.forEach((text, index) => {
      const tag = tags[index];
      expect(text).toContain(`start-${tag}`);
      expect(text).toContain(`end-${tag}`);
      expect(text).toContain(`value-${tag}`);
      for (const other of tags.filter((t) => t !== tag)) {
        expect(text).not.toContain(other);
      }
    });
  });

  it("has the globals a model expects, and not the ones that reach the server", async () => {
    // A vm context starts almost empty: no timers, no URL, no text encoding.
    const missing = await run(
      "const want = ['setTimeout','URL','TextEncoder','atob','fetch','structuredClone','crypto','Buffer'];\n" +
        "want.filter((n) => typeof globalThis[n] === 'undefined').join(', ') || 'all present'",
    );
    expect(missing).toBe("all present");

    const encoded = await run(
      "btoa('hi') + ' ' + new TextDecoder().decode(new Uint8Array([65,66]))",
    );
    expect(encoded).toBe("aGk= AB");

    // `process`, `require` and `module` would reach the server's own environment
    // and module graph, which is a different thing from running code with its
    // authority.
    const escapes = await run(
      "['process','require','module'].filter((n) => typeof globalThis[n] !== 'undefined').join(', ') || 'none reachable'",
    );
    expect(escapes).toBe("none reachable");
  });
});

describe("definitions persist across restarts", () => {
  it("reloads a definition in a fresh process pointed at the same directory", async () => {
    await run("const persisted = (x) => x + 1;");
    session?.close();
    session = null; // a genuinely fresh process, not a reused one

    expect(await run("persisted(41)")).toBe("42");
  });

  it("writes one file per bound name, and only definitions", async () => {
    await run("const alpha = 1; const beta = 2;");
    // A side-effecting statement is work, not a definition: persisting it would
    // mean replaying work on every boot.
    await run("console.log('this must not be saved'); const gamma = 3;");

    const files = readdirSync(harnessDir).sort();
    expect(files).toEqual(["alpha.js", "beta.js", "gamma.js"]);
  });

  it("does not persist a declaration that awaits", async () => {
    // `const hits = await ...` cannot run at the top level and cannot be
    // persisted without re-running its initializer, so it is call-local work.
    await run("const hits = await Promise.resolve(5);");

    expect(readdirSync(harnessDir)).not.toContain("hits.js");
  });

  it("forgets a definition, live and on disk", async () => {
    await run("const doomed = 1;");
    const after = await run('forget("doomed")\nkept().join(", ")');

    expect(readdirSync(harnessDir)).not.toContain("doomed.js");
    expect(after).not.toContain("doomed");
    expect(await run("typeof doomed")).toBe("undefined");
  });

  it("keeps a forgotten name forgotten after a restart", async () => {
    await run("const gone = 1; forget('gone')");
    session?.close();
    session = null;

    expect(await run("typeof gone")).toBe("undefined");
    expect(readdirSync(harnessDir)).not.toContain("gone.js");
  });

  it("boots when a saved definition is broken", async () => {
    // A broken saved definition must not stop the server from booting, and it
    // must not silently vanish either: the model has to be able to see it.
    await run("const fine = 1;");
    writeFileSync(join(harnessDir, "broken.js"), "this is not valid javascript (((\n", "utf8");

    const responses = await callServer([toolCall(1, "run", { code: "fine" })], { env: env() });

    expect(textOf(responses.get(1))).toBe("1");
  });
});

describe("the pre-existing capabilities still work from code", () => {
  it("drives a capability and returns its text", async () => {
    if (!requireArchive("drives a capability and returns its text")) return;
    const output = await run("await search_skills({ query: 'kdmapper' })");

    expect(output).toMatch(/skill|kdmapper/i);
  });

  it("reaches capabilities through the grouped namespace too", async () => {
    if (!requireArchive("reaches capabilities through the grouped namespace too")) return;
    const output = await run("await kb.skills.stats()");

    expect(output).toMatch(/Total/i);
  });

  it("rejects bad arguments with a readable message", async () => {
    // The capability's own schema validates the call, so a wrong type is named
    // instead of failing somewhere inside the handler.
    const output = await run("await search_skills({ query: 123 })");

    expect(output).toMatch(/query/);
    expect(output).toMatch(/string/);
  });

  it("opens a document and works on it in-process", async () => {
    if (!requireArchive("opens a document and works on it in-process")) return;
    const output = await run(
      "const d = await open('ags-eddeeh-kdmapper'); d.headings().slice(0, 2).join(' | ')",
    );

    expect(output).toMatch(/# kdmapper/);
  });

  it("reaches a project's source dump without another call", async () => {
    if (!requireArchive("reaches a project's source dump without another call")) return;
    const output = await run(
      "const d = await open('ags-kdmapper-1909');\n" +
        "const size = await d.sourceSize();\n" +
        "`${d.hasSource} ${size.lines} lines`",
    );

    // A project's source is usually the thing worth working on, so it travels
    // with the document instead of needing a separate paginated call.
    expect(output).toMatch(/^true \d+ lines$/);
  });

  it("searches a source dump and reports when it capped the answer", async () => {
    if (!requireArchive("searches a source dump and reports when it capped the answer")) return;
    const found = await run(
      "const d = await open('ags-kdmapper-1909');\n(await d.grepSource(/iqvw64e/i, 2)).join(' | ')",
    );
    expect(found).toMatch(/iqvw64e/);

    // A capped result must say so, or a partial match set reads as the whole
    // truth.
    const capped = await run(
      "const d = await open('ags-kdmapper-1909');\n(await d.grepSource(/./, 2)).slice(-1)[0]",
    );
    expect(capped).toMatch(/more of \d+ matches/);
  });

  it("reports whether a source dump exists, and refuses plainly when none does", async () => {
    if (!requireArchive("reports whether a source dump exists, and refuses plainly when none does"))
      return;

    // `hasSource` answers the question without an exception, so a model can
    // branch on it before asking for content.
    expect(await run("const s = await open('byovd'); s.hasSource")).toBe("false");
    expect(await run("const s = await open('byovd'); JSON.stringify(await s.sourceSize())")).toBe(
      "null",
    );

    // Asking anyway fails loudly with the reason, rather than returning nothing.
    const refused = await run("const s = await open('byovd'); await s.grepSource(/x/)");
    expect(refused).toMatch(/no source dump/);
  });

  it("names what is available when a document does not exist", async () => {
    // The answer names what IS available, which only exists when the archive
    // does — an empty list would make the message unverifiable here.
    if (!requireArchive("names what is available when a document does not exist")) return;
    const output = await run("await open('no-such-document-anywhere')");

    expect(output).toMatch(/No document named/);
    expect(output).toMatch(/Available:/);
  });

  it("is still callable when the harness has never been used", async () => {
    if (!requireArchive("is still callable when the harness has never been used")) return;
    const responses = await callServer([toolCall(1, "run", { code: "await skill_stats()" })], {
      env: env(),
    });

    expect(textOf(responses.get(1))).toMatch(/Total/i);
  });
});

describe("the tool refuses nothing it should do", () => {
  it("has no enable/disable flag and no code-free mode", async () => {
    // Running code IS the tool, so a flag that turned it off would reframe the
    // design as an optional feature. The published schema is the contract here,
    // so it is read through a schema rather than asserted about an unchecked
    // shape.
    const responses = await callServer([listTools(1)], { env: env() });
    const published = ToolsListResult.parse(responses.get(1)?.result);

    expect(published.tools).toHaveLength(1);
    expect(Object.keys(published.tools[0].inputSchema.properties ?? {})).toEqual([
      "code",
      "session_id",
      "strings",
    ]);
    expect(JSON.stringify(published.tools[0].inputSchema)).not.toMatch(
      /enable|disable|allow_code|safe_mode/i,
    );
  });

  it("accepts a call with no arguments at all", async () => {
    // Every parameter has a default, so the common case needs no arguments.
    if (!session) session = await openSession({ env: env() });
    const answered = await session.request(toolCall(1, "run", {}));

    expect(wasRefused(answered)).toBe(false);
    expect(textOf(answered)).toContain("The code harness");
  });
});
