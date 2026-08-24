import { findProjectConfig } from "../config.js";
import { AxiError, UsageError } from "../errors.js";
import { mdToHtml } from "../markdown.js";
import { stripHtml, truncate, withHelp } from "../output.js";
import { assertProjectInScope, resolveNamed, resolveProject } from "../resolve.js";
import { atMostOne, currentProject, currentWorkItem, projectPath, readBody } from "./common.js";

const PRIORITIES = new Set(["urgent", "high", "medium", "low", "none"]);
const FIELD_NAMES = new Set(["id", "seq", "title", "state", "priority", "assignee", "labels", "created_at", "updated_at"]);
// Trims the work-item payload to exactly what compactItem/FIELD_NAMES can render, plus
// expand=state so stateObject gets a dict instead of a bare uuid. Plane honors ?fields=
// even though it ignores filter params, and full-list scans were blowing the per-token
// rate budget (see planelib.py's LIST_FIELDS).
const LIST_FIELDS = "id,sequence_id,name,priority,state,assignees,labels,created_at,updated_at";
const LIST_QUERY = { fields: LIST_FIELDS, expand: "state" };
// The body scan only ever reads name + description_html (see matchesQuery), so nothing else is
// worth the extra payload.
const SEARCH_QUERY = { fields: "id,sequence_id,name,description_html" };
// Ceiling for the server search's own --limit, matching limitValue's maximum: --all has no
// number to send, and an unbounded request is not something to aim at someone's Plane.
const SEARCH_CAP = 1000;

async function workItemContext({ api, flags, positionals, cwd }, index = 0) {
  return currentWorkItem(api, flags, cwd, positionals[index]);
}

async function statesFor(api, project) {
  return (await api.all(projectPath(api, project, "/states/"))).results;
}

function stateObject(item, stateById) {
  if (item.state_detail) return item.state_detail;
  if (item.state && typeof item.state === "object") return item.state;
  return stateById.get(item.state);
}

function assigneeValues(item) {
  const list = item.assignees || item.assignee_details || [];
  return list.map((entry) => typeof entry === "string" ? entry : entry.id || entry.member_id || entry.display_name || entry.email).filter(Boolean);
}

function compactItem(item, project, stateById, fields) {
  const state = stateObject(item, stateById);
  const all = {
    id: item.id,
    seq: `${project.identifier}-${item.sequence_id}`,
    title: item.name,
    state: state?.name || item.state || "Unknown",
    priority: item.priority || "none",
    assignee: assigneeValues(item).join(", "),
    labels: (item.labels || item.label_details || []).map((label) => typeof label === "string" ? label : label.name || label.id).join(", "),
    created_at: item.created_at || "",
    updated_at: item.updated_at || ""
  };
  return Object.fromEntries(fields.map((field) => [field, all[field]]));
}

function requestedFields(value) {
  if (!value) return ["seq", "title", "state", "priority"];
  const fields = value.split(",").map((field) => field.trim()).filter(Boolean);
  const invalid = fields.filter((field) => !FIELD_NAMES.has(field));
  if (!fields.length || invalid.length) throw new UsageError(`invalid --fields value${invalid.length ? `: ${invalid.join(", ")}` : ""}`, `Valid fields: ${[...FIELD_NAMES].join(", ")}`);
  return fields;
}

