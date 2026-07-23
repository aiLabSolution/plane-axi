import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AxiError } from "../src/errors.js";
import { cachedItemId, cachedProjectId, rememberItems, rememberProjects } from "../src/cache.js";
import { resolveProject, resolveWorkItem } from "../src/resolve.js";

async function tmpCacheFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plane-axi-resolve-cache-"));
  return path.join(dir, "refs.json");
}

function notFound() {
  return new AxiError("Plane resource not found", { status: 404 });
}

test("resolveWorkItem takes the UUID path when the last dash-group happens to be all digits", async () => {
  const uuid = "12345678-90ab-4abc-8def-123456789012";
  const project = { id: "proj-id", identifier: "LABS", name: "Labs" };
  const api = {
    workspacePath: (suffix) => suffix,
    get: async (path) => {
      assert.equal(path, `/projects/${project.id}/work-items/${uuid}/`);
      return { id: uuid, sequence_id: 42, name: "Found" };
    },
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      throw new Error(`unexpected all ${path}`);
    }
  };
  const result = await resolveWorkItem(api, uuid, "LABS");
  assert.equal(result.project.identifier, "LABS");
  assert.equal(result.item.sequence_id, 42);
});

test("resolveProject: a cache hit resolves via one direct GET and never scans the project list", async () => {
  const cacheFile = await tmpCacheFile();
  const project = { id: "proj-uuid-1", identifier: "LABS", name: "Labs" };
  await rememberProjects(cacheFile, "labsolution", [project]);
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    get: async (path) => { assert.equal(path, "/projects/proj-uuid-1/"); return project; },
    all: async () => { throw new Error("full scan should not run on a cache hit"); }
  };
  const result = await resolveProject(api, "LABS", cacheFile);
  assert.equal(result.id, "proj-uuid-1");
});

test("resolveProject: a stale cached uuid 404s, falls back to a scan, and rewrites the cache", async () => {
  const cacheFile = await tmpCacheFile();
  await rememberProjects(cacheFile, "labsolution", [{ id: "stale-uuid", identifier: "LABS", name: "Labs" }]);
  const fresh = { id: "fresh-uuid", identifier: "LABS", name: "Labs" };
  const calls = { get: 0, all: 0 };
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    get: async (path) => { calls.get += 1; assert.equal(path, "/projects/stale-uuid/"); throw notFound(); },
    all: async (path) => { calls.all += 1; assert.equal(path, "/projects/"); return { results: [fresh], total: 1 }; }
  };
  const result = await resolveProject(api, "LABS", cacheFile);
  assert.equal(result.id, "fresh-uuid");
  assert.equal(calls.get, 1);
  assert.equal(calls.all, 1);
  assert.equal(await cachedProjectId(cacheFile, "labsolution", "labs"), "fresh-uuid");
});

test("resolveProject: a cache hit whose identifier no longer matches the ref is treated as a miss", async () => {
  const cacheFile = await tmpCacheFile();
  await rememberProjects(cacheFile, "labsolution", [{ id: "reused-uuid", identifier: "LABS", name: "Labs" }]);
  const renamed = { id: "reused-uuid", identifier: "OTHER", name: "Other" };
  const real = { id: "real-uuid", identifier: "LABS", name: "Labs" };
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    get: async () => renamed,
    all: async () => ({ results: [renamed, real], total: 2 })
  };
  const result = await resolveProject(api, "LABS", cacheFile);
  assert.equal(result.id, "real-uuid");
});

test("resolveProject: PLANE_AXI_NO_CACHE=1 bypasses a populated cache entirely", async () => {
  const cacheFile = await tmpCacheFile();
  const stale = { id: "stale-uuid", identifier: "LABS", name: "Labs" };
  await rememberProjects(cacheFile, "labsolution", [stale]);
  const fresh = { id: "fresh-uuid", identifier: "LABS", name: "Labs" };
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    get: async () => { throw new Error("cache should not be consulted when disabled"); },
    all: async () => ({ results: [fresh], total: 1 })
  };
  process.env.PLANE_AXI_NO_CACHE = "1";
  try {
    const result = await resolveProject(api, "LABS", cacheFile);
    assert.equal(result.id, "fresh-uuid");
  } finally {
    delete process.env.PLANE_AXI_NO_CACHE;
  }
  // the scan-time store was also skipped: no cache entry was rewritten to fresh-uuid
  assert.equal(await cachedProjectId(cacheFile, "labsolution", "labs"), "stale-uuid");
});

test("resolveWorkItem: a cache hit resolves the item via one direct GET and never scans", async () => {
  const cacheFile = await tmpCacheFile();
  const project = { id: "proj-uuid-1", identifier: "LABS", name: "Labs" };
  await rememberProjects(cacheFile, "labsolution", [project]);
  await rememberItems(cacheFile, "labsolution", "proj-uuid-1", [{ sequence_id: 42, id: "item-uuid-1" }]);
  const fullItem = { id: "item-uuid-1", sequence_id: 42, name: "Title", description_html: "<p>Body</p>" };
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    get: async (path) => {
      if (path === "/projects/proj-uuid-1/") return project; // cache hit for the project half
      assert.equal(path, "/projects/proj-uuid-1/work-items/item-uuid-1/");
      return fullItem;
    },
    all: async () => { throw new Error("full scan should not run on a cache hit"); }
  };
  const result = await resolveWorkItem(api, "LABS-42", undefined, cacheFile);
  assert.equal(result.item.id, "item-uuid-1");
  assert.equal(result.item.description_html, "<p>Body</p>");
});

