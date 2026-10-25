# mcp-gamehacking

MCP (Model Context Protocol) server for game hacking & reverse engineering. A structured knowledge base of **4,100+ skills** with full source code archives, specialized agents, and workflow tools -- designed to be plugged into Claude, Cursor, or any MCP-compatible client.

**MCP-server for game hacking and reverse engineering.** Structured knowledge base of **4,100+ skills** with full source code archives, specialized agents, and tools -- connects to Claude, Cursor, or any MCP-compatible client.

---

## Features

### Skill Library

- **177 hand-written skills** -- deep technical references on injection, hooking, kernel drivers, anti-cheat internals, ESP/aimbot architecture, and more
- **3,985 archived projects** -- full source code snapshots from the game security ecosystem (prefixed `ags-`)
- Each skill has a `SKILL.md` (description, metadata, topics) and optionally a `source.txt` (complete source tree dump)

### Agents

| Agent                                                                                       | Description                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `reverse-engineer`                                                                          | Disassembly analysis, struct recovery, offset hunting, binary patching       |
| `exploit-developer`                                                                         | Kernel exploits, BYOVD chains, EFI persistence, privilege escalation         |
| `anti-cheat-analyst`                                                                        | BattlEye, EAC, Vanguard, VAC, FACEIT internals and bypass research           |
| `malware-analyst`                                                                           | Cheat binary analysis, unpacking, IOC extraction, technique classification   |
| `cheat-developer`                                                                           | ESP, aimbot, triggerbot, overlay rendering, UE/Unity/Source engine internals |
| `driver-developer`                                                                          | WDM/KMDF drivers, IOCTL comm, memory R/W, stealth loading                    |
| `hypervisor-researcher`                                                                     | Intel VMX, AMD SVM, EPT/NPT hooks, HV-based memory access                    |
| `android-researcher`                                                                        | Zygisk, KernelSU, frida, IL2CPP dumping, native hooking                      |
| `network-analyst`                                                                           | Game protocol RE, packet capture, MITM proxy, server emulation               |
| `cs2-specialist`                                                                            | Counter-Strike 2 / Source 2 internals                                        |
| `valorant-specialist`                                                                       | Valorant / UE4 fork / Vanguard interaction                                   |
| `fortnite-specialist`                                                                       | Fortnite / UE5 / EAC interaction                                             |
| `apex-specialist`                                                                           | Apex Legends / Source fork internals                                         |
| `unreal-engine-specialist`                                                                  | UE4/UE5 GObjects, GNames, ProcessEvent, SDK gen                              |
| `unity-specialist`                                                                          | Unity Mono/IL2CPP, GameObjectManager, metadata                               |
| `source-engine-specialist`                                                                  | Source 1/2 ConVar, NetVar, ClientClass                                       |
| `injection-specialist`                                                                      | All injection methods (manual map, reflective, APC, EFI)                     |
| `hooking-specialist`                                                                        | All hook types (VMT, IAT, inline, EPT, syscall)                              |
| `obfuscation-analyst`                                                                       | VMProtect, Themida, OLLVM analysis and unpacking                             |
| `windows-internals-agent`                                                                   | EPROCESS, PEB/TEB, system calls, object manager                              |
| `ida-specialist`                                                                            | IDA Pro scripting, plugins, FLIRT, type libraries                            |
| `ghidra-specialist`                                                                         | Ghidra scripting, P-code, extensions                                         |
| `dma-specialist`                                                                            | DMA/FPGA memory access (PCILeech, Screamer)                                  |
| ...and 52 more game-specific, engine-specific, technique-specific, and tool-specific agents |

### Subagents (161)

| Subagent                                               | Purpose                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `offset-finder`                                        | Cross-reference game offsets across 3,900+ archived sources |
| `code-analyzer`                                        | Classify technique, hook method, stealth measures           |
| `pattern-scanner`                                      | Generate and validate IDA-style byte patterns               |
| `detection-assessor`                                   | Assess detection risk per anti-cheat system                 |
| `vulnerability-scanner`                                | Find exploitable vulns in drivers and binaries              |
| `struct-recovery`                                      | Recover C++ structures from memory dumps or IDA             |
| `binary-differ`                                        | Diff game updates to track offset changes                   |
| `source-grep`                                          | Deep search across all 3,985 source archives                |
| `hook-planner`                                         | Plan hook chains for specific objectives                    |
| `import-resolver`                                      | Resolve imports for manual-mapped modules                   |
| `vtable-mapper`                                        | Map virtual function tables                                 |
| `syscall-stub-generator`                               | Generate direct/indirect syscall stubs                      |
| `bone-mapper`                                          | Map skeleton bone indices per game                          |
| `ac-driver-analyzer`                                   | Deep analysis of anti-cheat kernel driver                   |
| `stack-spoofer`                                        | Spoof call stack for AC evasion                             |
| `shellcode-encoder`                                    | Encode shellcode to evade signatures                        |
| ...and 145 more focused subagents across 16 categories |

