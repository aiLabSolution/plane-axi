// Readable-ref lookaside cache: identifier -> project uuid, "<project uuid>:<seq>" ->
// work-item uuid. Sequence_id assignments are immutable, so entries never expire; a
// deleted/renamed target just 404s on the direct GET and resolve.js falls back to a
// fresh scan (see resolve.js). Port of lis-control/scripts/planelib.py's
// _cache_load/_cache_store, generalised to (workspace -> projects/items) since plane-axi
// spans multiple workspaces/projects where planelib.py only ever tracked one project.
//
// A broken cache is an optimisation loss, not an error: every read/write here is
// defensive and never throws out of the module. PLANE_AXI_NO_CACHE=1 bypasses the cache
// entirely (both reads and writes) as an escape hatch/benchmarking knob.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function cachePath(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "plane-axi", "refs.json");
}

function disabled(env) {
  return env.PLANE_AXI_NO_CACHE === "1";
}

async function load(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // missing file, unreadable, or corrupt JSON: treat as an empty cache
  }
}

async function save(file, cache) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, file); // atomic-enough: rename is atomic on the same filesystem
  } catch {
    // disk full, read-only fs, etc. — the cache is an optimisation, never fail the command
  }
}

function workspaceSlot(cache, workspace) {
  const slot = cache[workspace];
  return {
    projects: slot?.projects && typeof slot.projects === "object" ? slot.projects : {},
    items: slot?.items && typeof slot.items === "object" ? slot.items : {}
  };
}

export async function cachedProjectId(file, workspace, identifierLower, env = process.env) {
  if (disabled(env)) return undefined;
  return workspaceSlot(await load(file), workspace).projects[identifierLower];
}

export async function cachedItemId(file, workspace, key, env = process.env) {
  if (disabled(env)) return undefined;
  return workspaceSlot(await load(file), workspace).items[key];
}

// Remembers every identifier -> uuid pair from a fresh project-list scan.
export async function rememberProjects(file, workspace, projects, env = process.env) {
  if (disabled(env)) return;
  const cache = await load(file);
  const slot = workspaceSlot(cache, workspace);
  for (const project of projects) {
    if (project?.identifier && project?.id) slot.projects[project.identifier.toLowerCase()] = project.id;
  }
  cache[workspace] = slot;
  await save(file, cache);
}

// Remembers every sequence_id -> uuid pair from a fresh work-item scan.
export async function rememberItems(file, workspace, projectId, items, env = process.env) {
  if (disabled(env)) return;
  const cache = await load(file);
  const slot = workspaceSlot(cache, workspace);
  for (const item of items) {
    if (item?.sequence_id != null && item?.id) slot.items[`${projectId}:${item.sequence_id}`] = item.id;
  }
  cache[workspace] = slot;
  await save(file, cache);
}
