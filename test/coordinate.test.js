import test from "node:test";
import assert from "node:assert/strict";
import { claim, heartbeat, release, claimStatus, nextSlice, _internals } from "../src/commands/coordinate.js";

const PROJECT = { id: "p1", identifier: "LABS", name: "Labs" };
const STATES = [
  { id: "st-ready", name: "ready-for-agent", group: "unstarted" },
  { id: "st-prog", name: "In Progress", group: "started" },
  { id: "st-done", name: "Done", group: "completed" }
];
const FUTURE = "2999-01-01T00:00:00+00:00";
const PAST = "2000-01-01T00:00:00+00:00";

function ledger(agent, verb, until, task, at) {
  let line = `LABS-${verb} v1 agent=${agent}`;
  if (task) line += ` task='${task}'`;
  if (until) line += ` until=${until}`;
  return { created_at: at, comment_stripped: line };
}

// Fake PlaneApi. No `config` -> resolve.js bypasses the ref cache (same trick the other
// command tests use). Non-expand work-item scans are trimmed to id/sequence_id/name/state
// exactly like the real API, so status must fall back to a full GET for assignees.
function makeApi({ items, comments = [], commentSnapshots = null, me = "me-id" } = {}) {
  const record = { posts: [], patches: [] };
  const wiBase = `/projects/${PROJECT.id}/work-items/`;
  const byId = new Map(STATES.map((s) => [s.id, s]));
  let snapshotIndex = 0;
  const api = {
    workspacePath: (p = "") => p,
    get: async (path) => {
      if (path === "/users/me/") return { id: me };
      const m = path.match(new RegExp(`^${wiBase}([^/]+)/$`));
      if (m) return items.find((i) => i.id === m[1]);
      throw new Error(`unexpected get ${path}`);
    },
    all: async (path, query) => {
      if (path === "/projects/") return { results: [PROJECT], total: 1 };
      if (path === `${wiBase.replace("/work-items/", "")}/states/`) return { results: STATES, total: STATES.length };
      if (path === wiBase) {
        const rows = query?.expand === "state"
          ? items.map((i) => ({ ...i, state: byId.get(i.state) || i.state }))
          : items.map((i) => ({ id: i.id, sequence_id: i.sequence_id, name: i.name, state: i.state }));
        return { results: rows, total: rows.length };
      }
      if (/\/comments\/$/.test(path)) {
        if (commentSnapshots) { const snap = commentSnapshots[Math.min(snapshotIndex, commentSnapshots.length - 1)]; snapshotIndex += 1; return { results: snap, total: snap.length }; }
        return { results: comments, total: comments.length };
      }
      throw new Error(`unexpected all ${path}`);
    },
    post: async (path, data) => { record.posts.push({ path, data }); return { id: `c-${record.posts.length}` }; },
    patch: async (path, data) => { record.patches.push({ path, data }); return items[0]; }
  };
  return { api, record };
}

function itemFix(overrides = {}) {
  return { id: "i42", sequence_id: 42, name: "[S2.9] ASTM channel", priority: "high", state: "st-ready", assignees: [], ...overrides };
}

test("claim writes a project-tagged ledger line and assigns self", async () => {
  const { api, record } = makeApi({ items: [itemFix()] });
  const out = await claim({ api, flags: { task: "auth thread" }, positionals: ["LABS-42"], cwd: "/tmp" });
  const comment = record.posts.at(-1).data.comment_html;
  assert.match(comment, /^<p>LABS-CLAIM v1 agent=\S+ task='auth thread' until=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00<\/p>$/);
  assert.deepEqual(record.patches.at(-1).data.assignees, ["me-id"]);
  assert.equal(out.result, "claimed");
});

