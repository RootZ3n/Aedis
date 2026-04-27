/**
 * Aedis TUI API wrappers — thin fetch shims over the running server.
 *
 * Mirrors the helpers in cli/aedis.ts but typed to the endpoints the
 * runs dashboard actually consumes. Reads AEDIS_API_BASE the same way
 * cli/aedis.ts does so both surfaces target the same server without
 * extra config.
 *
 * Endpoints used (all already exist):
 *   GET  /runs?limit=N                   → list recent runs
 *   GET  /runs/:id                       → full run detail
 *   POST /tasks                          → submit a new task
 *   POST /approvals/:runId/approve       → approve an awaiting run
 *   POST /approvals/:runId/reject        → reject an awaiting run
 */

const API_BASE = process.env["AEDIS_API_BASE"] ?? "http://localhost:18796";

/**
 * Lane id and workspace role mirror the server-side `Lane` and
 * `WorkspaceRole` types in core/candidate.ts. Kept loose at the TUI
 * boundary so an unknown future value (server adds a third role)
 * still renders rather than crashing the dashboard.
 */
export type CandidateLane = "local" | "cloud";
export type CandidateRole = "primary" | "shadow" | string;
export type CandidateLaneMode =
  | "primary_only"
  | "local_then_cloud"
  | "local_vs_cloud"
  | "cloud_with_local_check"
  | string;

/**
 * Per-candidate row exposed on the run detail. Mirrors the server's
 * CandidateManifestEntry minus the workspace path and patch artifact.
 * All fields besides `workspaceId / role / status` are optional so a
 * legacy receipt (no candidates manifest) round-trips as `undefined`.
 */
export interface CandidateManifestRow {
  readonly workspaceId: string;
  readonly role: CandidateRole;
  readonly lane?: CandidateLane;
  readonly provider?: string;
  readonly model?: string;
  readonly status: string;
  readonly disqualification?: string | null;
  readonly costUsd?: number;
  readonly latencyMs?: number;
  readonly verifierVerdict?: string | null;
  readonly reason?: string;
  readonly criticalFindings?: number;
  readonly advisoryFindings?: number;
  readonly testsPassed?: boolean;
  readonly typecheckPassed?: boolean;
}

export interface RunListEntry {
  readonly id: string;
  readonly runId: string;
  readonly status: string;
  readonly classification: string | null;
  readonly prompt: string;
  readonly summary: string;
  readonly costUsd: number;
  readonly confidence: number;
  readonly timestamp: string;
  readonly completedAt: string | null;
  // ── Phase C additive fields ────────────────────────────────────────
  // Surfaced when the server starts including them on /runs list
  // entries. The TUI treats `undefined` as "single-lane / not
  // applicable" and renders nothing extra, so legacy server responses
  // keep working unchanged.
  readonly laneMode?: CandidateLaneMode;
  readonly candidatesCount?: number;
  readonly selectedCandidateWorkspaceId?: string | null;
  readonly selectedCandidateLane?: CandidateLane;
}

export interface SubmitResponse {
  readonly task_id?: string;
  readonly run_id?: string;
  readonly status?: string;
  readonly message?: string;
  readonly question?: string;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${url}\n${body}`);
  }
  return res.json() as Promise<T>;
}

export async function listRuns(limit = 20): Promise<RunListEntry[]> {
  const data = await fetchJson<{ runs?: RunListEntry[] }>(`/runs?limit=${limit}`);
  return data.runs ?? [];
}

export async function submitRun(prompt: string, repoPath: string): Promise<SubmitResponse> {
  return fetchJson<SubmitResponse>("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, repoPath }),
  });
}

export interface RunDetailData {
  readonly id: string;
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly submittedAt: string;
  readonly completedAt: string | null;
  readonly filesChanged: readonly { path: string; operation: string }[];
  readonly summary: {
    readonly classification: string | null;
    readonly headline: string;
    readonly narrative: string;
    readonly verification: string;
    readonly verificationChecks?: readonly {
      kind: string;
      name: string;
      executed: boolean;
      passed: boolean;
    }[];
    readonly failureExplanation?: {
      code: string;
      rootCause: string;
      stage: string;
      suggestedFix: string;
    } | null;
  };
  readonly confidence: unknown;
  readonly errors: readonly { source: string; message: string; suggestedFix?: string }[];
  readonly totalCostUsd: number;
  // ── Phase C additive fields ────────────────────────────────────────
  // Lifted from `receipt.{candidates, selectedCandidateWorkspaceId,
  // laneMode}` by getRunDetail so screens can read them at the top
  // level without poking at the raw receipt. Always optional —
  // primary_only runs (and pre-Phase-B receipts) leave them undefined.
  readonly laneMode?: CandidateLaneMode;
  readonly candidates?: readonly CandidateManifestRow[];
  readonly selectedCandidateWorkspaceId?: string | null;
}

interface ReceiptWithCandidates {
  readonly candidates?: readonly CandidateManifestRow[];
  readonly selectedCandidateWorkspaceId?: string | null;
  readonly laneMode?: CandidateLaneMode;
}

interface RunDetailWire extends Omit<RunDetailData, "laneMode" | "candidates" | "selectedCandidateWorkspaceId"> {
  readonly receipt?: unknown;
  readonly laneMode?: CandidateLaneMode;
  readonly candidates?: readonly CandidateManifestRow[];
  readonly selectedCandidateWorkspaceId?: string | null;
}

/**
 * Promote `receipt.candidates / receipt.selectedCandidateWorkspaceId /
 * receipt.laneMode` to the top level so screens can stay decoupled
 * from the raw finalReceipt shape. Defensive — accepts top-level
 * fields too in case the server ever surfaces them directly.
 */
function liftCandidateFields(wire: RunDetailWire): RunDetailData {
  const receipt = wire.receipt as ReceiptWithCandidates | null | undefined;
  const candidates = wire.candidates ?? receipt?.candidates;
  const selectedCandidateWorkspaceId =
    wire.selectedCandidateWorkspaceId ?? receipt?.selectedCandidateWorkspaceId;
  const laneMode = wire.laneMode ?? receipt?.laneMode;
  // Strip the raw `receipt` field on the way out — RunDetailData
  // doesn't expose it and screens never read it directly.
  const { receipt: _drop, ...rest } = wire as RunDetailWire & { receipt?: unknown };
  return {
    ...(rest as RunDetailData),
    ...(laneMode !== undefined ? { laneMode } : {}),
    ...(candidates !== undefined ? { candidates } : {}),
    ...(selectedCandidateWorkspaceId !== undefined ? { selectedCandidateWorkspaceId } : {}),
  };
}

export async function getRunDetail(runId: string): Promise<RunDetailData> {
  const wire = await fetchJson<RunDetailWire>(`/runs/${encodeURIComponent(runId)}`);
  return liftCandidateFields(wire);
}

export async function approveRun(runId: string): Promise<unknown> {
  return fetchJson<unknown>(`/approvals/${encodeURIComponent(runId)}/approve`, { method: "POST" });
}

export async function rejectRun(runId: string): Promise<unknown> {
  return fetchJson<unknown>(`/approvals/${encodeURIComponent(runId)}/reject`, { method: "POST" });
}
