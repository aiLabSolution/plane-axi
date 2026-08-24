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

async function scopedCwd(project) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plane-axi-wi-scope-"));
  await writeFile(path.join(dir, ".plane-axi.json"), JSON.stringify({ project }));
  return dir;
}

const SELECTED = { id: "labs-id", identifier: "LABS", name: "Labs" };
const FOREIGN = { id: "other-id", identifier: "OTHER", name: "Other" };

// serverSearch: (params) => rows, or an AxiError to throw (404 = endpoint absent).
function searchApi({ serverSearch, scanned = [], searches = [] } = {}) {
  return {
    workspacePath: (suffix) => suffix,
    get: async (path, params) => {
      assert.equal(path, "/issues/search/");
      searches.push(params);
      const outcome = serverSearch ? serverSearch(params) : [];
      if (outcome instanceof Error) throw outcome;
      return { issues: outcome };
    },
    all: async (path) => {
      if (path === "/projects/") return { results: [SELECTED, FOREIGN], total: 2 };
      if (path.endsWith("/states/")) return { results: [], total: 0 };
      scanned.push(path);
      return { results: [{ id: `item-${scanned.length}`, sequence_id: 5, name: "needle" }], total: 1 };
    }
  };
}

const titleRow = (project, sequence) => ({ id: `item-${sequence}`, sequence_id: sequence, name: "needle", project__identifier: project.identifier, project_id: project.id });

test("wi search asks the server for titles in the selected project and scans nothing", async () => {
  const cwd = await scopedCwd("LABS");
  const scanned = [];
  const searches = [];
  const api = searchApi({ scanned, searches, serverSearch: () => [titleRow(SELECTED, 5)] });
  const result = await wiSearch({ api, flags: {}, positionals: ["needle"], cwd });
  assert.deepEqual(searches, [{ search: "needle", limit: 51, project_id: "labs-id" }]);
  assert.deepEqual(scanned, []);
  assert.equal(result.match, "title");
  assert.equal(result.project, "LABS");
  assert.equal(result.wi[0].seq, "LABS-5");
  assert.equal(result.wi[0].project, undefined); // named once in the payload, not repeated per row
});

test("wi search --workspace drops the project filter and labels each row", async () => {
  const cwd = await scopedCwd("LABS");
  const searches = [];
  const api = searchApi({ searches, serverSearch: () => [titleRow(SELECTED, 5), titleRow(FOREIGN, 9)] });
  const result = await wiSearch({ api, flags: { workspace: true }, positionals: ["needle"], cwd });
  assert.equal(searches[0].project_id, undefined);
  assert.equal(result.project, undefined);
  assert.deepEqual(result.wi.map((row) => row.project), ["LABS", "OTHER"]);
});

test("wi search --text scans the selected project and leaves other projects unscanned", async () => {
  const cwd = await scopedCwd("LABS");
  const scanned = [];
  const searches = [];
  const api = searchApi({ scanned, searches });
  const result = await wiSearch({ api, flags: { text: true }, positionals: ["needle"], cwd });
  assert.deepEqual(scanned, ["/projects/labs-id/work-items/"]);
  assert.deepEqual(searches, []); // --text never asks the title endpoint
  assert.equal(result.match, "title+body");
  assert.equal(result.count, "1 of 1 matching");
});

test("wi search --text --workspace scans every project", async () => {
  const cwd = await scopedCwd("LABS");
  const scanned = [];
  const api = searchApi({ scanned });
  await wiSearch({ api, flags: { text: true, workspace: true }, positionals: ["needle"], cwd });
  assert.deepEqual(scanned, ["/projects/labs-id/work-items/", "/projects/other-id/work-items/"]);
});

