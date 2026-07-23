import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AxiError } from "../src/errors.js";
import { rememberItems, rememberProjects } from "../src/cache.js";
import { wiList, wiView, wiUpdate, wiCreate, wiSearch } from "../src/commands/wi.js";

const LIST_QUERY = { fields: "id,sequence_id,name,priority,state,assignees,labels,created_at,updated_at", expand: "state" };

async function tmpBodyFile(content) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plane-axi-wi-body-"));
  const file = path.join(dir, "body.md");
  await writeFile(file, content);
  return file;
}

test("wi list default (single-page) fetch is field-trimmed with expand=state", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  let seenQuery;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/states/") return { results: [], total: 0 };
      throw new Error(`unexpected all ${path}`);
    },
    page: async (path, query) => { seenQuery = query; return { results: [], total: 0, nextCursor: null }; }
  };
  await wiList({ api, flags: { project: "LABS" }, cwd: "/tmp" });
  assert.deepEqual(seenQuery, LIST_QUERY);
});

test("wi list --all (full scan) fetch is field-trimmed with expand=state", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  let seenQuery;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path, query) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/states/") return { results: [], total: 0 };
      if (path === "/projects/project-id/work-items/") { seenQuery = query; return { results: [], total: 0 }; }
      throw new Error(`unexpected all ${path}`);
    }
  };
  await wiList({ api, flags: { project: "LABS", all: true }, cwd: "/tmp" });
  assert.deepEqual(seenQuery, LIST_QUERY);
});

test("wi search's per-project fallback scan is field-trimmed to id,sequence_id,name,description_html", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  let seenQuery;
  const api = {
    workspacePath: (suffix) => suffix,
    get: async () => { throw new AxiError("no search endpoint", { status: 404 }); },
    all: async (path, query) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      seenQuery = query;
      return { results: [{ id: "item-1", sequence_id: 5, name: "Match", description_html: "<p>needle</p>" }], total: 1 };
    }
  };
  const result = await wiSearch({ api, flags: {}, positionals: ["needle"] });
  assert.deepEqual(seenQuery, { fields: "id,sequence_id,name,description_html" });
  assert.equal(result.wi[0].seq, "LABS-5");
});

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

test("wi view skips the redundant detail GET when a readable-cache hit already returned the full item", async () => {
  const previousXdg = process.env.XDG_CACHE_HOME;
  const dir = await mkdtemp(path.join(os.tmpdir(), "plane-axi-wi-cache-"));
  process.env.XDG_CACHE_HOME = dir;
  const cacheFile = path.join(dir, "plane-axi", "refs.json");
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  await rememberProjects(cacheFile, "labsolution", [project]);
  await rememberItems(cacheFile, "labsolution", "project-id", [{ sequence_id: 42, id: "item-id" }]);
  const getCalls = [];
  const api = {
    config: { workspace: "labsolution" },
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/project-id/states/") return { results: [], total: 0 };
      throw new Error(`unexpected all ${path} (readable-cache hit should skip project/item scans)`);
    },
    get: async (path) => {
      getCalls.push(path);
      if (path === "/projects/project-id/") return project;
      assert.equal(path, "/projects/project-id/work-items/item-id/");
      return { id: "item-id", sequence_id: 42, name: "Title", description_html: "<p>Body</p>" };
    }
  };
  try {
    const result = await wiView({ api, flags: {}, positionals: ["LABS-42"], cwd: "/tmp" });
    assert.equal(result.work_item.body, "Body");
    assert.equal(getCalls.length, 2); // project cache-hit GET + item cache-hit GET, no redundant detail GET
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousXdg;
  }
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

test("wi create renders a markdown --body into description_html", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  let posted;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      throw new Error(`unexpected all ${path}`);
    },
    post: async (path, data) => { posted = data; return { id: "item-1", sequence_id: 1, name: data.name, priority: "none" }; }
  };
  await wiCreate({ api, flags: { project: "LABS", title: "T", body: "# Head\n\nSee [x](https://a.test)" }, cwd: "/tmp" });
  assert.equal(posted.description_html, "<h1>Head</h1>\n<p>See <a href=\"https://a.test\">x</a></p>");
});

