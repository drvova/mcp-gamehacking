import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * A promise with its settle functions, without `Promise.withResolvers`.
 *
 * That helper is Node 22+ while this project supports Node 20. Using it here
 * meant the suite passed on a modern local Node and failed on the runner, which
 * is the one place the declared floor is exercised.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * This module's directory, without `import.meta.dirname`.
 *
 * That property is Node 20.11+, and this package declares `engines: >=18`
 * (the MCP SDK's own floor). Deriving it from `import.meta.url` keeps the
 * declaration true rather than quietly requiring a newer runtime than the
 * package says it needs.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(HERE, "../..");

/**
 * A temp harness directory, created once per test process.
 *
 * Every spawned server gets this unless a test overrides it. Isolation is the
 * DEFAULT rather than something each test must remember, so a test cannot write
 * into a real home directory by forgetting to ask for a temp one.
 */
export const TEST_HARNESS_DIR = mkdtempSync(join(tmpdir(), "gamehacking-harness-helper-"));
export const SERVER = resolve(ROOT, "dist", "index.js");
export const SKILLS_DIR = resolve(ROOT, "skills");

/**
 * Whether the skill archive is present.
 *
 * It is 19 GB, so a CI checkout cannot materialise it and a sparse checkout
 * deliberately omits it. Tests that compare against real archive data are
 * meaningless without it, so they skip rather than assert against nothing.
 */
export function archivePresent(): boolean {
  try {
    return existsSync(SKILLS_DIR) && readdirSync(SKILLS_DIR).length > 0;
  } catch {
    return false;
  }
}

const skippedTests: string[] = [];

/**
 * Skip guard for archive-dependent tests.
 *
 * Returns false when the archive is absent so the caller can return early. The
 * notice goes to stderr, not stdout: a runner may suppress stdout for tests
 * that pass, which would make a skip indistinguishable from a pass on a green
 * run. Set GATES_REQUIRE_ARCHIVE=1 to fail instead of skipping.
 */
export function requireArchive(testName: string): boolean {
  if (archivePresent()) return true;

  if (process.env.GATES_REQUIRE_ARCHIVE === "1") {
    throw new Error(
      `GATES_REQUIRE_ARCHIVE=1 but the skill archive is absent at ${SKILLS_DIR}, ` +
        `so "${testName}" cannot run.`,
    );
  }

  skippedTests.push(testName);
  process.stderr.write(`[SKIP] ${testName} — no skill archive at ${SKILLS_DIR}\n`);
  return false;
}

/**
 * Print what did not run, so a green suite never implies full coverage.
 *
 * An early-returning test is counted as a pass by the runner, so without this
 * the suite reports the same number whether or not the archive was present.
 */
export function reportSkipped(): void {
  if (skippedTests.length === 0) return;
  const names = skippedTests.map((name) => `  - ${name}`).join("\n");
  process.stderr.write(
    `\n[SKIP SUMMARY] ${skippedTests.length} test(s) did not run — the skill archive is absent ` +
      `at ${SKILLS_DIR}:\n${names}\n` +
      "These compare against real archive data. Set GATES_REQUIRE_ARCHIVE=1 to fail instead.\n\n",
  );
}

/** A parsed JSON-RPC frame; `result` stays unvalidated until a use site parses it. */
export const Frame = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export const InitializeResult = z.object({
  serverInfo: z.object({ name: z.string(), version: z.string() }),
  instructions: z.string().optional(),
});

export const ToolsListResult = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      /** Published argument schema; tests read it to assert the contract. */
      inputSchema: z
        .object({ properties: z.record(z.string(), z.unknown()).optional() })
        .optional(),
    }),
  ),
});

export const CallToolResult = z.object({
  content: z.array(z.object({ text: z.string() })).nonempty(),
});

export type Frame = z.infer<typeof Frame>;

export type CallOptions = {
  /** Value reported as `clientInfo.name` at initialize. */
  clientName?: string;
  timeoutMs?: number;
  /** Extra environment for the spawned server. Tests use this to isolate state. */
  env?: Record<string, string>;
};

/**
 * Spawn the built server, send requests, and collect responses by id.
 *
 * Spawning the artifact rather than importing sources is deliberate: it is the
 * only way to exercise module resolution, `import.meta.dirname`, and the stdio
 * transport that the shipped server actually uses.
 */
