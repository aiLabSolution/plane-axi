import { currentProject, projectPath, requireDate } from "./common.js";
import { resolveNamed } from "../resolve.js";

function compact(item) {
  return { name: item.name, start: item.start_date || "", end: item.end_date || item.target_date || "", id: item.id };
}

async function context({ api, flags, cwd }, noun) {
  const project = await currentProject(api, flags, cwd);
  return { project, path: projectPath(api, project, `/${noun}/`) };
}

export function listNamed(noun, outputKey) {
  return async (ctx) => {
    const { project, path } = await context(ctx, noun);
    const { results, total } = await ctx.api.all(path);
    return { count: `${results.length} of ${total} total`, project: project.identifier, [outputKey]: results.map(compact) };
  };
}

export function viewNamed(noun, label) {
  return async (ctx) => {
    const { path } = await context(ctx, noun);
    const item = await resolveNamed(ctx.api, path, ctx.positionals[0], label);
    return { [label]: {
      id: item.id,
      name: item.name,
      description: item.description || "",
      start: item.start_date || null,
      end: item.end_date || item.target_date || null,
      status: item.status || null
    } };
  };
}

export function createNamed(noun, label) {
  return async (ctx) => {
    const { api, flags } = ctx;
    requireDate(flags.start, "start");
    requireDate(flags.end, "end");
    const { project, path } = await context(ctx, noun);
    const data = { name: flags.name };
    if (flags.start) data.start_date = flags.start;
    if (flags.end) data[noun === "modules" ? "target_date" : "end_date"] = flags.end;
    if (flags.description) data.description = flags.description;
    const item = await api.post(path, data);
    return { [label]: compact(item), project: project.identifier, result: "created" };
  };
}
