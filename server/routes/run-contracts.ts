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

export interface RunDetailResponse {
  readonly id: string;
  readonly taskId: string | null;
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly submittedAt: string;
  readonly completedAt: string | null;
  readonly receipt: unknown | null;
  readonly filesChanged: readonly { path: string; operation: string }[];
  readonly summary: {
    readonly classification: string | null;
    readonly headline: string;
    readonly narrative: string;
    readonly verification: string;
  };
  readonly confidence: unknown;
  readonly errors: readonly { source: string; message: string; suggestedFix?: string }[];
  readonly executionVerified: boolean | null;
  readonly executionGateReason: string | null;
  readonly blastRadius: unknown | null;
  readonly totalCostUsd: number;
  readonly workerEvents: readonly unknown[];
  readonly checkpoints: readonly unknown[];
}

export interface RunIntegrationResponse {
  readonly runId: string;
  readonly status: string;
  readonly integration: {
    readonly verdict: "approved" | "blocked" | "pending" | "not-available";
    readonly summary: string;
    readonly events: readonly unknown[];
    readonly lastCheck: unknown | null;
  };
  readonly workerEvents: readonly unknown[];
  readonly checkpoints: readonly unknown[];
}

export function buildRunListEntry(input: RunListEntry): RunListEntry {
  return input;
}

export function buildRunDetailResponse(input: RunDetailResponse): RunDetailResponse {
  return input;
}

export function buildRunIntegrationResponse(input: RunIntegrationResponse): RunIntegrationResponse {
  return input;
}
