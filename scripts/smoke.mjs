import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const required = [
  "dist/server/index.js",
  "dist/cli/aedis.js",
  "dist/build-info.json",
  "README.md",
  ".env.example",
  "SECURITY.md",
  "CHANGELOG.md",
];

const missing = required.filter((path) => !existsSync(join(root, path)));
if (missing.length > 0) {
  console.error("[smoke] missing required release artifact(s):");
  for (const path of missing) console.error(`  - ${path}`);
  process.exit(1);
}

const buildInfo = JSON.parse(readFileSync(join(root, "dist/build-info.json"), "utf8"));
if (!buildInfo.version || !buildInfo.commit) {
  console.error("[smoke] dist/build-info.json must include version and commit");
  process.exit(1);
}

console.log(`[smoke] OK - dist artifacts present for version ${buildInfo.version} (${String(buildInfo.commit).slice(0, 8)})`);
