import test from "node:test";
import assert from "node:assert/strict";
import { commentAdd } from "../src/commands/comment.js";

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