### Plugins (114)

| Plugin                                                                           | Purpose                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `game-offset-db`                                                                 | Cross-reference offset database for 60+ games           |
| `technique-finder`                                                               | Find implementation examples across all source code     |
| `yara-generator`                                                                 | Generate YARA detection rules from cheat patterns       |
| `driver-catalog`                                                                 | Vulnerable driver database with exploit primitives      |
| `hook-library`                                                                   | All hook types with code examples and detection vectors |
| `struct-database`                                                                | Known game engine structures (UE4/UE5, Source, Unity)   |
| `anti-cheat-timeline`                                                            | AC update tracking and bypass shelf-life                |
| `exploit-chain-builder`                                                          | Compose multi-stage exploit chains                      |
| `signature-generator`                                                            | Generate and validate byte patterns                     |
| `cs2-offsets` / `valorant-offsets` / ...                                         | Per-game offset databases (10 games)                    |
| `ue4-sdk-reference` / `ue5-sdk-reference`                                        | Engine SDK structure references                         |
| `ntapi-reference`                                                                | Undocumented NT API reference                           |
| `syscall-table`                                                                  | Windows syscall numbers per OS build                    |
| `battleye-detection-db` / `eac-detection-db` / ...                               | Per-AC detection databases                              |
| `offset-header-generator` / `hook-template-generator`                            | Code generation tools                                   |
| ...and 99 more data, reference, and code generation plugins across 11 categories |

### Prompts (148)

| Prompt                                                                   | Purpose                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------- |
| `analyze-cheat`                                                          | Full architecture analysis of a cheat project  |
| `find-bypass`                                                            | Find bypass techniques for specific anti-cheat |
| `build-cheat` / `build-esp` / `build-aimbot`                             | Design cheat systems                           |
| `reverse-binary` / `reverse-unity-game` / `reverse-unreal-game`          | RE workflows                                   |
| `write-driver` / `write-injector` / `write-hook`                         | Implementation guides                          |
| `bypass-battleye` / `bypass-eac` / `bypass-vanguard`                     | AC bypass strategies                           |
| `spoof-hardware`                                                         | HWID spoofing design                           |
| `analyze-update`                                                         | Game update offset migration                   |
| `exploit-vuln-driver` / `exploit-kernel-bug`                             | Exploitation guides                            |
| `implement-backtrack` / `implement-autowall` / `implement-prediction`    | Feature implementation                         |
| ...and 138 more prompts across 14 categories for every game hacking task |

---

## Tools (28 total)

### Workflow Tools

| Tool                 | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `research_technique` | End-to-end technique research with scored keyword ranking  |
| `analyze_project`    | Full project analysis (SKILL.md + source code)             |
| `get_agent_briefing` | Load agent definition with available subagents and plugins |

### Skill Tools

| Tool            | Description                                                    |
| --------------- | -------------------------------------------------------------- |
| `list_skills`   | List/filter skills by name or type                             |
| `read_skill`    | Read a skill SKILL.md                                          |
| `read_source`   | Read source code with pagination (50KB chunks)                 |
| `search_skills` | Multi-keyword scored search across names, descriptions, topics |
| `skill_stats`   | Library statistics                                             |

### Component Tools

| Tool                               | Description                          |
| ---------------------------------- | ------------------------------------ |
| `list_agents` / `read_agent`       | Browse and read agent definitions    |
| `list_subagents` / `read_subagent` | Browse and read subagent definitions |
| `list_plugins` / `read_plugin`     | Browse and read plugin definitions   |
| `list_prompts` / `read_prompt`     | Browse and read prompt templates     |

### Surface Tool

| Tool      | Description                                       |
| --------- | ------------------------------------------------- |
| `surface` | Report, compose, keep and recall your own tooling |

## Tooling: the model builds its own

