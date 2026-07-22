import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findProjectConfig } from "../src/config.js";

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), "plane-axi-config-"));
}

test("a config file that parses to null triggers the repair error instead of a raw TypeError", async () => {
  const cwd = await tmp();
  await writeFile(path.join(cwd, ".plane-axi.json"), "null\n");
  await assert.rejects(() => findProjectConfig(cwd), (error) => error.name === "UsageError" && /invalid project config/.test(error.message));
});

test("a non-string project value triggers the repair error", async () => {
  const cwd = await tmp();
  await writeFile(path.join(cwd, ".plane-axi.json"), JSON.stringify({ project: 42 }));
  await assert.rejects(() => findProjectConfig(cwd), (error) => error.name === "UsageError" && /invalid project config/.test(error.message));
});

test("an empty-string project value triggers the repair error", async () => {
  const cwd = await tmp();
  await writeFile(path.join(cwd, ".plane-axi.json"), JSON.stringify({ project: "" }));
  await assert.rejects(() => findProjectConfig(cwd), (error) => error.name === "UsageError" && /invalid project config/.test(error.message));
});

test("a directory in place of the config file triggers the repair error (EISDIR)", async () => {
  const cwd = await tmp();
  await mkdir(path.join(cwd, ".plane-axi.json"));
  await assert.rejects(() => findProjectConfig(cwd), (error) => error.name === "UsageError" && /invalid project config/.test(error.message));
});

test("a valid config still resolves normally", async () => {
  const cwd = await tmp();
  await writeFile(path.join(cwd, ".plane-axi.json"), JSON.stringify({ project: "LABS" }));
  const config = await findProjectConfig(cwd);
  assert.equal(config.project, "LABS");
});

test("ENOENT still walks up to parent directories", async () => {
  const root = await tmp();
  await writeFile(path.join(root, ".plane-axi.json"), JSON.stringify({ project: "PARENT" }));
  const nested = path.join(root, "nested", "deep");
  await mkdir(nested, { recursive: true });
  const config = await findProjectConfig(nested);
  assert.equal(config.project, "PARENT");
});
