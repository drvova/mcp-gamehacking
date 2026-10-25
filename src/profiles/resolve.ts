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

    // An argument named by any of these that is not a real argument would leave
    // the tool advertising something that is not there.
    const properties = base.inputSchema?.properties;
    if (properties !== undefined && properties !== null && typeof properties === "object") {
      const named = [
        ...Object.keys(entry.args),
        ...Object.keys(entry.defaults),
        ...Object.keys(entry.constrain),
      ];
      if (named.some((key) => !(key in properties))) continue;
    }

    // A fixed argument and a default or a constraint for the same argument
    // contradict each other: the fixed value always wins, so the other two
    // would be inert. Dropped rather than approximated.
    const fixed = new Set(Object.keys(entry.args));
    const contradictory = [...Object.keys(entry.defaults), ...Object.keys(entry.constrain)].some(
      (key) => fixed.has(key),
    );
    if (contradictory) continue;

    // A constraint must hold for the value that will actually be used, not only
    // for what the caller sends. If a default — the model's own or the tool's —
    // falls outside the narrowed range, the schema would advertise a limit it
    // does not keep, so the entry is dropped rather than shipped as a lie.
    const presetViolation = Object.entries(entry.constrain).some(([key, rule]) => {
      const preset = entry.defaults[key];
      return preset !== undefined && checkConstraint(preset, rule) !== null;
    });
    if (presetViolation) continue;

    const baseViolation = Object.entries(entry.constrain).some(([key, rule]) => {
      if (entry.defaults[key] !== undefined) return false;
      const schemaProperties = base.inputSchema?.properties as
        Record<string, { default?: unknown }> | undefined;
      const baseDefault = schemaProperties?.[key]?.default;
      return baseDefault !== undefined && checkConstraint(baseDefault, rule) !== null;
    });
    if (baseViolation) continue;

    // A pattern that will not compile shapes nothing, and a head together with a
    // tail is ambiguous about which end wins. Both are refused at construction so
    // the model is told rather than left with a rule that quietly does nothing.
    const shaping = entry.output;
    if (hasShaping(shaping)) {
      if (shaping.head !== undefined && shaping.tail !== undefined) continue;
      const patterns = [shaping.filter, shaping.reject].filter(
        (pattern): pattern is string => pattern !== undefined,
      );
      if (patterns.some((pattern) => "problem" in compilePattern(pattern))) continue;
    }

    defined.add(entry.as);
    kept.push(entry);
  }

  return kept;
}

/**
 * The definition of a derived tool, if `name` is one of them.
 *
 * Resolved through `effectiveDerived`, so an alias is callable exactly while the
 * listing defines it. The two views cannot drift because there is only one, and
 * the call path needs the whole entry — fixed arguments, defaults and
 * constraints all apply at call time, not only in the listing.
 */
export function boundArgsFor<T extends ShapeableTool>(
  profile: ModelProfile,
  name: string,
  tools: T[],
): ModelProfile["tools"]["derived"][number] | null {
  const entry = effectiveDerived(profile, tools).find((candidate) => candidate.as === name);
  return entry ?? null;
}

/**
 * Apply a definition to a tool's schema: fix, default, constrain, re-word.
 *
 * Four things can happen to an argument, and they are deliberately different:
 *
 * - a FIXED argument leaves the schema, because a decision the caller cannot
 *   make is one it should not see;
 * - a DEFAULT stays but becomes omittable, and shows what it will be;
 * - a CONSTRAINT stays and narrows, so the wrong value is visible as wrong
 *   before the call rather than only rejected after it;
 * - a RE-WORD keeps the argument and changes how it is described.
 */
function narrowSchema(
  schema: Record<string, unknown> | undefined,
  entry: ModelProfile["tools"]["derived"][number],
): Record<string, unknown> | undefined {
  if (schema === undefined || typeof schema !== "object") return schema;

  const properties = schema.properties;
  if (properties === undefined || typeof properties !== "object" || properties === null) {
    return schema;
  }

  const { args: fixed, defaults, constrain, argDescriptions } = entry;
  const kept: Record<string, unknown> = {};
  const omittable = new Set<string>();

  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (key in fixed) continue;

    let next =
      value !== null && typeof value === "object"
        ? { ...(value as Record<string, unknown>) }
        : value;

    const preset = defaults[key];
    if (preset !== undefined && next !== null && typeof next === "object") {
      next = { ...(next as Record<string, unknown>), default: preset };
      omittable.add(key);
    }

    const rule = constrain[key];
    if (rule !== undefined && next !== null && typeof next === "object") {
      next = { ...(next as Record<string, unknown>), ...rule };
    }

    const override = argDescriptions[key];
    if (override !== undefined && next !== null && typeof next === "object") {
      next = { ...(next as Record<string, unknown>), description: override };
    }

    kept[key] = next;
  }

  const narrowed: Record<string, unknown> = { ...schema, properties: kept };
  if (Array.isArray(schema.required)) {
    narrowed.required = schema.required.filter(
      (key) => typeof key === "string" && !(key in fixed) && !omittable.has(key),
    );
  }
  return narrowed;
}

/**
 * Whether a value satisfies a constraint, and how to say so when it does not.
 *
 * Constraints are enforced rather than advertised: a schema that lists an enum
 * while the server accepts anything is a lie, and the point of narrowing an
 * argument is that the wrong value cannot get through.
 */
