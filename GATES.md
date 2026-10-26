# Gates

The acceptance ledger for this server. Each gate is a command whose exit status
is the verdict, and each is verified by **restoring its own defect** — a gate
that cannot fail proves nothing.

Run one gate by name, or the whole battery:

```
node tools/checks/check.mjs single-tool
npm run test:gates
```

`GATES_REQUIRE_ARCHIVE=1` turns an absent data directory from a skip into a
failure, so a green battery never implies coverage it did not have.

The battery **refuses to run against a stale build**: every gate drives
`dist/index.js`, so a gate that runs after a failed build would test the previous
artifact and could report a pass for code that is no longer there. That is not
hypothetical — it happened while writing this battery, when a broken injection
left the old `dist` in place and the gate passed. Run `npm run build` first. Every gate
runs against the **built** server (`dist/index.js`) over stdio JSON-RPC, and
every gate points the harness at a temp directory — the battery can never read
or write a real home directory.

## The contract

The server exposes exactly one tool. It runs code in a namespace that persists
across calls and across restarts, and the project's capabilities are reached
from inside that namespace rather than advertised as verbs.

- [x] G1: The advertised set is exactly `{run}` — one tool, unconditionally, and no capability is advertised as a tool
  CHECK: node tools/checks/check.mjs single-tool
  EXPECT: gate-passed:single-tool

- [x] G2: The surface does not vary by caller identity — four different client names all see the same single tool, because adaptation is emergent rather than a per-model switch
  CHECK: node tools/checks/check.mjs no-per-model-branching
  EXPECT: gate-passed:no-per-model-branching

- [x] G3: There is no enable/disable flag and no code-free mode; the published schema carries `code` and nothing that could turn the tool off, and a call with no arguments at all is accepted
  CHECK: node tools/checks/check.mjs no-toggle
  EXPECT: gate-passed:no-toggle

## Discovery

- [x] G4: Empty `code` returns a manual naming the namespace vocabulary and what the project offers
  CHECK: node tools/checks/check.mjs manual
  EXPECT: gate-passed:manual

- [x] G5: `describe` reports a capability's arguments with real types, and an object's public members — `any` where a real type exists is a lie that costs a round trip
  CHECK: node tools/checks/check.mjs describe-real-types
  EXPECT: gate-passed:describe-real-types

## One long-lived namespace

- [x] G6: A helper defined in one call is reusable in the next, redefinition refines it rather than throwing, and variables, functions and classes all persist
  CHECK: node tools/checks/check.mjs persist-calls
  EXPECT: gate-passed:persist-calls

- [x] G7: A trailing expression and captured output are returned, `result` is honoured, `await` works, `S` carries literal text, `console.log` returns undefined like the real thing, and a failure is reported without losing the namespace
  CHECK: node tools/checks/check.mjs run-semantics
  EXPECT: gate-passed:run-semantics

## A helper keeps its own identity

- [x] G14: A helper keeps the name it was defined with, reports the description its author wrote (and never a line of its own body), reports nothing when none was written, does not steal a comment that belongs to another declaration, keeps its description across a restart, and drops it on `forget`
  CHECK: node tools/checks/check.mjs helper-identity
  EXPECT: gate-passed:helper-identity

## A failure says what failed

- [x] G23: Every thrown value is described — a thrown string, number, `undefined` and `null` report as themselves, a real `Error` reports its name and message, and a custom subclass reports its own name — which requires duck-typing, because code runs in a `vm` realm whose `Error` is a different constructor and an `instanceof` check silently renders a real error as an opaque object
  CHECK: node tools/checks/check.mjs errors-are-described
  EXPECT: gate-passed:errors-are-described

## An accumulator does not become a tool

- [x] G25: A `const` container the call MUTATES is not saved — `const acc = []; acc.push(x)` is an accumulator, and saving it would start the next call with the previous call's contents — while a container that is only READ (a member read or a pure method call) is still saved
  CHECK: node tools/checks/check.mjs no-accumulators-saved
  EXPECT: gate-passed:no-accumulators-saved

## A long scan returns, and says how much it covered

- [x] G24: EVERY capability that scans the archive respects a time budget and returns partial results with an honest note — instead of outlasting the host's request timeout and returning nothing — and the note reports the CORPUS size, not the count it reached, while a narrowed search is complete and says so by not claiming to be partial. The same defect was in three capabilities (`grep_sources`, `find_offset`, `find_function`), so they now share one scanner
  CHECK: node tools/checks/check.mjs scan-budget
  EXPECT: gate-passed:scan-budget
  NOTE: gate calls have a 90s deadline. An earlier version of this gate HUNG on
  the unbounded scan for two minutes with no verdict — worse than a failure,
  because it names nothing. It now fails with the offending call quoted.

