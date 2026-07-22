import { selectedProject } from "../config.js";
import { UsageError } from "../errors.js";
import { resolveProject } from "../resolve.js";

export function projectPath(api, project, suffix = "") {
  return api.workspacePath(`/projects/${project.id}${suffix}`);
}

export async function currentProject(api, flags, cwd) {
  return resolveProject(api, await selectedProject(flags, cwd));
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

export function requireDate(value, flag) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UsageError(`--${flag} must be YYYY-MM-DD`);
}