test("claim --start transitions to In Progress", async () => {
  const { api, record } = makeApi({ items: [itemFix()] });
  await claim({ api, flags: { task: "x", start: true }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(record.patches.at(-1).data.state, "st-prog");
});

test("claim is CONTENDED (exit 3) when another agent holds a live claim", async () => {
  const { api } = makeApi({ items: [itemFix()], comments: [ledger("rival", "CLAIM", FUTURE, "theirs", "2026-07-24T10:00:00+00:00")] });
  await assert.rejects(
    () => claim({ api, flags: { task: "mine" }, positionals: ["LABS-42"], cwd: "/tmp" }),
    (e) => e.name === "AxiError" && e.exitCode === 3 && /CONTENDED/.test(e.message)
  );
});

test("claim --force overrides a live rival and notes the shared item", async () => {
  const { api, record } = makeApi({ items: [itemFix()], comments: [ledger("rival", "CLAIM", FUTURE, "theirs", "2026-07-24T10:00:00+00:00")] });
  const out = await claim({ api, flags: { task: "mine", force: true }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(out.result, "claimed");
  assert.ok(out.note.some((n) => /shared: also held by rival/.test(n)));
  assert.deepEqual(record.patches.at(-1).data.assignees, ["me-id"]);
});

test("claim loses the race when a rival's earlier claim surfaces on re-read, and withdraws", async () => {
  // 1st read (prior check): empty. 2nd read (post-claim): a rival with an earlier timestamp
  // plus my own claim. mine is later -> withdraw.
  const rival = ledger("rival", "CLAIM", FUTURE, "theirs", "2026-07-24T10:00:00+00:00");
  const mine = ledger("me-id", "CLAIM", FUTURE, "mine", "2026-07-24T10:00:05+00:00");
  const { api, record } = makeApi({ items: [itemFix()], commentSnapshots: [[], [rival, mine]] });
  await assert.rejects(
    () => claim({ api, flags: { task: "mine", agent: "me-id" }, positionals: ["LABS-42"], cwd: "/tmp" }),
    (e) => e.name === "AxiError" && e.exitCode === 3 && /LOST RACE/.test(e.message)
  );
  assert.equal(record.patches.length, 0, "must not assign after losing the race");
  assert.match(record.posts.at(-1).data.comment_html, /LABS-RELEASE v1 agent=me-id/);
});

test("an expired rival claim (past until) does not block a new claim", async () => {
  const { api, record } = makeApi({ items: [itemFix()], comments: [ledger("rival", "CLAIM", PAST, "stale", "2020-01-01T00:00:00+00:00")] });
  const out = await claim({ api, flags: { task: "mine" }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(out.result, "claimed");
  assert.deepEqual(record.patches.at(-1).data.assignees, ["me-id"]);
});

test("claim on a non-ready item warns but proceeds", async () => {
  const { api } = makeApi({ items: [itemFix({ state: "st-prog" })] });
  const out = await claim({ api, flags: { task: "x" }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(out.result, "claimed");
  assert.ok(out.note.some((n) => /state is 'In Progress', not 'ready-for-agent'/.test(n)));
});

test("heartbeat extends a live claim as HEARTBEAT, else posts CLAIM", async () => {
  const withClaim = makeApi({ items: [itemFix()], comments: [ledger("me-id", "CLAIM", FUTURE, "t", "2026-07-24T10:00:00+00:00")] });
  const hb = await heartbeat({ api: withClaim.api, flags: { agent: "me-id" }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(hb.result, "heartbeat");
  assert.match(withClaim.record.posts.at(-1).data.comment_html, /LABS-HEARTBEAT v1 agent=me-id/);

  const noClaim = makeApi({ items: [itemFix()] });
  const cl = await heartbeat({ api: noClaim.api, flags: { agent: "me-id" }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(cl.result, "claim");
  assert.ok(cl.note.some((n) => /no live claim/.test(n)));
});

test("release clears the assignee when no other live claim remains", async () => {
  const { api, record } = makeApi({ items: [itemFix()] });
  const out = await release({ api, flags: { agent: "me-id" }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(out.assignee, "cleared");
  assert.deepEqual(record.patches.at(-1).data.assignees, []);
});

test("release keeps the assignee while another agent still holds a live claim", async () => {
  const { api, record } = makeApi({ items: [itemFix()], comments: [ledger("other", "CLAIM", FUTURE, "theirs", "2026-07-24T10:00:00+00:00")] });
  const out = await release({ api, flags: { agent: "me-id" }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(out.assignee, "kept");
  assert.deepEqual(out.live_claims, ["other"]);
  assert.equal(record.patches.length, 0);
});

test("status reports the assignee flag and per-agent claim liveness", async () => {
  const { api } = makeApi({
    items: [itemFix({ assignees: ["me-id"] })],
    comments: [ledger("me-id", "CLAIM", FUTURE, "live one", "2026-07-24T10:00:00+00:00"), ledger("gone", "CLAIM", PAST, "expired", "2026-07-24T09:00:00+00:00")]
  });
  const out = await claimStatus({ api, flags: {}, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(out.assignee, "taken");
  assert.equal(out.state, "ready-for-agent");
  const live = out.claims.find((c) => c.agent === "me-id");
  const stale = out.claims.find((c) => c.agent === "gone");
  assert.equal(live.status, "active");
  assert.equal(live.task, "live one");
  assert.equal(stale.status, "stale");
});

test("next lists ready ∧ unclaimed items, stage-ordered, honoring --stage and --limit", async () => {
  const items = [
    itemFix({ id: "a", sequence_id: 10, name: "[S1.2] first", state: "st-ready", priority: "low" }),
    itemFix({ id: "b", sequence_id: 11, name: "[S2.1] second", state: "st-ready", priority: "urgent" }),
    itemFix({ id: "c", sequence_id: 12, name: "[S2.3] third", state: "st-ready", priority: "high" }),
    itemFix({ id: "d", sequence_id: 13, name: "[S2.4] taken", state: "st-ready", assignees: ["me-id"] }),
    itemFix({ id: "e", sequence_id: 14, name: "[S2.5] not ready", state: "st-prog" })
  ];
  const { api } = makeApi({ items });
  const all = await nextSlice({ api, flags: { project: "LABS" }, positionals: [], cwd: "/tmp" });
  assert.deepEqual(all.next.map((s) => s.seq), ["LABS-10", "LABS-11", "LABS-12"], "stage 1 before stage 2; within stage by priority");
  const s2 = await nextSlice({ api, flags: { project: "LABS", stage: "S2", limit: "1" }, positionals: [], cwd: "/tmp" });
  assert.deepEqual(s2.next.map((s) => s.seq), ["LABS-11"]);
  const withClaimed = await nextSlice({ api, flags: { project: "LABS", "include-claimed": true, stage: "S2" }, positionals: [], cwd: "/tmp" });
  assert.ok(withClaimed.next.some((s) => s.seq === "LABS-13" && s.claimed === "taken"));
});

test("ledger task quotes are curly-quoted so the single-quoted form round-trips", async () => {
  const encoded = _internals.encodeTask(`fix "foo" don't`);
  assert.equal(encoded, "fix ”foo” don’t");
  const { api } = makeApi({ items: [itemFix()], comments: [ledger("me-id", "CLAIM", FUTURE, encoded, "2026-07-24T10:00:00+00:00")] });
  const out = await claimStatus({ api, flags: {}, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(out.claims.find((c) => c.agent === "me-id").task, "fix ”foo” don’t");
});

test("isoUtc emits seconds precision with an explicit +00:00 offset", () => {
  assert.equal(_internals.isoUtc(new Date("2026-07-24T14:30:00.123Z")), "2026-07-24T14:30:00+00:00");
});

test("release --keep-assignee drops the claim but stays assigned", async () => {
  const { api, record } = makeApi({ items: [itemFix()] });
  const out = await release({ api, flags: { agent: "me-id", "keep-assignee": true }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(out.assignee, "kept (by request)");
  assert.equal(record.patches.length, 0, "must not touch assignees when keeping them");
});

test("claim --force proceeds even when a rival's earlier claim surfaces post-write", async () => {
  const rival = ledger("rival", "CLAIM", FUTURE, "theirs", "2026-07-24T10:00:00+00:00");
  const mine = ledger("me-id", "CLAIM", FUTURE, "mine", "2026-07-24T10:00:05+00:00");
  const { api, record } = makeApi({ items: [itemFix()], commentSnapshots: [[], [rival, mine]] });
  const out = await claim({ api, flags: { task: "mine", agent: "me-id", force: true }, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal(out.result, "claimed");
  assert.deepEqual(record.patches.at(-1).data.assignees, ["me-id"], "assigns rather than withdrawing under --force");
  assert.ok(!record.posts.some((p) => /LABS-RELEASE/.test(p.data.comment_html)), "must not withdraw under --force");
});

test("claim backs off when its own record has not surfaced on re-read (mineAt=Infinity)", async () => {
  // Post-write snapshot has a live rival but NOT my own claim yet -> mineAt=Infinity -> withdraw.
  const rival = ledger("rival", "CLAIM", FUTURE, "theirs", "2026-07-24T10:00:09+00:00");
  const { api, record } = makeApi({ items: [itemFix()], commentSnapshots: [[], [rival]] });
  await assert.rejects(
    () => claim({ api, flags: { task: "mine", agent: "me-id" }, positionals: ["LABS-42"], cwd: "/tmp" }),
    (e) => e.exitCode === 3 && /LOST RACE/.test(e.message)
  );
  assert.equal(record.patches.length, 0);
});

test("next sorts unstaged items after every staged one", async () => {
  const items = [
    itemFix({ id: "u", sequence_id: 20, name: "no stage prefix", state: "st-ready", priority: "urgent" }),
    itemFix({ id: "s", sequence_id: 21, name: "[S3.1] staged low", state: "st-ready", priority: "low" })
  ];
  const { api } = makeApi({ items });
  const out = await nextSlice({ api, flags: { project: "LABS" }, positionals: [], cwd: "/tmp" });
  assert.deepEqual(out.next.map((s) => s.seq), ["LABS-21", "LABS-20"], "staged (rank 3) beats unstaged (rank 98) despite lower priority");
  assert.equal(out.next[1].stage, "");
});

// Regression: CLAIM_TAIL used to slice the RAW comment tail before the ledger filter, so
// ordinary discussion evicted the records proving ownership. The boundary was exact — 39
// newer non-ledger comments kept the holder visible, 40 made it vanish.
function chatter(count, from = 0) {
  return Array.from({ length: count }, (_, i) => ({
    created_at: `2026-07-24T12:${String(from + i).padStart(2, "0")}:00+00:00`,
    comment_stripped: `ordinary discussion ${from + i}`
  }));
}

test("a live claim stays visible under more than CLAIM_TAIL newer non-ledger comments", async () => {
  const held = ledger("holder", "CLAIM", FUTURE, "real work", "2026-07-24T10:00:00+00:00");
  for (const noise of [0, 39, 40, 45, 120]) {
    const { api } = makeApi({ items: [itemFix()], comments: [held, ...chatter(noise)] });
    const out = await claimStatus({ api, flags: {}, positionals: ["LABS-42"], cwd: "/tmp" });
    assert.notEqual(out.claims, "none", `holder vanished under ${noise} non-ledger comments`);
    assert.equal(out.claims.find((c) => c.agent === "holder")?.status, "active", `holder not active under ${noise} non-ledger comments`);
  }
});

test("claim is still CONTENDED when chatter buries the rival's ledger line", async () => {
  const rival = ledger("rival", "CLAIM", FUTURE, "theirs", "2026-07-24T10:00:00+00:00");
  const { api, record } = makeApi({ items: [itemFix()], comments: [rival, ...chatter(60)] });
  await assert.rejects(
    () => claim({ api, flags: { task: "mine", agent: "me-id" }, positionals: ["LABS-42"], cwd: "/tmp" }),
    (e) => e.exitCode === 3 && /CONTENDED/.test(e.message)
  );
  assert.equal(record.patches.length, 0, "must not stomp the buried holder's assignee");
});

test("readClaims keeps the newest CLAIM_TAIL ledger rows when ledger rows exceed the cap", async () => {
  // 45 agents, each with one CLAIM: only the newest 40 stay authoritative.
  const rows = Array.from({ length: 45 }, (_, i) =>
    ledger(`agent${String(i).padStart(2, "0")}`, "CLAIM", FUTURE, "t", `2026-07-24T13:${String(i).padStart(2, "0")}:00+00:00`));
  const { api } = makeApi({ items: [itemFix()], comments: rows });
  const live = await _internals.readClaims(api, PROJECT, "i42");
  assert.equal(Object.keys(live).length, 40, "authority window is still bounded at CLAIM_TAIL");
  assert.ok(live.agent44, "newest ledger row survives");
  assert.ok(!live.agent04, "oldest ledger row beyond the cap is dropped");
});

test("next reports the matching total, not the truncated count, and hints the escape hatch", async () => {
  const items = Array.from({ length: 19 }, (_, i) =>
    itemFix({ id: `n${i}`, sequence_id: 100 + i, name: `[S2.${i}] slice ${i}`, state: "st-ready", assignees: [] }));
  const { api } = makeApi({ items });
  const capped = await nextSlice({ api, flags: { project: "LABS", limit: "5" }, positionals: [], cwd: "/tmp" });
  assert.equal(capped.next.length, 5);
  assert.equal(capped.count, "5 of 19 ready", "count must not be derived from the truncated array");
  assert.ok(capped.help.some((h) => /all 19 ready slices/.test(h)), "truncation needs an escape-hatch hint");
  assert.ok(capped.help.some((h) => /^Claim one:/.test(h)), "the actionable claim hint survives truncation");
  const full = await nextSlice({ api, flags: { project: "LABS" }, positionals: [], cwd: "/tmp" });
  assert.equal(full.count, "19 ready", "untruncated output keeps the bare count");
  assert.equal(full.help.length, 1, "no escape-hatch hint when nothing is hidden");
});

test("parseMs treats an offset-less until stamp as UTC, not local time", () => {
  assert.equal(_internals.parseMs("2026-07-24T14:30:00"), Date.parse("2026-07-24T14:30:00Z"));
  assert.equal(_internals.parseMs("2026-07-24T14:30:00+02:00"), Date.parse("2026-07-24T14:30:00+02:00"));
});