## Calls do not step on each other

- [x] G22: Concurrent calls each get their own output — the namespace is one shared mutable thing, so calls are serialized — and the context has the globals a model expects (timers, `fetch`, `URL`, encoding, `crypto`, `Buffer`) while `process`, `require` and `module` stay unreachable
  CHECK: node tools/checks/check.mjs calls-serialized
  EXPECT: gate-passed:calls-serialized

## A joined line is explained, not left to confuse

- [x] G21: A template literal joined to the line above by automatic semicolon insertion is reported as what it is — naming the line and the fix — while a real template tag (a name or member expression) still runs and a semicolon fixes the code
  CHECK: node tools/checks/check.mjs asi-accident
  EXPECT: gate-passed:asi-accident

## The manual tells the truth

- [x] G20: Every line of the manual's own persistence table is read back and executed — a manual that misdescribes the rules fails here rather than misleading a model, and it states the rule at all rather than leaving a model to discover it by losing a tool
  CHECK: node tools/checks/check.mjs manual-is-true
  EXPECT: gate-passed:manual-is-true

## A project's source, in-process

- [x] G15: A project's source dump comes with the document — `sourceSize` reports it, `sourceLines` reads a range lazily, `grepSource` searches it streamed with line numbers, a capped search says how many matched, a skill without a dump refuses plainly, and a ranged read of the **100 MB** dump does not pull it into memory
  CHECK: node tools/checks/check.mjs source-in-process
  EXPECT: gate-passed:source-in-process

## A definition that depends on this call stays in this call

- [x] G19: A tool is callable, constructible, or a literal — never a computed value and never a mutable binding: `1 + 2`, a template with expressions, a mapped array, a ternary, `let`, and `var` are all per-call, while an arrow, a class, a generator, a config object, an array of names, a plain or negative literal, a static template, and an object of functions are all saved
  CHECK: node tools/checks/check.mjs call-local-dependency
  EXPECT: gate-passed:call-local-dependency

- [x] G18: Shadowing is decided in BOTH directions — a parameter, a destructured/rest parameter, or a local declared at the top of the body shadows the call-local name (so the helper IS saved), while a default value, a nested arrow body, or a declaration inside a nested block does not (so it is NOT)
  CHECK: node tools/checks/check.mjs call-local-dependency
  EXPECT: gate-passed:call-local-dependency

- [x] G17: A declaration whose initializer COMPUTES something is per-call data, not a saved tool — `const before = stats().peakMB` is not persisted, while a function, a class, a literal, and a helper whose body calls are
  CHECK: node tools/checks/check.mjs call-local-dependency
  EXPECT: gate-passed:call-local-dependency

- [x] G16: A pipeline runs in source order — a value derived from per-call data is per-call data, not a saved tool — while a helper that depends on nothing is still saved with its description, and a helper whose body reads per-call data is treated as per-call data too
  CHECK: node tools/checks/check.mjs call-local-dependency
  EXPECT: gate-passed:call-local-dependency

## Persistence on disk

- [x] G8: A definition made in one process is reloaded and usable in a **fresh process** on the same directory; `forget` removes it live and on disk, and it stays gone after a restart
  CHECK: node tools/checks/check.mjs persist-restart
  EXPECT: gate-passed:persist-restart

- [x] G9: Only definitions are persisted — work is never replayed — a declaration that awaits stays call-local, and a name forgotten in the same call is not written back
  CHECK: node tools/checks/check.mjs definitions-only
  EXPECT: gate-passed:definitions-only

- [x] G10: A broken saved definition cannot stop the server from booting, and it is reported on stderr rather than swallowed — the model cannot fix what it cannot see
  CHECK: node tools/checks/check.mjs broken-definition-survivable
  EXPECT: gate-passed:broken-definition-survivable

## The capabilities

- [x] G11: Every capability the manual lists is reachable from code as a function — read from the manual rather than restated, so the list cannot drift from the server's own
  CHECK: node tools/checks/check.mjs capabilities-reachable
  EXPECT: gate-passed:capabilities-reachable

- [x] G12: The pre-existing capabilities still work when driven from code: a search returns real results, the grouped namespace reaches the same functions, a document opens and is workable in-process, and a wrong argument type is named by the capability's own schema
  CHECK: node tools/checks/check.mjs capability-works
  EXPECT: gate-passed:capability-works

