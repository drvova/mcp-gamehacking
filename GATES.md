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
failure, so a green battery never implies coverage it did not have. Every gate
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
