import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlaneApi, _internals } from "../src/api.js";

const config = { apiKey: "secret", workspace: "labsolution", baseUrl: "https://plane.test/api/v1" };
const noDelay = async () => {};

function response(body, init = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function htmlResponse(status, body, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
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

test("sends a default User-Agent of plane-axi/<package version>", async () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  let seen;
  const api = new PlaneApi(config, async (url, init) => { seen = init; return response({ ok: true }); });
  await api.get("/x");
  assert.equal(seen.headers["User-Agent"], `plane-axi/${version}`);
  assert.equal(_internals.DEFAULT_USER_AGENT, `plane-axi/${version}`);
});

test("PLANE_USER_AGENT overrides the default User-Agent", async () => {
  let seen;
  const api = new PlaneApi(config, async (url, init) => { seen = init; return response({ ok: true }); });
  process.env.PLANE_USER_AGENT = "plane-cli/1.0";
  try {
    await api.get("/x");
  } finally {
    delete process.env.PLANE_USER_AGENT;
  }
  assert.equal(seen.headers["User-Agent"], "plane-cli/1.0");
});

test("an HTML 403 (Cloudflare WAF challenge page) is reported as a WAF block, not an auth failure", async () => {
  const body = "<html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>";
  const api = new PlaneApi(config, async () => htmlResponse(403, body, { "cf-ray": "abc123-SIN" }));
  await assert.rejects(() => api.get("/x"), (error) => error.message === "Cloudflare WAF blocked the request" && /rephrase/.test(error.help) && !/authentication/.test(error.message));
});

test("a JSON 403 is still reported as an authentication failure, not a WAF block", async () => {
  const api = new PlaneApi(config, async () => response({ detail: "not authenticated" }, { status: 403 }));
  await assert.rejects(() => api.get("/x"), (error) => error.message === "Plane authentication failed");
});

test("a GET is retried once on a network failure and succeeds on the second attempt", async () => {
  let calls = 0;
  const api = new PlaneApi(config, async () => {
    calls += 1;
    if (calls === 1) { const error = new TypeError("fetch failed"); error.cause = new Error("ECONNRESET"); throw error; }
    return response({ ok: true });
  }, noDelay);
  const result = await api.get("/x");
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test("a GET still fails after its one retry is also a network failure", async () => {
  let calls = 0;
  const api = new PlaneApi(config, async () => {
    calls += 1;
    const error = new TypeError("fetch failed");
    error.cause = new Error("ECONNRESET");
    throw error;
  }, noDelay);
  await assert.rejects(() => api.get("/x"), (error) => error.message === "could not connect to the Plane API");
  assert.equal(calls, 2);
});

test("a POST is never retried on a network failure (a replay could double-write)", async () => {
  let calls = 0;
  const api = new PlaneApi(config, async () => {
    calls += 1;
    const error = new TypeError("fetch failed");
    error.cause = new Error("ECONNRESET");
    throw error;
  }, noDelay);
  await assert.rejects(() => api.post("/x", { name: "A" }), (error) => error.message === "could not connect to the Plane API");
  assert.equal(calls, 1);
});

test("a GET whose retry times out reports a timeout, not could-not-connect", async () => {
  let calls = 0;
  const api = new PlaneApi(config, async () => {
    calls += 1;
    if (calls === 1) { const error = new TypeError("fetch failed"); error.cause = new Error("ECONNRESET"); throw error; }
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }, noDelay);
  await assert.rejects(() => api.get("/x"), (error) => error.message === "Plane API request timed out");
  assert.equal(calls, 2);
});

test("a GET whose retry raises a non-network error surfaces that real message", async () => {
  let calls = 0;
  const api = new PlaneApi(config, async () => {
    calls += 1;
    if (calls === 1) { const error = new TypeError("fetch failed"); error.cause = new Error("ECONNRESET"); throw error; }
    throw new Error("Request with GET/HEAD method cannot have body.");
  }, noDelay);
  await assert.rejects(() => api.get("/x"), (error) => error.message === "Request with GET/HEAD method cannot have body." && !error.help);
  assert.equal(calls, 2);
});
