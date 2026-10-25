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
        mutatingArgs: manifest.mutatingArgs,
      };
  }

  const metaModel = metaString(input.meta, "model");
  if (metaModel) {
    const profile = matchByField(all, "models", metaModel);
    if (profile)
      return {
        profile,
        source: "meta-model",
        matched: metaModel,
        core: manifest.surfaceCore,
        mutatingArgs: manifest.mutatingArgs,
      };
  }

  const session = input.session !== undefined ? input.session : sessionSurface;
  if (session) {
    if (session.kind === "picked") {
      return {
        profile: session.profile,
        source: "session",
        matched: session.profile.id,
        core: manifest.surfaceCore,
        mutatingArgs: manifest.mutatingArgs,
      };
    }
    const profile = await findProfile(root, session.id);
    if (profile)
      return {
        profile,
        source: "session",
        matched: session.id,
        core: manifest.surfaceCore,
        mutatingArgs: manifest.mutatingArgs,
      };
  }

  const env = input.env ?? process.env;
  const envSignal = env.MCP_MODEL_PROFILE ?? env.MCP_MODEL;
  if (envSignal) {
    const direct = await findProfile(root, envSignal);
    if (direct)
      return {
        profile: direct,
        source: "env",
        matched: envSignal,
        core: manifest.surfaceCore,
        mutatingArgs: manifest.mutatingArgs,
      };
    const byModel = matchByField(all, "models", envSignal);
    if (byModel)
      return {
        profile: byModel,
        source: "env",
        matched: envSignal,
        core: manifest.surfaceCore,
        mutatingArgs: manifest.mutatingArgs,
      };
  }

  if (input.clientName) {
    const byClient = matchByField(all, "clientNames", input.clientName);
    if (byClient)
      return {
        profile: byClient,
        source: "client-name",
        matched: input.clientName,
        core: manifest.surfaceCore,
        mutatingArgs: manifest.mutatingArgs,
      };
  }

  const fallback = profiles.get(manifest.seed);
  if (!fallback) {
    throw new Error(
      `the manifest names "${manifest.seed}" as the seed surface, but no such surface is defined`,
    );
  }
  return {
    profile: fallback,
    source: "seed",
    matched: null,
    core: manifest.surfaceCore,
    mutatingArgs: manifest.mutatingArgs,
  };
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
  mutatingArgs: Record<string, string[]> = {},
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

    // A step whose tool does not exist, whose pattern will not compile, or whose
    // extracted name is not an argument of that tool cannot run. Each is refused
    // with the reason rather than failing later with the chain half-executed.
    for (const step of entry.then) {
      // A step may call a registered tool OR one this surface defined, which is
      // what lets a chain end in a tool the model built for itself.
      const alias = profile.tools.derived.find((candidate) => candidate.as === step.tool);
      const target = byName.get(step.tool) ?? (alias ? byName.get(alias.tool) : undefined);
      if (target === undefined) continue;

      // A step may call a defined tool, but not a CHAIN. Running one chain
      // inside another would make the sequence something to work out rather
      // than read, and would let a small surface hide an unbounded amount of
      // work behind a single name.
      if (alias !== undefined && alias.then.length > 0) continue;

      // A step may not fill an argument that changes session state. The chain
      // would reconfigure the caller's tooling as a side effect of a tool call,
      // and would change what the remaining steps resolve against — a fixed
      // sequence has to stay deterministic to be readable.
      const mutating = mutatingArgs[step.tool] ?? mutatingArgs[target.name] ?? [];
      const filled = [...Object.keys(step.extract), ...Object.keys(alias?.args ?? {})];
      if (filled.some((name) => mutating.includes(name))) continue;

      const targetProperties = target.inputSchema?.properties;
      const names = Object.keys(step.extract);
      if (
        targetProperties !== undefined &&
        targetProperties !== null &&
        typeof targetProperties === "object" &&
        names.some((key) => !(key in targetProperties))
      ) {
        continue;
      }

      const badPattern = Object.values(step.extract)
        .map((pattern) => compilePattern(pattern))
        .find((compiled) => "problem" in compiled);
      if (badPattern !== undefined && "problem" in badPattern) continue;
    }

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
  mutatingArgs: Record<string, string[]> = {},
): ModelProfile["tools"]["derived"][number] | null {
  const entry = effectiveDerived(profile, tools, mutatingArgs).find(
    (candidate) => candidate.as === name,
  );
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

/**
 * Pull values out of a step's answer.
 *
 * The first capture group is used when the pattern has one, so a pattern can
 * target the part that matters inside a line instead of the whole line; a
 * pattern with no group yields the whole match.
 *
 * The cap is not a nicety. A pattern that matches every line of a large answer
 * would otherwise pull tens of thousands of values and try to call a tool with
 * each of them.
 */
export function extractValues(
  text: string,
  pattern: string,
): { values: string[]; capped: boolean } | { problem: string } {
  const compiled = compilePattern(pattern);
  if ("problem" in compiled) return compiled;

  const flags = compiled.regex.flags.includes("g")
    ? compiled.regex.flags
    : `${compiled.regex.flags}g`;
  const scan = new RegExp(compiled.regex.source, flags);

  const values: string[] = [];
  const MAX_VALUES = 50;

  let match = scan.exec(text);
  while (match !== null && values.length < MAX_VALUES) {
    values.push((match[1] ?? match[0]).trim());
    // A pattern that can match nothing would otherwise spin on the same spot.
    if (match[0].length === 0) scan.lastIndex += 1;
    match = scan.exec(text);
  }

  // Whether the cap was reached is reported, not swallowed. A pattern that
  // matched more than the cap yields the first fifty values, and a model that
  // cannot tell fifty from seventy-five will reason about the wrong set - the
  // same silent-truncation defect that output shaping exists to avoid.
  return { values, capped: match !== null };
}

/** Whether a chain would run anything. */
export function hasChain(entry: ModelProfile["tools"]["derived"][number]): boolean {
  return entry.then.length > 0;
}

/** A value written short enough to sit in a one-line trace. */
function brief(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text !== undefined && text.length > 40 ? `${text.slice(0, 37)}...` : (text ?? "null");
}

/** One line describing what a step was called with, for the chain trace. */
export function describeStep(
  index: number,
  tool: string,
  args: Record<string, unknown>,
  chars: number,
): string {
  const shown = Object.entries(args)
    .map(([key, value]) => `${key}=${brief(value)}`)
    .join(", ");
  return `[${index}] ${tool}(${shown}) → ${chars} chars`;
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
  const lines = [base.description ?? base.name];

  const fixed = Object.entries(entry.args);
  if (fixed.length > 0) {
    const shown = fixed.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
    const pronoun = fixed.length === 1 ? "it" : "them";
    lines.push(`Already set for you: ${shown}. Omit ${pronoun} when you call.`);
  }

  // The listing has to say a tool CHAINS, not only the chain trace. A model that
  // expects a search result and receives a document has been misled about the
  // tool, and the fix is the same as for shaping: say it before the call.
  if (hasChain(entry)) {
    const described = entry.then.map((step) => {
      const into = Object.keys(step.extract);
      const target = into.length > 0 ? `${step.tool}(${into.join(", ")})` : step.tool;
      return step.take > 1 ? `${target} ×${step.take}` : target;
    });
    lines.push(
      `Runs a chain: this tool, then ${described.join(", then ")}. ` +
        "Each step receives values pulled from the previous answer. Every answer " +
        "opens with the chain trace, so what ran is always visible.",
    );
  }

  // The listing has to say a tool truncates, not only the result. A model that
  // discovers the rule by reading the note has already made the call and read a
  // partial answer as if it were whole.
  if (hasShaping(entry.output)) {
    const rule = entry.output;
    const parts: string[] = [];
    if (rule.sections !== undefined && rule.sections.length > 0) {
      parts.push(`only the ${rule.sections.map((name) => `"${name}"`).join(" and ")} sections`);
    }
    if (rule.filter !== undefined) parts.push(`only lines matching \`${rule.filter}\``);
    if (rule.reject !== undefined) parts.push(`no lines matching \`${rule.reject}\``);
    if (rule.head !== undefined) parts.push(`the first ${rule.head} lines`);
    if (rule.tail !== undefined) parts.push(`the last ${rule.tail} lines`);
    if (rule.maxChars !== undefined) parts.push(`at most ${rule.maxChars} characters`);

    if (parts.length > 0) {
      lines.push(
        `Returns ${parts.join(", ")}. Every answer says how much it kept, so a ` +
          "shaped result never reads as the whole one.",
      );
    }
  }

  return lines.join("\n\n");
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
  mutatingArgs: Record<string, string[]> = {},
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
  for (const entry of effectiveDerived(profile, tools, mutatingArgs)) {
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
