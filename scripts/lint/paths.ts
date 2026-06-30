import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const CORE_PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "core");
