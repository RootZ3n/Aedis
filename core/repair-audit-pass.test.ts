import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRepairAuditPass, type RepairAuditResult } from "./repair-audit-pass.js";
import type { ChangeSet } from "./change-set.js";
import { decideMerge, type MergeGateInputs } from "./merge-gate.js";

/**
 * Phase 5 — repair-audit-pass tests.
 *
 * Lock in:
 *   - The pass reports findings on dirty cases (e.g. broken imports).
 *   - The pass reports zero findings on clean cases.
 *   - The result NEVER carries `repairsApplied` or `repairsAttempted`
 *     (those would imply repair behavior that doesn't exist).
 *   - The `auditOnly: true` invariant is always set.
 *   - The merge gate treats audit findings as ADVISORY signal —
 *     they never block on their own.
 *   - No language anywhere claims a "repair was applied" or
 *     "repair was attempted".
 */

function emptyChangeSet(filesInScope: { path: string }[]): ChangeSet {
  return {
    filesInScope: filesInScope.map((f) => ({
      path: f.path,
      mutationRole: "write-required",
      mutationExpected: true,
      mutationReason: "test fixture",
    })),
    invariants: [],
    dependencyRelationships: {},
    coherenceVerdict: { coherent: true, reasons: [] },
  } as unknown as ChangeSet;
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "aedis-repair-audit-"));
}

