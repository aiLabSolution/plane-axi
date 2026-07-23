import { AxiError } from "./errors.js";
import { assertCredentials, envConfig } from "./config.js";

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

export class PlaneApi {
  constructor(config = envConfig(), fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
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
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          "X-API-Key": this.config.apiKey,
          "Content-Type": "application/json",
          "User-Agent": "plane-axi/0.1"
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      if (error?.name === "TimeoutError") {
        throw new AxiError("Plane API request timed out", { help: "Check your network connection and PLANE_BASE_URL" });
      }
      const isNetworkFailure = (error instanceof TypeError && error.cause !== undefined) || error?.message === "fetch failed";
      if (isNetworkFailure) {
        throw new AxiError("could not connect to the Plane API", { help: "Check your network connection and PLANE_BASE_URL" });
      }
      throw new AxiError(error?.message || "unexpected error calling the Plane API");
    }
    if (response.status === 204) return null;
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!response.ok) {
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

export const _internals = { messageFromBody };
