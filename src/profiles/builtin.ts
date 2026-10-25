import { ModelProfileSchema, type ModelProfile } from "./types.js";

/**
 * Built-in profiles. Every entry is validated at module load, so a malformed
 * profile fails immediately instead of surfacing as odd behaviour at call time.
 *
 * A profile is not a filter over a shared catalogue: it owns its surface. It
 * decides which tools it carries, in what order, and how each one is worded for
 * the model that reads it. There is deliberately no "generic" profile that
 * presents everything as a neutral baseline, because a surface that fits no
 * model in particular fits every model badly.
 */

/** Tools that let a model orient, see its options, and take or author more. */
const BOOTSTRAP_TOOLS = [
  "get_model_profile",
  "list_model_profiles",
  "list_available_tools",
  "set_model_profile",
  "define_model_profile",
  "search_skills",
  "read_skill",
];

const DEFINITIONS = [
  {
    id: "default",
    label: "Seed",
    description:
      "Bootstrap surface for an unrecognised caller: enough to orient, see every option, and take or author a fitted surface.",
    match: { clientNames: [], models: [] },
    tools: {
      include: BOOTSTRAP_TOOLS,
      order: BOOTSTRAP_TOOLS,
      descriptions: {
        get_model_profile:
          "Start here. Reports which profile governs this session, why it was selected, and the guidance written for it.",
        list_model_profiles:
          "See the profiles available. Each one carries a different surface, so pick the one that fits how you work.",
        list_available_tools:
          "See every tool the server registers, including the ones this seed does not carry. Nothing is withheld: any tool can be called by name, or added to a profile of your own.",
        set_model_profile: "Switch to a profile that fits you. Use 'auto' to return to detection.",
        define_model_profile:
          "Build your own surface: choose which tools you carry, the order, and how each is described to you. Saved and reloaded in later sessions.",
        search_skills:
          "Scored search across the library. A specific query beats several broad ones.",
        read_skill: "Read one curated write-up. Prefer this over raw source.",
      },
    },
    guidance:
      "You are running on the seed surface, which is deliberately small: it carries only what you need to orient and then choose. It is not the full library and is not meant to be.\n\n" +
      "Call `list_available_tools` to see everything the server registers, and `list_model_profiles` to see the surfaces already built. If one fits, take it with `set_model_profile`. If none does, call `define_model_profile` and build the surface you actually want — pick your tools, order them, and write the descriptions in the terms you work best in. That profile persists for later sessions.\n\n" +
      "Nothing is withheld while you are on the seed: every tool remains callable by name, so you can finish a task now and shape your surface afterwards.",
    workflow: [
      "get_model_profile to see which surface you have.",
      "list_available_tools to see what else exists.",
      "set_model_profile if a built-in fits, otherwise define_model_profile.",
      "search_skills then read_skill to do the work.",
    ],
  },
  {
    id: "full",
    label: "Complete",
    description:
      "Carries every registered tool. For a caller that knows what it wants and would rather not have anything chosen for it.",
    match: { clientNames: [], models: ["full", "complete", "unfiltered"] },
    tools: { order: [], exclude: [], descriptions: {} },
    guidance:
      "This profile carries every tool the server registers, in registration order, with the server's own wording. It makes no judgement about what suits you, which is exactly the point: take it when you already know which tools you want and would rather not have a surface chosen on your behalf.\n\n" +
      "The cost is real. Every listed tool contributes its full schema to each `tools/list`, so a large surface spends context before any work happens. If you find yourself ignoring most of it, build a narrower profile with `define_model_profile`.",
    workflow: [
      "Skim the listing once to learn what exists.",
      "Narrow it with define_model_profile once you know your working set.",
    ],
  },
  {
    id: "claude",
    label: "Claude",
    description:
      "Curated-first surface with cross-checking guidance: read the distilled write-up, then verify against a second archive.",
    match: { clientNames: ["claude", "anthropic"], models: ["claude", "opus", "sonnet", "haiku"] },
    tools: {
      order: [
        "skill_stats",
        "research_technique",
        "search_skills",
        "read_skill",
        "find_similar",
        "find_offset",
        "find_function",
        "grep_sources",
        "read_source",
      ],
      descriptions: {
        read_skill:
          "Read the curated write-up for one skill. This is the distilled layer; open source only when the write-up is not enough.",
        read_source:
          "Open an unedited source archive, paginated. Expensive: single projects exceed 100,000 lines. State which project and line range you read so the conclusion is auditable.",
        find_offset:
          "Confirm a concrete offset against a second archive. A single archive can be stale or simply wrong, so cross-check before repeating a value.",
        grep_sources:
          "Stream a pattern across every archive. Use it to establish how widely something appears, not to read one project.",
        research_technique:
          "Ranked briefing across the library. Usually the fastest way into unfamiliar ground.",
      },
    },
    guidance:
      "You handle long, structured context well, so spend it on the curated layer first. Prefer `read_skill` over `read_source`: the write-up is distilled and the archive is an unedited dump.\n\n" +
      "When a write-up asserts a concrete offset or symbol, confirm it against a second archive with `find_offset` or `grep_sources` before repeating it. Agreement across independent archives is the strongest signal this library offers, and a single archive is not evidence.\n\n" +
      "When you do open source, name the project and line range you read, so the conclusion can be checked without re-deriving it.",
    workflow: [
      "skill_stats, then research_technique for a ranked entry point.",
      "read_skill on the top two or three hits.",
      "Cross-check any concrete offset or symbol against a second archive.",
      "Open read_source only for the project you intend to reason about.",
      "Report which archives you actually consulted.",
    ],
  },
  {
    id: "gpt",
    label: "GPT",
    description:
      "Short deterministic sequences over broad exploration, with compact structured results.",
    match: {
      clientNames: ["gpt", "openai", "chatgpt", "codex"],
      models: ["gpt", "o1", "o3", "o4"],
    },
    tools: {
      order: [
        "search_skills",
        "read_skill",
        "get_file_tree",
        "find_function",
        "extract_offsets",
        "skill_stats",
        "read_source",
      ],
      descriptions: {
        search_skills:
          "One specific multi-word query. Scores across name, description, topics, games and engines, so a precise query beats several broad ones.",
        get_file_tree:
          "Cheapest way to learn a project's shape. Use it instead of paging through source to discover what exists.",
        extract_offsets:
          "Direct offset dump from one project, with surrounding context. Use when a list of values is the whole answer.",
        read_source:
          "Paginated archive read. Reach for it only after the tree or an offset dump has localised what you need.",
      },
    },
    guidance:
      "Keep the sequence short and purposeful: one search, one read, then act. A specific query beats several broad ones, and `get_file_tree` is cheaper than paging through source to find out what exists.\n\n" +
      "Return a compact result rather than narrating the exploration. If a task needs a value, reach for `extract_offsets` or `find_function` instead of reading a project end to end.",
    workflow: [
      "search_skills with a specific multi-word query.",
      "read_skill on the best hit.",
      "get_file_tree when you need the project's structure.",
      "extract_offsets / find_function for concrete values.",
      "Answer directly; skip restating the search process.",
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    description:
      "Aggregation-first surface: fan out across archives cheaply, then synthesise with per-claim attribution.",
    match: { clientNames: ["gemini", "google"], models: ["gemini", "gemma"] },
    tools: {
      order: [
        "search_skills",
        "search_by_game",
        "search_by_engine",
        "find_similar",
        "grep_sources",
        "compare_projects",
        "read_source",
        "skill_stats",
      ],
      descriptions: {
        grep_sources:
          "Streams every archive at once. The right tool for 'which projects do X', not for reading one project closely.",
        compare_projects:
          "Groups related archives so several can be read in one pass, instead of visiting them one at a time.",
        find_similar:
          "Find alternative implementations of the same technique, so a synthesis is not built on one source.",
        read_source:
          "Batch reads are efficient here. Attribute each claim to the archive it came from.",
      },
    },
    guidance:
      "Use your context budget to aggregate rather than to go deep on one file. `search_by_game`, `search_by_engine` and `find_similar` fan out cheaply, and `grep_sources` establishes how widely a technique appears across the whole library.\n\n" +
      "When you synthesise, attribute each claim to the archive it came from and say how many archives agreed. Agreement across independent archives is the strongest signal available here; a single source is an anecdote.",
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
      "Five high-yield tools for a small context window, weighted toward search over reading.",
    match: {
      clientNames: ["compact", "small"],
      models: ["small", "mini", "nano", "flash", "lite"],
    },
    tools: {
      include: ["search_skills", "read_skill", "skill_stats", "list_skills", "get_file_tree"],
      order: ["search_skills", "read_skill", "skill_stats", "list_skills", "get_file_tree"],
      descriptions: {
        search_skills: "Narrow first. One specific query, then stop searching and read.",
        read_skill: "The distilled write-up. Cheapest way to a real answer.",
        list_skills: "Cheaper than a search when you already know part of the name.",
        get_file_tree: "Project shape without reading any source.",
        skill_stats: "Confirm the library is reachable and see its shape.",
      },
    },
    guidance:
      "Your budget is small, so treat every read as expensive. Five tools are carried here for that reason.\n\n" +
      "Never call `read_source` without a specific question: a single archive can exceed 100,000 lines. Work in one direction — narrow with `search_skills`, read the write-up with `read_skill`, and stop once you can answer.\n\n" +
      "If you need more than these five, say so and take a wider profile rather than working around the gap.",
    workflow: [
      "search_skills once, with the most specific query you can form.",
      "read_skill on the single best hit.",
      "Answer; widen only if the answer is genuinely insufficient.",
    ],
  },
  {
    id: "local",
    label: "Local / small model",
    description:
      "Four unambiguous single-argument tools. Avoids multi-step composition and large output.",
    match: {
      clientNames: ["ollama", "lmstudio", "llama", "local"],
      models: ["llama", "qwen", "mistral", "phi"],
    },
    tools: {
      include: ["search_skills", "read_skill", "skill_stats", "get_file_tree"],
      order: ["search_skills", "read_skill", "skill_stats", "get_file_tree"],
      descriptions: {
        search_skills:
          "Takes a plain query string. If nothing useful comes back, try one distinctive word rather than a sentence.",
        read_skill: "Takes one exact skill name, copied from a search result.",
        get_file_tree: "Takes a project name and max_entries of at least 10.",
        skill_stats: "No arguments. Use it to confirm the library is reachable.",
      },
    },
    guidance:
      "Four tools are carried, all with simple arguments. Use them one at a time and do not chain steps speculatively.\n\n" +
      "`search_skills` takes a plain query string; if the first query returns nothing useful, try a single distinctive word rather than a sentence. `read_skill` takes one exact skill name copied from a search result. `get_file_tree` needs a project name and `max_entries` of at least 10.\n\n" +
      "The offset, grep and source tools are deliberately absent: they need careful arguments and produce large output.",
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
