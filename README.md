# plane-axi

An agent-first CLI for [Plane.so](https://plane.so): compact TOON output, strict non-interactive commands, directory-scoped project context, structured errors, session hooks, and an installable Agent Skill.

## Why a direct API client

`plane-axi` talks directly to Plane's REST API using Node's built-in `fetch`. It does not wrap `plane-cli` and has no runtime dependencies. That keeps stdout fully deterministic, avoids stale client caches and interactive prompts, and makes hook execution fast. Node 18 or newer is required.

## Run it

```sh
npm install -g github:ailabsolution/plane-axi
export PLANE_API_KEY="<personal-access-token>"
export PLANE_WORKSPACE="<workspace-slug>"
plane-axi
```

Or run it without a global install:

```sh
npx -y github:ailabsolution/plane-axi
```

`PLANE_WORKSPACE_SLUG` is accepted as an alias. Self-hosted or alternate API hosts can set `PLANE_BASE_URL`; both `https://host` and `https://host/api/v1` forms work.

For local development:

```sh
npm link
plane-axi project list
plane-axi use LABS
plane-axi wi list
```

The nearest `.plane-axi.json` is discovered by walking up from the current directory. Any project-scoped command can override it with `--project <uuid|identifier|exact-name>`.

## Common commands

```sh
plane-axi project list
plane-axi project view LABS
plane-axi wi list --state started --priority high
plane-axi wi view LABS-42
plane-axi wi create --title "Fix authentication" --priority high
plane-axi wi update LABS-42 --state completed
plane-axi wi assign LABS-42 alice@example.com
plane-axi comment add LABS-42 --body "Fixed in staging"
plane-axi cycle list
plane-axi module list
plane-axi state list
plane-axi label list
plane-axi member list
```

References accept UUIDs, project identifiers or exact names, and readable work-item IDs such as `LABS-42`. Run any command with `--help` for its complete flags and examples. Unknown flags fail before any API call with exit code 2 and an inline list of valid flags.

## Agent integration

Install compact SessionStart context for Claude Code, Codex, and OpenCode:

```sh
plane-axi setup
plane-axi setup --app codex --scope user
```

Project scope is the default. Setup merges existing configuration, repairs a changed executable path, and repeated runs are no-ops. Codex hooks also require `[features].hooks = true` in `config.toml`.

Alternatively, install the generated on-demand skill (you may use either integration or both):

```sh
plane-axi setup --skill
npx skills add ailabsolution/plane-axi --skill plane-axi
```

[`skill/SKILL.md`](skill/SKILL.md) is generated from the CLI command metadata. CI can detect drift with `npm run skill:check`.

## Output and safety

All agent-consumed output—including errors—is TOON on stdout. stderr is reserved for diagnostics. Exit codes are `0` for success and no-ops, `1` for operational failures, and `2` for usage errors. Lists expose aggregate counts, empty states are explicit, and long work-item bodies are previewed with a `--full` escape hatch.

Mutations never prompt. Work-item deletion requires `--yes`, and closing an already completed item succeeds as an idempotent no-op. Plane's ignored list filters are applied client-side after fetching all pages.

The raw escape hatch is available when the normal command surface does not cover an endpoint:

```sh
plane-axi api GET /users/me/
plane-axi api PATCH /workspaces/<slug>/projects/<id>/work-items/<id>/ --input '{"priority":"high"}'
```

Workspace search uses Plane's search endpoint when available and transparently falls back to paginated client-side search on Plane versions where that endpoint is unavailable.

## Development

```sh
npm test
npm run skill:generate
npm run skill:check
```

The implementation is ESM and has zero runtime dependencies.
