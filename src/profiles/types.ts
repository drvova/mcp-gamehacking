import { z } from "zod";

/**
 * Profile ids become file names, so the alphabet is deliberately narrow: no
 * separators, no dots, no leading or trailing hyphen. Anything outside it is
 * rejected rather than sanitized, so a hostile id can never escape the
 * profile directory.
 */
export const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Windows reserves these names for devices regardless of extension, so
 * `con.json` is not a normal file there. Reject them explicitly rather than
 * letting the write fail in a confusing way on one platform.
 */
const RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export const PROFILE_ID_MESSAGE =
  "id must be lowercase kebab-case (letters, digits, hyphens), 1-64 characters, not starting or ending with a hyphen, and not a reserved device name";

/** Signals used to recognise a caller. All matching is case-insensitive substring. */
const MatchSchema = z.object({
  clientNames: z.array(z.string().min(1)).default([]),
  models: z.array(z.string().min(1)).default([]),
});

/**
 * A tool the model defines for itself by binding arguments of a registered one.
 *
 * The point is the call shape, not the capability. A tool a model must call with
 * six correct arguments is a different tool from the same one with four of them
 * already set, and if models do not perform equally then the call shape is
 * exactly where a weaker one fails. Binding removes the decision.
 */
/**
 * What an argument is allowed to be, for arguments the caller keeps.
 *
 * Binding removes a decision; constraining narrows one. A `limit` that can only
 * be 1-20, or a category that must be one of five known values, cannot be got
 * wrong in a way that matters — and the narrowed schema says so before the call
 * rather than after it.
 */
const ConstraintSchema = z.object({
  enum: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .min(1)
    .optional()
    .describe("The only values accepted"),
  minimum: z.number().optional().describe("Lowest accepted number"),
  maximum: z.number().optional().describe("Highest accepted number"),
  minLength: z.number().int().nonnegative().optional().describe("Shortest accepted string"),
  maxLength: z.number().int().nonnegative().optional().describe("Longest accepted string"),
  pattern: z.string().optional().describe("Regular expression the string must match"),
});

/**
 * One step of a chain: a tool to run on what the previous step produced.
 *
 * A step is a declaration, not a program. There is no branching, no condition,
 * and no way to run a step twice with different logic — the sequence is fixed
 * and every step runs, or the chain fails and says which step failed. That is
 * deliberate: a model can debug a fixed sequence by reading it, and cannot debug
 * a program it did not write.
 */
const StepSchema = z.object({
  /** The registered tool to run, or a tool this surface defined. */
  tool: z.string().min(1),
  /**
   * Values pulled out of the previous step's answer, keyed by the argument they
   * fill. Extraction runs on the RAW answer, never on shaped text: shaping is
   * for the reader, and a rule meant for eyes must not decide what data flows.
   */
  extract: z.record(z.string(), z.string()).default({}),
  /**
   * How many matches to run this step for. Two or more fans out — one call per
   * match, each with its own extracted arguments — which is how "read the top
   * three" is expressed.
   */
  take: z.number().int().min(1).max(3).default(1),
});

