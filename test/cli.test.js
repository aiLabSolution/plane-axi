import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { main, run, _internals, COMMAND_METADATA } from "../src/cli.js";
import { AxiError } from "../src/errors.js";
import { PACKAGE_VERSION } from "../src/version.js";
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

test("empty-string flag values are rejected instead of silently accepted", async () => {
  const result = await captureMain(["wi", "list", "--state", ""]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--state requires a non-empty value/);
});

test("empty-string flag values are rejected in --flag=value form too", async () => {
  const result = await captureMain(["wi", "list", "--state="]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--state requires a non-empty value/);
});

test("wi update --state \"\" is a usage error, not a crash", async () => {
  const result = await captureMain(["wi", "update", "LABS-1", "--state", ""]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--state requires a non-empty value/);
});

test("--body allows an explicit empty value via the allowEmpty flag meta", () => {
  const parsed = _internals.parseFlags("wi update", COMMAND_METADATA["wi update"], ["LABS-1", "--body", ""]);
  assert.equal(parsed.flags.body, "");
});

test("--body allows an explicit empty value on wi create too", () => {
  const parsed = _internals.parseFlags("wi create", COMMAND_METADATA["wi create"], ["--title", "T", "--body", ""]);
  assert.equal(parsed.flags.body, "");
});

test("a bare - is accepted as a flag value (stdin marker), space or equals form", () => {
  const spaced = _internals.parseFlags("comment add", COMMAND_METADATA["comment add"], ["LABS-1", "--body-file", "-"]);
  assert.equal(spaced.flags["body-file"], "-");
  const equals = _internals.parseFlags("comment add", COMMAND_METADATA["comment add"], ["LABS-1", "--body-file=-"]);
  assert.equal(equals.flags["body-file"], "-");
});

test("a value that looks like a flag (leading --) is still rejected", () => {
  assert.throws(
    () => _internals.parseFlags("comment add", COMMAND_METADATA["comment add"], ["LABS-1", "--body-file", "--body"]),
    (error) => error.name === "UsageError" && /--body-file requires a value/.test(error.message)
  );
});

test("group --help lists group subcommands with exit 0 instead of failing", async () => {
  const result = await captureMain(["wi", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /wi list/);
  assert.match(result.stdout, /wi view/);
});

test("group --help fires even with an invalid subcommand as long as --help is present", async () => {
  const result = await captureMain(["project", "bogus", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /project list/);
});

test("a bare group with no subcommand still errors normally", async () => {
  const result = await captureMain(["wi"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /missing or unknown subcommand for wi/);
});

test("flag descriptions do not duplicate the mechanical default suffix", async () => {
  const help = await run(["wi", "list", "--help"]);
  const limitFlag = help.flags.find((entry) => entry.flag.startsWith("--limit"));
  assert.equal(limitFlag.description, "Maximum rows [default: 50]");
  const searchHelp = await run(["wi", "search", "--help"]);
  const searchLimit = searchHelp.flags.find((entry) => entry.flag.startsWith("--limit"));
  assert.equal(searchLimit.description, "Maximum rows [default: 50]");
});

test("setup --app/--scope descriptions do not duplicate the mechanical default suffix", async () => {
  const help = await run(["setup", "--help"]);
  const appFlag = help.flags.find((entry) => entry.flag.startsWith("--app"));
  const scopeFlag = help.flags.find((entry) => entry.flag.startsWith("--scope"));
  assert.equal(appFlag.description, "claude|codex|opencode|all [default: all]");
  assert.equal(scopeFlag.description, "project|user [default: project]");
});

test("prototype-chain command names are rejected as unknown commands", async () => {
  const result = await captureMain(["toString"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /unknown command toString/);
});

test("prototype-chain flag names are rejected as unknown flags", async () => {
  const api = new Proxy({}, { get() { throw new Error("API should not be called"); } });
  const result = await captureMain(["me", "--constructor", "x"], { api });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /unknown flag --constructor/);
});

test("render prints the plain HTML string via main(), not TOON-quoted", async () => {
  const result = await captureMain(["render", "--body", "line one\nline two"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "<p>line one<br>line two</p>\n");
});

test("main never crashes when an error message contains a lone surrogate", async () => {
  const api = new Proxy({}, { get() { throw new AxiError("bad \ud800 body"); } });
  const result = await captureMain(["me"], { api });
  assert.equal(result.status, 1);
  assert.notEqual(result.stdout, "");
  assert.doesNotMatch(result.stdout, /[\ud800-\udfff]/);
});

test("version reports the running build without calling the API", async () => {
  const api = new Proxy({}, { get() { throw new Error("API should not be called"); } });
  const result = await run(["version"], { api, executable: "/opt/bin/plane-axi" });
  assert.equal(result.version, PACKAGE_VERSION);
  assert.equal(result.bin, "/opt/bin/plane-axi");
  assert.equal(result.node, process.version);
});

test("--version and -v resolve to the version command", async () => {
  for (const token of ["--version", "-v"]) {
    const api = new Proxy({}, { get() { throw new Error("API should not be called"); } });
    const result = await run([token], { api, executable: "/opt/bin/plane-axi" });
    assert.equal(result.version, PACKAGE_VERSION, `${token} should report the package version`);
  }
});

// The whole point of `version` is diagnosing which copy is on PATH, so it has to answer
// before credentials are configured — otherwise a stale install cannot be identified.
test("version answers with no credentials configured", async () => {
  const result = await captureMain(["version"], { config: { apiKey: undefined, workspace: undefined, baseUrl: "https://plane.test/api/v1" } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`version: ${PACKAGE_VERSION.replace(/\./g, "\\.")}`));
});

test("version collapses the home directory in the reported bin path", async () => {
  const result = await run(["version"], { executable: path.join(os.homedir(), ".local", "bin", "plane-axi") });
  assert.equal(result.bin, "~/.local/bin/plane-axi");
});

test("version is listed in top-level help so agents can discover it", async () => {
  const help = await run(["--help"]);
  assert.ok(help.commands.some((entry) => entry.command === "version"));
  assert.ok(Object.hasOwn(COMMAND_METADATA, "version"));
});
