---
name: plane-axi
description: Manage Plane.so projects, work items, comments, cycles, modules, labels, states, and members from an agent-friendly CLI.
---

# Plane AXI

Use this skill when the user asks to inspect or change Plane.so project-management data. The CLI emits compact TOON on stdout, never prompts, and returns structured errors.

## Setup

Set `PLANE_API_KEY` and `PLANE_WORKSPACE` (or `PLANE_WORKSPACE_SLUG`). Run `npx -y github:aiLabSolution/plane-axi` with no arguments for a live directory-scoped dashboard. Select a default project with `npx -y github:aiLabSolution/plane-axi use <project>`, or pass `--project <project>`.

## Commands

### project

- `npx -y github:aiLabSolution/plane-axi project list` — List workspace projects
- `npx -y github:aiLabSolution/plane-axi project view <ref>` — Show a project
- `npx -y github:aiLabSolution/plane-axi project create --name <name> --identifier <id>` — Create a project

### use

- `npx -y github:aiLabSolution/plane-axi use <project>` — Select the directory-scoped default project

### me

- `npx -y github:aiLabSolution/plane-axi me` — Show the authenticated Plane user

### wi

- `npx -y github:aiLabSolution/plane-axi wi list [flags]` — List work items
- `npx -y github:aiLabSolution/plane-axi wi view <ref> [--full]` — Show a work item
- `npx -y github:aiLabSolution/plane-axi wi create --title <title> [flags]` — Create a work item
- `npx -y github:aiLabSolution/plane-axi wi update <ref> [flags]` — Update a work item
- `npx -y github:aiLabSolution/plane-axi wi assign <ref> <member>...` — Replace work item assignees
- `npx -y github:aiLabSolution/plane-axi wi close <ref>` — Move a work item to the first completed state
- `npx -y github:aiLabSolution/plane-axi wi delete <ref> --yes` — Delete a work item
- `npx -y github:aiLabSolution/plane-axi wi search <query> [--limit <n>|--all]` — Search work items across the workspace

### comment

- `npx -y github:aiLabSolution/plane-axi comment list <wi-ref> [--all]` — List comments or all activity
- `npx -y github:aiLabSolution/plane-axi comment add <wi-ref> (--body <text>|--body-file <path|->)` — Add a comment

### cycle

- `npx -y github:aiLabSolution/plane-axi cycle list [--project <ref>]` — List project cycles
- `npx -y github:aiLabSolution/plane-axi cycle view <ref>` — Show a cycle
- `npx -y github:aiLabSolution/plane-axi cycle create --name <name> [flags]` — Create a cycle

### module

- `npx -y github:aiLabSolution/plane-axi module list [--project <ref>]` — List project modules
- `npx -y github:aiLabSolution/plane-axi module view <ref>` — Show a module
- `npx -y github:aiLabSolution/plane-axi module create --name <name> [flags]` — Create a module

### state

- `npx -y github:aiLabSolution/plane-axi state list [--project <ref>]` — List project workflow states

### label

- `npx -y github:aiLabSolution/plane-axi label list [--project <ref>]` — List project labels

### member

- `npx -y github:aiLabSolution/plane-axi member list` — List workspace members

### render

- `npx -y github:aiLabSolution/plane-axi render (--body <text>|--body-file <path|->)` — Render a markdown body to HTML (no network)

### next

- `npx -y github:aiLabSolution/plane-axi next [--stage <s>] [--ready-state <name>]` — List ready ∧ unclaimed work items, stage-ordered

### claim

- `npx -y github:aiLabSolution/plane-axi claim <ref> [--task <t>] [--ttl <min>] [--start]` — Claim a work item (TTL'd advisory lock) and flag it taken

### status

- `npx -y github:aiLabSolution/plane-axi status <ref>` — Show claim ownership of a work item

### heartbeat

- `npx -y github:aiLabSolution/plane-axi heartbeat <ref> [--ttl <min>]` — Extend your claim's TTL (task carries over)

### release

- `npx -y github:aiLabSolution/plane-axi release <ref>` — Release your claim (unassign if no other live claim remains)

### api

- `npx -y github:aiLabSolution/plane-axi api <METHOD> <path> [--input <json>]` — Call a Plane API path directly

### setup

- `npx -y github:aiLabSolution/plane-axi setup [--app <app>] [--scope <scope>] [--skill]` — Install session hooks or the generated skill

### version

- `npx -y github:aiLabSolution/plane-axi version` — Show the running version, executable path, and Node.js runtime

## Operating rules

- Prefer readable references such as `LABS-42`; UUIDs are also accepted.
- Run a command with `--help` for its complete flags and examples.
- Use `--full` only when a truncated work-item body needs expansion.
- Work-item deletion requires explicit `--yes`.
- Use `npx -y github:aiLabSolution/plane-axi api <METHOD> <path>` only when the normal command surface does not cover the endpoint.
