import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ModelProfileSchema, type ModelProfile } from "./types.js";

/**
 * The system manifest.
 *
 * Everything the engine needs to know about the shape of the surface layer is
 * declared here rather than written into the code, so a tool name never appears
 * in TypeScript and the design can be extended by editing data.
 */
const ManifestSchema = z.object({
  /** Surface an unrecognised caller lands on. */
  seed: z.string().min(1),
  /**
   * Tools every surface must carry, whatever else a profile drops.
   *
   * Without these a narrow profile is a trap: a model cannot see that a surface
   * governs it, cannot discover the catalogue, and cannot leave. A profile may
   * choose to be narrow; it may not choose to be inescapable.
   */
  surfaceCore: z.array(z.string().min(1)).min(1),
  /** Id given to a surface a caller composes at runtime with `pick`. */
  pickedId: z.string().min(1),
  /**
   * Arguments that change session state, keyed by tool.
   *
   * A chain step that fills one of these would reconfigure the caller's own
   * tooling as a side effect of a tool call, and would change what the remaining
   * steps resolve against — non-determinism in the middle of a fixed sequence.
   * Declared here so the rule is data, and so a second mutating tool costs a
   * line rather than a code change.
   */
  mutatingArgs: z.record(z.string(), z.array(z.string().min(1))).default({}),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export const MANIFEST_FILE = "manifest.json";

/**
 * Load the manifest and the shipped surfaces from disk.
 *
 * Read at runtime rather than imported, so adding or editing a surface is a data
 * change: no rebuild, no code touched. Shipped surfaces live in `profiles/` and
 * model-authored ones in `model-profiles/`; both go through the same schema.
 */
export async function loadShipped(root: string): Promise<{
  manifest: Manifest;
  profiles: ModelProfile[];
  invalid: Array<{ file: string; reason: string }>;
}> {
  const dir = join(root, "profiles");
  const invalid: Array<{ file: string; reason: string }> = [];

  const raw = await readFile(join(dir, MANIFEST_FILE), "utf8").catch(() => null);
  if (raw === null) {
    throw new Error(
      `The surface manifest is missing at ${join(dir, MANIFEST_FILE)}. ` +
        "It declares the seed surface and the core every surface must carry.",
    );
  }

  const parsedManifest = ManifestSchema.safeParse(JSON.parse(raw));
  if (!parsedManifest.success) {
    const issue = parsedManifest.error.issues[0];
    throw new Error(
      `The surface manifest is invalid: ${issue?.path.join(".") || "manifest"}: ${issue?.message}`,
    );
  }

  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json") && name !== MANIFEST_FILE);
  } catch {
    files = [];
  }

  const profiles: ModelProfile[] = [];
  for (const file of files.sort()) {
    const text = await readFile(join(dir, file), "utf8").catch(() => null);
    if (text === null) {
      invalid.push({ file, reason: "unreadable" });
      continue;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      invalid.push({ file, reason: `invalid JSON: ${(error as Error).message}` });
      continue;
    }

    const parsed = ModelProfileSchema.safeParse(decoded);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      invalid.push({ file, reason: `${issue?.path.join(".") || "profile"}: ${issue?.message}` });
      continue;
    }

    const expected = file.replace(/\.json$/, "");
    if (parsed.data.id !== expected) {
      invalid.push({
        file,
        reason: `id "${parsed.data.id}" does not match file name "${expected}"`,
      });
      continue;
    }

    profiles.push(parsed.data);
  }

  return { manifest: parsedManifest.data, profiles, invalid };
}