Models do not work equally well on the same tools. A model that reasons well
over a large surface and a small local model that needs four unambiguous
single-argument tools are not served by the same list — so this server does not
impose one. **There is no base set, and no catalogue of surfaces to choose
from.** You get one tool, the whole tool catalogue, and the means to build a
surface from it.

```
surface          the only tool you begin with
```

Called with no arguments it reports where you are and lists **every registered
tool with its arguments** — required and optional, types, defaults — plus the
delta between what you carry and what you do not. A model deciding what to pick
needs to know what each tool takes; a list of bare names forces a second call
before it can even decide.

```
- `read_agent` (name: string) — Read a agent's full definition and system prompt.
- `search_skills` (query: string, has_source?: boolean, limit?: number=20) — Scored keyword search...
- `skill_stats` (no arguments) — Library statistics from the in-memory index.
```

`surface` with `detail: "<tool>"` explains one tool completely — every argument
with what it accepts, and a worked example of carrying it:

```
surface { detail: "read_agent" }
```

Then:

```
surface { pick: [...] }               build your own surface, this session
surface { save: "id" }                keep it, so later sessions can start there
surface { set: "id" }                 recall a surface you saved
surface { list: "tools" }             the catalogue again
surface { list: "surfaces" }          what you have saved
```

An entry may also **bind arguments**, which is how a model defines a tool whose
call shape it cannot get wrong:

```
surface { pick: [
  "search_skills",
  { tool: "read_source", as: "read_kdmapper", args: { name: "ags-kdmapper-1909" } }
] }
```

`read_kdmapper` is listed with `name` **gone from its schema** — not merely
pre-filled — so it is called with no arguments at all. A bound argument leaves
the schema because an argument the caller can still see is one the caller can
still get wrong, and removing the decision is the whole point. The model can also
re-word the arguments that remain with `argDescriptions`, and re-word the tool
itself with `description`.

Bound arguments win over anything the caller sends: they left the schema, so a
caller sending one is reaching past what it was shown. A partial binding keeps
everything it did not bind — `args: { limit: 5 }` on a three-argument tool leaves
a two-argument tool.

### Four things you can do to an argument

They are deliberately different, and the difference is the point:

|                   | what happens                      | why                                |
| ----------------- | --------------------------------- | ---------------------------------- |
| `args`            | leaves the schema, always wins    | the decision is gone               |
| `defaults`        | stays, omittable, shows the value | _"this, unless you say otherwise"_ |
| `constrain`       | stays, narrows, **enforced**      | the wrong value cannot get through |
| `argDescriptions` | stays, re-worded                  | said the way you need to hear it   |

```
surface { pick: [
  { tool: "search_skills", as: "find",
    defaults:  { limit: 3 },
    constrain: { limit: { minimum: 1, maximum: 3 } },
    argDescriptions: { query: "What you are looking for." } }
] }
```

A constraint is **enforced, not advertised**: a schema that lists an enum while
the server accepts anything is a lie, so a value outside the range is refused and
the refusal names what was allowed. Constraints cover `enum`, `minimum`,
`maximum`, `minLength`, `maxLength` and `pattern`.

Two contradictions are refused rather than accepted as no-ops, because either
would leave the surface saying something it does not do:

- a `defaults` or `constrain` on an argument you also **fixed** — the fixed value
  wins, so the other is inert;
- a constraint the tool's **own default** would break. `search_skills` defaults
  `limit` to 20, so narrowing the maximum to 3 without also setting a `defaults`
  that fits is refused, and the refusal says which default it conflicts with.

Omit `as` and the tool is redefined under its own name: _"`read_source`, but for
me `name` is already set."_

`pick` is the path. Nothing is chosen for you — not here, and not anywhere else.
A composed surface is session-scoped and writes nothing to disk until you `save`
it, so recomposing when the task changes shape costs one call. Re-saving an id
you already own **revises** it: your tooling has to be able to change as the work
does.

**Nothing is withheld while you decide.** Every registered tool stays callable by
name even when your surface does not carry it, so you can finish a task first and
shape your surface afterwards. `surface` always shows the delta.

### Chaining tools

A chain is a declaration, not a program. Fixed sequence, no branching, at most
three steps, each running at most three times:

```
surface { pick: [
  { tool: "search_skills", as: "find_and_read",
    args: { limit: 3 },
    then: [{ tool: "read_skill", extract: { name: "- \\*\\*([^*]+)\\*\\*" } }],
    output: { head: 6 } }
] }
```