test("a Plane without the title endpoint falls back to a body scan and reports the wider match", async () => {
  const cwd = await scopedCwd("LABS");
  const scanned = [];
  const api = searchApi({ scanned, serverSearch: () => new AxiError("no such endpoint", { status: 404 }) });
  const result = await wiSearch({ api, flags: {}, positionals: ["needle"], cwd });
  assert.deepEqual(scanned, ["/projects/labs-id/work-items/"]);
  assert.equal(result.match, "title+body"); // the caller is told the semantics widened
});

test("a server-search failure that is not a 404 is not silently downgraded to a scan", async () => {
  const cwd = await scopedCwd("LABS");
  const scanned = [];
  const api = searchApi({ scanned, serverSearch: () => new AxiError("Plane is unavailable", { status: 503 }) });
  await assert.rejects(() => wiSearch({ api, flags: {}, positionals: ["needle"], cwd }), (error) => error.status === 503);
  assert.deepEqual(scanned, []);
});

test("a title-only miss points at --text; a body scan's miss has nothing wider to offer", async () => {
  const cwd = await scopedCwd("LABS");
  const api = searchApi({ serverSearch: () => [] });
  const titleMiss = await wiSearch({ api, flags: {}, positionals: ["needle"], cwd });
  assert.match(titleMiss.wi, /0 work items matching needle in LABS by title/);
  assert.match(titleMiss.help[0], /--text/);

  const empty = { workspacePath: (suffix) => suffix, all: async (path) => path === "/projects/" ? { results: [SELECTED], total: 1 } : { results: [], total: 0 } };
  const textMiss = await wiSearch({ api: empty, flags: { text: true }, positionals: ["needle"], cwd });
  assert.match(textMiss.wi, /by title\+body/);
  assert.equal(textMiss.help, undefined);
});

test("the server search reports 'or more' instead of inventing a total it never established", async () => {
  const cwd = await scopedCwd("LABS");
  const rows = Array.from({ length: 4 }, (_, index) => titleRow(SELECTED, index + 1));
  const api = searchApi({ serverSearch: () => rows });
  const result = await wiSearch({ api, flags: { limit: "3" }, positionals: ["needle"], cwd });
  assert.equal(result.count, "3 matching or more");
  assert.equal(result.wi.length, 3);
  assert.match(result.help[1], /--all/);
});

test("--all caps the server search rather than requesting an unbounded page", async () => {
  const cwd = await scopedCwd("LABS");
  const searches = [];
  const api = searchApi({ searches, serverSearch: () => [titleRow(SELECTED, 5)] });
  const result = await wiSearch({ api, flags: { all: true }, positionals: ["needle"], cwd });
  assert.equal(searches[0].limit, 1000);
  assert.equal(result.count, "1 matching");
});

test("wi search --project refuses a project outside the selected one", async () => {
  const cwd = await scopedCwd("LABS");
  const scanned = [];
  const searches = [];
  await assert.rejects(
    () => wiSearch({ api: searchApi({ scanned, searches }), flags: { project: "OTHER" }, positionals: ["needle"], cwd }),
    (error) => error.name === "AxiError" && error.message === "project OTHER is outside the selected project LABS"
  );
  assert.deepEqual(scanned, []);
  assert.deepEqual(searches, []);
});

test("wi search rejects --workspace with --project before any API call", async () => {
  const cwd = await scopedCwd("LABS");
  const api = { workspacePath: (suffix) => suffix, get: async () => { throw new Error("no request expected"); }, all: async () => { throw new Error("no request expected"); } };
  await assert.rejects(
    () => wiSearch({ api, flags: { workspace: true, project: "OTHER" }, positionals: ["needle"], cwd }),
    (error) => error.name === "UsageError"
  );
});

test("wi list --project refuses a project outside the selected one", async () => {
  const cwd = await scopedCwd("LABS");
  const scanned = [];
  await assert.rejects(
    () => wiList({ api: searchApi({ scanned }), flags: { project: "OTHER" }, cwd }),
    (error) => error.name === "AxiError" && error.message === "project OTHER is outside the selected project LABS"
  );
  assert.deepEqual(scanned, []);
});
