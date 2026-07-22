import test from "node:test";
import assert from "node:assert/strict";
import { wiList } from "../src/commands/wi.js";

test("unfiltered lists retain the server total while limiting rendered rows", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path.endsWith("/states/")) return { results: [], total: 0 };
      throw new Error(`unexpected all ${path}`);
    },
    page: async () => ({
      results: Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, sequence_id: index + 1, name: `Item ${index + 1}`, priority: "none", state: null })),
      total: 847,
      nextCursor: "next"
    })
  };
  const result = await wiList({ api, flags: { project: "LABS" }, cwd: "/tmp" });
  assert.equal(result.count, "50 of 847 matching (847 total)");
  assert.equal(result.wi.length, 50);
  assert.match(result.help[1], /all 847 matching items/);
});