export function checkConstraint(value: unknown, rule: Record<string, unknown>): string | null {
  const allowed = rule.enum;
  if (Array.isArray(allowed) && !allowed.some((candidate) => candidate === value)) {
    return `must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}`;
  }

  if (typeof value === "number") {
    const min = rule.minimum;
    const max = rule.maximum;
    if (typeof min === "number" && value < min) return `must be at least ${min}`;
    if (typeof max === "number" && value > max) return `must be at most ${max}`;
  }

  if (typeof value === "string") {
    const minLength = rule.minLength;
    const maxLength = rule.maxLength;
    const pattern = rule.pattern;
    if (typeof minLength === "number" && value.length < minLength) {
      return `must be at least ${minLength} characters`;
    }
    if (typeof maxLength === "number" && value.length > maxLength) {
      return `must be at most ${maxLength} characters`;
    }
    if (typeof pattern === "string") {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        // A pattern that will not compile constrains nothing, so say so rather
        // than silently accepting everything.
        return `cannot be checked: \`${pattern}\` is not a valid regular expression`;
      }
      if (!regex.test(value)) return `must match \`${pattern}\``;
    }
  }

  return null;
}

/** Compile a pattern, or report why it cannot be. */
export function compilePattern(pattern: string): { regex: RegExp } | { problem: string } {
  try {
    return { regex: new RegExp(pattern) };
  } catch {
    // The message does not depend on why it failed to compile: the pattern is
    // what the model wrote, and naming it is what lets the model fix it.
    return { problem: `\`${pattern}\` is not a valid regular expression` };
  }
}

/** Whether a shaping rule would do anything. */
export function hasShaping(rule: ModelProfile["tools"]["derived"][number]["output"]): boolean {
  if (rule === undefined) return false;
  return (
    (rule.sections !== undefined && rule.sections.length > 0) ||
    rule.filter !== undefined ||
    rule.reject !== undefined ||
    rule.head !== undefined ||
    rule.tail !== undefined ||
    rule.maxChars !== undefined
  );
}

/** Keep the named markdown sections, heading line included. */
function keepSections(lines: string[], wanted: string[]): string[] {
  const keep = new Set(wanted.map((name) => name.trim().toLowerCase()));
  const out: string[] = [];
  let inside = false;

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) inside = keep.has((heading[1] ?? "").trim().toLowerCase());
    if (inside) out.push(line);
  }

  return out;
}

/**
 * Reduce an answer to the part that was asked for.
 *
 * Applied in a fixed order — sections, then line selection, then a line window,
 * then a character cap — so a rule set means one thing rather than depending on
 * the order it was written in.
 *
 * The reduction is always REPORTED. A shaped answer that hides its own shaping
 * is the worst outcome available: a model reads a truncated list as the whole
 * truth and draws a confident wrong conclusion. So when anything is removed the
 * result says how much was kept of how much, and which rule did it.
 */
export function shapeOutput(
  text: string,
  rule: ModelProfile["tools"]["derived"][number]["output"],
): string {
  if (!hasShaping(rule)) return text;

  const originalLines = text.split("\n");
  let lines = originalLines;
  const applied: string[] = [];

  if (rule.sections !== undefined && rule.sections.length > 0) {
    lines = keepSections(lines, rule.sections);
    applied.push(`sections: ${rule.sections.join(", ")}`);
  }

  if (rule.filter !== undefined) {
    const compiled = compilePattern(rule.filter);
    if ("regex" in compiled) {
      lines = lines.filter((line) => compiled.regex.test(line));
      applied.push(`filter: \`${rule.filter}\``);
    }
  }

  if (rule.reject !== undefined) {
    const compiled = compilePattern(rule.reject);
    if ("regex" in compiled) {
      lines = lines.filter((line) => !compiled.regex.test(line));
      applied.push(`reject: \`${rule.reject}\``);
    }
  }

  if (rule.head !== undefined) {
    lines = lines.slice(0, rule.head);
    applied.push(`head: ${rule.head}`);
  }

  if (rule.tail !== undefined) {
    lines = lines.slice(-rule.tail);
    applied.push(`tail: ${rule.tail}`);
  }

  let out = lines.join("\n");
  let capped = false;
  if (rule.maxChars !== undefined && out.length > rule.maxChars) {
    out = out.slice(0, rule.maxChars);
    // End on a line break where that does not throw most of the allowance away,
    // so a cap does not leave half a word hanging.
    const lastBreak = out.lastIndexOf("\n");
    if (lastBreak > rule.maxChars * 0.5) out = out.slice(0, lastBreak);
    capped = true;
    applied.push(`maxChars: ${rule.maxChars}`);
  }

  const removedLines = lines.length < originalLines.length;
  const removedChars = out.length < text.length;
  if (!removedLines && !removedChars) return text;

  const kept = `${lines.length} of ${originalLines.length} lines`;
  const chars = capped ? `, ${out.length} of ${text.length} characters` : "";

  // The note is deliberately ONE line: the call path lifts it out so a result
  // made of several blocks states the same rule once, and a multi-line note
  // could not be separated from the answer it belongs to.
  //
  // Nothing left is a result worth stating plainly, not an empty answer.
  if (out.trim().length === 0) {
    return `[shaped: nothing matched — ${kept}${chars}; ${applied.join("; ")}]`;
  }

  return `${out}\n\n[shaped: ${kept}${chars} — ${applied.join("; ")}]`;
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
      inputSchema: narrowSchema(base.inputSchema, entry),
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
