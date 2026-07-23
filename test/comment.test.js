import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { commentAdd } from "../src/commands/comment.js";

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
