import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setup } from "../src/commands/setup.js";

test("Claude project setup is non-destructive and idempotent", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "plane-axi-setup-"));
  await mkdir(path.join(cwd, ".claude"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "settings.json"), '{"permissions":{"allow":["Read"]}}\n');
  const executable = path.resolve("bin/plane-axi.js");
  const first = await setup({ flags: { app: "claude", scope: "project" }, cwd, executable });
  const second = await setup({ flags: { app: "claude", scope: "project" }, cwd, executable });
  assert.equal(first.result, "setup complete");
  assert.equal(second.result, "already configured (no-op)");
  const settings = JSON.parse(await readFile(path.join(cwd, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Read"] });
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /plane-axi\.js' snapshot|plane-axi snapshot/);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].timeout, 30);
});

test("OpenCode setup uses direct process spawning and is idempotent", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "plane-axi-opencode-"));
  const executable = path.resolve("bin/plane-axi.js");
  const first = await setup({ flags: { app: "opencode", scope: "project" }, cwd, executable });
  const second = await setup({ flags: { app: "opencode", scope: "project" }, cwd, executable });
  const plugin = await readFile(path.join(cwd, ".opencode", "plugins", "plane-axi.js"), "utf8");
  assert.equal(first.result, "setup complete");
  assert.equal(second.result, "already configured (no-op)");
  assert.match(plugin, /spawn\(binary, \["snapshot"\]/);
  assert.doesNotMatch(plugin, /sh.*-lc/);
});

test("generated skill installs for all supported agents", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "plane-axi-skill-"));
  const executable = path.resolve("bin/plane-axi.js");
  const first = await setup({ flags: { app: "all", scope: "project", skill: true }, cwd, executable });
  const second = await setup({ flags: { app: "all", scope: "project", skill: true }, cwd, executable });
  assert.equal(first.skills.length, 3);
  assert.equal(first.result, "skill installed");
  assert.equal(second.result, "already installed (no-op)");
  for (const file of [
    path.join(cwd, ".claude", "skills", "plane-axi", "SKILL.md"),
    path.join(cwd, ".agents", "skills", "plane-axi", "SKILL.md"),
    path.join(cwd, ".opencode", "skills", "plane-axi", "SKILL.md")
  ]) assert.match(await readFile(file, "utf8"), /name: plane-axi/);
});

test("a non-object hooks value in an existing settings file fails with a named AxiError", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "plane-axi-setup-bad-hooks-"));
  await mkdir(path.join(cwd, ".claude"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "settings.json"), '{"hooks":"disabled"}\n');
  const executable = path.resolve("bin/plane-axi.js");
  await assert.rejects(
    () => setup({ flags: { app: "claude", scope: "project" }, cwd, executable }),
    (error) => error.name === "AxiError" && /hooks/.test(error.message) && /settings\.json/.test(error.message) && Boolean(error.help)
  );
});

test("a non-array SessionStart value in an existing settings file fails with a named AxiError", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "plane-axi-setup-bad-session-"));
  await mkdir(path.join(cwd, ".claude"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "settings.json"), '{"hooks":{"SessionStart":"nope"}}\n');
  const executable = path.resolve("bin/plane-axi.js");
  await assert.rejects(
    () => setup({ flags: { app: "claude", scope: "project" }, cwd, executable }),
    (error) => error.name === "AxiError" && /SessionStart/.test(error.message) && /settings\.json/.test(error.message) && Boolean(error.help)
  );
});

test("a null-root settings file fails with a named AxiError instead of a raw TypeError", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "plane-axi-setup-bad-null-"));
  await mkdir(path.join(cwd, ".claude"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "settings.json"), "null\n");
  const executable = path.resolve("bin/plane-axi.js");
  await assert.rejects(
    () => setup({ flags: { app: "claude", scope: "project" }, cwd, executable }),
    (error) => error.name === "AxiError" && /settings\.json/.test(error.message) && Boolean(error.help)
  );
});

test("an array-root settings file fails with a named AxiError instead of silently dropping the hook", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "plane-axi-setup-bad-array-"));
  await mkdir(path.join(cwd, ".claude"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "settings.json"), '["x"]\n');
  const executable = path.resolve("bin/plane-axi.js");
  await assert.rejects(
    () => setup({ flags: { app: "claude", scope: "project" }, cwd, executable }),
    (error) => error.name === "AxiError" && /settings\.json/.test(error.message) && Boolean(error.help)
  );
  const settings = JSON.parse(await readFile(path.join(cwd, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings, ["x"]);
});
