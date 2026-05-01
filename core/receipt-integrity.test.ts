/**
 * ReceiptStore integrity sidecar — pin the contract:
 *
 *   1. Every patchRun() call writes a `.sig` next to the receipt with
 *      a SHA-256 over the canonical (sort-keys-deep) JSON of the
 *      persisted receipt.
 *   2. `verifyReceiptIntegrity` returns valid:true on a clean
 *      write/read round-trip.
 *   3. Tampering with the receipt (any mutation that changes the
 *      canonical JSON) is detected with a hash-mismatch reason.
 *   4. Removing the sidecar is detected with a sig-missing reason.
 *   5. Canonicalization is invariant to key order — re-serializing
 *      with reshuffled keys still verifies.
 *   6. Coordinator.receiptVerify wraps the same call and prints a
 *      single PASS/FAIL line.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ReceiptStore,
  canonicalizeReceiptJson,
  computeReceiptHash,
  type ReceiptSignature,
} from "./receipt-store.js";

// ─── Pure helpers ────────────────────────────────────────────────────

test("canonicalizeReceiptJson: object-key reorder produces identical bytes", () => {
  const a = canonicalizeReceiptJson({ b: 2, a: 1, c: 3 });
  const b = canonicalizeReceiptJson({ c: 3, a: 1, b: 2 });
  assert.equal(a, b, "key order must not affect canonical form");
  assert.equal(a, '{"a":1,"b":2,"c":3}');
});

test("canonicalizeReceiptJson: nested objects sorted recursively", () => {
  const out = canonicalizeReceiptJson({ outer: { z: 1, a: 2 }, top: 0 });
  assert.equal(out, '{"outer":{"a":2,"z":1},"top":0}');
});

test("canonicalizeReceiptJson: arrays preserve order", () => {
  // Arrays are ordered data — sorting them would change semantics.
  assert.equal(canonicalizeReceiptJson([3, 1, 2]), "[3,1,2]");
});

test("canonicalizeReceiptJson: undefined keys dropped (matches JSON.stringify)", () => {
  const out = canonicalizeReceiptJson({ a: 1, b: undefined, c: 3 });
  assert.equal(out, '{"a":1,"c":3}');
});

test("computeReceiptHash: hex SHA-256, deterministic for equivalent values", () => {
  const h1 = computeReceiptHash({ b: 2, a: 1 });
  const h2 = computeReceiptHash({ a: 1, b: 2 });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("computeReceiptHash: mutation changes the digest", () => {
  const before = computeReceiptHash({ runId: "r", status: "PROPOSED" });
  const after = computeReceiptHash({ runId: "r", status: "VERIFIED_PASS" });
  assert.notEqual(before, after);
});

// ─── End-to-end with ReceiptStore ───────────────────────────────────

async function seedRun(store: ReceiptStore, runId = "run-sig-1"): Promise<void> {
  await store.beginRun({
    runId,
    intentId: "intent-1",
    prompt: "p",
    taskSummary: "p",
    startedAt: "2026-04-30T10:00:00.000Z",
    phase: "charter",
  });
  await store.patchRun(runId, {
    status: "EXECUTING_IN_WORKSPACE",
    appendCheckpoints: [{
      at: "2026-04-30T10:00:01.000Z",
      type: "worker_step",
      status: "EXECUTING_IN_WORKSPACE",
      phase: "building",
      summary: "builder ran",
    }],
  });
}

test("patchRun writes a .sig sidecar next to the receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-sig-write");
    const runPath = join(root, "state", "receipts", "runs", "run-sig-write.json");
    const sigPath = `${runPath}.sig`;
    assert.ok(existsSync(runPath), "receipt file must exist");
    assert.ok(existsSync(sigPath), ".sig sidecar must exist");

    const sig = JSON.parse(readFileSync(sigPath, "utf-8")) as ReceiptSignature;
    assert.match(sig.sha256, /^[0-9a-f]{64}$/, "sha256 must be 64 hex chars");
    assert.equal(typeof sig.ts, "number", "ts must be unix ms");
    assert.ok(sig.ts > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyReceiptIntegrity: valid on clean round-trip", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-sig-valid");
    const result = await store.verifyReceiptIntegrity("run-sig-valid");
    assert.equal(result.valid, true, `expected valid, got ${result.reason}`);
    assert.equal(result.reason, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyReceiptIntegrity: detects receipt tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-sig-tampered");
    const runPath = join(root, "state", "receipts", "runs", "run-sig-tampered.json");

    // Tamper: read receipt, mutate a field, write back. The .sig
    // still points to the original hash so verification must fail.
    const receipt = JSON.parse(readFileSync(runPath, "utf-8")) as Record<string, unknown>;
    receipt["status"] = "PROMOTED";
    writeFileSync(runPath, JSON.stringify(receipt, null, 2), "utf-8");

    const result = await store.verifyReceiptIntegrity("run-sig-tampered");
    assert.equal(result.valid, false, "tampered receipt must fail verification");
    assert.match(result.reason ?? "", /hash mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyReceiptIntegrity: detects missing .sig sidecar", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-sig-nosig");
    const sigPath = join(root, "state", "receipts", "runs", "run-sig-nosig.json.sig");
    unlinkSync(sigPath);

    const result = await store.verifyReceiptIntegrity("run-sig-nosig");
    assert.equal(result.valid, false);
    assert.match(result.reason ?? "", /signature sidecar not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyReceiptIntegrity: detects missing receipt file", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    const result = await store.verifyReceiptIntegrity("does-not-exist");
    assert.equal(result.valid, false);
    assert.match(result.reason ?? "", /receipt not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyReceiptIntegrity: detects malformed sig sidecar", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-sig-bad");
    const sigPath = join(root, "state", "receipts", "runs", "run-sig-bad.json.sig");
    // Sidecar with no sha256 field — must fail with "missing sha256".
    writeFileSync(sigPath, JSON.stringify({ ts: Date.now() }), "utf-8");
    const result = await store.verifyReceiptIntegrity("run-sig-bad");
    assert.equal(result.valid, false);
    assert.match(result.reason ?? "", /missing sha256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyReceiptIntegrity: stable under key reorder of the receipt file", async () => {
  // A future code change that re-emits the receipt JSON with a
  // different key order MUST NOT invalidate existing sigs.
  // Canonicalization (sort_keys_deep) is the contract that protects us.
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-sig-reorder");
    const runPath = join(root, "state", "receipts", "runs", "run-sig-reorder.json");

    // Re-serialize with a stable but different key order: reverse-sorted.
    const original = JSON.parse(readFileSync(runPath, "utf-8")) as Record<string, unknown>;
    const reverseSorted: Record<string, unknown> = {};
    for (const k of Object.keys(original).sort().reverse()) {
      reverseSorted[k] = original[k];
    }
    writeFileSync(runPath, JSON.stringify(reverseSorted, null, 2), "utf-8");

    const result = await store.verifyReceiptIntegrity("run-sig-reorder");
    assert.equal(
      result.valid,
      true,
      `key reorder must not break verification; got ${result.reason}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchRun updates the .sig on every subsequent write", async () => {
  // The hash must track the latest persisted receipt — old sig
  // pointing at a stale receipt would defeat the whole mechanism
  // because mid-run mutations would silently invalidate.
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-sig-multi");

    const sigPath = join(root, "state", "receipts", "runs", "run-sig-multi.json.sig");
    const sig1 = JSON.parse(readFileSync(sigPath, "utf-8")) as ReceiptSignature;

    // Add another patch — should produce a new hash.
    await store.patchRun("run-sig-multi", {
      status: "VERIFIED_PASS",
      finalClassification: "VERIFIED_SUCCESS",
    });
    const sig2 = JSON.parse(readFileSync(sigPath, "utf-8")) as ReceiptSignature;

    assert.notEqual(sig1.sha256, sig2.sha256, "sig must change when receipt changes");
    const result = await store.verifyReceiptIntegrity("run-sig-multi");
    assert.equal(result.valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Coordinator.receiptVerify wrapper ──────────────────────────────

test("Coordinator.receiptVerify: prints VALID and returns valid:true on a good receipt", async () => {
  const { Coordinator } = await import("./coordinator.js");
  const { WorkerRegistry } = await import("../workers/base.js");
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-coord-valid");
    const coord = new Coordinator(
      { projectRoot: root, stateRoot: root },
      { scores: new Map(), tierThresholds: { fast: 0, standard: 0, premium: 0 } },
      new WorkerRegistry(),
      undefined,
      store,
    );
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      const result = await coord.receiptVerify("run-coord-valid");
      assert.equal(result.valid, true);
      assert.ok(
        lines.some((l) => /run-coord-valid: VALID/.test(l)),
        `expected VALID print line, got: ${JSON.stringify(lines)}`,
      );
    } finally {
      console.log = orig;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Coordinator.receiptVerify: prints INVALID and returns valid:false on tampered receipt", async () => {
  const { Coordinator } = await import("./coordinator.js");
  const { WorkerRegistry } = await import("../workers/base.js");
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-coord-bad");
    const runPath = join(root, "state", "receipts", "runs", "run-coord-bad.json");
    const r = JSON.parse(readFileSync(runPath, "utf-8")) as Record<string, unknown>;
    r["status"] = "PROMOTED";
    writeFileSync(runPath, JSON.stringify(r, null, 2), "utf-8");

    const coord = new Coordinator(
      { projectRoot: root, stateRoot: root },
      { scores: new Map(), tierThresholds: { fast: 0, standard: 0, premium: 0 } },
      new WorkerRegistry(),
      undefined,
      store,
    );
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => errs.push(args.join(" "));
    try {
      const result = await coord.receiptVerify("run-coord-bad");
      assert.equal(result.valid, false);
      assert.ok(
        errs.some((l) => /run-coord-bad: INVALID/.test(l)),
        `expected INVALID print line, got: ${JSON.stringify(errs)}`,
      );
    } finally {
      console.error = orig;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Hash matches canonical form on disk ────────────────────────────

test("computeReceiptHash matches the on-disk receipt's canonical hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipt-sig-"));
  try {
    const store = new ReceiptStore(root);
    await seedRun(store, "run-sig-canonical");
    const runPath = join(root, "state", "receipts", "runs", "run-sig-canonical.json");
    const sigPath = `${runPath}.sig`;

    // Read receipt back from disk → canonicalize → hash. This is the
    // exact path verifyReceiptIntegrity takes; pinning it here makes
    // sure the sig writer and verifier agree on the shape.
    const onDisk = JSON.parse(readFileSync(runPath, "utf-8"));
    const recomputed = computeReceiptHash(onDisk);
    const sig = JSON.parse(readFileSync(sigPath, "utf-8")) as ReceiptSignature;
    assert.equal(recomputed, sig.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
