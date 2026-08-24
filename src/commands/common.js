import { readFile } from "node:fs/promises";
import { findProjectConfig, selectedProject } from "../config.js";
import { UsageError } from "../errors.js";
import { assertProjectInScope, resolveProject, resolveWorkItem } from "../resolve.js";

export function projectPath(api, project, suffix = "") {
  return api.workspacePath(`/projects/${project.id}${suffix}`);
}

// Every project-addressed command resolves its project here, so the directory scope is
// enforced in one place: a `--project` naming something other than the selected project is
// refused instead of silently overriding it.
export async function currentProject(api, flags, cwd) {
  const { ref, boundary } = await selectedProject(flags, cwd);
  const project = await resolveProject(api, ref);
  return assertProjectInScope(api, project, boundary, undefined, `project ${ref}`);
}

// The work-item twin of currentProject. A readable ref supplies its own project, so unlike
// currentProject this does not require one to be selected — but when one is, the ref must
// name it. Every wi/comment/claim command addresses its item through here.
export async function currentWorkItem(api, flags, cwd, ref) {
  const boundary = await findProjectConfig(cwd);
  return resolveWorkItem(api, ref, flags.project || boundary?.project, undefined, boundary);
}

export function compactProject(project) {
  return { identifier: project.identifier, name: project.name, id: project.id };
}

export function compactState(state) {
  return { name: state.name, group: state.group, id: state.id };
}

export function compactMember(member) {
  const user = member.member || member;
  return {
    name: user.display_name || user.name || user.email || "unknown",
    email: user.email || "",
    id: user.id || member.member_id || member.id
  };
}

export function requireOne(flags, names, message) {
  const present = names.filter((name) => flags[name] !== undefined);
  if (present.length !== 1) throw new UsageError(message, `Use exactly one of ${names.map((name) => `--${name}`).join(" or ")}`);
  return present[0];
}

export function atMostOne(flags, names, message) {
  const present = names.filter((name) => flags[name] !== undefined);
  if (present.length > 1) throw new UsageError(message, `Use at most one of ${names.map((name) => `--${name}`).join(" or ")}`);
  return present[0];
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export async function readBody(path) {
  if (path === "-") return readStdin();
  return readFile(path, "utf8").catch(() => {
    throw new UsageError(`cannot read body file ${path}`, "Check that the path exists and is readable");
  });
}

export function requireDate(value, flag) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UsageError(`--${flag} must be YYYY-MM-DD`);
}
