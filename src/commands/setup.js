import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { displayPath } from "../config.js";
import { AxiError } from "../errors.js";

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function readJson(file, fallback = {}) {
  if (!(await exists(file))) return fallback;
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJsonIfChanged(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if ((await exists(file)) && await readFile(file, "utf8") === text) return false;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
  return true;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function commandFor(executable) {
  let target;
  try { target = await realpath(executable); } catch { target = path.resolve(executable); }
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "plane-axi");
    try {
      if (await realpath(candidate) === target) return "plane-axi snapshot";
    } catch {}
  }
  return `${shellQuote(target)} snapshot`;
}

function mergeSessionHook(settings, command, file) {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new AxiError(`invalid settings in ${displayPath(file)}`, { help: "Fix or remove the file, then rerun `plane-axi setup`" });
  }
  if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new AxiError(`invalid "hooks" in ${displayPath(file)}`, { help: "Fix or remove the hooks key, then rerun `plane-axi setup`" });
  }
  settings.hooks ||= {};
  if (settings.hooks.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart)) {
    throw new AxiError(`invalid "hooks.SessionStart" in ${displayPath(file)}`, { help: "Fix or remove the hooks.SessionStart key, then rerun `plane-axi setup`" });
  }
  settings.hooks.SessionStart ||= [];
  let group = settings.hooks.SessionStart.find((entry) => entry?.hooks?.some((hook) => hook?.type === "command" && /plane-axi(?:\.js)?['\"]? snapshot$/.test(hook.command || "")));
  if (!group) {
    group = { matcher: "", hooks: [{ type: "command", command, timeout: 30 }] };
    settings.hooks.SessionStart.push(group);
  } else {
    group.hooks = [{ type: "command", command, timeout: 30 }];
  }
  return settings;
}

async function installClaude(root, command) {
  const file = path.join(root, ".claude", "settings.json");
  const settings = mergeSessionHook(await readJson(file), command, file);
  return { app: "claude", file: displayPath(file), changed: await writeJsonIfChanged(file, settings) };
}

async function installCodex(root, command) {
  const file = path.join(root, ".codex", "hooks.json");
  const settings = mergeSessionHook(await readJson(file), command, file);
  return { app: "codex", file: displayPath(file), changed: await writeJsonIfChanged(file, settings), note: "Codex requires [features].hooks = true in config.toml" };
}

function openCodePlugin(binary) {
  return `// Managed by plane-axi setup.\nimport { spawn } from \"node:child_process\";\n\nconst binary = ${JSON.stringify(binary)};\nconst timeoutMs = 30000;\n\nfunction snapshot(cwd) {\n  return new Promise((resolve) => {\n    const child = spawn(binary, [\"snapshot\"], { cwd: typeof cwd === \"string\" ? cwd : process.cwd(), env: process.env, shell: false, stdio: [\"ignore\", \"pipe\", \"ignore\"] });\n    let stdout = \"\";\n    let settled = false;\n    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(\"SIGTERM\"); resolve(\"\"); } }, timeoutMs);\n    child.stdout?.setEncoding(\"utf8\");\n    child.stdout?.on(\"data\", (chunk) => { stdout += chunk; });\n    child.on(\"error\", () => { if (!settled) { settled = true; clearTimeout(timer); resolve(\"\"); } });\n    child.on(\"close\", (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve(code === 0 ? stdout.trim() : \"\"); } });\n  });\n}\n\nexport const PlaneAxiAmbientContextPlugin = async ({ directory }) => {\n  const sessions = new Map();\n  return {\n    \"experimental.chat.system.transform\": async (input, output) => {\n      const id = input.sessionID ?? \"__global__\";\n      if (!sessions.has(id)) sessions.set(id, await snapshot(directory));\n      const context = sessions.get(id);\n      if (context) output.system.push(\"## AXI ambient context: plane-axi\\n\" + context);\n    }\n  };\n};\n`;
}

async function installOpenCode(root, binary, scope) {
  const file = scope === "user"
    ? path.join(os.homedir(), ".config", "opencode", "plugins", "plane-axi.js")
    : path.join(root, ".opencode", "plugins", "plane-axi.js");
  const text = openCodePlugin(binary);
  const changed = !(await exists(file)) || await readFile(file, "utf8") !== text;
  if (changed) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return { app: "opencode", file: displayPath(file), changed };
}

async function copySkill(source, target) {
  const content = await readFile(source, "utf8");
  const file = path.join(target, "plane-axi", "SKILL.md");
  const changed = !(await exists(file)) || await readFile(file, "utf8") !== content;
  if (changed) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { file: displayPath(file), changed };
}

export async function setup({ flags, cwd, executable }) {
  const scope = flags.scope || "project";
  const requested = flags.app || "all";
  const apps = requested === "all" ? ["claude", "codex", "opencode"] : [requested];
  const root = scope === "user" ? os.homedir() : cwd;
  if (flags.skill) {
    const source = fileURLToPath(new URL("../../skill/SKILL.md", import.meta.url));
    const targets = [];
    if (apps.includes("claude")) targets.push(path.join(root, ".claude", "skills"));
    if (apps.includes("codex")) targets.push(scope === "user" ? path.join(root, ".codex", "skills") : path.join(root, ".agents", "skills"));
    if (apps.includes("opencode")) targets.push(scope === "user" ? path.join(root, ".config", "opencode", "skills") : path.join(root, ".opencode", "skills"));
    const installed = [];
    for (const target of targets) installed.push(await copySkill(source, target));
    return { result: installed.some((item) => item.changed) ? "skill installed" : "already installed (no-op)", skills: installed };
  }
  const command = await commandFor(executable);
  const openCodeBinary = command === "plane-axi snapshot" ? "plane-axi" : await realpath(executable).catch(() => path.resolve(executable));
  const integrations = [];
  for (const app of apps) {
    if (app === "claude") integrations.push(await installClaude(root, command));
    if (app === "codex") integrations.push(await installCodex(root, command));
    if (app === "opencode") integrations.push(await installOpenCode(root, openCodeBinary, scope));
  }
  return { result: integrations.some((item) => item.changed) ? "setup complete" : "already configured (no-op)", integrations };
}

export const _internals = { mergeSessionHook, commandFor, openCodePlugin, writeJsonIfChanged };