- [x] G13: The skill index is stable under CONCURRENT calls and matches the number of `SKILL.md` directories on disk
  CHECK: node tools/checks/check.mjs index-stability
  EXPECT: gate-passed:index-stability
  NOTE: this gate proves the total is stable and correct. It does NOT prove the
  single-flight guard is present: removing that guard no longer reproduces the
  nondeterminism, because the chunked build (which fixed the same bug) prevents
  it independently. Stated here rather than implied, so the gate is not credited
  with a defect it cannot catch.

## What each gate catches

| Gate | Restore this defect | Failure it produces |
|---|---|---|
| G1 | register any capability as a tool | `expected exactly one tool, got run, search_skills` |
| G2 | branch the surface on `clientInfo.name` | `the surface differs by client: run \| run,surface` |
| G3 | add an `enable` flag to the schema | `the tool publishes an enable/disable-style flag` |
| G4 | return an empty string for empty code | `the manual does not name describe` |
| G5 | report the zod wrapper instead of the inner type | `describe reported any for a real type` |
| G6 | run definitions inside the async wrapper | `a helper did not persist` |
| G7 | return `push()`'s result from `console.log` | `console.log leaked a value: "only"` |
| G8 | never call `load()` at startup | `a definition did not survive a restart` |
| G9 | save every statement, or save after work | `unexpected files saved: alpha.js, beta.js, hits.js` |
| G10 | load definitions without a per-file try/except | `the server did not boot cleanly` |
| G11 | seed only a subset of the capabilities | `missing: compare_projects, ...` |
| G12 | skip the capability's schema validation | `bad arguments were not explained` |
| G13 | make the index total depend on how many calls are in flight | `the index total varied: ...` (not reproducible today — see the note) |
| G14 | persist by assignment without setting the name | `the helper lost its name: anonymous(q)` |
| G14 | report the first body line as the description | `the author's description was dropped: briefing(q)` |
| G14 | attach any earlier comment to a declaration | `a comment was stolen by between` |
| G14 | let `forget` keep the description | `a redefined name inherited the previous description` |
| G14 | read descriptions only for functions | `a comment was not attached to its own declaration` |
| G15 | read the whole file instead of streaming a range | `a ranged read of a 100 MB dump grew the harness by 206 MB` |
| G15 | swallow the search cap | `a capped search was silent: 3: Source Tree:` |
| G15 | report no source for a skill that has one | `sourceSize reported nothing useful: null` |
| G16 | classify definitions without checking what they depend on | `a pipeline did not run in source order: While defining: rows is not defined` |
| G17 | save a declaration whose initializer calls something | `a computed value was persisted as a tool: after.js, before.js, doubleAll.js` |
| G25 | drop the mutation check entirely | `an array pushed to leaked into the next call: acc is object` |
| G25 | keep mutation detection but not consult the bound name | `an array pushed to leaked into the next call: acc is object` |
| G24 | remove the scan budget | `the scan ran 44994ms with a 1500ms budget` (the host timeout) |
| G24 | leave `find_offset` unbounded | `no answer within 90s: await find_offset({ query: '0x140001000', budget_ms: 1500 })` |
| G24 | count coverage as it goes instead of up front | `the corpus size reported is wrong: 113` |
| G23 | use `instanceof Error` across the realm boundary | `an Error was not described: Thrown: {}` |
| G23 | read `.name`/`.message` off any thrown value | `a thrown string was not described: undefined: undefined` |
| G22 | remove the call queue | `call A lost its own start line: start-D` |
| G22 | seed `process` into the context | `the server's own environment is reachable: process` |
| G22 | seed no globals | `call A lost its own end line` (no `setTimeout`) |
| G21 | drop the joined-line check | `the accident was not explained: TypeError: forget(...) is not a function` |
| G21 | reject every template tag, not just the accident | `a real template tag broke: Line 2: a template literal on the line after code is joined to it,` |
| G20 | print `let` as saved in the manual | `the manual says \`let total = 0\` is saved, but it was not saved` |
| G20 | print arithmetic as saved in the manual | `the manual says \`const sum = 1 + 2\` is saved, but it was not saved` |
| G19 | save a computed initializer | `a computed value was persisted as a tool: after.js, before.js, doubleAll.js` |
| G19 | save a mutable binding | `scratchLet was saved but should be skipped` |
| G19 | treat a template with expressions as static | `computeTemplate was saved but should be skipped` |
| G19 | treat arithmetic as static | `a computed value was persisted as a tool` |
| G18 | ignore parameter shadowing | `shadowParam was skipped but should be saved` |
| G18 | treat a default value as a binding rather than a use | `defaultReads was saved but should be skipped` |
| G18 | treat a nested-block declaration as shadowing the body | `blockReads was saved but should be skipped` |
