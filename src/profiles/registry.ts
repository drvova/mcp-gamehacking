import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join, resolve, sep } from "path";
import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID } from "./builtin.js";
import { ModelProfileSchema, type ModelProfile } from "./types.js";

/**
 * Where model-authored profiles live. Kept beside the server data directories
 * rather than inside `src/` so an authored profile survives a rebuild.
 */
export const PROFILES_DIR_NAME = "model-profiles";

export type ProfileLoadReport = {
  profiles: Map<string, ModelProfile>;
  /** Files that were present but unusable, with the reason. */
  invalid: Array<{ file: string; reason: string }>;
};

let cache: ProfileLoadReport | null = null;

function profilesDir(root: string): string {
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
  const dir = profilesDir(root);
  const candidate = resolve(dir, `${id}.json`);
  const boundary = resolve(dir) + sep;
  if (!candidate.startsWith(boundary)) {
    throw new Error(`profile id "${id}" resolves outside the profiles directory`);
  }
  return candidate;
}

/**
 * Load built-ins plus every authored profile.
 *
 * Built-ins always load; an unreadable or malformed authored file is recorded
 * and skipped. A profile file must never be able to stop the server from
 * starting, so loading fails open while the individual file fails closed.
 */
export async function loadProfiles(
  root: string,
  options: { fresh?: boolean } = {},
): Promise<ProfileLoadReport> {
  if (cache && !options.fresh) return cache;

  const profiles = new Map<string, ModelProfile>();
  for (const profile of BUILTIN_PROFILES) profiles.set(profile.id, profile);

  const invalid: ProfileLoadReport["invalid"] = [];
  const dir = profilesDir(root);

  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    // No authored profiles yet; built-ins are the whole set.
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

    profiles.set(parsed.data.id, parsed.data);
  }

  cache = { profiles, invalid };
  return cache;
}

/** Look up one profile, refreshing once if an id is unknown to the cache. */
export async function findProfile(root: string, id: string): Promise<ModelProfile | null> {
  const cached = await loadProfiles(root);
  const hit = cached.profiles.get(id);
  if (hit) return hit;

  // A profile may have been authored outside this process; re-read once.
  const fresh = await loadProfiles(root, { fresh: true });
  return fresh.profiles.get(id) ?? null;
}

/** Validate and persist an authored profile, then refresh the cache. */
export async function saveProfile(root: string, input: unknown): Promise<ModelProfile> {
  const profile = ModelProfileSchema.parse(input);
  const path = profilePathFor(root, profile.id);

  await mkdir(profilesDir(root), { recursive: true });
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

  cache = null;
  return profile;
}

export { DEFAULT_PROFILE_ID };
