import { fileURLToPath } from "node:url";
import { displayPath, findProjectConfig } from "../config.js";
import { compactProject, projectPath } from "./common.js";
import { resolveProject } from "../resolve.js";

const DESCRIPTION = "Manage Plane.so projects and work items from the current workspace";

export async function me({ api }) {
  const user = await api.get("/users/me/");
  return { user: {
    id: user.id,
    name: user.display_name || user.first_name || user.email,
    email: user.email || ""
  } };
}

export async function home({ api, cwd, executable }) {
  const config = await findProjectConfig(cwd);
  const payload = {
    bin: displayPath(executable || fileURLToPath(new URL("../../bin/plane-axi.js", import.meta.url))),
    description: DESCRIPTION,
    workspace: api.config.workspace
  };
  if (!config) {
    const { results } = await api.all(api.workspacePath("/projects/"));
    return {
      ...payload,
      projects: results.map(compactProject),
      help: [
        "Run `plane-axi use <project>` to select a default project",
        "Run `plane-axi project list` to list projects"
      ]
    };
  }
  const project = await resolveProject(api, config.project);
  const states = (await api.all(projectPath(api, project, "/states/"))).results;
  const items = (await api.all(projectPath(api, project, "/work-items/"))).results;
  const stateById = new Map(states.map((state) => [state.id, state]));
  const counts = new Map();
  for (const item of items) {
    const state = typeof item.state === "object" ? item.state : stateById.get(item.state);
    const name = state?.name || "Unknown";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return {
    ...payload,
    project: compactProject(project),
    work_items: items.length,
    states: [...counts].map(([state, count]) => ({ state, count })),
    help: [
      "Run `plane-axi wi list` to see work items",
      "Run `plane-axi wi create --title \"<title>\"` to create one"
    ]
  };
}

export async function snapshot(context) {
  try { return await home(context); }
  catch { return null; }
}

export { DESCRIPTION };
