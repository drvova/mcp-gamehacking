import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";

export const ROOT = resolve(import.meta.dirname, "../..");
export const SERVER = resolve(ROOT, "dist", "index.js");
export const SKILLS_DIR = resolve(ROOT, "skills");
export const PROFILES_DIR = resolve(ROOT, "model-profiles");

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
  tools: z.array(z.object({ name: z.string() })),
});

export const CallToolResult = z.object({
  content: z.array(z.object({ text: z.string() })).nonempty(),
});

export type Frame = z.infer<typeof Frame>;

export type CallOptions = {
  /** Value reported as `clientInfo.name` at initialize. */
  clientName?: string;
  timeoutMs?: number;
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
  const { clientName = "rstest", timeoutMs = 120_000 } = options;
  const { promise, resolve: settle, reject } = Promise.withResolvers<Map<number, Frame>>();

  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
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

/** Read the profile id out of a `surface` report. */
export function profileIdOf(frame: Frame | undefined): string {
  const match = textOf(frame).match(/^# Surface: .*\(`([a-z0-9-]+)`\)/m);
  if (!match) throw new Error(`no profile id in: ${textOf(frame).slice(0, 160)}`);
  return match[1];
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
  const { clientName = "rstest", timeoutMs = 120_000 } = options;

  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(timeoutMs),
  });

  const pending = new Map<number, (frame: Frame) => void>();
  const failures = new Map<number, (error: Error) => void>();
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
    const { promise, resolve, reject } = Promise.withResolvers<Frame>();
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

  return { request, close: () => child.kill() };
}
