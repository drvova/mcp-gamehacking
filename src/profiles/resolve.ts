import { findProfile, loadSurfaces } from "./registry.js";
import type { ModelProfile, ResolvedProfile } from "./types.js";

/**
 * The session-scoped surface override.
 *
 * Either a named surface the caller selected, or an ad-hoc one they composed
 * with `surface { pick: [...] }`. Both occupy the same slot: choosing one
 * replaces the other, and `set: "auto"` clears whichever is present.
 */
export type SessionSurface = { kind: "id"; id: string } | { kind: "picked"; profile: ModelProfile };

let sessionSurface: SessionSurface | null = null;

export function setSessionSurface(next: SessionSurface | null): void {
  sessionSurface = next;
}

export function getSessionSurface(): SessionSurface | null {
  return sessionSurface;
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
  session?: SessionSurface | null;
};

/**
 * Resolve which profile governs a request.
 *
 * Precedence, highest first: an explicit `_meta.profile`, a `_meta.model`
 * match, the session override, an environment variable, the client name, and
 * finally the seed. Every step falls through on a miss, so an unrecognised
 * caller always lands on the seed surface rather than on an unfitted one.
 */
export async function resolveProfile(
  root: string,
  input: ResolveInput = {},
): Promise<ResolvedProfile> {
  const { manifest, profiles } = await loadSurfaces(root);
  const all = [...profiles.values()];

  const metaProfileId = metaString(input.meta, "profile");
  if (metaProfileId) {
    const profile = await findProfile(root, metaProfileId);
    if (profile)
      return {
        profile,
        source: "meta-profile",
        matched: metaProfileId,
        core: manifest.surfaceCore,
      };
  }

  const metaModel = metaString(input.meta, "model");
  if (metaModel) {
    const profile = matchByField(all, "models", metaModel);
    if (profile)
      return { profile, source: "meta-model", matched: metaModel, core: manifest.surfaceCore };
  }

  const session = input.session !== undefined ? input.session : sessionSurface;
  if (session) {
    if (session.kind === "picked") {
      return {
        profile: session.profile,
        source: "session",
        matched: session.profile.id,
        core: manifest.surfaceCore,
      };
    }
    const profile = await findProfile(root, session.id);
    if (profile)
      return { profile, source: "session", matched: session.id, core: manifest.surfaceCore };
  }

  const env = input.env ?? process.env;
  const envSignal = env.MCP_MODEL_PROFILE ?? env.MCP_MODEL;
  if (envSignal) {
    const direct = await findProfile(root, envSignal);
    if (direct)
      return { profile: direct, source: "env", matched: envSignal, core: manifest.surfaceCore };
    const byModel = matchByField(all, "models", envSignal);
    if (byModel)
      return { profile: byModel, source: "env", matched: envSignal, core: manifest.surfaceCore };
  }

  if (input.clientName) {
    const byClient = matchByField(all, "clientNames", input.clientName);
    if (byClient)
      return {
        profile: byClient,
        source: "client-name",
        matched: input.clientName,
        core: manifest.surfaceCore,
      };
  }

  const fallback = profiles.get(manifest.seed);
  if (!fallback) {
    throw new Error(
      `the manifest names "${manifest.seed}" as the seed surface, but no such surface is defined`,
    );
  }
  return { profile: fallback, source: "seed", matched: null, core: manifest.surfaceCore };
}

/** The minimum a tool needs to expose for shaping. */
export type ShapeableTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/**
 * The derived entries a surface can actually honour.
 *
 * This is the single source of truth for both views of a surface: the listing
 * asks it which aliases to define, and the call path asks it what an alias binds.
 * Keeping one implementation is the point — when the two were written separately
 * they could disagree, and a listing that promises one thing while the call does
 * another is worse than a missing tool.
 *
 * An entry that cannot be honoured is dropped rather than approximated, so a
 * mistake is visible as a tool that is not carried instead of a tool that lies.
 * `pick` refuses these outright with an explanation; this is the same rule for a
 * profile that was hand-edited on disk.
 */
export function effectiveDerived<T extends ShapeableTool>(
  profile: ModelProfile,
  tools: T[],
): ModelProfile["tools"]["derived"] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const defined = new Set<string>();
  const kept: ModelProfile["tools"]["derived"] = [];

  for (const entry of profile.tools.derived) {
    const base = byName.get(entry.tool);
    if (base === undefined) continue;

    // First definition wins, so an alias means one thing and one thing only.
    if (defined.has(entry.as)) continue;

    // Stealing another tool's name would make that tool unreachable. Redefining
    // a tool under its own name is the documented case and stays allowed.
    if (entry.as !== entry.tool && byName.has(entry.as)) continue;

    // A bound argument that is not a real argument binds nothing, and would
    // leave a tool advertising a binding that is not there.
    const properties = base.inputSchema?.properties;
    if (properties !== undefined && properties !== null && typeof properties === "object") {
      if (Object.keys(entry.args).some((key) => !(key in properties))) continue;
    }

    defined.add(entry.as);
    kept.push(entry);
  }

  return kept;
}

