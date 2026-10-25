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
 * How a profile presents the tool surface.
 *
 * A profile owns its surface rather than filtering a shared one: it decides
 * which tools it carries, in what order, and — via `descriptions` — how each
 * one is worded for the model that reads it. Two models that both need
 * `read_source` may need to be told about it in different terms.
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
});

export const ModelProfileSchema = z.object({
  id: z
    .string()
    .regex(PROFILE_ID_PATTERN, PROFILE_ID_MESSAGE)
    .refine((value) => !RESERVED_NAMES.has(value), { message: PROFILE_ID_MESSAGE }),
  label: z.string().min(1),
  description: z.string().min(1),
  match: MatchSchema.default({ clientNames: [], models: [] }),
  tools: ToolsSchema.default({ order: [], exclude: [], descriptions: {} }),
  /** Model-specific operating guidance returned by get_model_profile. */
  guidance: z.string().min(80),
  /** Ordered working steps for this model. */
  workflow: z.array(z.string().min(1)).default([]),
});

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/** Why a profile was selected, for transparency in get_model_profile. */
export type ProfileSource =
  "meta-profile" | "meta-model" | "session" | "env" | "client-name" | "default";

export type ResolvedProfile = {
  profile: ModelProfile;
  source: ProfileSource;
  /** The raw signal that matched, when there was one. */
  matched: string | null;
};
