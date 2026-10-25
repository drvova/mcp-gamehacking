import { DEFAULT_PROFILE_ID } from "./builtin.js";
import { findProfile, loadProfiles } from "./registry.js";
import type { ModelProfile, ResolvedProfile } from "./types.js";

/** Session-scoped override set by `set_model_profile`. */
let sessionProfileId: string | null = null;

export function setSessionProfile(id: string | null): void {
  sessionProfileId = id;
}

export function getSessionProfile(): string | null {
  return sessionProfileId;
}

/** Read a string field from an untrusted `_meta` object without asserting a shape. */
function metaString(meta: unknown, key: string): string | null {
  if (typeof meta !== "object" || meta === null || !(key in meta)) return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** First profile whose `match.models` contains one of the given signals. */
function matchByField(
  profiles: ModelProfile[],
  field: "models" | "clientNames",
  signal: string,
): ModelProfile | null {
  const needle = signal.toLowerCase();
  for (const profile of profiles) {
    if (profile.match[field].some((entry) => needle.includes(entry.toLowerCase()))) {
      return profile;
    }
  }
  return null;
}

export type ResolveInput = {
  /** Raw `_meta` from the request, if any. */
  meta?: unknown;
  /** Host name reported by the client at initialize. */
  clientName?: string | null;
  /** Process environment, injected for testability. */
  env?: Record<string, string | undefined>;
  /**
   * Session override captured when the request arrived. Passing it explicitly
   * keeps resolution deterministic: without it, a request that awaits before
   * resolving could observe a mutation made by a later, pipelined request.
   */
  session?: string | null;
};

/**
 * Resolve which profile governs a request.
 *
 * Precedence, highest first: an explicit `_meta.profile`, a `_meta.model`
 * match, the session override, an environment variable, the client name, and
 * finally the neutral default. Every step falls through on a miss, so an
 * unrecognised caller always lands on the full default surface.
 */
export async function resolveProfile(
  root: string,
  input: ResolveInput = {},
): Promise<ResolvedProfile> {
  const { profiles } = await loadProfiles(root);
  const all = [...profiles.values()];

  const metaProfileId = metaString(input.meta, "profile");
  if (metaProfileId) {
    const profile = await findProfile(root, metaProfileId);
    if (profile) return { profile, source: "meta-profile", matched: metaProfileId };
  }

  const metaModel = metaString(input.meta, "model");
  if (metaModel) {
    const profile = matchByField(all, "models", metaModel);
    if (profile) return { profile, source: "meta-model", matched: metaModel };
  }

  const sessionId = input.session !== undefined ? input.session : sessionProfileId;
  if (sessionId) {
    const profile = await findProfile(root, sessionId);
    if (profile) return { profile, source: "session", matched: sessionId };
  }

  const env = input.env ?? process.env;
  const envSignal = env.MCP_MODEL_PROFILE ?? env.MCP_MODEL;
  if (envSignal) {
    const direct = await findProfile(root, envSignal);
    if (direct) return { profile: direct, source: "env", matched: envSignal };
    const byModel = matchByField(all, "models", envSignal);
    if (byModel) return { profile: byModel, source: "env", matched: envSignal };
  }

  if (input.clientName) {
    const byClient = matchByField(all, "clientNames", input.clientName);
    if (byClient) return { profile: byClient, source: "client-name", matched: input.clientName };
  }

  const fallback = profiles.get(DEFAULT_PROFILE_ID);
  if (!fallback) {
    throw new Error(`built-in "${DEFAULT_PROFILE_ID}" profile is missing`);
  }
  return { profile: fallback, source: "default", matched: null };
}

/** The minimum a tool needs to expose for shaping. */
export type ShapeableTool = { name: string; description?: string };

/**
 * Apply a profile to the registered tools: select, order, and re-word.
 *
 * Names the profile mentions but that no longer exist are ignored, and a
 * profile whose `include` list matches nothing falls back to the full set: a
 * mistake in a profile must never present an empty tool surface.
 */
export function shapeTools<T extends ShapeableTool>(tools: T[], profile: ModelProfile): T[] {
  const available = new Set(tools.map((tool) => tool.name));
  const { include, exclude, order, descriptions } = profile.tools;

  let shaped = tools;
  if (include && include.length > 0) {
    const kept = new Set(include.filter((name) => available.has(name)));
    if (kept.size > 0) shaped = shaped.filter((tool) => kept.has(tool.name));
  }

  const excluded = new Set(exclude);
  const filtered = shaped.filter((tool) => !excluded.has(tool.name));
  const selected = filtered.length > 0 ? filtered : tools;

  // Rank: an explicit `order` wins for the tools it names; otherwise the
  // `include` list's own order is the author's declared preference; otherwise
  // registration order, which the stable sort below preserves.
  const orderRank = new Map(order.map((name, index) => [name, index]));
  const includeRank = new Map((include ?? []).map((name, index) => [name, index]));
  const keyOf = (name: string): [number, number] => {
    const explicit = orderRank.get(name);
    if (explicit !== undefined) return [0, explicit];
    const included = includeRank.get(name);
    if (included !== undefined) return [1, included];
    return [2, 0];
  };

  const ranked = [...selected].sort((a, b) => {
    const [aTier, aRank] = keyOf(a.name);
    const [bTier, bRank] = keyOf(b.name);
    return aTier === bTier ? aRank - bRank : aTier - bTier;
  });

  // Re-word for this model. A tool with no override keeps the server's wording.
  return ranked.map((tool) => {
    const override = descriptions[tool.name];
    return override === undefined ? tool : { ...tool, description: override };
  });
}