function quoteFilterValue(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function limitValue(flags) {
  if (flags.all) return Infinity;
  const limit = Number(flags.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new UsageError("--limit must be an integer from 1 to 1000");
  return limit;
}

function checkPriority(value) {
  if (value && !PRIORITIES.has(value.toLowerCase())) throw new UsageError(`invalid priority ${value}`, `Use one of: ${[...PRIORITIES].join(", ")}`);
  return value?.toLowerCase();
}

async function resolveState(api, project, ref) {
  if (!ref) return null;
  const states = await statesFor(api, project);
  const lower = ref.toLowerCase();
  let matches = states.filter((state) => state.id === ref || state.name?.toLowerCase() === lower);
  if (!matches.length) matches = states.filter((state) => state.group?.toLowerCase() === lower);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new AxiError(`ambiguous state ${ref}`, { help: matches.map((state) => `${state.name}: ${state.id}`) });
  throw new AxiError(`state ${ref} not found`, { help: `Run \`plane-axi state list --project ${project.identifier}\`` });
}

async function resolveMember(api, ref) {
  return resolveNamed(api, api.workspacePath("/members/"), ref, "member");
}

export async function wiList({ api, flags, cwd }) {
  const limit = limitValue(flags);
  const priority = checkPriority(flags.priority);
  const fields = requestedFields(flags.fields);
  const project = await currentProject(api, flags, cwd);
  const states = await statesFor(api, project);
  const stateById = new Map(states.map((state) => [state.id, state]));
  const member = flags.assignee ? await resolveMember(api, flags.assignee) : null;
  const path = projectPath(api, project, "/work-items/");
  const needsAll = flags.all || flags.state || flags.priority || flags.assignee || limit > 100;
  const response = needsAll ? await api.all(path, LIST_QUERY) : await api.page(path, LIST_QUERY);
  let items = response.results;
  if (flags.state) {
    const lower = flags.state.toLowerCase();
    items = items.filter((item) => {
      const state = stateObject(item, stateById);
      return item.state === flags.state || state?.id === flags.state || state?.name?.toLowerCase() === lower || state?.group?.toLowerCase() === lower;
    });
  }
  if (priority) items = items.filter((item) => (item.priority || "none").toLowerCase() === priority);
  if (member) {
    const ids = new Set([member.id, member.member_id, member.member?.id].filter(Boolean));
    items = items.filter((item) => assigneeValues(item).some((value) => ids.has(value)));
  }
  const matching = needsAll ? items.length : response.total;
  items = items.slice(0, limit);
  const filters = [flags.state && `--state ${quoteFilterValue(flags.state)}`, priority && `--priority ${quoteFilterValue(priority)}`, flags.assignee && `--assignee ${quoteFilterValue(flags.assignee)}`].filter(Boolean).join(" ");
  if (!items.length) return { wi: `0 work items${filters ? ` matching ${filters}` : ""} in project ${project.identifier}` };
  const hints = ["Run `plane-axi wi view <ref>` for details"];
  if (matching > items.length) {
    const extra = [filters, flags.project ? `--project ${project.identifier}` : ""].filter(Boolean).join(" ");
    hints.push(`Run \`plane-axi wi list --all${extra ? ` ${extra}` : ""}\` for all ${matching} matching items`);
  }
  return withHelp({ count: `${items.length} of ${matching} matching (${response.total} total)`, project: project.identifier, wi: items.map((item) => compactItem(item, project, stateById, fields)) }, hints);
}

export async function wiView(ctx) {
  const { api, flags } = ctx;
  const { project, item: summary } = await workItemContext(ctx);
  // A readable-cache hit already returned the full item (direct GET, not a trimmed
  // scan) — description_html is present, so skip the redundant detail GET.
  const item = "description_html" in summary ? summary : await api.get(`${projectPath(api, project, "/work-items/")}${summary.id}/`);
  const states = await statesFor(api, project);
  const state = stateObject(item, new Map(states.map((entry) => [entry.id, entry])));
  const body = stripHtml(item.description_html || item.description || "");
  const preview = flags.full ? { text: body, truncated: false } : truncate(body, 1000);
  const seq = `${project.identifier}-${item.sequence_id}`;
  const hints = [`Run \`plane-axi comment list ${seq}\` for comments`];
  if (preview.truncated) hints.push(`Run \`plane-axi wi view ${seq} --full\` to see the complete body`);
  return withHelp({ work_item: {
    id: item.id,
    seq,
    title: item.name,
    state: state?.name || item.state || "Unknown",
    priority: item.priority || "none",
    assignees: assigneeValues(item),
    labels: (item.labels || item.label_details || []).map((label) => typeof label === "string" ? label : label.name || label.id),
    body: preview.text,
    created_at: item.created_at || null,
    updated_at: item.updated_at || null
  } }, hints);
}

export async function wiCreate({ api, flags, cwd }) {
  const priority = checkPriority(flags.priority);
  const bodySource = atMostOne(flags, ["body", "body-file"], "create accepts at most one of --body or --body-file");
  const project = await currentProject(api, flags, cwd);
  const data = { name: flags.title };
  if (bodySource) {
    const raw = bodySource === "body" ? flags.body : await readBody(flags["body-file"]);
    const trimmed = raw.trim();
    if (trimmed) data.description_html = mdToHtml(trimmed);
  }
  if (priority) data.priority = priority;
  if (flags.state) data.state = (await resolveState(api, project, flags.state)).id;
  if (flags.assignee) {
    const member = await resolveMember(api, flags.assignee);
    data.assignees = [member.member?.id || member.member_id || member.id];
  }
  if (flags.label) data.labels = [(await resolveNamed(api, projectPath(api, project, "/labels/"), flags.label, "label")).id];
  if (flags.parent) data.parent = (await resolveWorkItem(api, flags.parent, project.identifier)).item.id;
  const item = await api.post(projectPath(api, project, "/work-items/"), data);
  return withHelp({ work_item: { id: item.id, seq: `${project.identifier}-${item.sequence_id}`, title: item.name, priority: item.priority || "none" }, result: "created" }, [
    `Run \`plane-axi wi view ${project.identifier}-${item.sequence_id}\` for details`
  ]);
}

export async function wiUpdate(ctx) {
  const { api, flags } = ctx;
  const priority = flags.priority !== undefined ? checkPriority(flags.priority) : undefined;
  const bodySource = atMostOne(flags, ["body", "body-file"], "update accepts at most one of --body or --body-file");
  const { project, item } = await workItemContext(ctx);
  const data = {};
  if (flags.title !== undefined) data.name = flags.title;
  if (bodySource) {
    const raw = bodySource === "body" ? flags.body : await readBody(flags["body-file"]);
    data.description_html = mdToHtml(raw.trim()); // "" is an explicit clear (preserves the allowEmpty fix)
  }
  if (flags.priority !== undefined) data.priority = priority;
  if (flags.state !== undefined) data.state = (await resolveState(api, project, flags.state)).id;
  if (!Object.keys(data).length) throw new UsageError("nothing to update", "Pass at least one of --title, --body, --body-file, --priority, or --state");
  const updated = await api.patch(`${projectPath(api, project, "/work-items/")}${item.id}/`, data);
  return withHelp({ work_item: { id: updated.id, seq: `${project.identifier}-${updated.sequence_id}`, title: updated.name }, result: "updated" }, [
    `Run \`plane-axi wi view ${project.identifier}-${updated.sequence_id}\` for details`
  ]);
}

export async function wiAssign(ctx) {
  const { api, positionals } = ctx;
  const { project, item } = await workItemContext(ctx);
  const members = [];
  for (const ref of positionals.slice(1)) members.push(await resolveMember(api, ref));
  const ids = members.map((member) => member.member?.id || member.member_id || member.id);
  await api.patch(`${projectPath(api, project, "/work-items/")}${item.id}/`, { assignees: ids });
  return withHelp({ work_item: `${project.identifier}-${item.sequence_id}`, assignees: ids.length, result: "assigned" }, [
    `Run \`plane-axi wi view ${project.identifier}-${item.sequence_id}\` to verify`
  ]);
}

export async function wiClose(ctx) {
  const { api } = ctx;
  const { project, item } = await workItemContext(ctx);
  const states = await statesFor(api, project);
  const current = stateObject(item, new Map(states.map((state) => [state.id, state])));
  if (current?.group?.toLowerCase() === "completed") return { work_item: `${project.identifier}-${item.sequence_id}`, result: "already closed (no-op)" };
  const completed = states.find((state) => state.group?.toLowerCase() === "completed");
  if (!completed) throw new AxiError(`project ${project.identifier} has no completed state`, { help: `Run \`plane-axi state list --project ${project.identifier}\`` });
  await api.patch(`${projectPath(api, project, "/work-items/")}${item.id}/`, { state: completed.id });
  return withHelp({ work_item: `${project.identifier}-${item.sequence_id}`, state: completed.name, result: "closed" }, [
    `Run \`plane-axi wi view ${project.identifier}-${item.sequence_id}\` to verify`
  ]);
}

export async function wiDelete(ctx) {
  if (!ctx.flags.yes) throw new UsageError("deletion requires --yes", `Run \`plane-axi wi delete ${ctx.positionals[0]} --yes\``);
  const { project, item } = await workItemContext(ctx);
  await ctx.api.delete(`${projectPath(ctx.api, project, "/work-items/")}${item.id}/`);
  return { work_item: `${project.identifier}-${item.sequence_id}`, result: "deleted" };
}

function searchItems(body) {
  if (Array.isArray(body)) return body;
  for (const key of ["results", "work_items", "issues"]) if (Array.isArray(body?.[key])) return body[key];
  return [];
}

function matchesQuery(item, lower) {
  return `${item.name || ""}\n${stripHtml(item.description_html || item.description || "")}`.toLowerCase().includes(lower);
}

async function scanProject(api, project, lower) {
  const { results } = await api.all(projectPath(api, project, "/work-items/"), SEARCH_QUERY);
  return results.filter((item) => matchesQuery(item, lower)).map((item) => ({ ...item, project_identifier: project.identifier }));
}

async function scanEveryProject(api, lower) {
  const projects = (await api.all(api.workspacePath("/projects/"))).results;
  const items = [];
  for (const project of projects) items.push(...await scanProject(api, project, lower));
  return items;
}

// Titles are matched by the server, which is one request instead of paging every work item in
// the project — but the endpoint matches titles and ids only: a term that appears solely in a
// body returns nothing here, which is why --text still exists and why the mode is named in
// every result. Absent on deployments that predate it, hence the 404 fallback in searchFor.
async function searchTitles(api, query, project, cap) {
  const params = { search: query, limit: cap };
  if (project) params.project_id = project.id;
  return searchItems(await api.get(api.workspacePath("/issues/search/"), params));
}

// Returns the rows plus how they were matched: "title" costs one request but only sees titles,
// "title+body" scans and sees everything. The caller never has to guess which one ran — a 404
// silently downgrading to a scan would otherwise report title semantics for body results.
async function searchFor(api, { query, lower, project, limit, text }) {
  if (!text) {
    // One row past the limit is what distinguishes "exactly this many" from "at least this
    // many": the endpoint reports no total of its own.
    const cap = Math.min(limit === Infinity ? SEARCH_CAP : limit + 1, SEARCH_CAP);
    try {
      return { items: await searchTitles(api, query, project, cap), match: "title", cap };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const items = project ? await scanProject(api, project, lower) : await scanEveryProject(api, lower);
  return { items, match: "title+body", cap: null };
}

// Search is scoped to the selected project by default. It used to be workspace-wide with no
// way to narrow it, which put other projects' work items in front of a caller working in this
// one — the first step of a cross-project reference leaking into scoped work. `--workspace`
// still searches everything for callers who mean to; it is read-only, and the scoped path is
// what runs unless it is asked for.
export async function wiSearch({ api, flags, positionals, cwd }) {
  const query = positionals.join(" ");
  const lower = query.toLowerCase();
  const limit = limitValue(flags);
  if (flags.workspace && flags.project) throw new UsageError("search accepts at most one of --workspace or --project", "Use at most one of --workspace or --project");
  const boundary = flags.workspace ? null : await findProjectConfig(cwd);
  const scopeRef = flags.workspace ? null : (flags.project || boundary?.project);
  const project = scopeRef
    ? await assertProjectInScope(api, await resolveProject(api, scopeRef), boundary, undefined, `project ${scopeRef}`)
    : null;
  const { items: found, match, cap } = await searchFor(api, { query, lower, project, limit, text: flags.text });
  const where = project ? ` in ${project.identifier}` : "";
  const rerun = `${query}${flags.project ? ` --project ${flags.project}` : ""}${flags.workspace ? " --workspace" : ""}`;
  if (!found.length) {
    const miss = { wi: `0 work items matching ${query}${where} by ${match}` };
    // A title-only miss is the one case where the wider search plainly might not miss, so this
    // is the one place --text is worth naming.
    return match === "title" ? withHelp(miss, [`Run \`plane-axi wi search ${rerun} --text\` to match bodies too`]) : miss;
  }
  const items = found.slice(0, limit === Infinity ? found.length : limit);
  // A scan knows its true total. The server search only knows how many rows it was allowed to
  // return, so it reports "N or more" rather than a total it never established.
  const truncated = found.length > items.length || (cap !== null && found.length >= cap);
  const count = cap === null
    ? `${items.length} of ${found.length} matching`
    : `${items.length} matching${truncated ? " or more" : ""}`;
  const hints = ["Run `plane-axi wi view <ref>` for details"];
  if (truncated) hints.push(`Run \`plane-axi wi search ${rerun} --all\` for ${cap === null ? `all ${found.length} matches` : "every match"}`);
  const row = (item) => {
    const identifier = item.project_identifier || item.project__identifier || item.project_detail?.identifier;
    const rendered = { seq: item.sequence_id && identifier ? `${identifier}-${item.sequence_id}` : item.id, title: item.name || item.title };
    // A scoped search names its project once in the payload, so repeating it on every row is
    // pure output weight; a workspace search needs it per row to stay unambiguous.
    return project ? rendered : { ...rendered, project: identifier || item.project || "" };
  };
  const payload = { count, match, ...(project ? { project: project.identifier } : {}), wi: items.map(row) };
  return withHelp(payload, hints);
}

export const _internals = { requestedFields, limitValue, checkPriority, compactItem, searchItems };
