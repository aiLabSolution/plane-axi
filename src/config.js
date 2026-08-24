import { access, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AxiError, UsageError } from "./errors.js";

export function envConfig(env = process.env) {
  const configuredBase = (env.PLANE_BASE_URL || "https://api.plane.so").replace(/\/$/, "");
  return {
    apiKey: env.PLANE_API_KEY,
    workspace: env.PLANE_WORKSPACE || env.PLANE_WORKSPACE_SLUG,
    baseUrl: configuredBase.endsWith("/api/v1") ? configuredBase : `${configuredBase}/api/v1`
  };
}

export function assertCredentials(config) {
  if (!config.apiKey) throw new AxiError("PLANE_API_KEY is not set", { help: 'Export it with `export PLANE_API_KEY="<token>"`' });
  if (!config.workspace) throw new AxiError("PLANE_WORKSPACE is not set", { help: 'Export it with `export PLANE_WORKSPACE="<workspace-slug>"`' });
}

export async function findProjectConfig(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    const file = path.join(current, ".plane-axi.json");
    try {
      await access(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw new UsageError(`invalid project config at ${file}`, "Run `plane-axi use <project>` to repair it");
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw new UsageError(`invalid project config at ${file}`, "Run `plane-axi use <project>` to repair it");
    }
    const project = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.project : undefined;
    if (typeof project !== "string" || !project) {
      throw new UsageError(`invalid project config at ${file}`, "Run `plane-axi use <project>` to repair it");
    }
    return { ...parsed, file };
  }
}

// Returns both the project to act on and the directory config that scopes it. The config is a
// boundary, not merely a default: callers pass the boundary on to assertProjectInScope so a
// `--project` (or a readable ref's own prefix) naming a different project is refused rather
// than silently honoured. Discovery commands that legitimately span the workspace
// (`project list`, `member list`, `wi search --workspace`) never consult it.
export async function selectedProject(flags = {}, cwd = process.cwd()) {
  const boundary = await findProjectConfig(cwd);
  const ref = flags.project || boundary?.project;
  if (!ref) throw new UsageError("no project selected", "Run `plane-axi use <project>` or pass `--project <project>`");
  return { ref, boundary };
}

export function displayPath(file) {
  const home = os.homedir();
  return file === home ? "~" : file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}
