import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/plane-axi.js", import.meta.url));
const project = { id: "11111111-1111-4111-8111-111111111111", identifier: "TEST", name: "Test" };
const item = { id: "22222222-2222-4222-8222-222222222222", sequence_id: 1, name: "Claim fixture", state: "ready-for-agent", assignees: [] };

// Exercise the installed command shape in separate processes, through the real HTTP client.
// Credentials are synthetic and the server binds only loopback; no live Plane is contacted.
async function fixture(t) {
  const comments = [];
  const writes = [];
  const cwd = await mkdtemp(path.join(os.tmpdir(), "plane-axi-ownership-"));
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET") writes.push({ method: req.method, pathname, body });
    let out;
    if (pathname.endsWith("/comments/") && req.method === "POST") {
      out = { ...JSON.parse(body), created_at: new Date(Date.now() + comments.length).toISOString() };
      comments.push(out);
    } else if (pathname.endsWith("/comments/")) out = comments;
    else if (pathname.endsWith("/projects/")) out = [project];
    else if (pathname.endsWith(`/projects/${project.id}/`)) out = project;
    else if (pathname.endsWith("/states/")) out = [{ id: "ready-for-agent", name: "ready-for-agent" }];
    else if (pathname.endsWith("/work-items/")) out = [item];
    else if (pathname.endsWith(`/work-items/${item.id}/`)) out = item;
    else if (pathname.endsWith("/users/me/")) out = { id: "test-user" };
    else { res.statusCode = 404; out = { detail: pathname }; }
    res.end(JSON.stringify(out));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(cwd, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH, PLANE_API_KEY: "synthetic-test-key", PLANE_WORKSPACE: "test", PLANE_BASE_URL: `http://127.0.0.1:${server.address().port}`, PLANE_AXI_NO_CACHE: "1" };
  async function run(verb, agent, more = []) {
    const args = [cli, verb, "TEST-1", "--project", "TEST", ...(agent ? ["--agent", agent] : []), ...more];
    try { const out = await execute(process.execPath, args, { cwd, env, timeout: 10000 }); return { code: 0, ...out }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  }
  return { comments, writes, run };
}

test("separate CLI processes cannot acquire ownership through heartbeat or clear a foreign lease", async t => {
  const { run, writes } = await fixture(t);
  assert.equal((await run("claim", "owner", ["--task", "test", "--ttl", "360"])).code, 0);
  const before = writes.length;
  assert.equal((await run("claim", "rival")).code, 3);
  const heartbeat = await run("heartbeat", "rival");
  assert.equal(heartbeat.code, 3, heartbeat.stdout);
  assert.match(heartbeat.stdout, /CONTENDED/);
  const release = await run("release", "rival");
  assert.equal(release.code, 0);
  assert.match(release.stdout, /not-owned/);
  assert.equal(writes.length, before, "foreign renewal/release must not mutate the tracker");
  assert.equal((await run("heartbeat", "owner")).code, 0);
  assert.match((await run("release", "owner")).stdout, /result: released/);
  assert.equal((await run("heartbeat", "owner")).code, 3, "a release cannot be undone by heartbeat");
});

test("CLI mutations require a stable identity and refuse an expired renewal without writes", async t => {
  const { run, writes, comments } = await fixture(t);
  for (const verb of ["claim", "heartbeat", "release"]) {
    const out = await run(verb);
    assert.equal(out.code, 2, out.stdout);
    assert.match(out.stdout, /stable.*identity/i);
  }
  assert.equal(writes.length, 0);
  comments.push({ created_at: "2000-01-01T00:00:00Z", comment_stripped: "TEST-CLAIM v1 agent=expired until=2000-01-02T00:00:00Z" });
  assert.equal((await run("heartbeat", "expired")).code, 3);
  assert.match((await run("release", "expired")).stdout, /not-owned/);
  assert.equal(writes.length, 0);
});