Each step receives values pulled out of the previous answer, keyed by the
argument they fill. A pattern with a capture group targets part of a line; one
without yields the whole match.

```
[chain] search_skills → read_skill
[2] read_skill(name=ags-eddeeh-kdmapper) → 1072 chars

# ags-eddeeh-kdmapper
...
```

**The trace is not decoration.** It says which step ran, with what, and how much
came back — which is the difference between a chain a model can debug and one it
cannot see into. It names the tool that actually ran, so a step calling a tool the
surface defined never hides behind its alias.

`take: 2` fans out — one call per match, each result labelled, because a content
rule that stripped the labels would leave several results with no way to tell
which is which.

Five things are refused rather than half-run, and each says which step and why:

| what went wrong                         | what happens                                              |
| --------------------------------------- | --------------------------------------------------------- |
| a step returns an error                 | the chain stops, that step is named, its error shown      |
| an extraction matches nothing           | the chain stops; the **pattern and the answer** are shown |
| fewer matched than `take`               | it runs what it has and **says so**                       |
| a chain inside a chain                  | refused: nesting makes a sequence something to work out   |
| a step naming nothing, or a bad pattern | refused before anything runs, all faults at once          |

The last two matter most. A chain that half-runs and says nothing useful is worse
than one that never started, and silently reading one of the three things you
asked for is the kind of lie this design keeps refusing to tell.

Two rules that make a chain predictable:

- **Extraction reads the raw answer, at every step.** `output` shaping is for the
  reader; a rule meant for eyes must not decide what flows between steps. (It
  once read raw for step 2 and shaped for step 3 — the same chain behaving
  differently by position.)
- **An extraction that matched more than 50 values says so.** The cap exists so a
  broad pattern cannot pull tens of thousands of values, but a model that cannot
  tell fifty from seventy-five reasons about the wrong set, so reaching the cap
  is reported in the trace and a narrow pattern stays silent.
- **A step may not fill an argument that changes session state.** Otherwise a
  chain could reconfigure the surface it is running under, and change what the
  remaining steps resolve against. Reading the surface tool as a step is fine;
  `pick`, `save` and `set` are not. Which arguments those are is declared in
  `profiles/manifest.json`, so a second mutating tool costs a line of data.

### Shaping the answer

The mirror of shaping the call. A tool that returns a thousand lines is unusable;
the same tool returning fifty is not.

```
surface { pick: [
  { tool: "read_agent", as: "who",
    output: { sections: ["Workflow"], head: 20 } }
] }
```

| rule            | keeps                                                  |
| --------------- | ------------------------------------------------------ |
| `sections`      | only these markdown sections, heading included         |
| `filter`        | only lines matching a pattern                          |
| `reject`        | everything except lines matching a pattern             |
| `head` / `tail` | the first or last N lines                              |
| `maxChars`      | a character cap, ending on a line break where possible |

Rules apply in a fixed order — sections, line selection, line window, character
cap — so a rule set means one thing rather than depending on the order it was
written in.

**Every reduction is reported.** This is the whole point of the feature, not a
detail of it:

```
## Workflow

1. Receive a task or question within the domain
...

[shaped: 14 of 66 lines — sections: Core Capabilities, Workflow]
```

A shaped answer that hid its own shaping would be read as the whole truth, and a
model acting on a truncated list as if it were complete is worse off than one
that got no answer at all. Three consequences of that rule:

- a rule that removed **nothing** adds no note, so the note never cries wolf;
- a rule that removed **everything** says so (`nothing matched — 0 of 66 lines`)
  instead of returning a blank, which would read as "the tool returned nothing";
- a **failure is never shaped.** The reason for a failure is the one thing a
  caller must not lose, so errors pass through untouched however destructive the
  rules are.

`head` with `tail` is refused as ambiguous, and a pattern that will not compile is
refused by name — a rule that cannot do what it says is worse than no rule.

### Reaching a host that reads the list once

A host that reads `tools/list` at session start only ever sees the seed, so a
surface composed later would be unreachable — the model composes into a void.

MCP's standard answer applies, and this server implements it:

- `tools.listChanged` is declared in the initialize response, so a conforming
  host knows to re-list;
- `notifications/tools/list_changed` is sent whenever the surface actually
  changes — on `pick`, on `set`, on `save`;
- and **never** on a read, and **never** when a change was refused. A signal that
  fires when nothing changed is one a host learns to ignore.

