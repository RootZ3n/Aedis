/**
 * Promotion filter — deny Aedis runtime artifacts from promoted commits.
 *
 * Background: Aedis runs in a disposable workspace and writes runtime
 * state (memory.json, receipt blobs, circuit-breaker state, etc.) to
 * `.aedis/` and `state/` within that workspace. When a verified run
 * is promoted to the source repo, those workspace-local artifacts must
 * not ride along with the user-facing code change. Otherwise a single
 * docstring edit can land a 60-line memory.json into the target repo,
 * which is what happened in run d3524769 (commit 5838aad on
 * absent-pianist, since reverted).
 *
 * This module owns the canonical denylist and is consumed by both
 * workspace-manager.generatePatch (which builds the patch artifact)
 * and coordinator.promoteToSource (defense-in-depth at the staging
 * boundary). The patterns are conservative: only paths Aedis itself
 * writes during a run are excluded, so user-edited config files like
 * `.aedis/model-config.json` and `.aedis/providers.json` continue to
 * promote normally if a task targets them.
 *
 * Distinct from `git-diff-verifier.ts:isIgnoredForDiffCheck` — that
 * one is audit-only (used to ignore noise when verifying that no
 * undeclared changes happened). This one gates what actually ends up
 * in the promoted commit.
 */

/**
 * Paths Aedis writes during a run. Promoted commits MUST exclude these
 * unless the user task explicitly targets them. Patterns are tested
 * against repo-relative POSIX paths (forward-slash separators).
 */
const RUNTIME_ARTIFACT_PATTERNS: readonly RegExp[] = [
  // Project memory snapshot — written by Aedis during/after a run.
  /^\.aedis\/memory\.json$/,
  // Workspace-local receipts (patch-{runId}.diff and friends).
  /^\.aedis\/receipts\//,
  // Reserved for any sub-state Aedis introduces under .aedis/.
  /^\.aedis\/state\//,
  // Circuit breaker + repo-index caches that Aedis maintains.
  /^\.aedis\/circuit-breaker-state\.json$/,
  /^\.aedis\/repo-index\.json$/,
  // Top-level persisted run receipts and memory substrate (Aedis's own
  // state dir; if a target repo somehow ends up with one, deny it).
  /^state\/receipts\//,
  /^state\/memory\//,
  // Disposable workspace remnants. Should never appear in a target
  // repo, but if Aedis-scratch directories ever leak in, deny them.
  /^aedis-ws-/,
];

/**
 * Pathspecs (Git's `:(exclude,glob)<pattern>` magic syntax) that match
 * the same set of runtime artifacts. Pass these to `git diff` /
 * `git status` after a positive pathspec (e.g. `'.'`) so the underlying
 * commands never report runtime files.
 *
 * Keep in sync with RUNTIME_ARTIFACT_PATTERNS above.
 */
export const PROMOTION_EXCLUDE_PATHSPECS: readonly string[] = [
  ":(exclude,glob).aedis/memory.json",
  ":(exclude,glob).aedis/receipts/**",
  ":(exclude,glob).aedis/state/**",
  ":(exclude,glob).aedis/circuit-breaker-state.json",
  ":(exclude,glob).aedis/repo-index.json",
  ":(exclude,glob)state/receipts/**",
  ":(exclude,glob)state/memory/**",
  ":(exclude,glob)aedis-ws-*",
];

/**
 * True when the given repo-relative path is an Aedis runtime artifact
 * that must not be staged into a promoted commit.
 */
export function isRuntimeArtifact(relativePath: string): boolean {
  // Normalize Windows-style separators just in case a caller hands us
  // a raw path from a Windows runner. Git itself always reports POSIX
  // separators, so this is belt-and-suspenders.
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return RUNTIME_ARTIFACT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Filter a list of repo-relative paths down to those that may be
 * promoted to the source repo. Convenience wrapper around
 * isRuntimeArtifact for use in changed-file lists.
 */
export function filterRuntimeArtifacts(paths: readonly string[]): string[] {
  return paths.filter((path) => !isRuntimeArtifact(path));
}