export function callServer(
  requests: object[],
  options: CallOptions = {},
): Promise<Map<number, Frame>> {
  const { clientName = "rstest", timeoutMs = 120_000, env } = options;
  const { promise, resolve: settle, reject } = deferred<Map<number, Frame>>();

  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GAMEHACKING_HARNESS_DIR: TEST_HARNESS_DIR,
      ...env,
    },
    // Kills a wedged child so a hung server fails the test instead of stalling
    // the run. This is a process guard, not a pacing delay.
    signal: AbortSignal.timeout(timeoutMs),
  });

  const responses = new Map<number, Frame>();
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.on("error", reject);
  child.on("close", () => {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(trimmed);
      } catch {
        continue; // Not JSON; the server also emits plain lines.
      }
      const frame = Frame.safeParse(decoded);
      if (frame.success) responses.set(frame.data.id, frame.data);
    }
    if (responses.size === 0) {
      reject(new Error(`no JSON-RPC responses. stderr: ${stderr.slice(0, 500)}`));
      return;
    }
    settle(responses);
  });

  const handshake = [
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: clientName, version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ];

  child.stdin.write(
    [...handshake, ...requests].map((request) => JSON.stringify(request)).join("\n") + "\n",
  );
  child.stdin.end();

  return promise;
}

export function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown> = {},
  meta?: Record<string, unknown>,
) {
  const params: Record<string, unknown> = { name, arguments: args };
  if (meta) params._meta = meta;
  return { jsonrpc: "2.0", id, method: "tools/call", params };
}

export function listTools(id: number, meta?: Record<string, unknown>) {
  const params: Record<string, unknown> = {};
  if (meta) params._meta = meta;
  return { jsonrpc: "2.0", id, method: "tools/list", params };
}

/** Text payload of a tools/call result. */
export function textOf(frame: Frame | undefined): string {
  if (!frame) return "";
  const parsed = CallToolResult.safeParse(frame.result);
  return parsed.success ? parsed.data.content[0].text : "";
}

/** Names in the order the server presented them. */
export function toolNames(frame: Frame | undefined): string[] {
  const parsed = ToolsListResult.parse(frame?.result);
  return parsed.tools.map((tool) => tool.name);
}

const ErrorFlag = z.object({ isError: z.boolean().optional() });

/**
 * True when a call was refused, whether the refusal arrived as a JSON-RPC error
 * (schema rejection) or as an `isError` tool result (handler-level refusal).
 */
export function wasRefused(frame: Frame | undefined): boolean {
  if (!frame) return false;
  if (frame.error !== undefined) return true;
  const parsed = ErrorFlag.safeParse(frame.result);
  return parsed.success && parsed.data.isError === true;
}

export type Session = {
  /** Send one request and wait for its response before returning. */
  request: (request: object) => Promise<Frame>;
  /** Notification methods the server has sent, in order. */
  notifications: string[];
  close: () => void;
};

/**
 * Open a server session that exchanges one request at a time.
 *
 * `callServer` batches every request up front, and this SDK processes a batch
 * concurrently — response order is not arrival order, so a batch cannot express
 * "set this, then observe it". Real clients await each response before sending
 * the next, and this session models that.
 */
export async function openSession(options: CallOptions = {}): Promise<Session> {
  const { clientName = "rstest", timeoutMs = 120_000, env } = options;

  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GAMEHACKING_HARNESS_DIR: TEST_HARNESS_DIR,
      ...env,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const pending = new Map<number, (frame: Frame) => void>();
  const failures = new Map<number, (error: Error) => void>();
  /**
   * Notification methods the server has sent, in order.
   *
   * A server can announce that the tool list changed, and a host that honours it
   * re-lists. Without a way to observe that, the announcement is untestable — and
   * an untestable announcement is one nobody can rely on.
   */
  const notifications: string[] = [];
  let buffer = "";
  let stderr = "";

  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("{")) continue;

      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        continue;
      }
      // A notification is checked BEFORE the frame parse, because it carries a
      // method and no id — and `Frame` requires a numeric id, so it would be
      // rejected and dropped silently, making the announcement invisible.
      const asNotification = decoded as { method?: unknown; id?: unknown };
      if (typeof asNotification.method === "string" && asNotification.id === undefined) {
        notifications.push(asNotification.method);
        continue;
      }

      const frame = Frame.safeParse(decoded);
      if (!frame.success) continue;

      const settle = pending.get(frame.data.id);
      if (settle) {
        pending.delete(frame.data.id);
        failures.delete(frame.data.id);
        settle(frame.data);
      }
    }
  });

  child.on("close", () => {
    for (const [id, reject] of failures) {
      failures.delete(id);
      reject(
        new Error(
          `server exited before responding to request ${id}. stderr: ${stderr.slice(0, 400)}`,
        ),
      );
    }
  });

  const request = (outgoing: object): Promise<Frame> => {
    const id = (outgoing as { id?: unknown }).id;
    if (typeof id !== "number") {
      return Promise.reject(new Error("session requests need a numeric id"));
    }
    const { promise, resolve, reject } = deferred<Frame>();
    pending.set(id, resolve);
    failures.set(id, reject);
    child.stdin.write(`${JSON.stringify(outgoing)}\n`);
    return promise;
  };

  await request({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return { request, notifications, close: () => child.kill() };
}
