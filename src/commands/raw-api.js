import { UsageError } from "../errors.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export async function rawApi({ api, flags, positionals }) {
  const method = positionals[0].toUpperCase();
  if (!METHODS.has(method)) throw new UsageError(`unsupported HTTP method ${method}`, `Use one of: ${[...METHODS].join(", ")}`);
  if (flags.input !== undefined && (method === "GET" || method === "HEAD")) {
    throw new UsageError(`--input cannot be used with ${method}`, `${method} requests cannot carry a body`);
  }
  let path = positionals[1];
  if (!path.startsWith("/")) path = `/${path}`;
  let data;
  if (flags.input !== undefined) {
    try { data = JSON.parse(flags.input); } catch { throw new UsageError("--input must be valid JSON"); }
  }
  return { response: await api.request(method, path, { data }) };
}