The notification goes out after the report is built, so a host that re-lists
immediately fetches the surface the report just described.

A host that ignores the notification still works: the report says what changed,
and every registered tool stays callable by name. The announcement makes the
composed surface _reachable_; it is not what makes it _work_.

### What cannot be changed

Three guards protect the floor, each because removing it takes away the way back:

| guard                                | why                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| a shipped surface cannot be replaced | it is what an unrecognised caller lands on; replacing the seed would leave no way to discover the catalogue |
| the runtime id is reserved           | the engine uses it for a surface composed in memory, so a file under that name would mean two things        |
| a mistyped rule is refused           | `minimun` used to be accepted and ignored, leaving the model reasoning as if a range were in force          |

The first is enforced at **both** layers — `save` refuses it with a reason, and
the loader refuses an authored file whose id collides with a shipped one, because
a file written straight to disk never passes through `save`. A refused
replacement is reported in `list: "surfaces"` rather than swallowed: silent
rejection would leave a model wondering why nothing changed.

### What the server does ship

Exactly one surface, and it is not a choice:

```
profiles/manifest.json     seed surface, the core every surface must carry
profiles/default.json      the seed itself: one tool
```

Any second file here would be the server guessing what some model needs, which is
the thing this design exists to avoid. The gate `no-pre-authored-base` fails if
one appears.

### The surface core

`surface` is carried by **every** surface, whatever else it drops. A surface may
choose to be narrow; it may not choose to be _inescapable_ — without this one
tool a model could not see that a surface governs it, could not discover the
catalogue, and could not leave. The core is declared in `manifest.json` and
enforced in the shaper, which every profile passes through: shipped, authored, or
edited by hand on disk.

### The design is data

No tool name, surface id, or list appears in the engine. The shape of the system
lives in files, read at runtime:

```
profiles/manifest.json     { seed, surfaceCore, pickedId }
profiles/<id>.json         a surface shipped with the server
model-profiles/<id>.json   surfaces you built and saved
```

Both directories go through the same schema, so a shipped surface and a saved one
are the same kind of thing: one is simply already on disk. Adding, reordering or
rewording a surface is an edit to data — no rebuild, no source change. The
`data-driven` gate enforces that: it fails if a surface id appears in the source,
and proves a drop-in file takes effect with the built artifact byte-identical.

### Resolution

A request's surface is chosen by the first of: `_meta.profile`, `_meta.model`, the
session override from `set`, `MCP_MODEL_PROFILE`/`MCP_MODEL`, a client-name match,
or the seed. With nothing pre-authored, an unrecognised caller always lands on the
seed — and `detect-client` is the gate that proves no client is quietly handed a
base set.

## Installation

### Requirements

- Node.js 20+ (the build tooling requires it; the built server's own floor is the SDK's)
- npm

### Build

```bash
cd mcp-gamehacking
npm install
npm run build
```

### Connect to Claude Code

Add to your MCP settings:

```json
{
  "mcpServers": {
    "gamehacking": {
      "command": "node",
      "args": ["/path/to/mcp-gamehacking/dist/index.js"]
    }
  }
}
```

### Connect to Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gamehacking": {
      "command": "node",
      "args": ["/path/to/mcp-gamehacking/dist/index.js"]
    }
  }
}
```

### Connect to Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gamehacking": {
      "command": "node",
      "args": ["/path/to/mcp-gamehacking/dist/index.js"]
    }
  }
}
```

---

## Usage Examples

### Research a technique

```
> research_technique("EPT hook")

Found 12 relevant skills (showing top 10):
- ags-budget-ept (score:7) -- BudgetEPT: stealthy inline EPT-like hooks...
- ags-hyper-deceit (score:6) -- HyperDeceit: HvcallCodeVa hook framework...
```

### Analyze a project

```
> analyze_project("ags-kdmapper", focus="architecture")

# kdmapper
Most popular kernel driver mapper using iqvw64e.sys...
## Source Code (first 300 lines)
...
```

### Search skills

```
> search_skills("valorant vanguard bypass")

Found 23 skills:
- vgk-internals-callbacks (score:7)
- ags-valorant-external (score:4)
```

### Agent briefing

```
> get_agent_briefing("exploit-developer")

# Agent: exploit-developer
Kernel exploit and driver development agent...
## Available Subagents: offset-finder, detection-assessor
## Available Plugins: game-offset-db, technique-finder
```

---

