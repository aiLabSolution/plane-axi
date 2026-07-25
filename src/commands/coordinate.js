// Multi-agent coordination for work items: a TTL'd advisory-lock "claim ledger" plus a
// stage-ordered `next` picker. Ported from lis-control/scripts/slice.py so plane-axi can be
// the sole harness for concurrent agent sessions sharing one Plane PAT.
//
// Two layers (see the slice.py docstring it was ported from):
//   * coarse / cross-item : the work item's *assignee* is the "taken" flag. `next` hides
//     assigned items; `claim` assigns, `release` unassigns.
//   * fine / same-item    : an append-only ledger in the comments —
//     `<IDENT>-CLAIM|HEARTBEAT|RELEASE v1 agent=<id> task='<...>' until=<ISO>` — with a TTL,
//     so `status` reduces the comment tail to "who holds what, and is it still alive".
// The ledger tag is the *project identifier* (e.g. `LIS`), so the lines plane-axi writes carry
// the exact `<IDENT>-CLAIM v1 …` shape slice.py's reader expects and the two read each other's
// records during a migration. plane-axi additionally HTML-escapes the line for a valid comment
// body (slice.py posts it raw); the decoded text still round-trips through the same ledger regex.
//
// `claim` writes its ledger record first, then re-reads: if a rival's live claim carries an
// earlier timestamp we withdraw (first-writer-wins settles the claim/claim race). `release`
// keeps the coarse assignee flag while any other agent still holds a live claim on a shared
// item, so it doesn't resurface in another agent's `next` mid-work.
import os from "node:os";
import { findProjectConfig, selectedProject } from "../config.js";
import { AxiError, UsageError } from "../errors.js";
import { stripHtml, withHelp } from "../output.js";
import { resolveProject, resolveWorkItem, UUID } from "../resolve.js";
import { projectPath } from "./common.js";

const DEFAULT_READY_STATE = "ready-for-agent";
const DEFAULT_TTL_MINUTES = 90;
const CLAIM_TAIL = 40; // only the most recent ledger comments can still be authoritative
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const STAGE_RE = /^\s*\[S(\d+)(?:\.(\d+))?\]/; // "[S2.9] ..." title prefix -> (2, 9)

function agentId(flags) {
  return flags.agent
    || process.env.PLANE_AGENT_ID
    || process.env.LIS_AGENT_ID
    || process.env.CODEX_THREAD_ID
    || process.env.CODEX_SESSION_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || `${os.hostname()}:${process.pid}`;
}

function ttlMinutes(flags) {
  if (flags.ttl === undefined) return DEFAULT_TTL_MINUTES;
  const minutes = Number(flags.ttl);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 100_000) throw new UsageError("--ttl must be a positive integer (minutes)");
  return minutes;
}

function limitValue(flags) {
  if (flags.limit === undefined) return Infinity;
  const limit = Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a positive integer");
  return limit;
}

function stageOf(name) {
  const match = STAGE_RE.exec(name || "");
  return match ? [Number(match[1]), Number(match[2] || 0)] : null;
}

