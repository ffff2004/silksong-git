import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const WEB_APP_ROOT = path.join(REPO_ROOT, "apps", "web");
