import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkItem } from "../src/resolve.js";

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
