/**
 * CrucibulumClient — HTTP client for Aedis → Crucibulum integration.
 *
 * Submits evaluation requests, polls for completion, and retrieves
 * structured results. All failures are contained — a Crucibulum
 * outage never corrupts an Aedis run.
 *
 * The client speaks to Crucibulum's existing HTTP API:
 *   POST /api/run          — submit a task evaluation
 *   GET  /api/run/:id/status — poll for completion
 *   GET  /api/runs/:id     — retrieve full evidence bundle
 *   GET  /api/runs/:id/summary — retrieve evaluation summary
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface CrucibulumConfig {
  /** Whether post-run evaluation is enabled. */
  readonly enabled: boolean;
  /** Base URL for the Crucibulum API. */
  readonly baseUrl: string;
  /** Crucibulum task IDs to run. If empty, uses default task set. */
  readonly tasks: readonly string[];
  /** Adapter label for the model that produced the Aedis build. */
  readonly adapterLabel: string;
  /** Model label for the model that produced the Aedis build. */
  readonly modelLabel: string;
  /** Run outcomes that trigger evaluation. */
  readonly triggerOnOutcome: readonly TriggerOutcome[];
  /** Maximum time to wait for Crucibulum to complete (ms). */
  readonly timeoutMs: number;
  /** Poll interval when waiting for results (ms). */
  readonly pollIntervalMs: number;
  /** Maximum number of retry attempts on transient failures. */
  readonly maxRetries: number;
}

export type TriggerOutcome =
  | "success"
  | "partial"
  | "review_required";

export const DEFAULT_CRUCIBULUM_CONFIG: CrucibulumConfig = {
  enabled: false,
  baseUrl: "http://localhost:18795",
  tasks: ["spec-001"],
  adapterLabel: "aedis",
  modelLabel: "aedis-build",
  triggerOnOutcome: ["success", "partial"],
  timeoutMs: 300_000,  // 5 minutes
  pollIntervalMs: 3_000,
  maxRetries: 2,
};

// ─── Crucibulum Response Types (subset of what the API returns) ─────

export interface CrucibulumRunResponse {
  readonly ok: boolean;
  readonly run_id: string;
}

export interface CrucibulumStatusResponse {
  readonly id: string;
  readonly status: "running" | "complete" | "error";
  readonly bundle?: CrucibulumBundleSummary;
  readonly error?: string;
}

export interface CrucibulumBundleSummary {
  readonly bundle_id: string;
  readonly task: { readonly id: string; readonly family: string; readonly difficulty: string };
  readonly score: {
    readonly total: number;
    readonly total_percent: number;
    readonly pass: boolean;
    readonly pass_threshold: number;
    readonly breakdown: {
      readonly correctness: number;
      readonly regression: number;
      readonly integrity: number;
      readonly efficiency: number;
    };
    readonly breakdown_percent: {
      readonly correctness: number;
      readonly regression: number;
      readonly integrity: number;
      readonly efficiency: number;
    };
    readonly integrity_violations: number;
  };
  readonly diagnosis: {
    readonly failure_mode: string | null;
    readonly localized_correctly: boolean;
    readonly avoided_decoys: boolean;
  };
  readonly usage: {
    readonly tokens_in: number;
    readonly tokens_out: number;
    readonly estimated_cost_usd: number;
  };
}

// ─── Client ─────────────────────────────────────────────────────────

export class CrucibulumClient {
  private config: CrucibulumConfig;

  constructor(config: Partial<CrucibulumConfig> = {}) {
    this.config = { ...DEFAULT_CRUCIBULUM_CONFIG, ...config };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if Crucibulum is reachable.
   */
  async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const response = await this.fetch("/api/judge", "GET");
      return response.ok
        ? { ok: true }
        : { ok: false, reason: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  /**
   * Submit a task evaluation to Crucibulum.
   * Returns the run ID for polling, or null on failure.
   */
  async submitRun(taskId: string): Promise<string | null> {
    try {
      const body = {
        task: taskId,
        model: this.config.modelLabel,
        adapter: this.config.adapterLabel,
        count: 1,
      };

      const response = await this.fetch("/api/run", "POST", body);
      if (!response.ok) {
        console.log(`[crucibulum-client] submit failed: HTTP ${response.status}`);
        return null;
      }

      const data = await response.json() as CrucibulumRunResponse;
      return data.ok ? data.run_id : null;
    } catch (err) {
      console.log(`[crucibulum-client] submit error: ${err}`);
      return null;
    }
  }

  /**
   * Poll for run completion. Returns the status, or null on failure.
   */
  async checkStatus(runId: string): Promise<CrucibulumStatusResponse | null> {
    try {
      const response = await this.fetch(`/api/run/${runId}/status`, "GET");
      if (!response.ok) return null;
      return await response.json() as CrucibulumStatusResponse;
    } catch {
      return null;
    }
  }

  /**
   * Retrieve the full evidence bundle for a completed run.
   */
  async getBundle(bundleId: string): Promise<CrucibulumBundleSummary | null> {
    try {
      const response = await this.fetch(`/api/runs/${bundleId}/summary`, "GET");
      if (!response.ok) return null;
      return await response.json() as CrucibulumBundleSummary;
    } catch {
      return null;
    }
  }

  /**
   * Submit a task and wait for completion. Returns the bundle summary
   * or null if the evaluation failed or timed out.
   */
  async submitAndWait(taskId: string): Promise<CrucibulumBundleSummary | null> {
    const runId = await this.submitRun(taskId);
    if (!runId) return null;

    const deadline = Date.now() + this.config.timeoutMs;

    while (Date.now() < deadline) {
      await sleep(this.config.pollIntervalMs);

      const status = await this.checkStatus(runId);
      if (!status) continue;

      if (status.status === "complete" && status.bundle) {
        return status.bundle;
      }
      if (status.status === "error") {
        console.log(`[crucibulum-client] run ${runId} errored: ${status.error}`);
        return null;
      }
    }

    console.log(`[crucibulum-client] run ${runId} timed out after ${this.config.timeoutMs}ms`);
    return null;
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────

  private async fetch(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    return globalThis.fetch(url, options);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
