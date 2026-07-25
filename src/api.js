import { AxiError } from "./errors.js";
import { assertCredentials, envConfig } from "./config.js";
import { PACKAGE_VERSION } from "./version.js";

// Some Cloudflare-fronted Plane instances filter unrecognised User-Agents, so
// PLANE_USER_AGENT lets an operator override this to a known-safe value
// (e.g. "plane-cli/1.0") per request.
const DEFAULT_USER_AGENT = `plane-axi/${PACKAGE_VERSION}`;

function messageFromBody(body) {
  if (!body) return null;
  if (typeof body === "string") return body.slice(0, 300);
  const candidate = body.error || body.message || body.detail || body.error_message;
  if (typeof candidate === "string") return candidate;
  for (const value of Object.values(body)) {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return null;
}

const NETWORK_HELP = "Check your network connection and PLANE_BASE_URL";

// A fetch rejection is a network blip only if it's an undici TypeError carrying a cause
// (DNS/ECONNREFUSED/reset) or the bare "fetch failed". A TimeoutError and any other error
// are NOT network failures, so they never trigger the GET retry.
function isNetworkFailure(error) {
  return (error instanceof TypeError && error.cause !== undefined) || error?.message === "fetch failed";
}

// Map a fetch rejection to its user-facing AxiError. Applied to BOTH the first attempt and
// the retry so a retry-time timeout (or any non-network error) keeps its true classification
// instead of being flattened into "could not connect".
function classifyFetchError(error) {
  if (error?.name === "TimeoutError") return new AxiError("Plane API request timed out", { help: NETWORK_HELP });
  if (isNetworkFailure(error)) return new AxiError("could not connect to the Plane API", { help: NETWORK_HELP });
  return new AxiError(error?.message || "unexpected error calling the Plane API");
}

// Plane's own 401/403 bodies are JSON. A 401/403 that is HTML (or carries Cloudflare's
// challenge markers/headers) is the WAF blocking the request before it reached Plane —
// reporting it as "authentication failed" sends the caller chasing the wrong fix.
function isCloudflareWaf(status, text, headers) {
  if (status !== 401 && status !== 403) return false;
  const trimmed = (text || "").trim();
  const html = trimmed.startsWith("<");
  if (html || trimmed.includes("Attention Required") || trimmed.includes("Cloudflare")) return true;
  return Boolean(headers.get("cf-mitigated") || headers.get("cf-ray")) && html;
}

export class PlaneApi {
  constructor(config = envConfig(), fetchImpl = globalThis.fetch, delayImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    this.config = config;
    this.fetch = fetchImpl;
    this.delay = delayImpl;
  }

  workspacePath(path = "") {
    return `/workspaces/${encodeURIComponent(this.config.workspace)}${path}`;
  }

  async request(method, path, { data, query } = {}) {
    assertCredentials(this.config);
    const url = new URL(`${this.config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const buildInit = () => ({
      method,
      headers: {
        "X-API-Key": this.config.apiKey,
        "Content-Type": "application/json",
        "User-Agent": process.env.PLANE_USER_AGENT || DEFAULT_USER_AGENT
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(30_000)
    });
    let response;
    try {
      response = await this.fetch(url, buildInit());
    } catch (error) {
      // Idempotent reads get one retry after a network blip; a replayed POST could
      // double-write, so only GET ever retries (port of planelib.py's rule). The retry's
      // own failure is re-classified so a retry-time timeout stays a timeout.
      if (method === "GET" && isNetworkFailure(error)) {
        await this.delay(1000);
        try {
          response = await this.fetch(url, buildInit());
        } catch (retryError) {
          throw classifyFetchError(retryError);
        }
      } else {
        throw classifyFetchError(error);
      }
    }
    if (response.status === 204) return null;
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!response.ok) {
      if (isCloudflareWaf(response.status, text, response.headers)) {
        throw new AxiError("Cloudflare WAF blocked the request", {
          help: "Some Cloudflare-fronted Plane instances block bodies that look like path traversal (`../`) or literal shell command lines; rephrase the body and retry",
          status: response.status
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new AxiError("Plane authentication failed", { help: "Check PLANE_API_KEY and workspace access", status: response.status });
      }
      if (response.status === 404) throw new AxiError("Plane resource not found", { help: "Check the workspace and reference", status: 404 });
      if (response.status === 429) {
        const reset = response.headers.get("x-ratelimit-reset");
        throw new AxiError("Plane API rate limit reached", { help: reset ? `Retry after ${reset}` : "Wait briefly, then retry", status: 429 });
      }
      throw new AxiError(messageFromBody(body) || `Plane API request failed with HTTP ${response.status}`, { status: response.status });
    }
    return body;
  }

  get(path, query) { return this.request("GET", path, { query }); }
  post(path, data) { return this.request("POST", path, { data }); }
  patch(path, data) { return this.request("PATCH", path, { data }); }
  delete(path) { return this.request("DELETE", path); }

  async page(path, query = {}) {
    const body = await this.get(path, { per_page: 100, ...query });
    if (Array.isArray(body)) return { results: body, total: body.length, nextCursor: null };
    const results = body?.results || [];
    return {
      results,
      total: Number(body?.total_results ?? results.length),
      nextCursor: body?.next_page_results ? body?.next_cursor : null
    };
  }

  async all(path, query = {}) {
    const results = [];
    let cursor;
    let total = 0;
    do {
      const page = await this.page(path, { ...query, ...(cursor ? { cursor } : {}) });
      results.push(...page.results);
      total = page.total;
      cursor = page.nextCursor;
    } while (cursor);
    return { results, total: Math.max(total, results.length) };
  }
}

export const _internals = { messageFromBody, isCloudflareWaf, DEFAULT_USER_AGENT };
