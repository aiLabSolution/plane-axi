import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { render } from "../src/commands/render.js";

async function withStdin(text, fn) {
  const original = process.stdin;
  Object.defineProperty(process, "stdin", { value: Readable.from([text]), configurable: true });
  try { return await fn(); }
  finally { Object.defineProperty(process, "stdin", { value: original, configurable: true }); }
}

test("render returns rendered HTML for --body, no network", async () => {
  const api = new Proxy({}, { get() { throw new Error("render must not touch the api"); } });
  const html = await render({ api, flags: { body: "**bold**" } });
  assert.equal(html, "<p><strong>bold</strong></p>");
});

test("render --body-file reads and renders a markdown file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plane-axi-render-"));
  const file = path.join(dir, "slice.md");
  await writeFile(file, "# Title\n\nBody");
  const html = await render({ flags: { "body-file": file } });
  assert.equal(html, "<h1>Title</h1>\n<p>Body</p>");
});

test("render --body-file - reads from stdin", async () => {
  const html = await withStdin("- one\n- two", () => render({ flags: { "body-file": "-" } }));
  assert.equal(html, "<ul><li>one</li><li>two</li></ul>");
});

test("render trims the body so its preview matches what create/update/comment send", async () => {
  // wi create/update/comment add all call mdToHtml(raw.trim()); render must match, or a
  // leading space would suppress heading detection only in the preview.
  const html = await render({ flags: { body: "  # Title\nBody\n" } });
  assert.equal(html, "<h1>Title</h1>\n<p>Body</p>");
});

test("render requires exactly one of --body or --body-file", async () => {
  await assert.rejects(
    () => render({ flags: {} }),
    (error) => error.name === "UsageError" && /render requires --body or --body-file/.test(error.message)
  );
  await assert.rejects(
    () => render({ flags: { body: "x", "body-file": "y" } }),
    (error) => error.name === "UsageError"
  );
});

test("render --body-file read errors translate to a UsageError, not a raw ENOENT", async () => {
  await assert.rejects(
    () => render({ flags: { "body-file": "/nonexistent/plane-axi-test-path/note.md" } }),
    (error) => error.name === "UsageError" && /cannot read body file/.test(error.message) && !/ENOENT/.test(error.message)
  );
});