test("repair-audit reports findings on a broken named-import case", async () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    // a.ts imports `missingExport` from b.ts, but b.ts doesn't export it.
    writeFileSync(
      join(root, "src", "a.ts"),
      "import { missingExport } from \"./b\";\nexport const x = 1;\nexport function use() { return missingExport; }\n",
      "utf-8",
    );
    writeFileSync(
      join(root, "src", "b.ts"),
      "export const presentExport = 2;\n",
      "utf-8",
    );

    const result = await runRepairAuditPass(
      emptyChangeSet([{ path: "src/a.ts" }, { path: "src/b.ts" }]),
      root,
    );

    assert.equal(result.auditOnly, true, "auditOnly invariant must be set");
    assert.equal(result.findingsCount, result.findings.length);
    assert.ok(result.findingsCount >= 1, "at least one finding expected");
    assert.ok(
      result.findings.some((f) => f.includes("missingExport")),
      `expected the missing-export finding, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair-audit returns zero findings on a clean change-set", async () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "a.ts"),
      "import { presentExport } from \"./b\";\nexport function use() { return presentExport; }\n",
      "utf-8",
    );
    writeFileSync(
      join(root, "src", "b.ts"),
      "export const presentExport = 2;\n",
      "utf-8",
    );

    const result = await runRepairAuditPass(
      emptyChangeSet([{ path: "src/a.ts" }, { path: "src/b.ts" }]),
      root,
    );

    assert.equal(result.auditOnly, true);
    assert.deepEqual(result.findings, []);
    assert.equal(result.findingsCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair-audit result shape never exposes repairsApplied or repairsAttempted", async () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf-8");

    const result: RepairAuditResult = await runRepairAuditPass(
      emptyChangeSet([{ path: "src/a.ts" }]),
      root,
    );

    // The new shape lists exactly: findings, findingsCount, auditOnly.
    const keys = Object.keys(result).sort();
    assert.deepEqual(
      keys,
      ["auditOnly", "findings", "findingsCount"],
      "audit result must expose only findings, findingsCount, auditOnly",
    );

    // No legacy fields under any name.
    assert.equal(("repairsApplied" in (result as unknown as Record<string, unknown>)), false);
    assert.equal(("repairsAttempted" in (result as unknown as Record<string, unknown>)), false);
    assert.equal(("issues" in (result as unknown as Record<string, unknown>)), false);

    // Type-level invariant: literal true.
    assert.equal(result.auditOnly, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair-audit is robust on empty scope and still asserts audit-only", async () => {
  const root = makeProject();
  try {
    const result = await runRepairAuditPass(emptyChangeSet([]), root);
    assert.equal(result.auditOnly, true);
    // The empty-scope sentinel finding includes the explicit "no
    // repairs attempted" disclaimer so any downstream reader sees the
    // audit-only stance.
    assert.ok(result.findings.length === 1);
    assert.match(result.findings[0]!, /no repairs attempted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merge-gate treats every repair-audit finding as advisory, never critical", () => {
  const inputs: MergeGateInputs = {
    // Pass null for judgment + verification — the gate accepts nulls
    // and we only want to exercise the change-set-gate path here.
    judgment: null,
    verification: null,
    cancelled: false,
    hasFailedNodes: false,
    changeSetGate: {
      changeSet: emptyChangeSet([{ path: "src/a.ts" }]),
      allWavesComplete: true,
      invariantsSatisfied: true,
      invariantCount: 0,
      repairAudit: {
        findings: [
          "src/a.ts: broken import target \"./missing\"",
          "src/a.ts: stale reference marker detected (TODO rename)",
        ],
        findingsCount: 2,
        auditOnly: true,
      },
    },
  };

  const decision = decideMerge(inputs);

  // Both findings should appear as advisory under the new code.
  // (We don't assert decision.action — the gate may block for
  // judgment/verification reasons unrelated to the audit. The Phase 5
  // contract is that audit findings are advisory, never critical.)
  const auditFindings = decision.findings.filter(
    (f) => f.code === "change-set:repair-audit",
  );
  assert.equal(auditFindings.length, 2);
  for (const f of auditFindings) {
    assert.equal(f.severity, "advisory");
    assert.equal(f.source, "change-set-gate");
  }

  // No legacy "change-set:repair" code should be emitted any longer.
  assert.equal(
    decision.findings.filter((f) => f.code === "change-set:repair").length,
    0,
  );

  // None of the audit findings should land in the critical bucket.
  const auditCritical = decision.critical.filter(
    (f) => f.code === "change-set:repair-audit",
  );
  assert.deepEqual(auditCritical, []);
});

test("merge-gate produces no audit findings when the audit is clean", () => {
  const inputs: MergeGateInputs = {
    // Pass null for judgment + verification — the gate accepts nulls
    // and we only want to exercise the change-set-gate path here.
    judgment: null,
    verification: null,
    cancelled: false,
    hasFailedNodes: false,
    changeSetGate: {
      changeSet: emptyChangeSet([{ path: "src/a.ts" }]),
      allWavesComplete: true,
      invariantsSatisfied: true,
      invariantCount: 0,
      repairAudit: { findings: [], findingsCount: 0, auditOnly: true },
    },
  };

  const decision = decideMerge(inputs);
  // Clean audit must produce zero audit findings (regardless of
  // overall action, which depends on judgment/verification).
  assert.equal(
    decision.findings.filter((f) => f.code === "change-set:repair-audit").length,
    0,
  );
});

test("merge-gate finding messages do NOT claim any repair was applied", () => {
  const inputs: MergeGateInputs = {
    // Pass null for judgment + verification — the gate accepts nulls
    // and we only want to exercise the change-set-gate path here.
    judgment: null,
    verification: null,
    cancelled: false,
    hasFailedNodes: false,
    changeSetGate: {
      changeSet: emptyChangeSet([{ path: "src/a.ts" }]),
      allWavesComplete: true,
      invariantsSatisfied: true,
      invariantCount: 0,
      repairAudit: {
        findings: ["src/a.ts: broken import target \"./missing\""],
        findingsCount: 1,
        auditOnly: true,
      },
    },
  };

  const decision = decideMerge(inputs);

  // Belt-and-braces: no message in the decision (findings, summary,
  // primaryBlockReason) should claim a successful repair.
  const allText = [
    decision.summary,
    decision.primaryBlockReason,
    ...decision.findings.map((f) => f.message),
    ...decision.findings.map((f) => f.code),
  ].join(" \n ");

  assert.doesNotMatch(
    allText,
    /\brepairs?\s*(?:applied|completed|succeeded|fixed)\b/i,
    "merge-gate output must never claim repair behavior",
  );
});
