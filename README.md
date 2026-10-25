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

## The tool: `run`

**One tool. It runs code.**

```json
run(code = "", session_id = "", strings = null) -> str
```

There is no catalog of per-capability verbs, and no `action=` dispatcher — the
parameter is _code_. You discover what is here, write helpers, and those helpers
are still there next call and after a restart. The harness adapts to the model
and the task, instead of every model having to work the same hand-picked menu.

### What a session looks like

```
> run("")                                    # the manual: vocabulary + every capability

> run("await search_skills({ query: 'EPT hook' })")
Found 12 relevant skills (showing top 10):
- ags-budget-ept (score:7) -- BudgetEPT: stealthy inline EPT-like hooks...

> run("const brief = async (name) => (await read_skill({ name })).split('\\n').slice(0, 40).join('\\n');")
[function brief]

> run("await brief('ags-kdmapper')")          # still defined, one call later
# kdmapper
...
```

### Everything is reached from inside the namespace

| Seed                      | What it is                                                                 |
| ------------------------- | -------------------------------------------------------------------------- |
| the capabilities          | every project function, as an async call: `await search_skills({...})`     |
| `kb`                      | the same functions grouped: `kb.skills.search(...)`, `kb.agents.read(...)` |
| `open(name)`              | open a skill (`agent/name` for a component) to work on it in-process       |
| `describe(x)`             | one function's arguments, or an object's public members                    |
| `S`                       | the `strings` dict you passed, so long text is data rather than escaped    |
| `kept()` / `forget(name)` | what you have defined, and how to delete one                               |
| `man()`                   | the manual again                                                           |

### Persistence

- **Across calls.** A definition (`function`, `class`, `const`, `let`, `var`) is
  saved and reloaded, so a helper is written once. Refine one by defining it
  again — redefinition is fine.
- **Across restarts.** Each definition is written to
  `$GAMEHACKING_HARNESS_DIR` (default `~/.gamehacking/harness`), one file per
  bound name, and loaded at startup. Each file loads in its own try/except: a
  broken saved definition cannot stop the server from booting, and it is reported
  on stderr rather than swallowed.
- **Only definitions, never work.** A side-effecting statement is not persisted,
  so a restart rebuilds your tools without replaying your work. A declaration
  that awaits (`const hits = await search(...)`) is call-local for the same
  reason — persisting it would mean re-running its initializer.
- `forget("name")` removes one, live and on disk.

### Security: a deployment fact, not a toggle

**This executes code with the server's authority.** That is what the tool is,
not a mode it can be put into, so there is no enable/disable flag and no
"default" to reason about — a flag would reframe the whole design as an optional
feature.

**Run the server sandboxed — a container or a VM — as you would a shell.**

### Why one tool instead of twenty-eight

Every target and version supports a different subset of capabilities, and models
perform differently with different tool sets. A hand-picked menu biases the
system toward some models and some targets, and every new capability needs new
hand-wired glue. One tool that runs code against a live API inverts that: the
model composes what it needs, and its toolkit accretes in its own harness
directory rather than in this repository.

The capabilities are all still here and all still work — they are simply
**reached from code** instead of advertised as verbs. Adding one is still one
function.

### Tests isolate state

Every test and every gate points `GAMEHACKING_HARNESS_DIR` at a temp directory.
Isolation is the default in the test helper rather than something each test has
to remember, so a test cannot write into a real home directory by forgetting to
ask.

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

Every example below is one call to `run`.

### Research a technique

```
> run("await research_technique({ technique: 'EPT hook' })")

Found 12 relevant skills (showing top 10):
- ags-budget-ept (score:7) -- BudgetEPT: stealthy inline EPT-like hooks...
- ags-hyper-deceit (score:6) -- HyperDeceit: HvcallCodeVa hook framework...
```

### Build a tool once, use it all session

```
> run("const sweep = async (q) => (await search_skills({ query: q })).split('\\n').filter((l) => /driver|kernel/i.test(l));")

> run("await sweep('BYOVD')")
- ags-kdmapper (score:6): iqvw64e.sys based mapper...
```

### Work on a project's source in-process

```
> run("const d = await open('ags-kdmapper'); d.headings().slice(0, 5)")

[ "# kdmapper", "## Description", "## Source Tree", "## Key Files", "## Usage" ]

> run("d.grep(/iqvw64e/).length")
7
```

### Cross-reference offsets across the archive

```
> run("await compare_projects({ name_a: 'ags-kdmapper', name_b: 'ags-kdmapper-rs' })")
```

### Ask what something does before calling it

```
> run("describe(analyze_project)")

analyze_project({name, focus, source_lines})
  Analyze a project's source code with optional focus areas.
  - name: string — Project name (skill folder name)
  - focus: string — optional — Focus area
  - source_lines: number — optional — default 300
```

### Use a helper across sessions

```
# session 1
> run("const brief = async (n) => (await read_skill({ name: n })).slice(0, 2000);")

# session 2 — a fresh process, same harness directory
> run("await brief('hooking-vmt')")
```

## Project Structure

```
mcp-gamehacking/
+-- src/index.ts              # MCP server: capabilities + the one `run` tool
+-- src/harness.ts            # The code harness: namespace, persistence, describe
+-- test/                      # Rstest suites
+|   +-- harness.test.ts       #   the tool's contract
+|   +-- server.test.ts        #   capabilities, driven from code
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
+-- GATES.md                    # Acceptance ledger for the code harness
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

Some gates and tests compare against real data in `skills/`. That archive is
large, so CI checks the repository out without it; those cases detect the absence
and **skip with a loud notice** rather than asserting against nothing. Set
`GATES_REQUIRE_ARCHIVE=1` to make an absent archive a failure instead.

Every gate runs the harness in a temp directory, so the battery never reads or
writes a real home directory.

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
