import test from "node:test";
import assert from "node:assert/strict";
import { wiList, wiView, wiUpdate, wiCreate } from "../src/commands/wi.js";

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

test("wi list --all hint keeps the active filter flags so following it does not silently unfilter", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/states/") return { results: [{ id: "state-1", name: "Completed", group: "completed" }], total: 1 };
      if (path === "/projects/project-id/work-items/") {
        return {
          results: Array.from({ length: 60 }, (_, index) => ({ id: `item-${index}`, sequence_id: index + 1, name: `Item ${index + 1}`, priority: "high", state: "state-1" })),
          total: 60
        };
      }
      throw new Error(`unexpected all ${path}`);
    }
  };
  const result = await wiList({ api, flags: { project: "LABS", state: "completed", priority: "high" }, cwd: "/tmp" });
  assert.match(result.help[1], /--all --state completed --priority high --project LABS/);
});

test("wi list --all hint shell-quotes multi-word filter values so following it does not exit 2", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/states/") return { results: [{ id: "state-1", name: "In Progress", group: "started" }], total: 1 };
      if (path === "/projects/project-id/work-items/") {
        return {
          results: Array.from({ length: 60 }, (_, index) => ({ id: `item-${index}`, sequence_id: index + 1, name: `Item ${index + 1}`, priority: "none", state: "state-1" })),
          total: 60
        };
      }
      throw new Error(`unexpected all ${path}`);
    }
  };
  const result = await wiList({ api, flags: { project: "LABS", state: "In Progress" }, cwd: "/tmp" });
  assert.match(result.help[1], /--all --state "In Progress" --project LABS/);
});

test("wi view drops the fake comment/sub-item counts and hints at comment list", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const summary = { id: "item-id", sequence_id: 42 };
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/work-items/") return { results: [summary], total: 1 };
      if (path === "/projects/project-id/states/") return { results: [], total: 0 };
      throw new Error(`unexpected all ${path}`);
    },
    get: async (path) => {
      assert.equal(path, "/projects/project-id/work-items/item-id/");
      return { id: "item-id", sequence_id: 42, name: "Title", description_html: "<p>Body</p>", comment_count: 3, sub_issues_count: 2 };
    }
  };
  const result = await wiView({ api, flags: {}, positionals: ["LABS-42"], cwd: "/tmp" });
  assert.equal("comments" in result.work_item, false);
  assert.equal("sub_items" in result.work_item, false);
  assert.match(result.help[0], /comment list LABS-42.*for comments/);
});

test("resolveState (via wi update) matches a state by group when no exact name matches", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const item = { id: "item-id", sequence_id: 7 };
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/states/") return { results: [{ id: "state-done", name: "Done", group: "completed" }], total: 1 };
      if (path === "/projects/project-id/work-items/") return { results: [item], total: 1 };
      throw new Error(`unexpected all ${path}`);
    },
    patch: async (path, data) => {
      assert.equal(data.state, "state-done");
      return { id: item.id, sequence_id: item.sequence_id, name: "Old" };
    }
  };
  const result = await wiUpdate({ api, flags: { project: "LABS", state: "completed" }, positionals: ["LABS-7"], cwd: "/tmp" });
  assert.equal(result.result, "updated");
});

test("resolveState (via wi create) still reports ambiguity when multiple states share a group", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/states/") {
        return {
          results: [
            { id: "s1", name: "In Progress", group: "started" },
            { id: "s2", name: "In Review", group: "started" }
          ],
          total: 2
        };
      }
      throw new Error(`unexpected all ${path}`);
    }
  };
  await assert.rejects(
    () => wiCreate({ api, flags: { project: "LABS", title: "T", state: "started" }, cwd: "/tmp" }),
    (error) => error.name === "AxiError" && /ambiguous state started/.test(error.message)
  );
});