## Project Structure

```
mcp-gamehacking/
+-- src/index.ts              # MCP server (29 tools)
+-- src/profiles/             # Per-model profile layer
+|   +-- types.ts              #   profile schema and id rules
+|   +-- builtin.ts            #   built-in profiles
+|   +-- registry.ts           #   load, validate, persist
+|   +-- resolve.ts            #   resolution order and tool shaping
+-- profiles/                  # SHIPPED: manifest.json + the seed (data)
+-- model-profiles/            # Surfaces the model built and saved (data)
+-- test/                      # Rstest suites
+-- dist/                      # Compiled JS
+-- skills/                    # 4,161 skill directories
|   +-- <hand-written>/        #   177 curated deep-dive skills
|   +-- ags-*/                 #   3,985 archived projects
|       +-- SKILL.md           #     description + metadata
|       +-- source.txt         #     full source tree snapshot
+-- agents/                    # 75 agents across 7 categories
|   +-- games/        (15)     #   CS2, Valorant, Fortnite, Apex, etc.
|   +-- engines/      (10)     #   UE4/5, Unity, Source, CryEngine, etc.
|   +-- anti-cheat/   (10)     #   EAC, BE, Vanguard, FACEIT, Byfron, etc.
|   +-- kernel/       (10)     #   drivers, HV, firmware, DMA, EPT
|   +-- techniques/   (10)     #   injection, hooking, obfuscation, etc.
|   +-- tools/        (10)     #   IDA, Ghidra, WinDbg, Frida, x64dbg
|   +-- core/         (10)     #   RE, exploits, cheatdev, malware, etc.
+-- subagents/                 # 161 subagents across 16 categories
|   +-- offsets/      (10)     +-- patterns/     (10)
|   +-- code-analysis/(10)     +-- anti-cheat/   (11)
|   +-- kernel/       (10)     +-- injection/    (10)
|   +-- hooks/        (10)     +-- rendering/    (10)
|   +-- memory/       (10)     +-- network/      (10)
|   +-- game-data/    (10)     +-- stealth/      (10)
|   +-- reversing/    (10)     +-- platform/     (10)
|   +-- build/        (10)     +-- testing/      (10)
+-- plugins/                   # 114 plugins across 11 categories
|   +-- game-offsets/ (11)     +-- engine-sdks/  (10)
|   +-- anti-cheat/   (10)     +-- windows-int/  (10)
|   +-- technique-ref/(13)     +-- tool-finders/ (10)
|   +-- code-gen/     (10)     +-- binary-anal/  (10)
|   +-- crypto/       (10)     +-- detection/    (10)
|   +-- rendering/    (10)
+-- prompts/                   # 148 prompts across 14 categories
|   +-- build/        (11)     +-- write/        (16)
|   +-- implement/    (11)     +-- reverse/      (10)
|   +-- bypass/       (10)     +-- analyze/      (10)
|   +-- design/       (10)     +-- exploit/      (10)
|   +-- compare/      (10)     +-- debug/        (10)
|   +-- generate/     (10)     +-- migrate/      (10)
|   +-- optimize/     (10)     +-- setup/        (10)
+-- tools/checks/check.mjs      # Gate battery (see GATES.md)
+-- GATES.md                    # Acceptance ledger for the profile layer
+-- package.json
+-- tsconfig.json
```

---

## Verification

```bash
npm run build          # compile dist/
npm run check          # lint, typecheck, format
npm test               # test suite
npm run test:gates     # gate battery (spawns the built server)
npm run verify         # all of the above, in order
```

`GATES.md` is the acceptance ledger: each gate names the check that proves it,
and `npm run test:gate -- <name>` runs one on its own.

The gate battery spawns the built server and drives it over stdio JSON-RPC, so
it exercises the shipped artifact rather than the sources.

Three checks and five tests compare against real data in `skills/`. That archive
is 19 GB, so CI checks the repository out without it; those cases detect the
absence and **skip with a loud notice** rather than asserting against nothing.
Set `GATES_REQUIRE_ARCHIVE=1` to make an absent archive a failure instead.

---

## Skill Categories

### Hand-Written (177)

