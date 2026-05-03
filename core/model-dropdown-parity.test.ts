/**
 * Pin the contract that every dropdown role in the worker-models
 * panel sees the SAME list of models — the full registry view that
 * the coordinator already enumerates.
 *
 * The bug this guards against: Builder, Critic, and Escalation each
 * had their own per-role provider allow-list (`ROLE_PROVIDERS`),
 * which meant operators couldn't (e.g.) put Opus behind Critic even
 * though Aedis would happily dispatch it. The lists also drifted
 * out of sync with the coordinator's full registry view.
 *
 * Contract:
 *   1. There is no per-role provider allow-list for any dropdown
 *      role (builder, critic, integrator, escalation, coordinator).
 *      Only `scout` and `verifier` may stay local-only — they are
 *      rendered as fixed text, not dropdowns.
 *   2. `rebuildModelOptions` produces the SAME unified list for every
 *      dropdown role from the live provider registry.
 *   3. The seeded fallback (`SEED_DROPDOWN_OPTIONS`) gives every
 *      dropdown role the same superset before /config/providers
 *      lands.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HTML = readFileSync(join(__dirname, "..", "ui", "index.html"), "utf8");

test("ROLE_PROVIDERS no longer carries per-role allow-lists for dropdown roles", () => {
  // The remaining ROLE_PROVIDERS entries should ONLY cover the
  // fixed-local roles (scout, verifier). builder / critic /
  // integrator / escalation / coordinator must not be on the
  // allow-list — that's the bug class we eliminated.
  const idx = HTML.indexOf("const ROLE_PROVIDERS = {");
  assert.ok(idx > 0, "ROLE_PROVIDERS literal must exist");
  const end = HTML.indexOf("};", idx);
  const block = HTML.slice(idx, end);
  // Allowed entries:
  assert.match(block, /scout:\s*\['local'\]/);
  assert.match(block, /verifier:\s*\['local'\]/);
  // Forbidden entries:
  assert.doesNotMatch(block, /builder\s*:/);
  assert.doesNotMatch(block, /critic\s*:/);
  assert.doesNotMatch(block, /integrator\s*:/);
  assert.doesNotMatch(block, /escalation\s*:/);
  assert.doesNotMatch(block, /coordinator\s*:/);
});

test("FIXED_LOCAL_ROLES guards only scout + verifier", () => {
  assert.match(HTML, /const FIXED_LOCAL_ROLES = new Set\(\['scout', 'verifier'\]\)/);
});

test("seeded MODEL_OPTIONS gives every dropdown role the same SEED_DROPDOWN_OPTIONS", () => {
  // The seed must define a single list of options that's spread into
  // every dropdown role.
  assert.match(HTML, /const SEED_DROPDOWN_OPTIONS = \[/);
  for (const role of ["builder", "critic", "integrator", "escalation", "coordinator"]) {
    const re = new RegExp(`${role}:\\s*\\[\\.\\.\\.SEED_DROPDOWN_OPTIONS\\]`);
    assert.match(HTML, re, `${role} must seed from SEED_DROPDOWN_OPTIONS`);
  }
  // Scout/Verifier still render local-only.
  assert.match(HTML, /scout: \[\{ model: 'local', provider: 'local', label: 'local' \}\]/);
  assert.match(HTML, /verifier: \[\{ model: 'local', provider: 'local', label: 'local' \}\]/);
});

test("rebuildModelOptions enumerates the WHOLE registry and assigns the same list to every dropdown role", () => {
  const idx = HTML.indexOf("function rebuildModelOptions(registry)");
  assert.ok(idx > 0);
  const block = HTML.slice(idx, idx + 3_000);
  // No more per-role `ROLE_PROVIDERS[role]` filter for dropdowns.
  assert.doesNotMatch(block, /allowed = ROLE_PROVIDERS\[role\]/);
  // Iterates every provider name in the registry.
  assert.match(block, /Object\.keys\(registry/);
  // Every dropdown role gets `unified.slice\(\)` (i.e., the same list).
  assert.match(block, /unified\.slice\(\)/);
  // Fixed-local roles still resolve to the local sentinel.
  assert.match(block, /FIXED_LOCAL_ROLES\.has\(role\)/);
});
