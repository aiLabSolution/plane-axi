import { createRequire } from "node:module";

// Read the package version once at module load (no per-request JSON.parse churn). Both the
// API User-Agent and the `version` command read it, so it resolves in exactly one place.
export const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version;
