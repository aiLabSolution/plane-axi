import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_METADATA } from "../src/cli.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "skill", "SKILL.md");

const command = (value) => value.replace(/^plane-axi\b/gm, "npx -y github:ailabsolution/plane-axi");
const groups = new Map();
for (const [name, meta] of Object.entries(COMMAND_METADATA)) {
  if (name === "snapshot") continue;
  const group = name.split(" ")[0];
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push({ name, ...meta });
}

const sections = [...groups].map(([group, entries]) => `### ${group}\n\n${entries.map((entry) => `- \`${command(entry.usage)}\` — ${entry.description}`).join("\n")}`).join("\n\n");
const content = `---
name: plane-axi
description: Manage Plane.so projects, work items, comments, cycles, modules, labels, states, and members from an agent-friendly CLI.
---

# Plane AXI

Use this skill when the user asks to inspect or change Plane.so project-management data. The CLI emits compact TOON on stdout, never prompts, and returns structured errors.

## Setup

Set \`PLANE_API_KEY\` and \`PLANE_WORKSPACE\` (or \`PLANE_WORKSPACE_SLUG\`). Run \`npx -y github:ailabsolution/plane-axi\` with no arguments for a live directory-scoped dashboard. Select a default project with \`npx -y github:ailabsolution/plane-axi use <project>\`, or pass \`--project <project>\`.

## Commands

${sections}

## Operating rules

- Prefer readable references such as \`LABS-42\`; UUIDs are also accepted.
- Run a command with \`--help\` for its complete flags and examples.
- Use \`--full\` only when a truncated work-item body needs expansion.
- Work-item deletion requires explicit \`--yes\`.
- Use \`npx -y github:ailabsolution/plane-axi api <METHOD> <path>\` only when the normal command surface does not cover the endpoint.
`;

if (process.argv.includes("--check")) {
  let existing = "";
  try { existing = await readFile(target, "utf8"); } catch {}
  if (existing !== content) {
    process.stdout.write("skill/SKILL.md is stale; run `node scripts/gen-skill.mjs`\n");
    process.exitCode = 1;
  }
} else {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  process.stdout.write("generated skill/SKILL.md\n");
}
