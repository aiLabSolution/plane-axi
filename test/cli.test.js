import test from "node:test";
import assert from "node:assert/strict";
import { main, run } from "../src/cli.js";
async function captureMain(args, options) {
  let stdout = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  try { return { status: await main(args, options), stdout }; }
  finally { process.stdout.write = original; }
}

test("unknown flags fail with exit 2 and inline valid flags", async () => {
  const result = await captureMain(["wi", "list", "--stat", "closed"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /unknown flag --stat/);
  assert.match(result.stdout, /--state/);
});

test("renamed flags receive a targeted hint", async () => {
  const result = await captureMain(["wi", "create", "--name", "test"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--name was renamed; use --title/);
});

test("help bypasses required validation and is command-scoped", async () => {
  const help = await run(["project", "create", "--unknown", "--help"]);
  assert.equal(help.command, "project create");
  assert.match(help.usage, /--name/);
  assert.equal(help.flags.some((entry) => entry.flag === "--name" && entry.required), true);
});

test("boolean flags reject assigned values", async () => {
  const result = await captureMain(["wi", "list", "--all=false"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /does not take a value/);
});

test("missing credentials are structured errors on stdout", async () => {
  const result = await captureMain(["me"], { config: { apiKey: undefined, workspace: undefined, baseUrl: "https://plane.test/api/v1" } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /PLANE_API_KEY is not set/);
});

test("semantic flag errors are rejected before an API call", async () => {
  let called = false;
  const api = new Proxy({}, { get() { called = true; throw new Error("API should not be called"); } });
  const result = await captureMain(["wi", "list", "--project", "LABSO", "--priority", "critical"], { api });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /invalid priority critical/);
  assert.equal(called, false);
});

test("snapshot returns no context when Plane is unavailable", async () => {
  const result = await run(["snapshot"], { config: { apiKey: undefined, workspace: undefined, baseUrl: "https://plane.test/api/v1" } });
  assert.equal(result, null);
});
