/**
 * Reliability Runner — I/O boundary for the reliability harness.
 *
 * A TaskRunner submits one reliability task and returns a normalized
 * receipt. The default implementation drives Aedis over HTTP exactly
 * the way a human would: POST /tasks, then poll GET /tasks/:id/receipts
 * until a terminal receipt arrives. Tests use a StubRunner to avoid
 * booting the server.
 */

import type { ErrorType, ReliabilityTask } from "./reliability-harness.js";

/**
 * Normalized receipt the harness actually cares about. Mapped from the
 * full Aedis RunReceipt so the harness doesn't couple to every field.
 */
export interface RunnerReceipt {
  readonly verdict: string; // "success" | "partial" | "failed" | "aborted" | ...
  readonly executionVerified: boolean;
  readonly filesChanged: readonly string[];
  readonly commitSha: string | null;
  readonly iterations: number;
  readonly costUsd: number;
  readonly verificationConfidence: number;
  readonly diffLines?: number;
  readonly errorType?: ErrorType;
  readonly verificationFailed?: boolean;
  readonly compileFailed?: boolean;
  readonly testsFailed?: boolean;
  readonly lintFailed?: boolean;
  /**
   * Phase 9 — verbatim `code` from humanSummary.failureExplanation on
   * the Aedis RunReceipt. The coordinator already classifies failures
   * into a rich taxonomy (no-op, merge-blocked, verify-typecheck,
   * verify-test, worker-issue, etc.); we pass that through so the
   * harness can map it onto ErrorType instead of losing the signal.
   */
  readonly failureCode?: string;
  /**
   * Execution-gate human-readable reason, always populated by the
   * coordinator. Used as a fallback when humanSummary is absent
   * (early-exit paths) and as a diagnostic note on TaskResult.
   */
  readonly executionGateReason?: string;
}

export interface TaskRunner {
  run(task: ReliabilityTask): Promise<RunnerReceipt>;
}

// ─── HTTP runner ─────────────────────────────────────────────────────

export interface HttpRunnerConfig {
  readonly apiBase: string;
  /** Fetch implementation — injectable for tests. */
  readonly fetcher?: typeof fetch;
  /** Default timeout per task if ReliabilityTask.timeoutMs is unset. */
  readonly defaultTimeoutMs?: number;
  /** Poll interval while waiting for a receipt. */
  readonly pollIntervalMs?: number;
  /** Wall-clock source — injectable for tests. */
  readonly now?: () => number;
  /** Sleep — injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 min
const DEFAULT_POLL_MS = 2_000;

export class HttpTaskRunner implements TaskRunner {
  private readonly fetcher: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: HttpRunnerConfig) {
    this.fetcher = config.fetcher ?? fetch;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.now = config.now ?? (() => Date.now());
    this.sleep =
      config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(task: ReliabilityTask): Promise<RunnerReceipt> {
    const submitRes = await this.fetcher(`${this.config.apiBase}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: task.prompt,
        repoPath: task.repoPath,
      }),
    });
    if (!submitRes.ok) {
      const body = await submitRes.text().catch(() => "");
      throw new Error(
        `POST /tasks failed: ${submitRes.status} ${submitRes.statusText} — ${body}`
      );
    }
    const submitBody = (await submitRes.json()) as {
      task_id?: string;
      status?: string;
      question?: string;
    };

    // Pre-execution gate responses are NOT runtime errors. The server
    // refused to run because the prompt was ambiguous (needs_clarification)
    // or too large (needs_decomposition). Surface them as a dedicated
    // failed receipt so the harness classifies them distinctly from
    // thrown exceptions. Before this, the runner threw "task rejected:
    // needs_clarification" — which runTrial bucketed as runtime_exception
    // because the message doesn't match /timeout/, masking the real
    // signal that the prompt simply lacked a file path.
    if (submitBody.status === "needs_clarification") {
      return gateRefusedReceipt("ambiguous_prompt", submitBody.question);
    }
    if (submitBody.status === "needs_decomposition") {
      return gateRefusedReceipt(
        "needs_decomposition",
        "task too large — decomposition plan returned without auto-approval",
      );
    }
    if (!submitBody.task_id) {
      throw new Error(`submit response missing task_id: ${JSON.stringify(submitBody)}`);
    }
    const taskId = submitBody.task_id;

    const timeout = task.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = this.now() + timeout;

    while (this.now() < deadline) {
      const pollRes = await this.fetcher(
        `${this.config.apiBase}/tasks/${encodeURIComponent(taskId)}/receipts`
      );
      if (pollRes.ok) {
        const body = (await pollRes.json()) as { receipt?: unknown };
        const receipt = normalizeReceipt(body.receipt);
        if (receipt && isTerminal(receipt.verdict)) {
          return receipt;
        }
      } else if (pollRes.status !== 404) {
        const body = await pollRes.text().catch(() => "");
        throw new Error(
          `GET /tasks/${taskId}/receipts failed: ${pollRes.status} ${pollRes.statusText} — ${body}`
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`task ${taskId} did not terminate within ${timeout}ms (timeout)`);
  }
}

function isTerminal(verdict: string | undefined): boolean {
  if (!verdict) return false;
  return ["success", "partial", "failed", "aborted"].includes(verdict);
}

/**
 * Synthesize a RunnerReceipt for pre-execution gate refusals
 * (needs_clarification / needs_decomposition). These are not runtime
 * errors; the server deliberately refused to run. Returning a receipt
 * with a dedicated errorType lets the harness classify and cluster
 * them correctly instead of bucketing them as runtime_exception.
 */
export function gateRefusedReceipt(
  errorType: ErrorType,
  _detail: string | undefined,
): RunnerReceipt {
  return {
    verdict: "failed",
    executionVerified: false,
    filesChanged: [],
    commitSha: null,
    iterations: 0,
    costUsd: 0,
    verificationConfidence: 0,
    diffLines: 0,
    errorType,
  };
}

/**
 * Map an Aedis RunReceipt-shaped blob into the harness's normalized
 * RunnerReceipt. Unknown shapes return null so the poller keeps waiting.
 */
export function normalizeReceipt(raw: unknown): RunnerReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  if (typeof r["verdict"] !== "string") return null;

