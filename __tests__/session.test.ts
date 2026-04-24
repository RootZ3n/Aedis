/**
 * Session coordinator tests.
 *
 * Covers:
 * 1. Success: multi-cycle completion
 * 2. Retry with learning: compiler error fixed on retry
 * 3. Max-iteration stop: hit maxCycles → failed
 * 4. State continuity: history accumulates
 */

import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert";

// ─── Mock Coordinator ────────────────────────────────────────────────

interface MockBuildResult {
  success: boolean;
  touchedFiles: string[];
  verificationPassed: boolean;
  errorType?: string;
  errorMessage?: string;
  model?: string;
  costUsd?: number;
  runId: string;
}

const mockBuildResults: MockBuildResult[] = [];

function resetMockBuildResults() {
  mockBuildResults.length = 0;
}

const mockCoordinator = {
  buildCycle: mock.fn(async (taskIntent: string, projectRoot: string): Promise<MockBuildResult> => {
    if (mockBuildResults.length === 0) {
      return {
        success: false,
        touchedFiles: [],
        verificationPassed: false,
        errorType: "compile",
        errorMessage: "SyntaxError: Unexpected token",
        runId: "run-1",
      };
    }
    return mockBuildResults.shift()!;
  }),
};

// ─── Session store (in-memory for tests) ─────────────────────────────

interface TestSession {
  id: string;
  status: "active" | "success" | "failed" | "cancelled";
  cycleCount: number;
  cycleHistory: Array<{
    cycleNumber: number;
    outcome: string;
    artifactsProduced: string[];
  }>;
  maxCycles: number;
  terminalReason: string | null;
}

const inMemorySessions = new Map<string, TestSession>();

function createSession(id: string, maxCycles: number): TestSession {
  const session: TestSession = {
    id,
    status: "active",
    cycleCount: 0,
    cycleHistory: [],
    maxCycles,
    terminalReason: null,
  };
  inMemorySessions.set(id, session);
  return session;
}

function appendCycle(
  sessionId: string,
  cycleNumber: number,
  outcome: string,
  artifactsProduced: string[]
): void {
  const session = inMemorySessions.get(sessionId);
  if (!session) return;
  session.cycleHistory.push({ cycleNumber, outcome, artifactsProduced });
}

function terminateSession(
  sessionId: string,
  status: TestSession["status"],
  terminalReason: string
): TestSession {
  const session = inMemorySessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  session.status = status;
  session.terminalReason = terminalReason;
  return session;
}

async function runMockSession(
  id: string,
  maxCycles: number,
  coordinator: typeof mockCoordinator
): Promise<TestSession> {
  const session = createSession(id, maxCycles);

  while (session.status === "active") {
    if (session.cycleCount >= session.maxCycles) {
      return terminateSession(
        session.id,
        "failed",
        `maxCycles (${session.maxCycles}) reached — task not completed`
      );
    }

    const buildResult = await coordinator.buildCycle("task", "/tmp/test");

    if (buildResult.success) {
      appendCycle(session.id, session.cycleCount + 1, "success", buildResult.touchedFiles);
      return terminateSession(session.id, "success", `Goal achieved in ${session.cycleCount + 1} cycle(s)`);
    }

    const outcome = buildResult.errorType === "compile" || buildResult.errorType === "runtime"
      ? "retryable_failure"
      : "fatal_failure";

    appendCycle(session.id, session.cycleCount + 1, outcome, buildResult.touchedFiles);

    if (outcome === "fatal_failure") {
      return terminateSession(session.id, "failed", `Fatal error: ${buildResult.errorMessage}`);
    }

    session.cycleCount++;
  }

  return session;
}

// ─── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetMockBuildResults();
  inMemorySessions.clear();
});