test("wi create --body-file renders markdown read from a file", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const file = await tmpBodyFile("**bold** text");
  let posted;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      throw new Error(`unexpected all ${path}`);
    },
    post: async (path, data) => { posted = data; return { id: "item-1", sequence_id: 1, name: data.name, priority: "none" }; }
  };
  await wiCreate({ api, flags: { project: "LABS", title: "T", "body-file": file }, cwd: "/tmp" });
  assert.equal(posted.description_html, "<p><strong>bold</strong> text</p>");
});

test("wi create omits description_html when the body strips to empty", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  let posted;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      throw new Error(`unexpected all ${path}`);
    },
    post: async (path, data) => { posted = data; return { id: "item-1", sequence_id: 1, name: data.name, priority: "none" }; }
  };
  await wiCreate({ api, flags: { project: "LABS", title: "T", body: "   " }, cwd: "/tmp" });
  assert.equal("description_html" in posted, false);
});

test("wi create rejects --body and --body-file together before any API call", async () => {
  const api = new Proxy({}, { get() { throw new Error("api should not be touched"); } });
  await assert.rejects(
    () => wiCreate({ api, flags: { project: "LABS", title: "T", body: "x", "body-file": "y" }, cwd: "/tmp" }),
    (error) => error.name === "UsageError" && /at most one of --body or --body-file/.test(error.message)
  );
});

test("wi update --body \"\" explicitly clears description_html to an empty string", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const item = { id: "item-id", sequence_id: 7 };
  let patched;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/work-items/") return { results: [item], total: 1 };
      throw new Error(`unexpected all ${path}`);
    },
    patch: async (path, data) => { patched = data; return { id: item.id, sequence_id: item.sequence_id, name: "Old" }; }
  };
  await wiUpdate({ api, flags: { project: "LABS", body: "" }, positionals: ["LABS-7"], cwd: "/tmp" });
  assert.equal(patched.description_html, "");
});

test("wi update --body-file renders markdown read from a file", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const item = { id: "item-id", sequence_id: 7 };
  const file = await tmpBodyFile("- one\n- two\n");
  let patched;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/work-items/") return { results: [item], total: 1 };
      throw new Error(`unexpected all ${path}`);
    },
    patch: async (path, data) => { patched = data; return { id: item.id, sequence_id: item.sequence_id, name: "Old" }; }
  };
  await wiUpdate({ api, flags: { project: "LABS", "body-file": file }, positionals: ["LABS-7"], cwd: "/tmp" });
  assert.equal(patched.description_html, "<ul><li>one</li><li>two</li></ul>");
});

test("wi update rejects --body and --body-file together before resolving the work item", async () => {
  const api = new Proxy({}, { get() { throw new Error("api should not be touched"); } });
  await assert.rejects(
    () => wiUpdate({ api, flags: { project: "LABS", body: "x", "body-file": "y" }, positionals: ["LABS-7"], cwd: "/tmp" }),
    (error) => error.name === "UsageError" && /at most one of --body or --body-file/.test(error.message)
  );
});

test("wi update --body-file read errors translate to a UsageError, not a raw ENOENT", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const item = { id: "item-id", sequence_id: 7 };
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/work-items/") return { results: [item], total: 1 };
      throw new Error(`unexpected all ${path}`);
    }
  };
  await assert.rejects(
    () => wiUpdate({ api, flags: { project: "LABS", "body-file": "/nonexistent/plane-axi-test-path/note.md" }, positionals: ["LABS-7"], cwd: "/tmp" }),
    (error) => error.name === "UsageError" && /cannot read body file/.test(error.message) && !/ENOENT/.test(error.message)
  );
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