test("resolveWorkItem: a stale cached item uuid 404s, falls back to a scan, and rewrites the cache", async () => {
  const cacheFile = await tmpCacheFile();
  const project = { id: "proj-uuid-1", identifier: "LABS", name: "Labs" };
  await rememberProjects(cacheFile, "labsolution", [project]);
  await rememberItems(cacheFile, "labsolution", "proj-uuid-1", [{ sequence_id: 42, id: "stale-item-uuid" }]);
  const fresh = { id: "fresh-item-uuid", sequence_id: 42, name: "Title" };
  const calls = { get: 0, all: 0 };
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    get: async (path) => {
      if (path === "/projects/proj-uuid-1/") return project;
      calls.get += 1;
      assert.equal(path, "/projects/proj-uuid-1/work-items/stale-item-uuid/");
      throw notFound();
    },
    all: async (path) => { calls.all += 1; assert.equal(path, "/projects/proj-uuid-1/work-items/"); return { results: [fresh], total: 1 }; }
  };
  const result = await resolveWorkItem(api, "LABS-42", undefined, cacheFile);
  assert.equal(result.item.id, "fresh-item-uuid");
  assert.equal(calls.get, 1);
  assert.equal(calls.all, 1);
  assert.equal(await cachedItemId(cacheFile, "labsolution", "proj-uuid-1:42"), "fresh-item-uuid");
});

test("resolveWorkItem: a cache hit whose sequence_id no longer matches is treated as a miss", async () => {
  const cacheFile = await tmpCacheFile();
  const project = { id: "proj-uuid-1", identifier: "LABS", name: "Labs" };
  await rememberProjects(cacheFile, "labsolution", [project]);
  await rememberItems(cacheFile, "labsolution", "proj-uuid-1", [{ sequence_id: 42, id: "reused-uuid" }]);
  const renamed = { id: "reused-uuid", sequence_id: 99, name: "Different item now" };
  const real = { id: "real-item-uuid", sequence_id: 42, name: "Title" };
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    get: async (path) => (path === "/projects/proj-uuid-1/" ? project : renamed),
    all: async () => ({ results: [renamed, real], total: 2 })
  };
  const result = await resolveWorkItem(api, "LABS-42", undefined, cacheFile);
  assert.equal(result.item.id, "real-item-uuid");
});

test("resolveProject: the project-list scan omits a fields param (the list is small already)", async () => {
  const cacheFile = await tmpCacheFile();
  let seenQuery;
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    all: async (path, query) => { assert.equal(path, "/projects/"); seenQuery = query; return { results: [{ id: "p1", identifier: "LABS", name: "Labs" }], total: 1 }; }
  };
  const result = await resolveProject(api, "LABS", cacheFile);
  assert.equal(result.id, "p1");
  assert.equal(seenQuery, undefined);
});

test("resolveWorkItem: a fresh scan is field-trimmed to id,sequence_id,name,state", async () => {
  const cacheFile = await tmpCacheFile();
  const project = { id: "proj-uuid-1", identifier: "LABS", name: "Labs" };
  let seenQuery;
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    all: async (path, query) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      assert.equal(path, "/projects/proj-uuid-1/work-items/");
      seenQuery = query;
      return { results: [{ id: "item-uuid", sequence_id: 42, name: "Title", state: "state-id" }], total: 1 };
    }
  };
  const result = await resolveWorkItem(api, "LABS-42", undefined, cacheFile);
  assert.equal(result.item.id, "item-uuid");
  assert.deepEqual(seenQuery, { fields: "id,sequence_id,name,state" });
});

test("resolveWorkItem: PLANE_AXI_NO_CACHE=1 bypasses a populated cache entirely", async () => {
  const cacheFile = await tmpCacheFile();
  const project = { id: "proj-uuid-1", identifier: "LABS", name: "Labs" };
  await rememberProjects(cacheFile, "labsolution", [project]);
  await rememberItems(cacheFile, "labsolution", "proj-uuid-1", [{ sequence_id: 42, id: "stale-item-uuid" }]);
  const fresh = { id: "fresh-item-uuid", sequence_id: 42, name: "Title" };
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    get: async () => { throw new Error("neither cache should be consulted when disabled"); },
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      assert.equal(path, "/projects/proj-uuid-1/work-items/");
      return { results: [fresh], total: 1 };
    }
  };
  process.env.PLANE_AXI_NO_CACHE = "1";
  try {
    const result = await resolveWorkItem(api, "LABS-42", undefined, cacheFile);
    assert.equal(result.item.id, "fresh-item-uuid");
  } finally {
    delete process.env.PLANE_AXI_NO_CACHE;
  }
});
