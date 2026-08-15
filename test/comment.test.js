import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { commentAdd, commentList } from "../src/commands/comment.js";

const COMMENTS_PATH = "/projects/project-id/work-items/item-id/comments/";
const ACTIVITIES_PATH = "/projects/project-id/work-items/item-id/activities/";

const sampleComments = () => [
  { comment_html: "<p>first comment</p>", created_by_detail: { display_name: "Ada" }, created_at: "2026-08-01T10:00:00Z" },
  { comment_html: "<p>second comment</p>", created_by: "bob-id", created_at: "2026-08-02T10:00:00Z" }
];
const sampleActivities = () => [
  { field: "state", new_value: "In Progress", actor_detail: { display_name: "Ada" }, created_at: "2026-08-03T10:00:00Z" },
  { field: "priority", new_value: "High", actor: "carol-id", created_at: "2026-08-04T10:00:00Z" }
];

function fakeApi({ comments = [], activities = [] } = {}) {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const item = { id: "item-id", sequence_id: 1 };
  const called = [];
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      called.push(path);
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/work-items/") return { results: [item], total: 1 };
      if (path === COMMENTS_PATH) return { results: comments, total: comments.length };
      if (path === ACTIVITIES_PATH) return { results: activities, total: activities.length };
      throw new Error(`unexpected all ${path}`);
    },
    post: async () => { throw new Error("post should not be called"); }
  };
  return { api, called };
}

test("comment list (default) lists only comments and never calls the activities endpoint", async () => {
  const { api, called } = fakeApi({ comments: sampleComments(), activities: sampleActivities() });
  const out = await commentList({ api, flags: { project: "LABS" }, positionals: ["LABS-1"], cwd: "/tmp" });
  assert.equal(out.work_item, "LABS-1");
  assert.equal(out.count, "2 of 2 total");
  assert.deepEqual(out.comments.map((c) => c.body), ["first comment", "second comment"]);
  assert.deepEqual(out.comments.map((c) => c.author), ["Ada", "bob-id"]);
  assert.ok(!called.includes(ACTIVITIES_PATH), `activities endpoint should not be called, got ${JSON.stringify(called)}`);
  assert.ok(!("activities" in out));
});

test("comment list --all lists the comments first, then the activity entries after them", async () => {
  const { api } = fakeApi({ comments: sampleComments(), activities: sampleActivities() });
  const out = await commentList({ api, flags: { project: "LABS", all: true }, positionals: ["LABS-1"], cwd: "/tmp" });
  assert.equal(out.work_item, "LABS-1");
  assert.deepEqual(out.comments.map((c) => c.body), ["first comment", "second comment"]);
  assert.deepEqual(out.activities.map((a) => a.body), ["In Progress", "High"]);
  assert.deepEqual(out.activities.map((a) => a.author), ["Ada", "carol-id"]);
  assert.deepEqual(out.activities.map((a) => a.created_at), ["2026-08-03T10:00:00Z", "2026-08-04T10:00:00Z"]);
  assert.equal(out.activity_count, "2 of 2 total");
  // The TOON encoder emits object keys in insertion order, so assert the RENDERED
  // order: the comments section must serialize before the activities section.
  const keys = Object.keys(out);
  assert.ok(keys.indexOf("comments") < keys.indexOf("activities"), `comments must render before activities, got keys ${JSON.stringify(keys)}`);
  const serialized = JSON.stringify(out);
  assert.ok(serialized.indexOf('"comments"') < serialized.indexOf('"activities"'), "serialized output must list comments before activities");
});

test("comment list --all requests both the comments and activities endpoints", async () => {
  const { api, called } = fakeApi({ comments: sampleComments(), activities: sampleActivities() });
  await commentList({ api, flags: { project: "LABS", all: true }, positionals: ["LABS-1"], cwd: "/tmp" });
  assert.ok(called.includes(COMMENTS_PATH), `comments endpoint not called: ${JSON.stringify(called)}`);
  assert.ok(called.includes(ACTIVITIES_PATH), `activities endpoint not called: ${JSON.stringify(called)}`);
});