  const evidence: Array<{ operation?: string; path?: string; kind?: string; ref?: string }> = Array.isArray(
    r["executionEvidence"]
  )
    ? r["executionEvidence"]
    : [];
  const filesChanged: string[] = [];
  for (const e of evidence) {
    if (!e || typeof e !== "object") continue;
    const path =
      typeof e.path === "string"
        ? e.path
        : typeof e.ref === "string"
          ? e.ref
          : null;
    if (!path) continue;
    const isFileEvidence =
      e.operation === "modified" ||
      e.operation === "created" ||
      e.operation === "deleted" ||
      e.kind === "file_modified" ||
      e.kind === "file_created" ||
      e.kind === "file_deleted";
    if (isFileEvidence) {
      filesChanged.push(path);
    }
  }

  const conf =
    typeof r["humanSummary"]?.confidence === "number"
      ? r["humanSummary"].confidence
      : typeof r["verificationReceipt"]?.confidenceScore === "number"
        ? r["verificationReceipt"].confidenceScore
        : typeof r["verificationReceipt"]?.confidence === "number"
          ? r["verificationReceipt"].confidence
        : typeof r["confidence"] === "number"
          ? r["confidence"]
          : 0;

  const cost =
    typeof r["totalCost"]?.estimatedCostUsd === "number"
      ? r["totalCost"].estimatedCostUsd
      : typeof r["totalCost"]?.usd === "number"
        ? r["totalCost"].usd
      : typeof r["costUsd"] === "number"
        ? r["costUsd"]
        : 0;

  const iters =
    typeof r["summary"]?.iterations === "number"
      ? r["summary"].iterations
      : typeof r["iterations"] === "number"
        ? r["iterations"]
        : 1;

  const diffLines =
    typeof r["blastRadius"]?.linesChanged === "number"
      ? r["blastRadius"].linesChanged
      : undefined;

  // Phase 9 — pull the coordinator's failure taxonomy through so the
  // harness can classify post-pipeline failures concretely. Before
  // this, humanSummary.failureExplanation.code was ignored and every
  // failed run fell back to "unknown".
  const failureCode =
    typeof r["humanSummary"]?.failureExplanation?.code === "string"
      ? r["humanSummary"].failureExplanation.code
      : undefined;
  const executionGateReason =
    typeof r["executionGateReason"] === "string"
      ? r["executionGateReason"]
      : undefined;

  // Specific signals derived from verification stages so the picker
  // can distinguish compile / test / lint failures even when
  // failureCode is absent (e.g. older receipts, partial shapes).
  const stages: Array<{ kind?: string; passed?: boolean }> = Array.isArray(
    r["verificationReceipt"]?.stages,
  )
    ? r["verificationReceipt"].stages
    : [];
  const failedStages = stages.filter(
    (s) => s && typeof s === "object" && s.passed === false,
  );
  const compileFailed = failedStages.some(
    (s) => s.kind === "typecheck" || s.kind === "compile",
  );
  const testsFailed = failedStages.some((s) => s.kind === "tests" || s.kind === "test");
  const lintFailed = failedStages.some((s) => s.kind === "lint");

  return {
    verdict: r["verdict"],
    executionVerified: Boolean(r["executionVerified"]),
    filesChanged,
    commitSha: typeof r["commitSha"] === "string" ? r["commitSha"] : null,
    iterations: iters,
    costUsd: cost,
    verificationConfidence: conf,
    diffLines,
    verificationFailed:
      r["verificationReceipt"]?.passed === false ||
      r["verificationReceipt"]?.verdict === "fail",
    compileFailed,
    testsFailed,
    lintFailed,
    failureCode,
    executionGateReason,
  };
}