const DerivedToolSchema = z.object({
  /** The name this derived tool answers to. */
  as: z.string().min(1),
  /** The registered tool it wraps. */
  tool: z.string().min(1),
  /**
   * Arguments fixed for this tool. They are removed from the schema, not merely
   * ignored at call time: an argument the caller can still see is one the caller
   * can still get wrong. A fixed argument always wins, so it cannot also carry a
   * `defaults` or `constrain` entry.
   */
  args: z.record(z.string(), z.unknown()).default({}),
  /**
   * Values used when the caller omits an argument. Unlike `args`, the argument
   * stays in the schema and can still be overridden — the difference between
   * "always this" and "this unless you say otherwise".
   */
  defaults: z.record(z.string(), z.unknown()).default({}),
  /** Narrowed accepted values for arguments the caller keeps. */
  constrain: z.record(z.string(), ConstraintSchema).default({}),
  /** Wording to use instead of the base tool's description. */
  description: z.string().min(1).optional(),
  /** Per-argument wording for the arguments that remain. */
  argDescriptions: z.record(z.string(), z.string().min(1)).default({}),
  /**
   * Steps to run after this tool, feeding each step the previous answer. The
   * chain is fixed and short by construction: at most three steps, each running
   * at most three times.
   */
  then: z.array(StepSchema).max(3).default([]),
  /**
   * How much of the answer to keep. The mirror of shaping the call: a tool that
   * returns a thousand lines is unusable, and the same tool returning fifty is
   * not.
   *
   * Every reduction is REPORTED in the result, because a shaped answer that
   * hides its own shaping is the worst outcome available: the model would read
   * a truncated list as the whole truth. Errors are never shaped.
   */
  output: z
    .object({
      sections: z
        .array(z.string().min(1))
        .optional()
        .describe("Keep only these markdown sections, by heading"),
      filter: z.string().optional().describe("Keep only lines matching this regular expression"),
      reject: z.string().optional().describe("Drop lines matching this regular expression"),
      head: z.number().int().positive().optional().describe("Keep the first N lines"),
      tail: z.number().int().positive().optional().describe("Keep the last N lines"),
      maxChars: z
        .number()
        .int()
        .min(50)
        .optional()
        .describe("Keep at most this many characters, ending on a line break where possible"),
    })
    .default({}),
});

/**
 * How a profile presents the tool surface.
 *
 * A profile owns its surface rather than filtering a shared one: it decides
 * which tools it carries, in what order, how each one is worded for the model
 * that reads it, and — via `derived` — which arguments are already set on them.
 * Two models that both need `read_source` may need to be told about it in
 * different terms, and may need it callable with different amounts of ceremony.
 *
 * This shapes `tools/list` only: a tool omitted here remains callable, so a
 * wrong profile can never disable a capability.
 */
const ToolsSchema = z.object({
  /** Preferred ordering; listed tools come first in this order. */
  order: z.array(z.string().min(1)).default([]),
  /** When set, only these tools are listed. */
  include: z.array(z.string().min(1)).optional(),
  /** Removed from the listing. */
  exclude: z.array(z.string().min(1)).default([]),
  /**
   * Per-tool description overrides, keyed by tool name. A model reads the
   * wording written for it instead of the server's generic one.
   */
  descriptions: z.record(z.string(), z.string().min(1)).default({}),
  /** Tools the model defines for itself by binding arguments of registered ones. */
  derived: z.array(DerivedToolSchema).default([]),
});

export const ModelProfileSchema = z.object({
  id: z
    .string()
    .regex(PROFILE_ID_PATTERN, PROFILE_ID_MESSAGE)
    .refine((value) => !RESERVED_NAMES.has(value), { message: PROFILE_ID_MESSAGE }),
  label: z.string().min(1),
  description: z.string().min(1),
  match: MatchSchema.default({ clientNames: [], models: [] }),
  tools: ToolsSchema.default({ order: [], exclude: [], descriptions: {}, derived: [] }),
  /** Model-specific operating guidance returned by get_model_profile. */
  guidance: z.string().min(80),
  /** Ordered working steps for this model. */
  workflow: z.array(z.string().min(1)).default([]),
});

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/**
 * Why a surface was selected, reported by `surface` so a caller can see the
 * decision. `seed` means no signal matched and the manifest's seed applies.
 */
export type ProfileSource =
  "meta-profile" | "meta-model" | "session" | "env" | "client-name" | "seed";

export type ResolvedProfile = {
  profile: ModelProfile;
  source: ProfileSource;
  /** The raw signal that matched, when there was one. */
  matched: string | null;
  /**
   * Tools every surface must carry, from the manifest. Returned with the
   * resolution so a caller shaping a tool list has the invariant in hand and
   * cannot accidentally apply a different one.
   */
  core: readonly string[];
  /**
   * Arguments that change session state, from the manifest. Returned for the
   * same reason as `core`: a caller shaping a surface must apply the same rule
   * the resolution was made under, not one it looked up separately.
   */
  mutatingArgs: Record<string, string[]>;
};
