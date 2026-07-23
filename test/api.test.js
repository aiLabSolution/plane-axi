import test from "node:test";
import assert from "node:assert/strict";
import { PlaneApi } from "../src/api.js";

const config = { apiKey: "secret", workspace: "labsolution", baseUrl: "https://plane.test/api/v1" };

function response(body, init = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

test("paginates cursor collections and retains the total", async () => {
  const urls = [];
  const api = new PlaneApi(config, async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? response({ results: [{ id: 1 }], total_results: 2, next_page_results: true, next_cursor: "next token" })
      : response({ results: [{ id: 2 }], total_results: 2, next_page_results: false });
  });
  assert.deepEqual(await api.all("/things/"), { results: [{ id: 1 }, { id: 2 }], total: 2 });
  assert.match(urls[0], /per_page=100/);
  assert.match(urls[1], /cursor=next\+token/);
});

test("translates authentication and rate-limit failures", async () => {
  const unauthorized = new PlaneApi(config, async () => response({ detail: "raw secret noise" }, { status: 401 }));
  await assert.rejects(() => unauthorized.get("/x"), (error) => error.message === "Plane authentication failed" && !error.message.includes("raw secret"));
  const limited = new PlaneApi(config, async () => response({}, { status: 429, headers: { "x-ratelimit-reset": "60" } }));
  await assert.rejects(() => limited.get("/x"), (error) => error.message === "Plane API rate limit reached" && error.help === "Retry after 60");
});

test("sends JSON with the Plane API key without exposing it in the URL", async () => {
  let seen;
  const api = new PlaneApi(config, async (url, init) => { seen = { url: String(url), init }; return response({ ok: true }); });
  await api.post("/things/", { name: "A" });
  assert.equal(seen.init.headers["X-API-Key"], "secret");
  assert.equal(seen.url.includes("secret"), false);
  assert.equal(seen.init.body, '{"name":"A"}');
});

test("classifies TimeoutError as a timeout message", async () => {
  const api = new PlaneApi(config, async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  });
  await assert.rejects(() => api.get("/x"), (error) => error.message === "Plane API request timed out");
});

test("classifies undici network failures as could-not-connect", async () => {
  const api = new PlaneApi(config, async () => {
    const error = new TypeError("fetch failed");
    error.cause = new Error("ECONNREFUSED");
    throw error;
  });
  await assert.rejects(() => api.get("/x"), (error) => error.message === "could not connect to the Plane API");
});

test("surfaces the real error message for non-network local failures (no network hint)", async () => {
  const api = new PlaneApi(config, async () => {
    throw new TypeError("Request with GET/HEAD method cannot have body.");
  });
  await assert.rejects(() => api.get("/x"), (error) => error.message === "Request with GET/HEAD method cannot have body." && !error.help);
});