describe("Session Coordinator", () => {

  test("Success: multi-cycle completion — succeeds on first successful build", async () => {
    mockBuildResults.push({
      success: true,
      touchedFiles: ["src/foo.ts"],
      verificationPassed: true,
      runId: "run-1",
    });

    const session = await runMockSession("s1", 3, mockCoordinator);

    assert.strictEqual(session.status, "success");
    assert.strictEqual(session.cycleCount, 0);
    assert.strictEqual(session.cycleHistory.length, 1);
    assert.strictEqual(session.cycleHistory[0].outcome, "success");
    assert.deepStrictEqual(session.cycleHistory[0].artifactsProduced, ["src/foo.ts"]);
    assert.ok(session.terminalReason?.includes("Goal achieved"));
  });

  test("Retry with learning: compiler error fixed on retry — second attempt succeeds", async () => {
    // Cycle 1: compile error
    // Cycle 2: success
    mockBuildResults.push(
      {
        success: false,
        touchedFiles: [],
        verificationPassed: false,
        errorType: "compile",
        errorMessage: "SyntaxError: Unexpected token",
        runId: "run-1",
      },
      {
        success: true,
        touchedFiles: ["src/bar.ts", "src/bar.test.ts"],
        verificationPassed: true,
        runId: "run-2",
      }
    );

    const session = await runMockSession("s2", 3, mockCoordinator);

    assert.strictEqual(session.status, "success");
    assert.strictEqual(session.cycleCount, 1); // incremented after first cycle
    assert.strictEqual(session.cycleHistory.length, 2);
    assert.strictEqual(session.cycleHistory[0].outcome, "retryable_failure");
    assert.strictEqual(session.cycleHistory[1].outcome, "success");
    assert.ok(session.terminalReason?.includes("Goal achieved in 2 cycle(s)"));
  });

  test("Max-iteration stop: hit maxCycles → failed", async () => {
    // All cycles fail with retryable errors — exhausts maxCycles
    mockBuildResults.push(
      {
        success: false,
        touchedFiles: [],
        verificationPassed: false,
        errorType: "runtime",
        errorMessage: "EISDIR: illegal operation on a directory",
        runId: "run-1",
      },
      {
        success: false,
        touchedFiles: [],
        verificationPassed: false,
        errorType: "runtime",
        errorMessage: "EISDIR: illegal operation on a directory",
        runId: "run-2",
      },
      {
        success: false,
        touchedFiles: [],
        verificationPassed: false,
        errorType: "runtime",
        errorMessage: "EISDIR: illegal operation on a directory",
        runId: "run-3",
      }
    );

    const session = await runMockSession("s3", 3, mockCoordinator);

    assert.strictEqual(session.status, "failed");
    assert.strictEqual(session.cycleHistory.length, 3);
    assert.ok(session.terminalReason?.includes("maxCycles"));
    assert.ok(session.terminalReason?.includes("reached"));
  });

  test("State continuity: history accumulates across cycles", async () => {
    // Cycle 1: retryable — touches one file
    // Cycle 2: success — touches two more files
    mockBuildResults.push(
      {
        success: false,
        touchedFiles: ["src/utils.ts"],
        verificationPassed: false,
        errorType: "compile",
        errorMessage: "TypeError: Cannot read property",
        runId: "run-1",
      },
      {
        success: true,
        touchedFiles: ["src/utils.ts", "src/main.ts", "src/index.ts"],
        verificationPassed: true,
        runId: "run-2",
      }
    );

    const session = await runMockSession("s4", 3, mockCoordinator);

    // History should have 2 entries (one per cycle)
    assert.strictEqual(session.cycleHistory.length, 2);

    // First cycle: retryable failure, still recorded
    const [cycle1, cycle2] = session.cycleHistory;
    assert.strictEqual(cycle1.cycleNumber, 1);
    assert.strictEqual(cycle1.outcome, "retryable_failure");
    assert.deepStrictEqual(cycle1.artifactsProduced, ["src/utils.ts"]);

    // Second cycle: success, accumulated files
    assert.strictEqual(cycle2.cycleNumber, 2);
    assert.strictEqual(cycle2.outcome, "success");
    assert.deepStrictEqual(cycle2.artifactsProduced, [
      "src/utils.ts",
      "src/main.ts",
      "src/index.ts",
    ]);

    // Session state preserved correctly
    assert.strictEqual(session.status, "success");
    assert.strictEqual(session.terminalReason?.includes("2 cycle(s)"), true);
  });

});
