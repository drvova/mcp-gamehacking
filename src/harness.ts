/**
 * The code harness: one tool that runs code against a live API.
 *
 * The model gets a namespace, not a menu. It discovers what is here, writes
 * helpers, and those helpers persist — across calls, and across restarts. The
 * harness adapts to the model rather than the model adapting to a fixed catalog
 * of verbs, which is the whole point: every deployment and every model is
 * different, and no hand-picked menu is right for all of them.
 *
 * ## How a call is executed
 *
 * Code is parsed once, then split into two kinds of statement:
 *
 *   definitions   function / class / variable declarations. Run as top-level
 *                 scripts in the context, so they become real bindings that
 *                 survive into the next call. Written to disk afterwards.
 *
 *   work          everything else. Run inside an async wrapper, so `await`
 *                 works. This is where the actual doing happens, and it is
 *                 deliberately NOT persisted: a restart rebuilds the model's
 *                 tools without replaying its work.
 *
 * The split matters because `await` and persistence pull in opposite directions:
 * a top-level script cannot await, and an async function's bindings die with the
 * call. Running each kind where it belongs gets both.
 *
 * `let`/`const`/`class` are rewritten to `var` when persisted. That is not
 * cosmetic — a redeclared `const` in the same lexical scope throws, and refining
 * a helper is the main thing this harness is for.
 *
 * ## Security
 *
 * This executes code with the server's authority. That is what the tool IS, not
 * a mode it can be put into, so there is no enable/disable switch. Run the
 * server somewhere you would run a shell.
 */
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import * as acorn from "acorn";

/** A capability the harness can call: one of the server's own functions. */
export type Capability = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /**
   * Validate arguments against the capability's own schema and fill defaults.
   *
   * Called before the handler, so a call from code is checked exactly as an MCP
   * call would be: a model that passes a number where a string belongs is told
   * so, instead of failing somewhere inside the handler.
   */
  prepare: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

/** A document opened through `open()`, usable in-process without another call. */
export type Doc = {
  name: string;
  text: string;
  path: string | null;
  lines: string[];
  grep: (pattern: string | RegExp) => string[];
  headings: () => string[];
  /** Whether this document has a source dump beside it. */
  hasSource: boolean;
  /** Size of the source dump, so a decision can be made before reading it. */
  sourceSize: () => Promise<{ bytes: number; lines: number } | null>;
  /**
   * A range of the source dump, by line.
   *
   * Ranged and lazy on purpose: a source dump can be 100 MB, so reading one in
   * full to look at ten lines would be the wrong shape for the question.
   */
  sourceLines: (from?: number, to?: number) => Promise<string[]>;
  /**
   * Search the source dump, streaming it line by line.
   *
   * Returns matches with their line numbers, and reports how many were found
   * when more matched than the limit, so a capped answer is never mistaken for
   * the whole truth.
   */
  grepSource: (pattern: string | RegExp, max?: number) => Promise<string[]>;
};

/** A session's bound working state. */
type Session = {
  id: string;
  opened: Doc[];
};

/** Everything the harness needs from the server it is embedded in. */
export type HarnessOptions = {
  /** Directory holding persisted definitions. */
  dir: string;
  /** Opens a document by name, for `open()`. `source` is the source dump, if one
   *  exists beside the document. */
  open: (
    name: string,
  ) => Promise<{ text: string; path: string | null; source?: string | null } | null>;
  /** The names the project offers, for the manual. */
  offers: () => string[];
};

/** Names that may be persisted, forgotten, or deleted through the context. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** How much captured output is returned before the harness says it truncated. */
const MAX_OUTPUT = 60_000;

/**
 * Classify one top-level statement as a definition or as work.
 *
 * A declaration whose initializer awaits is WORK: it cannot run as a top-level
 * script, and persisting it would mean re-running its initializer on every load,
 * which is the "replaying work" the contract forbids. It stays call-local, which
 * is the right home for `const hits = await search(...)` — per-call data, not a
 * tool.
 */
type Statement = acorn.Node & { type: string };

type VariableStatement = Statement & {
  type: "VariableDeclaration";
  kind: string;
  declarations: { id: Statement & { name?: string }; init: acorn.Node | null }[];
};

/** acorn's parsed statement union is not exported as a narrowable type, so the
 *  variable-declaration shape is read through this guard rather than asserted. */
function asVariableStatement(node: Statement): VariableStatement | null {
  if (node.type !== "VariableDeclaration") return null;
  if (!("declarations" in node) || !Array.isArray(node.declarations)) return null;
  const kind = "kind" in node && typeof node.kind === "string" ? node.kind : "var";
  return {
    ...node,
    type: "VariableDeclaration",
    kind,
    declarations: node.declarations as VariableStatement["declarations"],
  };
}

function isDefinition(node: Statement): boolean {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") return true;
  const declaration = asVariableStatement(node);
  if (declaration === null) return false;
  // `let` and `var` are scratch. A mutable binding carried into the next call
  // starts it from a stale value — `let total = 0` then `total += 1` would make
  // the next call begin at 1 — and a value is not a tool. `const` is the
  // commitment to something worth keeping.
  if (declaration.kind !== "const") return false;
  if (awaitsHere(node)) return false;
  // `const before = stats().peakMB` computes a value NOW. Saving it would re-run
  // that call on every load, which is the work the contract says never to
  // replay — and the value would be meaningless anyway, since it is a snapshot.
  // Only an initializer that creates something (a function, a class, a literal)
  // is a tool.
  if (declaration.declarations.some((d) => d.init !== null && !isStaticValue(d.init))) {
    return false;
  }
  return declaration.declarations.every((d) => d.id.type === "Identifier");
}

