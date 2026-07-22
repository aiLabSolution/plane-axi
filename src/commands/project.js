import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { compactProject } from "./common.js";
import { resolveProject } from "../resolve.js";
import { withHelp } from "../output.js";

export async function projectList({ api }) {
  const { results, total } = await api.all(api.workspacePath("/projects/"));
  return withHelp({ count: `${results.length} of ${total} total`, projects: results.map(compactProject) }, [
    "Run `plane-axi project view <project>` for details",
    "Run `plane-axi use <project>` to select a default"
  ]);
}

export async function projectView({ api, positionals }) {
  const project = await resolveProject(api, positionals[0]);
  return { project: {
    id: project.id,
    identifier: project.identifier,
    name: project.name,
    description: project.description || project.description_text || "",
    created_at: project.created_at || null,
    updated_at: project.updated_at || null
  } };
}

export async function projectCreate({ api, flags }) {
  const data = { name: flags.name, identifier: flags.identifier.toUpperCase() };
  if (flags.description) data.description = flags.description;
  const project = await api.post(api.workspacePath("/projects/"), data);
  return withHelp({ project: compactProject(project), result: "created" }, [
    `Run \`plane-axi use ${project.identifier}\` to select it`
  ]);
}

export async function useProject({ api, positionals, cwd }) {
  const project = await resolveProject(api, positionals[0]);
  const target = path.join(cwd, ".plane-axi.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ project: project.identifier }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return withHelp({ project: compactProject(project), config: target, result: "selected" }, [
    "Run `plane-axi` to see the project dashboard"
  ]);
}
