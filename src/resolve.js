import { AxiError, UsageError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validRef(ref, label) {
  if (!ref || /[/\\]/.test(ref) || ref.includes("..")) throw new UsageError(`invalid ${label} reference`, `Use a UUID, identifier, or exact name`);
  return String(ref);
}

export async function resolveProject(api, ref) {
  ref = validRef(ref, "project");
  const base = api.workspacePath("/projects/");
  if (UUID.test(ref)) {
    try { return await api.get(`${base}${ref}/`); } catch (error) { if (error.status !== 404) throw error; }
  }
  const { results } = await api.all(base);
  const lower = ref.toLowerCase();
  const exact = results.filter((project) => project.identifier?.toLowerCase() === lower || project.name?.toLowerCase() === lower || project.id === ref);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new AxiError(`ambiguous project reference ${ref}`, { help: exact.map((project) => `${project.identifier}: ${project.id}`) });
  throw new AxiError(`project ${ref} not found`, { help: "Run `plane-axi project list` to see projects" });
}

export async function resolveWorkItem(api, ref, projectHint) {
  ref = validRef(ref, "work item");
  let project;
  let sequence;
  if (UUID.test(ref)) {
    if (!projectHint) throw new UsageError("work item UUID requires project context", "Pass `--project <project>` or run `plane-axi use <project>`");
    project = await resolveProject(api, projectHint);
  } else {
    const readable = /^(.+)-(\d+)$/.exec(ref);
    if (readable) {
      project = await resolveProject(api, readable[1]);
      sequence = Number(readable[2]);
    } else {
      if (!projectHint) throw new UsageError("work item UUID requires project context", "Pass `--project <project>` or run `plane-axi use <project>`");
      project = await resolveProject(api, projectHint);
    }
  }
  const base = api.workspacePath(`/projects/${project.id}/work-items/`);
  if (UUID.test(ref)) {
    try { return { project, item: await api.get(`${base}${ref}/`) }; } catch (error) { if (error.status !== 404) throw error; }
  }
  const { results } = await api.all(base);
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
