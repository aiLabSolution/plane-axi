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
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (!parsed.project) throw new Error("missing project");
      return { ...parsed, file };
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError) && error.message !== "missing project") throw error;
      if (error.code !== "ENOENT") throw new UsageError(`invalid project config at ${file}`, "Run `plane-axi use <project>` to repair it");
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function selectedProject(flags = {}, cwd = process.cwd()) {
  if (flags.project) return flags.project;
  const config = await findProjectConfig(cwd);
  if (config?.project) return config.project;
  throw new UsageError("no project selected", "Run `plane-axi use <project>` or pass `--project <project>`");
}

export function displayPath(file) {
  const home = os.homedir();
  return file === home ? "~" : file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}
