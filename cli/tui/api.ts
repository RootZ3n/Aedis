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
 *   POST /tasks                          → submit a new task
 *   POST /approvals/:runId/approve       → approve an awaiting run
 *   POST /approvals/:runId/reject        → reject an awaiting run
 */

const API_BASE = process.env["AEDIS_API_BASE"] ?? "http://localhost:18796";

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

export async function approveRun(runId: string): Promise<unknown> {
  return fetchJson<unknown>(`/approvals/${encodeURIComponent(runId)}/approve`, { method: "POST" });
}

export async function rejectRun(runId: string): Promise<unknown> {
  return fetchJson<unknown>(`/approvals/${encodeURIComponent(runId)}/reject`, { method: "POST" });
}
