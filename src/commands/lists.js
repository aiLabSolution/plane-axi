import { compactMember, compactState, currentProject, projectPath } from "./common.js";

export async function stateList({ api, flags, cwd }) {
  const project = await currentProject(api, flags, cwd);
  const { results, total } = await api.all(projectPath(api, project, "/states/"));
  return { count: `${results.length} of ${total} total`, project: project.identifier, states: results.map(compactState) };
}

export async function labelList({ api, flags, cwd }) {
  const project = await currentProject(api, flags, cwd);
  const { results, total } = await api.all(projectPath(api, project, "/labels/"));
  return { count: `${results.length} of ${total} total`, project: project.identifier, labels: results.map((label) => ({ name: label.name, color: label.color || "", id: label.id })) };
}

export async function memberList({ api }) {
  const { results, total } = await api.all(api.workspacePath("/members/"));
  return { count: `${results.length} of ${total} total`, members: results.map(compactMember) };
}
