import { cachedItemId, cachedProjectId, cachePath, rememberItems, rememberProjects } from "./cache.js";
import { AxiError, UsageError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validRef(ref, label) {
  if (!ref || /[/\\]/.test(ref) || ref.includes("..")) throw new UsageError(`invalid ${label} reference`, `Use a UUID, identifier, or exact name`);
  return String(ref);
}

// A 404 on a cached uuid means the cache entry is stale (renamed/deleted target); treat
// it as a miss so the caller falls back to a fresh scan instead of failing the command.
async function getOk404(api, path) {
  return api.get(path).catch((error) => {
    if (error.status !== 404) throw error;
    return null;
  });
}

export async function resolveProject(api, ref, cacheFile = cachePath()) {
  ref = validRef(ref, "project");
  const base = api.workspacePath("/projects/");
  const workspace = api.config?.workspace;
  if (UUID.test(ref)) {
    try { return await api.get(`${base}${ref}/`); } catch (error) { if (error.status !== 404) throw error; }
  } else if (workspace) {
    const cached = await cachedProjectId(cacheFile, workspace, ref.toLowerCase());
    if (cached) {
      // The cache only ever keys on identifier, and identifiers are unique per workspace, so a
      // hit whose fetched identifier still matches is the canonical winner — accept it without a
      // scan. Only confirm the identifier (not the name): a warm hit must resolve identically to a
      // cold scan, and the cold scan lets an identifier match win over a project sharing the name.
      const project = await getOk404(api, `${base}${cached}/`);
      if (project && project.identifier?.toLowerCase() === ref.toLowerCase()) return project;
    }
  }
  const { results } = await api.all(base);
  if (workspace) await rememberProjects(cacheFile, workspace, results);
  const lower = ref.toLowerCase();
  // Identifiers (and ids) are unique per workspace and are the canonical project reference, so an
  // exact identifier/id match wins over a project that merely shares the name. Name is only
  // consulted when nothing matches by identifier/id (where two same-named projects stay ambiguous).
  const byId = results.filter((project) => project.identifier?.toLowerCase() === lower || project.id === ref);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) throw new AxiError(`ambiguous project reference ${ref}`, { help: byId.map((project) => `${project.identifier}: ${project.id}`) });
  const byName = results.filter((project) => project.name?.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new AxiError(`ambiguous project reference ${ref}`, { help: byName.map((project) => `${project.identifier}: ${project.id}`) });
  throw new AxiError(`project ${ref} not found`, { help: "Run `plane-axi project list` to see projects" });
}

export async function resolveWorkItem(api, ref, projectHint, cacheFile = cachePath()) {
  ref = validRef(ref, "work item");
  let project;
  let sequence;
  if (UUID.test(ref)) {
    if (!projectHint) throw new UsageError("work item UUID requires project context", "Pass `--project <project>` or run `plane-axi use <project>`");
    project = await resolveProject(api, projectHint, cacheFile);
  } else {
    const readable = /^(.+)-(\d+)$/.exec(ref);
    if (readable) {
      project = await resolveProject(api, readable[1], cacheFile);
      sequence = Number(readable[2]);
    } else {
      if (!projectHint) throw new UsageError("work item UUID requires project context", "Pass `--project <project>` or run `plane-axi use <project>`");
      project = await resolveProject(api, projectHint, cacheFile);
    }
  }
  const base = api.workspacePath(`/projects/${project.id}/work-items/`);
  const workspace = api.config?.workspace;
  if (UUID.test(ref)) {
    try { return { project, item: await api.get(`${base}${ref}/`) }; } catch (error) { if (error.status !== 404) throw error; }
  } else if (workspace && sequence !== undefined) {
    const cached = await cachedItemId(cacheFile, workspace, `${project.id}:${sequence}`);
    if (cached) {
      const item = await getOk404(api, `${base}${cached}/`);
      if (item && item.sequence_id === sequence) return { project, item };
    }
  }
  // state is kept (not just id/sequence_id/name) because wi close reads the resolved
  // item's current state; the bare uuid string + stateById map still resolves it.
  const { results } = await api.all(base, { fields: "id,sequence_id,name,state" });
  if (workspace) await rememberItems(cacheFile, workspace, project.id, results);
  const matches = results.filter((item) => item.id === ref || item.sequence_id === sequence);
  if (matches.length === 1) return { project, item: matches[0] };
  if (matches.length > 1) throw new AxiError(`ambiguous work item reference ${ref}`, { help: matches.map((item) => item.id) });
  throw new AxiError(`work item ${ref} not found`, { help: `Run \`plane-axi wi list --project ${project.identifier}\`` });
}

export async function resolveNamed(api, path, ref, label) {
  ref = validRef(ref, label);
  if (UUID.test(ref)) {
    try { return await api.get(`${path}${ref}/`); } catch (error) { if (error.status !== 404) throw error; }
  }
  const { results } = await api.all(path);
  const lower = ref.toLowerCase();
  const matches = results.filter((item) => {
    const nested = item.member || item.user || {};
    return item.id === ref || item.member_id === ref || nested.id === ref
      || item.name?.toLowerCase() === lower || item.display_name?.toLowerCase() === lower || item.email?.toLowerCase() === lower
      || nested.name?.toLowerCase() === lower || nested.display_name?.toLowerCase() === lower || nested.email?.toLowerCase() === lower;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new AxiError(`ambiguous ${label} reference ${ref}`, { help: matches.map((item) => `${item.name || item.display_name || item.email || item.member?.display_name || item.member?.email}: ${item.member?.id || item.member_id || item.id}`) });
  throw new AxiError(`${label} ${ref} not found`);
}

export { UUID };
