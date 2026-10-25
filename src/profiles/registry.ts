import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join, resolve, sep } from "path";
import { loadShipped, type Manifest } from "./shipped.js";
import { ModelProfileSchema, type ModelProfile } from "./types.js";

/**
 * Where model-authored profiles live. Kept beside the server data directories
 * rather than inside `src/` so an authored profile survives a rebuild.
 */
export const PROFILES_DIR_NAME = "model-profiles";

export type SurfaceLoadReport = {
  manifest: Manifest;
  profiles: Map<string, ModelProfile>;
  /** Files that were present but unusable, with the reason. */
  invalid: Array<{ file: string; reason: string }>;
};

let cache: SurfaceLoadReport | null = null;

function authoredDir(root: string): string {
  return join(root, PROFILES_DIR_NAME);
}

/**
 * Resolve a profile id to a path inside the profiles directory.
 *
 * The id schema already forbids separators and dots, so this is defence in
 * depth: it re-checks the resolved path stays inside the directory and refuses
 * otherwise, so a future schema change cannot silently open a write outside it.
 */
export function profilePathFor(root: string, id: string): string {
  const dir = authoredDir(root);
  const target = resolve(dir, `${id}.json`);
  const prefix = resolve(dir) + sep;
  if (!target.startsWith(prefix)) {
    throw new Error(`Refusing to write outside the profiles directory: ${id}`);
  }
  return target;
}

/**
 * Load the shipped surfaces plus every authored one.
 *
 * Shipped surfaces come from `profiles/` on disk rather than from an import, so
 * the design is data: adding a surface, reordering one, or changing the core
 * every surface must carry is a file edit, not a code change. Authored profiles
 * come from `model-profiles/` and override a shipped one of the same id.
 *
 * A malformed file is recorded and skipped. One bad profile must never be able
 * to stop the server from starting: loading fails open while the individual file
 * fails closed.
 */
export async function loadSurfaces(
  root: string,
  options: { fresh?: boolean } = {},
): Promise<SurfaceLoadReport> {
  if (cache && !options.fresh) return cache;

  const shipped = await loadShipped(root);
  const profiles = new Map<string, ModelProfile>();
  for (const profile of shipped.profiles) profiles.set(profile.id, profile);

  const invalid: SurfaceLoadReport["invalid"] = [...shipped.invalid];
  const dir = authoredDir(root);

  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    // Nothing authored yet; the shipped set is the whole surface catalogue.
    files = [];
  }

  for (const file of files.sort()) {
    const raw = await readFile(join(dir, file), "utf8").catch(() => null);
    if (raw === null) {
      invalid.push({ file, reason: "unreadable" });
      continue;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      invalid.push({ file, reason: `invalid JSON: ${(error as Error).message}` });
      continue;
    }

    const parsed = ModelProfileSchema.safeParse(decoded);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      invalid.push({ file, reason: `${first?.path.join(".") || "profile"}: ${first?.message}` });
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

    // A shipped surface is the floor and cannot be replaced from the authored
    // directory. Without this an authored file silently overwrote the seed, so a
    // model could remove the one surface every unrecognised caller lands on and
    // brick its own starting point — recoverable only by deleting a file by hand.
    // The id is refused here as well as at `save`, because a hand-edited file
    // never passes through `save` at all.
    if (shipped.profiles.some((profile) => profile.id === parsed.data.id)) {
      invalid.push({
        file,
        reason: `"${parsed.data.id}" is a shipped surface and cannot be replaced; save under a different id`,
      });
      continue;
    }

    profiles.set(parsed.data.id, parsed.data);
  }

  const report: SurfaceLoadReport = { manifest: shipped.manifest, profiles, invalid };
  cache = report;
  return report;
}

/**
 * Ids of the surfaces that ship with the server.
 *
 * Anything else in the catalogue was authored by a model, which a listing shows
 * so a reader can tell the maintained set from the local additions.
 */
export async function shippedIds(root: string): Promise<Set<string>> {
  const { profiles } = await loadShipped(root);
  return new Set(profiles.map((profile) => profile.id));
}

/** Look up one profile, refreshing once if an id is unknown to the cache. */
export async function findProfile(root: string, id: string): Promise<ModelProfile | null> {
  const { profiles } = await loadSurfaces(root);
  const hit = profiles.get(id);
  if (hit) return hit;
  const { profiles: fresh } = await loadSurfaces(root, { fresh: true });
  return fresh.get(id) ?? null;
}

/** Validate and persist an authored profile, then refresh the cache. */
export async function saveProfile(root: string, input: unknown): Promise<ModelProfile> {
  const parsed = ModelProfileSchema.parse(input);
  const path = profilePathFor(root, parsed.id);
  await mkdir(authoredDir(root), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await loadSurfaces(root, { fresh: true });
  return parsed;
}

export type { Manifest };