/**
 * The arguments a derived tool fixes, if `name` is one of them.
 *
 * Resolved through `effectiveDerived`, so an alias is callable exactly while the
 * listing defines it. The two views cannot drift because there is only one.
 */
export function boundArgsFor<T extends ShapeableTool>(
  profile: ModelProfile,
  name: string,
  tools: T[],
): { tool: string; args: Record<string, unknown> } | null {
  const entry = effectiveDerived(profile, tools).find((candidate) => candidate.as === name);
  if (entry === undefined) return null;
  return { tool: entry.tool, args: entry.args };
}

/**
 * Remove bound arguments from a tool's schema and re-word what is left.
 *
 * A fixed argument has to leave the schema rather than be quietly overridden at
 * call time: an argument the caller can still see is one the caller can still
 * get wrong, and removing the decision is the entire point of binding it.
 */
function narrowSchema(
  schema: Record<string, unknown> | undefined,
  bound: Record<string, unknown>,
  argDescriptions: Record<string, string>,
): Record<string, unknown> | undefined {
  if (schema === undefined || typeof schema !== "object") return schema;

  const properties = schema.properties;
  if (properties === undefined || typeof properties !== "object" || properties === null) {
    return schema;
  }

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (key in bound) continue;
    const override = argDescriptions[key];
    kept[key] =
      override !== undefined && value !== null && typeof value === "object"
        ? { ...(value as Record<string, unknown>), description: override }
        : value;
  }

  const narrowed: Record<string, unknown> = { ...schema, properties: kept };
  if (Array.isArray(schema.required)) {
    narrowed.required = schema.required.filter((key) => typeof key === "string" && !(key in bound));
  }
  return narrowed;
}

/** Say what a derived tool fixed, so the caller knows what it can omit. */
function describeDerived(
  base: ShapeableTool,
  entry: ModelProfile["tools"]["derived"][number],
): string {
  const lead = base.description ?? base.name;
  const fixed = Object.entries(entry.args);
  if (fixed.length === 0) return lead;

  const shown = fixed.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
  const pronoun = fixed.length === 1 ? "it" : "them";
  return `${lead}\n\nAlready set for you: ${shown}. Omit ${pronoun} when you call.`;
}

/**
 * Apply a profile to the registered tools: select, order, re-word, and define.
 *
 * Names the profile mentions but that no longer exist are ignored, and a
 * profile whose `include` list matches nothing falls back to the full set: a
 * mistake in a profile must never present an empty tool surface.
 */
export function shapeTools<T extends ShapeableTool>(
  tools: T[],
  profile: ModelProfile,
  surfaceCore: readonly string[],
): T[] {
  const { include, exclude, order, descriptions, derived } = profile.tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const aliasOf = new Set(derived.map((entry) => entry.as));

  // An alias is a name a profile may carry even though nothing registered it, so
  // it counts as available when the include and order lists are resolved.
  const available = new Set([...byName.keys(), ...aliasOf]);

  // The surface core is enforced here rather than trusted to each profile,
  // because this is the single chokepoint every profile passes through: shipped,
  // authored, or hand-edited on disk. A profile may choose to be narrow; it may
  // not choose to be inescapable, so these survive both `include` and `exclude`.
  // The core itself is declared in the manifest, not here.
  const core = new Set(surfaceCore);

  let shaped = tools;
  if (include && include.length > 0) {
    const kept = new Set(include.filter((name) => available.has(name)));
    for (const name of surfaceCore) if (available.has(name)) kept.add(name);
    if (kept.size > 0) shaped = shaped.filter((tool) => kept.has(tool.name));
  }

  const excluded = new Set(exclude.filter((name) => !core.has(name)));
  const filtered = shaped.filter((tool) => !excluded.has(tool.name));
  const selected = filtered.length > 0 ? filtered : tools;

  const merged = new Map<string, T>();
  for (const tool of selected) {
    const override = descriptions[tool.name];
    merged.set(tool.name, override === undefined ? tool : { ...tool, description: override });
  }

  // Define the tools this model asked for. An entry may wrap a tool the surface
  // does not otherwise carry, and an alias equal to its own base name replaces
  // that base rather than appearing twice. Which entries survive is decided by
  // `effectiveDerived`, so the listing and the call path agree by construction.
  for (const entry of effectiveDerived(profile, tools)) {
    if (excluded.has(entry.as)) continue;
    if (include && include.length > 0 && !include.includes(entry.as) && !core.has(entry.as)) {
      continue;
    }

    const base = byName.get(entry.tool);
    if (base === undefined) continue;

    const override = descriptions[entry.as] ?? entry.description;
    merged.set(entry.as, {
      ...base,
      name: entry.as,
      description: override ?? describeDerived(base, entry),
      inputSchema: narrowSchema(base.inputSchema, entry.args, entry.argDescriptions),
    });
  }

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

  return [...merged.values()].sort((a, b) => {
    const [aTier, aRank] = keyOf(a.name);
    const [bTier, bRank] = keyOf(b.name);
    return aTier === bTier ? aRank - bRank : aTier - bTier;
  });
}