/**
 * Find a template literal that ASI joined to the line above it, or null.
 *
 * A tag that is a name or a member expression is real code (`sql\`...\``); a tag
 * that is a call, a literal or an operator is two statements that got merged.
 */
function findAsiAccident(ast: acorn.Program, code: string): { line: number } | null {
  const visit = (node: unknown): { line: number } | null => {
    if (node === null || typeof node !== "object") return null;
    const record = node as Record<string, unknown> & { type?: string };

    if (record.type === "TaggedTemplateExpression") {
      const tag = record.tag;
      const tagType =
        tag !== null && typeof tag === "object" ? (tag as { type?: string }).type : undefined;
      if (tagType !== "Identifier" && tagType !== "MemberExpression") {
        // Point at the TEMPLATE, not at the statement it got merged into: the
        // template is the line the author needs to fix.
        const quasi = record.quasi;
        const start =
          quasi !== null && typeof quasi === "object" && "start" in quasi
            ? Number((quasi as { start?: number }).start ?? record.start)
            : typeof record.start === "number"
              ? record.start
              : 0;
        // A character offset is not a line; count the newlines before it.
        return { line: code.slice(0, start).split("\n").length };
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          const found = visit(child);
          if (found !== null) return found;
        }
      } else if (value !== null && typeof value === "object") {
        const found = visit(value);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return visit(ast);
}

/**
 * Whether a node is a static value: something that can be written down again
 * without re-running anything.
 *
 * Recursive, because `{ a: [1, 2] }` is static as a whole only if its parts are.
 * Anything that COMPUTES — a call, an arithmetic operator, a template with
 * expressions — is not: persisting it would replay that computation at every
 * load, which is the work the contract says never to replay.
 *
 *     const config = { retries: 3 }    static   — a literal the author keeps
 *     const double = (n) => n * 2      static   — callable
 *     const sum = 1 + 2                computes — a value for this call
 *     const before = stats().kept      computes
 */
function isStaticValue(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  const record = node as Record<string, unknown> & { type?: string; computed?: boolean };

  switch (record.type) {
    case "Literal":
      return true;
    case "Identifier":
      // A reference to another binding: an alias is as static as its target.
      return true;
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassExpression":
      return true;
    case "TemplateLiteral": {
      const expressions = record.expressions;
      return Array.isArray(expressions) && expressions.length === 0;
    }
    case "UnaryExpression":
      // `-1` is a value: the operator applies to a literal.
      return isStaticValue(record.argument);
    case "ArrayExpression": {
      const elements = record.elements;
      if (!Array.isArray(elements)) return false;
      return elements.every((element) => element === null || isStaticValue(element));
    }
    case "ObjectExpression": {
      const properties = record.properties;
      if (!Array.isArray(properties)) return false;
      return properties.every((property) => {
        if (property === null || typeof property !== "object") return false;
        const prop = property as Record<string, unknown>;
        if (prop.type === "SpreadElement") return isStaticValue(prop.argument);
        if (prop.computed === true) return false;
        return isStaticValue(prop.value);
      });
    }
    default:
      // CallExpression, NewExpression, BinaryExpression, MemberExpression,
      // ConditionalExpression, UpdateExpression and the rest all compute.
      return false;
  }
}

/**
 * Whether a node awaits at its OWN level.
 *
 * Descent stops at every function boundary, because `async () => await x()` is a
 * definition that awaits when CALLED, while `const v = await x()` must await to
 * exist at all — and only the second cannot be a persisted definition.
 */
function awaitsHere(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  const record = node as Record<string, unknown> & { type?: string };
  if (record.type === "AwaitExpression") return true;
  if (
    record.type === "FunctionDeclaration" ||
    record.type === "FunctionExpression" ||
    record.type === "ArrowFunctionExpression"
  ) {
    return false;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      if (value.some((child) => awaitsHere(child))) return true;
    } else if (value && typeof value === "object" && awaitsHere(value)) {
      return true;
    }
  }
  return false;
}

/** One persisted definition: the name it binds, the source that binds it, and the
 *  comment the author wrote above it. */
type Definition = { name: string; source: string; doc?: string };

/**
 * Rewrite a declaration so it can be persisted and later refined.
 *
 * `let`/`const`/`class` become `var` so that redefining a helper in a later call
 * rebinds instead of throwing "already been declared" — the single most common
 * thing a model does with this harness.
 */
function persistable(code: string, node: Statement): Definition[] {
  const declaration = asVariableStatement(node);
  if (declaration !== null) {
    // One file per bound name, as the contract requires: a multi-declarator
    // statement becomes one definition per declarator.
    const named = declaration.declarations.filter(
      (d): d is typeof d & { id: { name: string } } => typeof d.id.name === "string",
    );
    return named.map((d) => {
      const init = d.init ? code.slice(d.init.start, d.init.end) : undefined;
      const name = d.id.name;
      if (init === undefined) return { name, source: `globalThis.${name} = undefined;` };

      const source = `globalThis.${name} = ${init};`;
      if (!isFunctionLike(d.init)) return { name, source };
      // Assignment through a property does NOT infer the function's name the way
      // a declaration does, so `describe(helper)` would report `anonymous` and the
      // model would lose its own vocabulary. The name is set explicitly.
      return {
        name,
        source:
          `${source}\n` +
          `try { Object.defineProperty(globalThis.${name}, "name", { value: ${JSON.stringify(name)}, configurable: true }); } catch {}`,
      };
    });
  }

  const text = code.slice(node.start, node.end);
  const name =
    "id" in node && node.id !== null && typeof node.id === "object" && "name" in node.id
      ? node.id.name
      : undefined;
  if (typeof name !== "string") return [];

  if (node.type === "ClassDeclaration") {
    // A class declaration cannot be redeclared; assignment can.
    return [{ name, source: `globalThis.${name} = ${text};` }];
  }
  // A function declaration is rebound through globalThis for the same reason:
  // `var` and function bindings are non-configurable, so `forget` could not
  // remove them.
  return [{ name, source: `globalThis.${name} = ${text};` }];
}

/**
 * The expression inside an expression statement, or null for any other statement.
 *
 * Read from the parsed node rather than by trimming text, so a statement's
 * terminator can never end up inside the parentheses.
 */
function expressionOf(node: Statement): acorn.Node | null {
  if (node.type !== "ExpressionStatement") return null;
  if (!("expression" in node)) return null;
  const expression = node.expression;
  if (expression === null || typeof expression !== "object") return null;
  if (!("start" in expression) || !("end" in expression)) return null;
  return expression as acorn.Node;
}

/**
 * The author's description from a saved definition file, or undefined.
 *
 * The file carries the harness's own header comments, so the FIRST comment in it
 * is not the author's — reading that one reported the harness's note as the
 * helper's description. The comment that counts is the one attached to the
 * assignment itself, which is the same rule applied when the definition was
 * first written.
 */
function docFromSavedFile(text: string): string | undefined {
  try {
    const comments: { start: number; end: number; value: string }[] = [];
    const ast = acorn.parse(text, {
      ecmaVersion: "latest",
      sourceType: "script",
      onComment: (_block, value, start, end) => comments.push({ start, end, value }),
    });
    const first = ast.body[0];
    if (first === undefined) return undefined;
    return leadingComment(comments, text, first.start);
  } catch {
    // A file that does not parse has no recoverable description; the load path
    // reports the parse failure itself.
    return undefined;
  }
}

/**
 * The comment immediately above a declaration, or undefined.
 *
 * Only whitespace may separate them: a comment two statements up describes
 * something else, and attaching it here would be a lie about authorship.
 */
function leadingComment(
  comments: { start: number; end: number; value: string }[],
  code: string,
  start: number,
): string | undefined {
  let best: { end: number; value: string } | undefined;
  for (const comment of comments) {
    // Only whitespace may separate the comment from the declaration. A comment
    // above another statement describes that statement, and attaching it here
    // would misattribute the author's words.
    if (comment.end > start) continue;
    if (code.slice(comment.end, start).trim() !== "") continue;
    if (best === undefined || comment.end > best.end) best = comment;
  }
  if (best === undefined) return undefined;

  const text = best.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
  return text.length > 0 ? text : undefined;
}

/**
 * The first comment in a function's source, or undefined.
 *
 * A block comment wins; otherwise the first `//` line before any statement. Body
 * code is never returned, because a body line shown as a description reads as
 * documentation and is not.
 */
function firstComment(source: string): string | undefined {
  const lines = source.split("\n").map((line) => line.trim());

  for (const line of lines.slice(1)) {
    const block = /^\/\*\*?\s*(.*?)\s*\*?\/?$/.exec(line);
    if (block?.[1]) return block[1].replace(/^\*\s?/, "").trim();
  }

  for (const line of lines.slice(1)) {
    if (line.startsWith("//")) {
      const text = line.replace(/^\/\/+\s?/, "").trim();
      if (text.length > 0) return text;
      continue;
    }
    // A statement means the comments are over: stop rather than reaching into
    // the body.
    if (/^(const|let|var|return|await|if|for|while|throw|globalThis|Object)\b/.test(line)) break;
  }
  return undefined;
}

/** The name a declaration binds, if it binds exactly one. */
function declaredName(node: unknown): string | undefined {
  if (node === null || typeof node !== "object" || !("id" in node)) return undefined;
  const id = node.id;
  if (id === null || typeof id !== "object" || !("name" in id)) return undefined;
  return typeof id.name === "string" ? id.name : undefined;
}

/** Names a statement binds at its own level. */
function boundNames(node: Statement): string[] {
  const declaration = asVariableStatement(node);
  if (declaration !== null) {
    return declaration.declarations
      .map((d) => d.id.name)
      .filter((name): name is string => typeof name === "string");
  }
  const name = declaredName(node);
  return name === undefined ? [] : [name];
}

/**
 * Whether a node mentions any of these names as a FREE variable.
 *
 * Unlike the await check, descent does not stop at a function boundary: a helper
 * whose body reads a value computed in this call still depends on that call, so
 * it is call-local too. But a name BOUND inside the function — a parameter, a
 * local, a nested function's own name — shadows the outer one, so it is not a
 * reference to it:
 *
 *     const d = await open('x')        // call-local
 *     const f = (d) => d.n             // `d` is the parameter — a tool
 *     const g = () => d.n              // closes over d   — not a tool
 *
 * Treating the first case as a dependency discarded a usable helper, which is
 * the quieter of the two failures: nothing breaks, the tool simply is not there
 * on the next call.
 */
function referencesNames(
  node: unknown,
  names: Set<string>,
  shadowed: Set<string> = new Set(),
): boolean {
  if (names.size === 0) return false;
  if (node === null || typeof node !== "object") return false;
  const record = node as Record<string, unknown> & { type?: string; computed?: boolean };

  if (record.type === "Identifier") {
    const name = record.name;
    return typeof name === "string" && names.has(name) && !shadowed.has(name);
  }

  // A function binds its parameters, its own name, and its own declarations;
  // all of those shadow the outer scope inside its body.
  let inner = shadowed;
  if (
    record.type === "FunctionDeclaration" ||
    record.type === "FunctionExpression" ||
    record.type === "ArrowFunctionExpression"
  ) {
    inner = new Set(shadowed);
    const own = declaredName(record);
    if (own !== undefined) inner.add(own);

    const params = record.params;
    if (Array.isArray(params)) {
      for (const param of params) {
        for (const name of patternNames(param)) inner.add(name);
      }
      // A DEFAULT VALUE is a use, not a binding: `(x = outer) => x` reads
      // `outer` when called, so it depends on this call. Params are therefore
      // walked for their defaults with the bindings already shadowed, instead of
      // being skipped as a whole.
      for (const param of params) {
        if (param === null || typeof param !== "object") continue;
        const defaults =
          (param as Record<string, unknown>).type === "AssignmentPattern"
            ? [(param as Record<string, unknown>).right]
            : [];
        if (defaults.some((value) => referencesNames(value, names, inner))) return true;
      }
    }

    // Declarations at the top of the body shadow too: `() => { const k = 1; ... }`
    // does not read an outer `k`. Only the direct body is scanned, because a
    // declaration inside a NESTED block does not shadow the whole body, and
    // treating it as if it did would save a helper that really does depend on
    // this call.
    const body = record.body;
    const bodyStatements =
      body !== null &&
      typeof body === "object" &&
      (body as Record<string, unknown>).type === "BlockStatement"
        ? ((body as Record<string, unknown>).body as unknown[])
        : [];
    if (Array.isArray(bodyStatements)) {
      for (const statement of bodyStatements) {
        for (const name of boundNames(statement as Statement)) inner.add(name);
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    // A property name is not a reference: `a.b` mentions `b` only as a label.
    if (key === "property" && record.type === "MemberExpression") continue;
    if (
      key === "key" &&
      record.computed !== true &&
      (record.type === "Property" ||
        record.type === "PropertyDefinition" ||
        record.type === "MethodDefinition")
    ) {
      continue;
    }
    // Binding positions declare names rather than using them.
    if (key === "id" && /(Declaration|Declarator)$/.test(record.type ?? "")) continue;
    if (key === "params" && /Function/.test(record.type ?? "")) continue;

    if (Array.isArray(value)) {
      if (value.some((child) => referencesNames(child, names, inner))) return true;
    } else if (
      value !== null &&
      typeof value === "object" &&
      referencesNames(value, names, inner)
    ) {
      return true;
    }
  }
  return false;
}

/** Every name a binding pattern binds, including destructuring and defaults. */
function patternNames(node: unknown): string[] {
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown> & { type?: string };
  if (record.type === "Identifier") {
    return typeof record.name === "string" ? [record.name] : [];
  }
  if (record.type === "AssignmentPattern") {
    return patternNames(record.left);
  }
  if (record.type === "RestElement") {
    return patternNames(record.argument);
  }
  if (record.type === "ArrayPattern") {
    const elements = Array.isArray(record.elements) ? record.elements : [];
    return elements.flatMap((element) => patternNames(element));
  }
  if (record.type === "ObjectPattern") {
    const properties = Array.isArray(record.properties) ? record.properties : [];
    return properties.flatMap((property) => {
      if (property === null || typeof property !== "object") return [];
      const prop = property as Record<string, unknown>;
      if (prop.type === "RestElement") return patternNames(prop.argument);
      return patternNames(prop.value);
    });
  }
  return [];
}

/** Whether a node is a function or arrow function, which can carry a name. */
function isFunctionLike(node: unknown): boolean {
  if (node === null || typeof node !== "object" || !("type" in node)) return false;
  const type = node.type;
  return type === "ArrowFunctionExpression" || type === "FunctionExpression";
}

/** Render a value for the model: strings as-is, everything else as JSON. */
function render(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A capability argument, described well enough to call it correctly.
 *
 * This is the discovery surface for arguments: a model reads it to decide how to
 * call something, so "any" where a real type exists is a lie that costs a round
 * trip. Wrapper types are unwrapped rather than reported, because `optional` is
 * not a type — it is a property OF the type.
 */
function describeArg(name: string, field: unknown): string {
  const shape = readZodType(field);
  const parts: string[] = [`${name}: ${shape.type}`];
  if (shape.optional) parts.push("optional");
  if (shape.default !== undefined) parts.push(`default ${JSON.stringify(shape.default)}`);
  if (shape.description) parts.push(shape.description);
  return parts.join(" — ");
}

type ZodShape = {
  type: string;
  optional: boolean;
  default?: unknown;
  description?: string;
};

/**
 * Read a zod field's type, unwrapping the wrappers that are not types.
 *
 * zod keeps `optional`, `default`, `nullable` and `readonly` as outer layers over
 * an inner type, so reporting the outer layer would describe every optional
 * argument as "optional" instead of what it actually accepts.
 */
function readZodType(field: unknown): ZodShape {
  const result: ZodShape = { type: "unknown", optional: false };
  let current: unknown = field;

  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object" || !("_def" in current)) break;
    const def = current._def;
    if (def === null || typeof def !== "object") break;
    const record = def as Record<string, unknown>;

    const kind = typeof record.type === "string" ? record.type : undefined;
    const typeName = typeof record.typeName === "string" ? record.typeName : undefined;
    const type = kind ?? typeName?.replace(/^Zod/, "").toLowerCase();
    if (type === undefined) break;

    if (type === "optional" || type === "nullable" || type === "readonly" || type === "default") {
      if (type === "optional" || type === "nullable") result.optional = true;
      if (type === "default" && record.defaultValue !== undefined) {
        result.default = record.defaultValue;
      }
      current = record.innerType ?? record.schema ?? record.wrapped;
      continue;
    }

    if (type === "enum") {
      const entries = record.entries;
      if (entries && typeof entries === "object") {
        const values = Object.values(entries as Record<string, unknown>).filter(
          (value): value is string => typeof value === "string",
        );
        result.type = values.map((value) => JSON.stringify(value)).join(" | ");
      } else {
        result.type = "enum";
      }
    } else if (type === "array") {
      const inner = readZodType(record.element ?? record.items ?? record.type_);
      result.type = `${inner.type}[]`;
    } else if (type === "literal") {
      result.type = JSON.stringify(record.values ?? record.value ?? null);
    } else {
      result.type = type;
    }

    const description = fieldDescription(current);
    if (description) result.description = description;
    break;
  }

  // `isOptional` also covers a field with a default, which the loop may not see.
  if (fieldIsOptional(field)) result.optional = true;
  return result;
}

function fieldDescription(field: unknown): string | undefined {
  if (field === null || typeof field !== "object" || !("description" in field)) return undefined;
  const description = field.description;
  return typeof description === "string" ? description : undefined;
}

function fieldIsOptional(field: unknown): boolean {
  if (field === null || typeof field !== "object" || !("isOptional" in field)) return false;
  const isOptional = field.isOptional;
  if (typeof isOptional !== "function") return false;
  try {
    return Boolean((isOptional as () => unknown).call(field));
  } catch {
    return false;
  }
}

/**
 * The text and error flag of a tool result, read without trusting a shape.
 *
 * The MCP SDK returns a union that varies by outcome, so this narrows rather
 * than asserting: an unexpected result yields empty text, never a bad read.
 */
function toolResult(result: unknown): { text: string; isError: boolean } {
  if (result === null || typeof result !== "object") return { text: "", isError: false };
  const isError = "isError" in result && result.isError === true;
  if (!("content" in result) || !Array.isArray(result.content)) return { text: "", isError };
  const text = result.content
    .map((part) => {
      if (part === null || typeof part !== "object" || !("text" in part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
  return { text, isError };
}

export function createHarness(capabilities: Capability[], options: HarnessOptions) {
  const dir = options.dir;
  fs.mkdirSync(dir, { recursive: true });

  /** Functions the model defined, so `describe` can report their signatures. */
  const capabilityOf = new Map<unknown, Capability>();
  const context = vm.createContext({}) as Record<string, unknown>;
  const sessions = new Map<string, Session>();
  let captured: string[] = [];

  /** The session the running call belongs to, for `open()` to record into. */
  let active: Session | null = null;
  const currentSession = (): Session => {
    if (active === null) throw new Error("open() must be called from a call, not at load time");
    return active;
  };

  const sessionFor = (id: string): Session => {
    const key = id || "default";
    let session = sessions.get(key);
    if (!session) {
      session = { id: key, opened: [] };
      sessions.set(key, session);
    }
    return session;
  };

  // ---------------------------------------------------------------- documents

  const makeDoc = (
    name: string,
    text: string,
    docPath: string | null,
    sourcePath: string | null,
  ): Doc => {
    const asRegExp = (pattern: string | RegExp): RegExp =>
      typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;

    /** Stream a file line by line, so a 100 MB dump never has to be held whole. */
    const streamLines = async (file: string, visit: (line: string, index: number) => void) => {
      const input = fs.createReadStream(file, { encoding: "utf8" });
      const reader = readline.createInterface({ input, crlfDelay: Infinity });
      let index = 0;
      for await (const line of reader) {
        visit(line, index);
        index += 1;
      }
    };

    return {
      name,
      text,
      path: docPath,
      lines: text.split("\n"),
      hasSource: sourcePath !== null,
      grep(pattern) {
        const re = asRegExp(pattern);
        return text.split("\n").filter((line) => re.test(line));
      },
      headings() {
        return text
          .split("\n")
          .filter((line) => /^#{1,6}\s/.test(line))
          .map((line) => line.trim());
      },
      async sourceSize() {
        if (sourcePath === null) return null;
        const info = await fs.promises.stat(sourcePath);
        let lines = 0;
        await streamLines(sourcePath, () => {
          lines += 1;
        });
        return { bytes: info.size, lines };
      },
      async sourceLines(from = 0, to = 200) {
        if (sourcePath === null) {
          throw new Error(`${name} has no source dump; only its description is available.`);
        }
        const wanted: string[] = [];
        await streamLines(sourcePath, (line, index) => {
          if (index >= from && index < to) wanted.push(line);
        });
        return wanted;
      },
      async grepSource(pattern, max = 40) {
        if (sourcePath === null) {
          throw new Error(`${name} has no source dump; only its description is available.`);
        }
        const re = asRegExp(pattern);
        const matches: string[] = [];
        let total = 0;
        await streamLines(sourcePath, (line, index) => {
          if (!re.test(line)) return;
          total += 1;
          if (matches.length < max) matches.push(`${index + 1}: ${line.trim().slice(0, 200)}`);
        });
        // A capped answer says so, or the model reads a partial match set as the
        // whole truth.
        if (total > matches.length) {
          matches.push(`... ${total - matches.length} more of ${total} matches (raise max).`);
        }
        return matches;
      },
    };
  };

  const open = async (name: string): Promise<Doc> => {
    const found = await options.open(name);
    if (found === null) {
      throw new Error(`No document named ${JSON.stringify(name)}. ${offersHint()}`);
    }
    const doc = makeDoc(name, found.text, found.path, found.source ?? null);
    currentSession().opened.push(doc);
    return doc;
  };

  const offersHint = (): string => {
    const names = options.offers();
    return names.length
      ? `Available: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", ..." : ""}`
      : "";
  };

  // ------------------------------------------------------------ introspection

  /**
   * The name a value is bound to, when exactly one name holds it.
   *
   * Ambiguity is reported as ambiguity: if two bindings hold the same value, no
   * name is claimed, because guessing one would attach the wrong description.
   */
  const nameOf = (value: unknown): string | undefined => {
    const matches = [...docs.keys()].filter((name) => context[name] === value);
    return matches.length === 1 ? matches[0] : undefined;
  };

  const describe = (value: unknown): string => {
    const capability = capabilityOf.get(value);
    if (capability) {
      const args = Object.entries(capability.schema).map(([name, field]) =>
        describeArg(name, field),
      );
      return [
        `${capability.name}(${args.length ? "{" : ""}${Object.keys(capability.schema).join(", ")}${args.length ? "}" : ""})`,
        `  ${capability.description}`,
        ...args.map((line) => `  - ${line}`),
      ].join("\n");
    }

    if (typeof value === "function") {
      const source = Function.prototype.toString.call(value);
      const signature = /^[^(]*\(([^)]*)\)/.exec(source)?.[1] ?? "";
      // Only a COMMENT counts as documentation. Reporting the first body line
      // instead would present code as if it were an explanation, which is worse
      // than reporting nothing: the model reads it as the author's intent.
      // The author's own description wins; a comment inside the function is the
      // fallback for a function that was never persisted as a definition.
      const doc = docs.get(value.name) ?? firstComment(source);
      return [
        `${value.name || "anonymous"}(${signature})`,
        doc ? `  ${doc}` : "",
        `  (defined in this namespace${value.name ? `; persisted as ${value.name}.js` : ""})`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([key]) => !key.startsWith("_"),
      );
      const name = nameOf(value);
      const doc = name === undefined ? undefined : docs.get(name);
      const heading = doc === undefined ? [] : [doc];
      if (entries.length === 0) return [...heading, "(no public members)"].join("\n");
      return [
        ...heading,
        ...entries.map(([key, member]) => {
          const kind = typeof member;
          return `  ${key}: ${kind === "function" ? "function" : kind}`;
        }),
      ].join("\n");
    }

    // A documented definition reports its description whatever its kind, since
    // the author wrote it for the thing, not for its type.
    const name = nameOf(value);
    const doc = name === undefined ? undefined : docs.get(name);
    const rendered = `${typeof value} ${render(value)}`.trim();
    return doc === undefined ? rendered : `${rendered}\n  ${doc}`;
  };

  // ------------------------------------------------------------- persistence

  const fileFor = (name: string): string => path.join(dir, `${name}.js`);

  const save = (definition: Definition): void => {
    // The author's comment goes directly above the code, and the harness's own
    // note goes BELOW it. Anything above the assignment is read back as the
    // author's description, so a note of ours placed there would be reported as
    // theirs — which is exactly what happened.
    const body = [
      ...(definition.doc ? [`// ${definition.doc}`] : []),
      definition.source,
      "",
      `// Saved by the code harness from a definition of ${JSON.stringify(definition.name)}.`,
      "// Definitions persist across calls and restarts; work is never replayed.",
      "",
    ].join("\n");
    fs.writeFileSync(fileFor(definition.name), body, "utf8");
    if (definition.doc) docs.set(definition.name, definition.doc);
  };

  const forget = (name: string): boolean => {
    if (!IDENTIFIER.test(name)) return false;

    // Recorded so a definition made in the SAME call is not written back after
    // being forgotten.
    forgotten.add(name);
    // And its description goes, or a name defined again later would inherit the
    // old author's words.
    docs.delete(name);

    let removed: boolean;
    try {
      fs.unlinkSync(fileFor(name));
      removed = true;
    } catch {
      // Already gone is a successful outcome for "make this not exist".
      removed = false;
    }

    // The live binding goes too, so `forget` means the same thing before and
    // after a restart. Deleted from inside the context, because that is where
    // the binding lives — definitions are assigned through `globalThis` for
    // exactly this reason, since a `var` binding could never be removed.
    const hadBinding = context[name] !== undefined;
    try {
      vm.runInContext(`delete globalThis.${name};`, context);
    } catch {
      context[name] = undefined;
    }
    // True when the name is gone, which is the question being asked — a
    // definition made and forgotten in one call had no file yet, and is still
    // forgotten.
    return removed || hadBinding;
  };

  /** Names forgotten during the current call. */
  const forgotten = new Set<string>();

  /** Documentation the author wrote above a definition, by name. */
  const docs = new Map<string, string>();

  /**
   * The largest heap seen at the end of a call.
   *
   * Sampled before the collector can reclaim a large temporary, so a read that
   * pulled a 100 MB file into memory is visible here even though the memory is
   * released by the time anyone asks.
   */
  let peakHeap = 0;

  const kept = (): string[] =>
    fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".js"))
      .map((file) => file.slice(0, -3))
      .sort();

  /** Load persisted definitions. Each in its own try/except: one broken saved
   *  definition must not stop the server from booting. */
  const load = (): string[] => {
    const broken: string[] = [];
    for (const name of kept()) {
      try {
        const saved = fs.readFileSync(fileFor(name), "utf8");
        const doc = docFromSavedFile(saved);
        if (doc !== undefined) docs.set(name, doc);
        vm.runInContext(saved, context);
      } catch (error) {
        broken.push(`${name}: ${(error as Error).message}`);
      }
    }
    return broken;
  };

  // ------------------------------------------------------------------- manual

  const manual = (): string => {
    const names = capabilities.map((c) => c.name);
    return [
      "# The code harness",
      "",
      "You are not calling tools — you are writing code against a live API, and the",
      "namespace is yours to build on. Definitions persist across calls and across",
      "restarts; work does not.",
      "",
      "## Vocabulary",
      "",
      '  await search_skills({ query: "kdmapper" })   the project\'s functions, as async calls',
      "  kb.skills.search({ ... })                     the same functions, grouped",
      '  const d = await open("some-skill")           open a skill (or "agent/name") to work on it here',
      "  doc / docs                                    the documents this session opened, bound each call",
      "",
      "A document gives you its description AND its source dump, without another call:",
      "  d.text / d.lines / d.grep(/re/)               the description",
      "  d.hasSource                                   whether a source dump exists",
      "  await d.sourceSize()                          { bytes, lines } — check before reading",
      "  await d.sourceLines(0, 200)                   a line range (lazy: a dump can be 100 MB)",
      "  await d.grepSource(/0x140001000/)             search it, streamed, with line numbers",
      "  describe(search_skills)                       one function's arguments and doc",
      "  describe(doc)                                 an object's public members",
      "  S                                             the `strings` you passed, by name",
      "  kept()                                        what you have defined and kept",
      "  stats()                                       heap, kept count, sessions — for big reads",
      '  forget("name")                                delete one',
      "  man()                                         this page",
      "",
      "## Writing code",
      "",
      "  - `await` works. The project's functions are async; call them normally.",
      "  - A trailing expression is returned, and so is anything assigned to `result`.",
      "  - `console.log` is captured and returned with the value.",
      "  - Redefining a name is fine; refining a helper is the point.",
      "  - End a statement with `;` when the NEXT line starts with `\\``, `(` or `[`.",
      "    JavaScript joins those lines otherwise (a template becomes a TAG, so",
      "    `f()\\n\\`x\\`` tries to call f()'s result). Other lines do not need one.",
      "",
      "  WHAT IS SAVED — this decides what you still have next call:",
      "",
      "    saved      const f = (n) => n * 2        a function, or a function declaration",
      "    saved      class Box { }                 a class",
      "    saved      const cfg = { retries: 3 }    a literal, recursively",
      "    saved      const names = ['a', 'b']      a list, a number, a string",
      "    saved      const path = `skills/ags`     a template with no ${} in it",
      "",
      "    NOT saved  let total = 0                 `let`/`var` are scratch — a mutable",
      "                                             binding would carry a stale value",
      "                                             into the next call. Use `const`.",
      "    NOT saved  const v = await search(...)   anything that awaits",
      "    NOT saved  const n = stats().kept        anything that COMPUTES: a call, a",
      "    NOT saved  const sum = 1 + 2             sum, a comparison, a ternary, a",
      "    NOT saved  const msg = `x${1}`           template with ${} in it, .map(),",
      "    NOT saved  const xs = [1].map(f)         .filter(), a member read",
      "    NOT saved  const y = d.lines             a value derived from this call is",
      "                                             per-call data, even with no await",
      "",
      "    A helper whose BODY computes is still saved: those calls happen when you",
      "    CALL it, not when it loads. `(d) => d.n` is saved even when `d` is also a",
      "    per-call value, because the parameter shadows it.",
      "",
      "## What the project offers",
      "",
      ...names.map((name) => {
        const capability = capabilities.find((c) => c.name === name);
        return `  ${name.padEnd(22)} ${capability?.description.split("\n")[0] ?? ""}`;
      }),
      "",
      `Definitions live in ${dir}.`,
    ].join("\n");
  };

  // --------------------------------------------------------------------- run

  /** Execute one call. Returns the text the caller sees. */
  const run = async (code: string, sessionId = "", strings: Record<string, unknown> = {}) => {
    if (code.trim() === "") return manual();

    const session = sessionFor(sessionId);

    let ast: acorn.Program;
    /** Comments from the parse, so a declaration's own description can be found. */
    const comments: { start: number; end: number; value: string }[] = [];
    try {
      ast = acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType: "script",
        allowAwaitOutsideFunction: true,
        onComment: (_block, value, start, end) => comments.push({ start, end, value }),
      });
    } catch (error) {
      return `Syntax error: ${(error as Error).message}\n\nNothing ran.`;
    }

    // Classify with a FIXPOINT, because a definition can depend on a value that
    // an earlier statement computed in this same call:
    //
    //   const d = await open('x')      work    — d is call-local
    //   const n = d.lines.length       work    — it depends on d
    //
    // Such a statement is not a tool, it is per-call data, so it runs with the
    // work. Persisting it would also be impossible: the top-level run happens
    // before the work, so `d` would not exist yet.
    const callLocal = new Set<string>();
    const kinds = new Map<acorn.Node, "definition" | "work">();
    for (let pass = 0; pass <= ast.body.length; pass += 1) {
      let changed = false;
      for (const statement of ast.body) {
        const kind: "definition" | "work" =
          isDefinition(statement) && !referencesNames(statement, callLocal) ? "definition" : "work";
        if (kinds.get(statement) !== kind) {
          kinds.set(statement, kind);
          changed = true;
        }
        if (kind === "work") {
          for (const name of boundNames(statement)) {
            if (!callLocal.has(name)) {
              callLocal.add(name);
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }

    // Automatic semicolon insertion merges two lines that look like two
    // statements into one expression:
    //
    //     forget('x')
    //     `kept: ${kept()}`
    //
    // parses as `forget('x')` used as a TEMPLATE TAG, so it fails with
    // "forget(...) is not a function" — an error that says nothing about the
    // missing semicolon. `const x = 1` followed by a template merges the same
    // way and fails with "Cannot access 'x' before initialization", which is
    // equally unhelpful.
    //
    // A template tag is a name or a member expression in any real code, so a
    // tag that is a call or a literal is reported as the accident it is.
    const asi = findAsiAccident(ast, code);
    if (asi !== null) {
      return [
        `Line ${asi.line}: a template literal on the line after code is joined to it,`,
        "so it is parsed as a TAGGED TEMPLATE rather than a new statement.",
        "",
        "Add a semicolon at the end of the previous line.",
        "",
        "Nothing ran.",
      ].join("\n");
    }

    const definitions: Definition[] = [];
    const work: acorn.Node[] = [];
    for (const statement of ast.body) {
      if (kinds.get(statement) === "work") {
        work.push(statement);
        continue;
      }
      // A comment immediately above the declaration is the author's description
      // of it. Without this it would be dropped, and `describe` would report the
      // helper with no explanation at all.
      const doc = leadingComment(comments, code, statement.start);
      for (const definition of persistable(code, statement)) {
        definitions.push(doc === undefined ? definition : { ...definition, doc });
      }
    }

    // Fresh per call: `result` is a return channel, not state that leaks.
    delete context.result;
    context.S = strings;
    context.session = session;
    // The session's working objects, bound fresh each call: a document opened in
    // one call is usable in the next, and two sessions do not see each other's.
    context.docs = session.opened;
    context.doc = session.opened[session.opened.length - 1];
    active = session;
    captured = [];

    try {
      for (const definition of definitions) {
        // Top level, so the binding outlives the call.
        vm.runInContext(definition.source, context);
      }
    } catch (error) {
      return `While defining: ${(error as Error).message}\n\nNothing was saved.`;
    }

    let value: unknown;
    if (work.length > 0) {
      const last = work[work.length - 1];
      const head = work
        .slice(0, -1)
        .map((node) => code.slice(node.start, node.end))
        .join("\n");

      // The trailing expression is sliced by the EXPRESSION's own range, not the
      // statement's: a statement's range includes its semicolon, and wrapping
      // that in parentheses is a syntax error.
      const trailing = expressionOf(last);
      const body =
        trailing === null
          ? `${head}\n${code.slice(last.start, last.end)}\nreturn undefined;`
          : `${head}\nreturn (${code.slice(trailing.start, trailing.end)});`;

      try {
        // The wrapper returns the trailing expression's value, so the value comes
        // from the execution that actually happened. Re-running the last
        // statement separately would fail: anything it refers to that was bound
        // earlier in THIS call is not in the context.
        value = await vm.runInContext(`(async () => {\n${body}\n})()`, context);
      } catch (error) {
        const failure = error as Error;
        // Sampled here too: a call that failed after allocating still shows what
        // it allocated.
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        return [
          ...captured,
          `${failure.name}: ${failure.message}`,
          "",
          "Nothing after the failure ran.",
        ]
          .filter((part) => part !== "")
          .join("\n");
      }
    }
    if (value === undefined) value = context.result;

    // Persist only after the call succeeded: a definition whose body threw while
    // being defined must not be written. A name forgotten DURING this call is
    // skipped, or the save would undo the forget.
    for (const definition of definitions) {
      if (!forgotten.has(definition.name)) save(definition);
    }
    forgotten.clear();

    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);

    const out: string[] = [...captured];
    const rendered = render(value);
    if (rendered !== "") out.push(rendered);

    let text = out.join("\n").trim();
    if (text === "") text = "(no output)";
    if (text.length > MAX_OUTPUT) {
      text = `${text.slice(0, MAX_OUTPUT)}\n\n... truncated at ${MAX_OUTPUT} of ${text.length} characters.`;
    }
    return text;
  };

  // ------------------------------------------------------------------- seeds

  const seed = (name: string, value: unknown): void => {
    context[name] = value;
  };

  for (const capability of capabilities) {
    const fn = async (args: Record<string, unknown> = {}) => {
      const validated = capability.prepare(args);
      const { text, isError } = toolResult(await capability.handler(validated));
      if (isError) throw new Error(text || `${capability.name} failed`);
      return text;
    };
    capabilityOf.set(fn, capability);
    seed(capability.name, fn);
  }

  const grouped = {
    skills: {
      search: context.search_skills,
      read: context.read_skill,
      list: context.list_skills,
      stats: context.skill_stats,
    },
    agents: { list: context.list_agents, read: context.read_agent },
    subagents: { list: context.list_subagents, read: context.read_subagent },
    plugins: { list: context.list_plugins, read: context.read_plugin },
    prompts: { list: context.list_prompts, read: context.read_prompt },
  };
  seed("kb", grouped);

  seed("open", open);
  seed("describe", describe);
  seed("kept", kept);
  seed("forget", forget);
  seed("man", manual);
  seed("S", {});
  seed("result", undefined);
  seed("doc", undefined);
  seed("docs", []);
  // The harness's own footprint. Useful when working with a 100 MB source dump —
  // and it is what makes "this read was lazy" an observable fact rather than a
  // claim about the code.
  seed("stats", () => ({
    heapMB: Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10,
    peakMB: Math.round((peakHeap / 1048576) * 10) / 10,
    kept: kept().length,
    sessions: sessions.size,
  }));

  // Capture, so the model's own output comes back with the value. Each returns
  // undefined, as the real console does: a trailing `console.log(...)` must not
  // report a value.
  const record = (...parts: unknown[]): undefined => {
    captured.push(parts.map(render).join(" "));
    return undefined;
  };
  seed("console", { log: record, error: record, warn: record, info: record, debug: record });

  return { run, manual, kept, forget, load, dir };
}

/** Where persisted definitions live: `<ENV_PREFIX>_HARNESS_DIR`, else a default. */
export function harnessDir(envPrefix: string, project: string): string {
  const configured = process.env[`${envPrefix}_HARNESS_DIR`];
  if (configured) return configured;
  return path.join(os.homedir(), `.${project}`, "harness");
}
