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
