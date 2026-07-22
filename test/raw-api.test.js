import test from "node:test";
import assert from "node:assert/strict";
import { rawApi } from "../src/commands/raw-api.js";

test("rejects --input combined with GET before any I/O happens", async () => {
  const api = new Proxy({}, { get() { throw new Error("api should not be touched"); } });
  await assert.rejects(
    () => rawApi({ api, flags: { input: "{}" }, positionals: ["GET", "/x"] }),
    (error) => error.name === "UsageError" && /--input cannot be used with GET/.test(error.message)
  );
});

test("still allows GET without --input", async () => {
  const api = { request: async (method, path) => ({ method, path }) };
  const result = await rawApi({ api, flags: {}, positionals: ["GET", "/x"] });
  assert.deepEqual(result.response, { method: "GET", path: "/x" });
});
