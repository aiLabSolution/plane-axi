# plane-axi

[![CI](https://github.com/aiLabSolution/plane-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/aiLabSolution/plane-axi/actions/workflows/ci.yml)
[![CodeQL](https://github.com/aiLabSolution/plane-axi/actions/workflows/codeql.yml/badge.svg)](https://github.com/aiLabSolution/plane-axi/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/aiLabSolution/plane-axi?sort=semver)](https://github.com/aiLabSolution/plane-axi/releases/latest)

An agent-first CLI for [Plane.so](https://plane.so): compact TOON output, strict non-interactive commands, directory-scoped project context, structured errors, session hooks, and an installable Agent Skill.

## Why a direct API client

`plane-axi` talks directly to Plane's REST API using Node's built-in `fetch`. It does not wrap `plane-cli` and has no runtime dependencies. That keeps stdout fully deterministic, avoids stale client caches and interactive prompts, and makes hook execution fast. Node 18 or newer is required.

## Run it

`plane-axi` is distributed from GitHub, not the npm registry:

```sh
npm install -g github:aiLabSolution/plane-axi
export PLANE_API_KEY="<personal-access-token>"
export PLANE_WORKSPACE="<workspace-slug>"
plane-axi
```

Or run it without a global install:

```sh
npx -y github:aiLabSolution/plane-axi
```

Check which build is actually on your PATH — `bin` is what distinguishes a stale global
install from a fresh one when both report the same version:

```sh
plane-axi version
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

## Multi-agent coordination

When several agent sessions share one Plane token, `claim` puts a TTL'd advisory lock on a work item so they don't collide, and `next` picks the earliest startable item.

```sh
plane-axi next                                   # ready-for-agent ∧ unassigned, stage-ordered
plane-axi next --stage S2 --limit 5
plane-axi claim LABS-42 --task "auth thread"     # assign self + post a TTL'd claim record
plane-axi claim LABS-42 --task "..." --start     # …and transition to "In Progress"
plane-axi status LABS-42                          # who holds the item, and is the claim still live
plane-axi heartbeat LABS-42                        # extend my claim's TTL before it lapses
plane-axi release LABS-42                          # drop my claim (unassign if no other live claim)
```

Two layers back this. The coarse flag is the item's **assignee** — `next` hides assigned items, `claim` assigns, `release` unassigns. The fine record is an append-only **ledger** in the comments (`<IDENTIFIER>-CLAIM|HEARTBEAT|RELEASE v1 agent=<id> task='<...>' until=<ISO>`) that carries a TTL, so `status` reduces the comment tail to current ownership without eyeballing timestamps. `claim` writes its ledger record first, then re-reads: if a rival's live claim carries an earlier timestamp it withdraws (first-writer-wins settles a claim/claim race) and exits `3`; `--force` claims a shared item anyway (then partition by sub-item). A claim past its `until` is ignored, so an abandoned lock is automatically reclaimable.

`next`/`claim` default to the `ready-for-agent` state (override with `--ready-state`) and read an optional `[S<n>.<m>]` stage prefix from the title for ordering; items without one sort last. Agent identity comes from `--agent`, else `$PLANE_AGENT_ID`/session-id env, else `host:pid`. TTL defaults to 90 minutes (`--ttl`).

## Markdown bodies

`wi create`, `wi update`, and `comment add` render their body through a small, dependency-free markdown-to-HTML pass before sending it as `description_html` / `comment_html`. Coverage matches a PRD/slice-note template: ATX headings, `-`/`*`/`+` and `1.` lists with one level of nesting, `[ ]`/`[x]` task items, fenced ` ``` ` code blocks, blockquotes, `---` rules, blank-line paragraphs, and inline `**bold**`, `` `code` ``, and `[text](url)` links (`http(s)`/`mailto`, plus root-relative `/…`, anchor `#…`, and dot-relative `./…`/`../…` targets only — everything else, including bare path-relative links like `docs/guide.md`, `javascript:`, and protocol-relative `//host` links, renders as literal text). One caveat within a nesting level: mixing marker types among a parent's nested children (a `-` child then a `1.` child under the same item) renders them all as one list of the last child's type. Plain text with no markdown still renders to a single `<p>` exactly as before.

Every body-accepting flag has a `--body-file <path>` counterpart; pass `-` to read from stdin:

```sh
plane-axi wi create --title "Ship auth fix" --body-file slice.md
printf '%s' "$BODY" | plane-axi wi update LABS-42 --body-file -
plane-axi comment add LABS-42 --body-file progress.md
```

Preview the exact HTML a body would produce — no network call, no credentials required:

```sh
plane-axi render --body-file slice.md
plane-axi render --body "Some **bold** text"
cat slice.md | plane-axi render --body-file -
```

`--body`/`--body-file` are mutually exclusive on `wi create`/`wi update` (both optional; pass neither to leave the body alone). `wi update --body ""` explicitly clears the description; an empty rendered `comment add` body is a usage error.

## Reference cache

Resolving a readable reference like `LABS-42` normally means a full project/work-item scan. `plane-axi` keeps a small lookaside cache at `$XDG_CACHE_HOME/plane-axi/refs.json` (default `~/.cache/plane-axi/refs.json`) mapping identifiers and sequence numbers to their UUIDs, so a repeat reference resolves with one direct `GET` instead of a rescan. Sequence assignments are immutable, so entries never expire; a stale entry (renamed or deleted target) 404s and self-heals with one fresh scan. A broken or corrupt cache file is treated as empty — it is never a fatal error. Set `PLANE_AXI_NO_CACHE=1` to bypass it entirely (useful for benchmarking or a read-only filesystem).

List and search scans also request only the fields each command needs (`?fields=`/`?expand=`), which Plane honors even though it ignores filter params — this keeps repeated scans well under the per-token rate budget.

## Cloudflare / WAF

Some Cloudflare-fronted Plane instances filter unrecognized `User-Agent` headers. `plane-axi` sends `plane-axi/<version>` by default; set `PLANE_USER_AGENT` to override it (a known-safe value in the field is `plane-cli/1.0`) if your instance blocks the default. If a request is blocked by the WAF before it reaches Plane, the response is an HTML challenge page rather than Plane's JSON, and `plane-axi` reports it distinctly as `Cloudflare WAF blocked the request` rather than a misleading authentication failure. This is most often triggered by a work-item body containing path-traversal-looking strings (`../`) or literal shell command lines — rephrase the body and retry. A `GET` that fails to connect at the network level (not a WAF block) is retried once after a one-second pause before failing; mutating requests (`POST`/`PATCH`/`DELETE`) are never retried, since a replay could double-write.

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

## Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please).
Nothing is released by hand — version numbers, `CHANGELOG.md`, tags, and GitHub Releases all
come from the commit history.

1. Land work on `main` using [Conventional Commits](https://www.conventionalcommits.org).
   `fix:` bumps the patch, `feat:` bumps the minor, and other types (`chore:`, `docs:`,
   `ci:`, `refactor:`) do not trigger a release on their own.
2. `.github/workflows/release.yml` opens or updates a **release PR** that bumps
   `package.json` and writes the changelog entry. It accumulates until you merge it.
3. Merging that PR tags the commit, publishes the GitHub Release, and attaches the
   `npm pack` tarball. Before the release stands, the workflow re-runs the tests and
   asserts the tag, `package.json`, and `plane-axi version` all report the same version.

To force a specific version, run the **Release** workflow manually with a `release-as`
input, or add a `Release-As: <version>` footer to a commit on `main`.

Because this project is pre-1.0, `bump-minor-pre-major` is set: a breaking change bumps the
minor rather than going to 1.0.0.

### One-time setup for unattended releases

`main` requires the `test` check, and GitHub does not start workflows for events authored by
`GITHUB_TOKEN` — so by default CI never runs on the release PR and it cannot merge on its
own. To close that gap, add a repository secret named `RELEASE_PLEASE_TOKEN` holding a
fine-grained PAT (or GitHub App token) with **contents: write** and **pull requests: write**.
Without it everything still works, but a maintainer has to merge the release PR manually.