// "2026-07-24T14:30:00+00:00" — seconds precision, explicit +00:00, matching slice.py's
// _iso() so both harnesses emit identically-shaped `until=` stamps.
function isoUtc(date) {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

function parseMs(value) {
  if (!value) return NaN;
  // A bare (offset-less) stamp is UTC — matching slice.py's _ts/_read_claims, which force
  // tzinfo=UTC on naive stamps. Without this JS reads "…T14:30:00" as local time.
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  return Date.parse(normalized);
}

function tsMs(value) {
  const ms = parseMs(value);
  return Number.isNaN(ms) ? 0 : ms; // unparseable sorts first, mirroring slice.py's datetime.min
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ledgerRe(project) {
  return new RegExp(
    `${escapeRe(project.identifier)}-(CLAIM|HEARTBEAT|RELEASE)\\s+v1\\s+agent=(\\S+)`
    + `(?:\\s+task=(?:'([^']*)'|"([^"]*)"|(\\S+)))?`
    + `(?:\\s+until=(\\S+))?`,
    "g");
}

// Curly-quote both ASCII quote kinds so the single-quoted task always round-trips through
// ledgerRe (a raw apostrophe would close the quote early). Matches slice.py's _post_ledger.
function encodeTask(task) {
  return task.replace(/'/g, "’").replace(/"/g, "”");
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stateName(item, statesById) {
  const state = item.state;
  if (state && typeof state === "object") return state.name || "?";
  return statesById?.get(state)?.name || state || "?";
}

function itemUrl(api, project, id) {
  return `${projectPath(api, project, "/work-items/")}${id}/`;
}

async function statesFor(api, project) {
  return (await api.all(projectPath(api, project, "/states/"))).results;
}

async function selfId(api) {
  return (await api.get("/users/me/")).id;
}

async function itemContext({ api, flags, positionals, cwd }) {
  const hint = flags.project || (await findProjectConfig(cwd))?.project;
  return resolveWorkItem(api, positionals[0], hint);
}

async function resolveStateId(api, project, ref, states) {
  if (UUID.test(ref)) return ref;
  const lower = ref.toLowerCase();
  const match = states.find((state) => state.name?.toLowerCase() === lower);
  if (!match) throw new AxiError(`no state named ${ref}`, { help: `Run \`plane-axi state list --project ${project.identifier}\`` });
  return match.id;
}

async function postLedger(api, project, itemId, verb, agent, task, until) {
  let line = `${project.identifier}-${verb} v1 agent=${agent}`;
  if (task) line += ` task='${encodeTask(task)}'`;
  if (until) line += ` until=${isoUtc(until)}`;
  await api.post(`${itemUrl(api, project, itemId)}comments/`, { comment_html: `<p>${escapeHtml(line)}</p>` });
}

// Reduce the ledger comment tail to current, still-live ownership per agent.
async function readClaims(api, project, itemId) {
  const { results } = await api.all(`${itemUrl(api, project, itemId)}comments/`, { fields: "created_at,comment_stripped,comment_html" });
  const re = ledgerRe(project);
  // CLAIM_TAIL bounds LEDGER rows, not raw comments. Slicing the raw tail first let ordinary
  // discussion evict the records that prove ownership: with CLAIM_TAIL newer non-ledger
  // comments the reader saw no claims at all, so `status` reported "none", claim's CONTENDED
  // gate never fired, and the assignee PATCH stomped a live holder. The protocol truncates its
  // own history too — postLedger appends a comment per claim/heartbeat/release.
  // isLedger drops the /g/ flag: .test() on a global regex advances lastIndex between calls
  // and would skip every other row. `re` keeps /g/ because matchAll requires it.
  const isLedger = new RegExp(re.source);
  const rows = results
    .map((row) => ({ row, text: row.comment_stripped || stripHtml(row.comment_html || "") }))
    .filter(({ text }) => isLedger.test(text))
    .sort((a, b) => tsMs(a.row.created_at) - tsMs(b.row.created_at))
    .slice(-CLAIM_TAIL);
  const latest = {};
  for (const { row, text } of rows) {
    for (const match of text.matchAll(re)) {
      const [, verb, agent, single, double, bare, until] = match;
      latest[agent] = { verb, task: single || double || bare || "", until: until || null, at: row.created_at || "" };
    }
  }
  const now = Date.now();
  const live = {};
  for (const [agent, claim] of Object.entries(latest)) {
    if (claim.verb === "RELEASE") continue;
    const parsed = claim.until ? parseMs(claim.until) : NaN;
    const active = claim.until ? (Number.isNaN(parsed) ? true : parsed > now) : true;
    live[agent] = { ...claim, active };
  }
  return live;
}

export async function claim(ctx) {
  const { api, flags } = ctx;
  const { project, item } = await itemContext(ctx);
  const agent = agentId(flags);
  const ttl = ttlMinutes(flags);
  const readyState = flags["ready-state"] || DEFAULT_READY_STATE;
  const startState = flags["start-state"] || (flags.start ? "In Progress" : null);
  const seq = `${project.identifier}-${item.sequence_id}`;
  const states = await statesFor(api, project);
  const statesById = new Map(states.map((state) => [state.id, state]));
  const notes = [];
  const current = stateName(item, statesById);
  if (current !== readyState) notes.push(`state is '${current}', not '${readyState}' — claiming anyway`);

  // Cooperative lock: don't stomp another agent's live claim unless --force.
  const priorRivals = Object.entries(await readClaims(api, project, item.id)).filter(([a, c]) => a !== agent && c.active);
  if (priorRivals.length && !flags.force) {
    throw new AxiError(`CONTENDED: ${seq} already claimed by ${priorRivals.map(([a, c]) => `${a} (task=${c.task || "—"}, until ${c.until})`).join(", ")}`, {
      help: "Take a different sub-task, or pass --force to share the slice (then partition by sub-item)", exitCode: 3
    });
  }

  const until = new Date(Date.now() + ttl * 60_000);
  // Ledger first, assignee second: the append-only ledger is the tie-breaker for
  // near-simultaneous claims, and this order can't leave the item assigned with no
  // machine-readable owner if the second write dies.
  await postLedger(api, project, item.id, "CLAIM", agent, flags.task || "", until);
  const claims = await readClaims(api, project, item.id);
  const mine = claims[agent];
  const mineAt = mine ? tsMs(mine.at) : Infinity; // our record not surfaced yet -> treat every rival as earlier
  const rivals = Object.entries(claims).filter(([a, c]) => a !== agent && c.active && tsMs(c.at) < mineAt);
  if (rivals.length && !flags.force) {
    await postLedger(api, project, item.id, "RELEASE", agent);
    throw new AxiError(`LOST RACE: ${seq} was claimed concurrently by ${rivals.map(([a]) => a).join(", ")} — withdrew my claim`, {
      help: "Pick another slice", exitCode: 3
    });
  }

  const patch = { assignees: [await selfId(api)] };
  if (startState) patch.state = await resolveStateId(api, project, startState, states);
  await api.patch(itemUrl(api, project, item.id), patch);

  const shared = (rivals.length ? rivals : priorRivals).map(([a]) => a);
  if (shared.length) notes.push(`shared: also held by ${shared.join(", ")} — partition by sub-item`);
  const claimOut = { work_item: seq, agent, task: flags.task || "", until: isoUtc(until) };
  if (startState) claimOut.state = startState;
  const payload = { claim: claimOut, result: "claimed" };
  return withHelp(notes.length ? { ...payload, note: notes } : payload, [`Run \`plane-axi status ${seq}\` to verify`]);
}

export async function heartbeat(ctx) {
  const { api, flags } = ctx;
  const { project, item } = await itemContext(ctx);
  const agent = agentId(flags);
  const ttl = ttlMinutes(flags);
  const seq = `${project.identifier}-${item.sequence_id}`;
  const mine = (await readClaims(api, project, item.id))[agent];
  const verb = mine ? "HEARTBEAT" : "CLAIM"; // nothing live to extend -> this *is* a claim
  const until = new Date(Date.now() + ttl * 60_000);
  await postLedger(api, project, item.id, verb, agent, mine?.task || "", until);
  const payload = { [verb.toLowerCase()]: { work_item: seq, agent, until: isoUtc(until) }, result: verb.toLowerCase() };
  const notes = mine ? [] : [`no live claim by ${agent} — posted CLAIM instead`];
  return withHelp(notes.length ? { ...payload, note: notes } : payload, [`Run \`plane-axi status ${seq}\` to verify`]);
}

export async function release(ctx) {
  const { api, flags } = ctx;
  const { project, item } = await itemContext(ctx);
  const agent = agentId(flags);
  const seq = `${project.identifier}-${item.sequence_id}`;
  await postLedger(api, project, item.id, "RELEASE", agent);
  const others = Object.entries(await readClaims(api, project, item.id)).filter(([a, c]) => a !== agent && c.active);
  if (others.length) {
    // Shared item: keep the coarse "taken" flag so it doesn't resurface in `next` mid-work.
    return { release: { work_item: seq, agent }, result: "released", assignee: "kept", live_claims: others.map(([a]) => a) };
  }
  if (flags["keep-assignee"]) return { release: { work_item: seq, agent }, result: "released", assignee: "kept (by request)" };
  await api.patch(itemUrl(api, project, item.id), { assignees: [] });
  return { release: { work_item: seq, agent }, result: "released", assignee: "cleared" };
}

export async function claimStatus(ctx) {
  const { api } = ctx;
  const { project, item } = await itemContext(ctx);
  const seq = `${project.identifier}-${item.sequence_id}`;
  const states = await statesFor(api, project);
  const statesById = new Map(states.map((state) => [state.id, state]));
  // resolveWorkItem trims to id/sequence_id/name/state, so fetch the full item for assignees
  // (a cache hit already returned the full item — reuse it).
  const full = "assignees" in item ? item : await api.get(itemUrl(api, project, item.id));
  const claims = await readClaims(api, project, item.id);
  const rows = Object.entries(claims)
    .sort((a, b) => tsMs(a[1].at) - tsMs(b[1].at))
    .map(([agent, c]) => ({ agent, status: c.active ? "active" : "stale", task: c.task || "", until: c.until || "", verb: c.verb.toLowerCase(), at: c.at }));
  return {
    work_item: seq,
    title: full.name || item.name,
    state: stateName(full, statesById),
    assignee: (full.assignees || []).length ? "taken" : "free",
    claims: rows.length ? rows : "none"
  };
}

export async function nextSlice({ api, flags, cwd }) {
  const project = await resolveProject(api, await selectedProject(flags, cwd));
  const readyState = flags["ready-state"] || DEFAULT_READY_STATE;
  const { results } = await api.all(projectPath(api, project, "/work-items/"), { expand: "state", fields: "id,sequence_id,name,priority,state,assignees" });
  let ready = results.filter((item) => stateName(item) === readyState && (flags["include-claimed"] || !(item.assignees || []).length));
  if (flags.stage) {
    const want = Number(String(flags.stage).toUpperCase().replace(/^S/, ""));
    if (!Number.isInteger(want)) throw new UsageError(`invalid --stage ${flags.stage}`, "Use a stage like S2");
    ready = ready.filter((item) => { const st = stageOf(item.name); return st && st[0] === want; });
  }
  ready.sort((a, b) => {
    const sa = stageOf(a.name);
    const sb = stageOf(b.name);
    return (sa ? sa[0] : 98) - (sb ? sb[0] : 98)
      || (PRIORITY_RANK[a.priority] ?? 5) - (PRIORITY_RANK[b.priority] ?? 5)
      || (sa ? sa[1] : 0) - (sb ? sb[1] : 0)
      || (b.sequence_id ?? 0) - (a.sequence_id ?? 0);
  });
  // Count what MATCHED, not what survived --limit: deriving the count from the truncated
  // array reported "5 ready" on a 19-item backlog with no signal that anything was hidden.
  // Mirrors wi list's `N of M matching` + escape-hatch hint (see wi.js).
  const matching = ready.length;
  ready = ready.slice(0, limitValue(flags));
  if (!ready.length) return { next: `0 ${readyState} unclaimed slices${flags.stage ? ` in stage ${flags.stage}` : ""} in ${project.identifier}` };
  const slices = ready.map((item) => {
    const st = stageOf(item.name);
    return { seq: `${project.identifier}-${item.sequence_id}`, stage: st ? st[0] : "", priority: item.priority || "none", title: item.name, claimed: (item.assignees || []).length ? "taken" : "" };
  });
  const truncated = matching > slices.length;
  const hints = [`Claim one: plane-axi claim ${slices[0].seq} --task "..."`];
  if (truncated) hints.push(`Run \`plane-axi next\` without --limit for all ${matching} ready slices`);
  return withHelp({ count: truncated ? `${slices.length} of ${matching} ready` : `${slices.length} ready`, project: project.identifier, next: slices }, hints);
}

export const _internals = { agentId, stageOf, isoUtc, parseMs, ledgerRe, encodeTask, escapeHtml, readClaims, ttlMinutes };
