import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cachedItemId, cachedProjectId, cachePath, rememberItems, rememberProjects } from "../src/cache.js";

async function tmpFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plane-axi-cache-"));
  return path.join(dir, "nested", "refs.json"); // directory does not exist yet
}

test("cachePath defaults under ~/.cache and honors XDG_CACHE_HOME", () => {
  assert.equal(cachePath({}), path.join(os.homedir(), ".cache", "plane-axi", "refs.json"));
  assert.equal(cachePath({ XDG_CACHE_HOME: "/custom" }), path.join("/custom", "plane-axi", "refs.json"));
});

test("rememberProjects then cachedProjectId round-trips through disk, creating missing directories", async () => {
  const file = await tmpFile();
  await rememberProjects(file, "labsolution", [{ identifier: "LABS", id: "proj-uuid-1" }, { identifier: "OPS", id: "proj-uuid-2" }]);
  assert.equal(await cachedProjectId(file, "labsolution", "labs"), "proj-uuid-1");
  assert.equal(await cachedProjectId(file, "labsolution", "ops"), "proj-uuid-2");
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(onDisk.labsolution.projects, { labs: "proj-uuid-1", ops: "proj-uuid-2" });
});

test("rememberItems then cachedItemId round-trips, keyed by project uuid + sequence", async () => {
  const file = await tmpFile();
  await rememberItems(file, "labsolution", "proj-uuid-1", [{ sequence_id: 42, id: "item-uuid-1" }, { sequence_id: 7, id: "item-uuid-2" }]);
  assert.equal(await cachedItemId(file, "labsolution", "proj-uuid-1:42"), "item-uuid-1");
  assert.equal(await cachedItemId(file, "labsolution", "proj-uuid-1:7"), "item-uuid-2");
});

test("an unknown workspace or identifier is a plain miss, not a throw", async () => {
  const file = await tmpFile();
  assert.equal(await cachedProjectId(file, "labsolution", "labs"), undefined);
  await rememberProjects(file, "labsolution", [{ identifier: "LABS", id: "proj-uuid-1" }]);
  assert.equal(await cachedProjectId(file, "other-workspace", "labs"), undefined);
});

test("a corrupt cache file is ignored instead of throwing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plane-axi-cache-"));
  const file = path.join(dir, "refs.json");
  await writeFile(file, "{not valid json");
  assert.equal(await cachedProjectId(file, "labsolution", "labs"), undefined);
  // and writing over a corrupt file self-heals it rather than propagating the parse error
  await rememberProjects(file, "labsolution", [{ identifier: "LABS", id: "proj-uuid-1" }]);
  assert.equal(await cachedProjectId(file, "labsolution", "labs"), "proj-uuid-1");
});

test("a non-object JSON root (array/string/number) is treated as an empty cache", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plane-axi-cache-"));
  const file = path.join(dir, "refs.json");
  await writeFile(file, JSON.stringify([1, 2, 3]));
  assert.equal(await cachedProjectId(file, "labsolution", "labs"), undefined);
});

test("PLANE_AXI_NO_CACHE=1 disables both reads and writes", async () => {
  const file = await tmpFile();
  await rememberProjects(file, "labsolution", [{ identifier: "LABS", id: "proj-uuid-1" }], { PLANE_AXI_NO_CACHE: "1" });
  await assert.rejects(() => readFile(file, "utf8")); // write was skipped entirely; no file created
  await rememberProjects(file, "labsolution", [{ identifier: "LABS", id: "proj-uuid-1" }]); // now populate for real
  assert.equal(await cachedProjectId(file, "labsolution", "labs", { PLANE_AXI_NO_CACHE: "1" }), undefined);
  assert.equal(await cachedProjectId(file, "labsolution", "labs"), "proj-uuid-1");
});

test("entries missing identifier/id or sequence_id/id are skipped rather than poisoning the cache", async () => {
  const file = await tmpFile();
  await rememberProjects(file, "labsolution", [{ identifier: "LABS" }, { id: "proj-uuid-1" }, { identifier: "OPS", id: "proj-uuid-2" }]);
  assert.equal(await cachedProjectId(file, "labsolution", "ops"), "proj-uuid-2");
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(onDisk.labsolution.projects), ["ops"]);
});