| Category         | Examples                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| Kernel / Drivers | kernel-cr3-physmem, kernel-hooks-ssdt, vulnerable-driver-exploits        |
| Injection        | reflective-dll, pe-injection-remote, early-bird-apc, threadpool-wait     |
| Anti-Cheat       | vanguard (15+ vgk-* skills), battleye, eac, patchguard, hvci             |
| Game Engines     | unreal-object-model, source-netvars, world-to-screen, present-hook       |
| Obfuscation      | fix-vmp-themida-ollvm, control-flow-flattening, mixed-boolean-arithmetic |
| UEFI / EFI       | efi-driver-bootkit, vgk-secure-boot-spoof                                |
| DMA              | dma, iommu, iommu-state-verification                                     |

### Archived Projects (3,985)

Sourced from [awesome-game-security](https://github.com/gmh5225/awesome-game-security):

- **60+ games**: CS2, Valorant, Fortnite, Apex, PUBG, Rust, R6, EFT, Overwatch, Genshin, etc.
- **Techniques**: injection, hooking, DMA/FPGA, driver comm, overlays, kernel exploits
- **Anti-cheat research**: BattlEye, EAC, Vanguard, VAC, FACEIT, Byfron
- **Tools**: IDA plugins, Ghidra scripts, debugger extensions, dumpers, unpackers
- **Platforms**: Windows kernel, Android (Zygisk/KernelSU/Magisk), iOS, Linux

---

## Tech Stack

- **Runtime**: Node.js 20+ to build, 18+ to run a prebuilt `dist/`
- **Language**: TypeScript
- **Protocol**: MCP via `@modelcontextprotocol/sdk`
- **Transport**: stdio
- **CI**: GitHub Actions — build, lint, typecheck, format, tests, gates

---

## License

This project aggregates publicly available research materials and open-source project snapshots for educational and security research purposes.

---

# mcp-gamehacking (RU)

MCP-сервер для геймхакинга и реверс-инжиниринга. База знаний из **4,100+ скиллов** с полными архивами исходного кода, специализированными агентами и инструментами.

## Возможности

- **177 вручную написанных скиллов** -- инъекции, хуки, ядерные драйверы, внутренности античитов, архитектура ESP/аимбота
- **3,985 архивированных проектов** -- полные снимки исходного кода из экосистемы игровой безопасности
- **75 агентов** (7 категорий) -- по играм (CS2, Valorant, Fortnite, Apex...), движкам (UE, Unity, Source, CryEngine...), античитам (EAC, BE, Vanguard, FACEIT...), ядру (драйверы, HV, DMA, EPT), техникам (инъекции, хуки, обфускация), инструментам (IDA, Ghidra, WinDbg, Frida)
- **161 субагент** (16 категорий) -- поиск офсетов, анализ кода, паттерны, диффы бинарников, grep по 3985 архивам, планирование хуков, восстановление структур, аудит драйверов, стелс, рендеринг, сеть и ещё 145
- **114 плагинов** (11 категорий) -- базы офсетов по 10+ играм, справочники SDK, каталог уязвимых драйверов, детект-базы по каждому античиту, генераторы кода, анализаторы бинарников, крипто, рендеринг
- **148 промптов** (14 категорий) -- байпасс каждого античита, билд ESP/аимбота/триггера, реверс Unity/UE/Source игр, написание драйверов/инжекторов/оверлеев, эксплуатация, HWID спуф, миграция, оптимизация, дизайн
- **16 MCP-инструментов** -- воркфлоу-тулы, скиллы, компоненты

## Установка

```bash
npm install
npm run build
```

Добавьте в настройки MCP-клиента:

```json
{
  "mcpServers": {
    "gamehacking": {
      "command": "node",
      "args": ["/path/to/mcp-gamehacking/dist/index.js"]
    }
  }
}
```

## Категории скиллов

- **Ядро / Драйверы**: CR3, SSDT, уязвимые драйверы, BYOVD
- **Инъекции**: рефлективная DLL, manual map, APC, thread hijack
- **Античиты**: Vanguard, BattlEye, EAC, PatchGuard, HVCI
- **Игровые движки**: Unreal, Source, Unity -- офсеты, нетвары, w2s
- **Обфускация**: VMProtect, Themida, OLLVM -- распаковка и деобфускация
- **UEFI / EFI**: буткиты, EFI-маперы, спуф SecureBoot
- **DMA / FPGA**: прямой доступ к памяти, IOMMU
- **60+ игр**: CS2, Valorant, Fortnite, Apex, PUBG, Rust, R6, EFT и др.

## Лицензия

Проект агрегирует публично доступные исследовательские материалы и open-source проекты в образовательных целях и для исследований безопасности.
