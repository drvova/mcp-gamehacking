import { ModelProfileSchema, type ModelProfile } from "./types.js";

/**
 * Built-in profiles. Every entry is validated at module load, so a malformed
 * profile fails immediately instead of surfacing as odd behaviour at call time.
 *
 * Guidance here is deliberately model-specific rather than generic: the point of
 * the layer is that a model is told how to drive *this* library in the shape it
 * handles best. A profile a model writes for itself goes in `model-profiles/`.
 */
const DEFINITIONS = [
  {
    id: "default",
    label: "Default",
    description:
      "Neutral surface for an unrecognised caller. Presents the complete tool set in its natural order.",
    match: { clientNames: [], models: [] },
    tools: { order: [], exclude: [] },
    guidance:
      "No model-specific profile matched, so the complete tool surface is available in its natural order. Start with `skill_stats` for orientation, `search_skills` to locate material, `read_skill` for the curated write-up, and `read_source` only when you need the implementation itself. `read_source` is paginated at 200 lines by default and some archives exceed 100,000 lines, so page deliberately instead of pulling whole files.",
    workflow: [
      "Orient with skill_stats, then search_skills for the topic.",
      "Read the SKILL.md with read_skill before opening any source.",
      "Page through read_source with offset/limit only when implementation detail matters.",
      "Use find_offset / find_function / grep_sources to cross-reference across archives.",
    ],
  },
  {
    id: "claude",
    label: "Claude",
    description:
      "For Claude clients. Favours explicit sequential tool use, reading curated material before raw source, and cross-checking claims against a second archive.",
    match: { clientNames: ["claude", "anthropic"], models: ["claude", "opus", "sonnet", "haiku"] },
    tools: {
      order: [
        "skill_stats",
        "search_skills",
        "read_skill",
        "research_technique",
        "find_similar",
        "read_source",
        "find_offset",
        "find_function",
        "grep_sources",
      ],
      exclude: [],
    },
    guidance:
      "You handle long, structured context well, so spend it on the curated layer first. Prefer `read_skill` over `read_source`: the SKILL.md is a distilled write-up and the source archive is an unedited dump. When a skill makes a claim about an offset or an API, confirm it against a second archive with `find_offset` or `grep_sources` before repeating it — a single archive can be stale or simply wrong. `research_technique` returns a ranked briefing and is usually the fastest way into unfamiliar ground. When you do open source, state which project and line range you read so the conclusion is auditable.",
    workflow: [
      "skill_stats, then research_technique for a ranked entry point.",
      "read_skill on the top two or three hits.",
      "Cross-check any concrete offset or symbol with find_offset / find_function.",
      "Open read_source only for the specific project you intend to reason about.",
      "Report which archives you actually consulted.",
    ],
  },
  {
    id: "gpt",
    label: "GPT",
    description:
      "For GPT clients. Favours a short, deterministic call sequence and terse structured output over broad exploratory reads.",
    match: {
      clientNames: ["gpt", "openai", "chatgpt", "codex"],
      models: ["gpt", "o1", "o3", "o4"],
    },
    tools: {
      order: [
        "search_skills",
        "read_skill",
        "find_function",
        "find_offset",
        "extract_offsets",
        "get_file_tree",
        "skill_stats",
      ],
      exclude: [],
    },
    guidance:
      "Keep the call sequence short and purposeful: one search, one read, then act. `search_skills` accepts a multi-word query and scores across name, description, topics, games and engines, so a specific query beats several broad ones. `get_file_tree` is the cheapest way to understand a project's shape before committing to reads — use it instead of paging through source to find out what exists. `extract_offsets` gives a direct offset dump from one project when that is all you need. Prefer returning a compact result over narrating the exploration.",
    workflow: [
      "search_skills with a specific multi-word query.",
      "read_skill on the best hit.",
      "get_file_tree if you need the project's structure.",
      "extract_offsets / find_function for concrete values.",
      "Answer directly; skip restating the search process.",
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    description:
      "For Gemini clients. Leans on large-context aggregation: batch reads across many archives, then synthesise with explicit source attribution.",
    match: { clientNames: ["gemini", "google"], models: ["gemini", "gemma"] },
    tools: {
      order: [
        "search_skills",
        "skill_stats",
        "find_similar",
        "search_by_engine",
        "search_by_game",
        "grep_sources",
        "read_source",
        "compare_projects",
      ],
      exclude: [],
    },
    guidance:
      "Use your context budget to aggregate rather than to go deep on one file. `search_skills` with `has_source: true`, `search_by_game` and `search_by_engine` fan out cheaply; `compare_projects` and `find_similar` group related archives so you can read several in one pass. `grep_sources` streams across every archive and is the right tool for 'which projects do X' questions. When you synthesise, attribute each claim to the archive it came from and say how many archives agreed — agreement across independent archives is the strongest signal this library offers.",
    workflow: [
      "Fan out with search_by_game / search_by_engine / find_similar.",
      "grep_sources to establish how widely a technique appears.",
      "Batch read the most relevant archives.",
      "Synthesise with per-claim attribution and an agreement count.",
    ],
  },
  {
    id: "compact",
    label: "Compact context",
    description:
      "For small context windows or tight token budgets. Lists a narrow, high-yield tool set and pushes strongly toward search over reading.",
    match: {
      clientNames: ["compact", "small"],
      models: ["small", "mini", "nano", "flash", "lite"],
    },
    tools: {
      order: ["search_skills", "read_skill", "skill_stats", "list_skills", "get_file_tree"],
      include: ["search_skills", "read_skill", "skill_stats", "list_skills", "get_file_tree"],
      exclude: [],
    },
    guidance:
      "Your budget is small, so treat every read as expensive. Five tools are listed here for that reason. Never call `read_source` without a specific question — a single archive can exceed 100,000 lines. Work in this order: `search_skills` to narrow, `read_skill` for the distilled write-up, and stop when you have enough to answer. `list_skills` with a `filter` is cheaper than a broad search when you already know part of the name. Prefer one precise answer over a survey.",
    workflow: [
      "search_skills once, with the most specific query you can form.",
      "read_skill on the single best hit.",
      "Answer; only widen if the answer is genuinely insufficient.",
    ],
  },
  {
    id: "local",
    label: "Local / small model",
    description:
      "For locally hosted or lower-capability models. Reduces the surface to unambiguous single-argument tools and avoids multi-step composition.",
    match: {
      clientNames: ["ollama", "lmstudio", "llama", "local"],
      models: ["llama", "qwen", "mistral", "phi"],
    },
    tools: {
      order: ["search_skills", "read_skill", "skill_stats", "get_file_tree"],
      include: ["search_skills", "read_skill", "skill_stats", "get_file_tree"],
      exclude: [],
    },
    guidance:
      "Four tools are listed, all with simple arguments. Use them one at a time and do not chain steps speculatively. `search_skills` takes a plain query string; if the first query returns nothing useful, try a single distinctive word rather than a sentence. `read_skill` takes one exact skill name copied from a search result. `get_file_tree` needs only a project name and `max_entries` of at least 10. Avoid `read_source`, `grep_sources` and the offset tools: they need careful arguments and produce large output.",
    workflow: [
      "skill_stats to confirm the library is reachable.",
      "search_skills with one distinctive word.",
      "read_skill with the exact name from the result.",
    ],
  },
] satisfies Array<Record<string, unknown>>;

export const BUILTIN_PROFILES: ModelProfile[] = DEFINITIONS.map((definition) =>
  ModelProfileSchema.parse(definition),
);

export const DEFAULT_PROFILE_ID = "default";