test("comment list --all with no comments and no activities reports an accurate empty message", async () => {
  const { api } = fakeApi();
  const out = await commentList({ api, flags: { project: "LABS", all: true }, positionals: ["LABS-1"], cwd: "/tmp" });
  assert.deepEqual(out, { comments: "0 comments and 0 activities on LABS-1" });
});

test("comment list without --all and with no comments reports an accurate empty message", async () => {
  const { api, called } = fakeApi({ activities: sampleActivities() });
  const out = await commentList({ api, flags: { project: "LABS" }, positionals: ["LABS-1"], cwd: "/tmp" });
  assert.deepEqual(out, { comments: "0 comments on LABS-1" });
  assert.ok(!called.includes(ACTIVITIES_PATH));
});

async function withStdin(text, fn) {
  const original = process.stdin;
  Object.defineProperty(process, "stdin", { value: Readable.from([text]), configurable: true });
  try { return await fn(); }
  finally { Object.defineProperty(process, "stdin", { value: original, configurable: true }); }
}

test("--body-file translates a missing file into a UsageError with help instead of a raw ENOENT", async () => {
  const api = new Proxy({}, { get() { throw new Error("api should not be touched"); } });
  await assert.rejects(
    () => commentAdd({ api, flags: { "body-file": "/nonexistent/plane-axi-test-path/note.md" }, positionals: ["LABS-1"], cwd: "/tmp" }),
    (error) => error.name === "UsageError"
      && error.message === "cannot read body file /nonexistent/plane-axi-test-path/note.md"
      && Boolean(error.help)
      && !/ENOENT/.test(error.message)
  );
});

test("comment add renders --body as markdown, not a single <p>", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const item = { id: "item-id", sequence_id: 1 };
  let posted;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/work-items/") return { results: [item], total: 1 };
      throw new Error(`unexpected all ${path}`);
    },
    post: async (path, data) => { posted = data; return { id: "comment-1" }; }
  };
  await commentAdd({ api, flags: { project: "LABS", body: "line one\nline two" }, positionals: ["LABS-1"], cwd: "/tmp" });
  assert.equal(posted.comment_html, "<p>line one<br>line two</p>");
});

test("comment add rejects a body that renders to empty", async () => {
  const api = new Proxy({}, { get() { throw new Error("api should not be touched"); } });
  await assert.rejects(
    () => commentAdd({ api, flags: { body: "   " }, positionals: ["LABS-1"], cwd: "/tmp" }),
    (error) => error.name === "UsageError" && error.message === "empty comment body"
  );
});

test("comment add --body-file - reads the body from stdin", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const item = { id: "item-id", sequence_id: 1 };
  let posted;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/work-items/") return { results: [item], total: 1 };
      throw new Error(`unexpected all ${path}`);
    },
    post: async (path, data) => { posted = data; return { id: "comment-1" }; }
  };
  await withStdin("**from stdin**", () => commentAdd({ api, flags: { project: "LABS", "body-file": "-" }, positionals: ["LABS-1"], cwd: "/tmp" }));
  assert.equal(posted.comment_html, "<p><strong>from stdin</strong></p>");
});

test("comment add --body-file renders markdown read from a file", async () => {
  const project = { id: "project-id", identifier: "LABS", name: "Labs" };
  const item = { id: "item-id", sequence_id: 1 };
  const dir = await mkdtemp(path.join(os.tmpdir(), "plane-axi-comment-body-"));
  const file = path.join(dir, "note.md");
  await writeFile(file, "## Progress\n\n- done");
  let posted;
  const api = {
    workspacePath: (suffix) => suffix,
    all: async (path) => {
      if (path === "/projects/") return { results: [project], total: 1 };
      if (path === "/projects/project-id/work-items/") return { results: [item], total: 1 };
      throw new Error(`unexpected all ${path}`);
    },
    post: async (path, data) => { posted = data; return { id: "comment-1" }; }
  };
  await commentAdd({ api, flags: { project: "LABS", "body-file": file }, positionals: ["LABS-1"], cwd: "/tmp" });
  assert.equal(posted.comment_html, "<h2>Progress</h2>\n<ul><li>done</li></ul>");
});
