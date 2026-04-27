/**
 * IntentObject — The immutable build directive.
 *
 * Once created by the Coordinator, the IntentObject is the single source of truth
 * for what a build run is trying to accomplish. Workers read it, never write it.
 * Only the Coordinator may create a new version at explicit checkpoints.
 */

import { randomUUID } from "crypto";

// ─── Schema ──────────────────────────────────────────────────────────

export interface IntentObject {
  /** Unique ID for this intent version */
  readonly id: string;
  /** ID of the build run this intent belongs to */
  readonly runId: string;
  /** Monotonically increasing version — v1 is the original, v2+ are checkpoint revisions */
  readonly version: number;
  /** ID of the previous version, null for v1 */
  readonly parentId: string | null;
  /** ISO timestamp of creation */
  readonly createdAt: string;

  /** The original user request, verbatim */
  readonly userRequest: string;
  /** Structured build objective produced by CharterGenerator */
  readonly charter: Charter;
  /** Constraints the build must respect */
  readonly constraints: readonly Constraint[];
  /** Assumptions the Coordinator accepted — visible to all workers */
  readonly acceptedAssumptions: readonly Assumption[];
  /** Explicit scope boundaries — what this build will NOT touch */
  readonly exclusions: readonly string[];
  /** Checkpoint reason if this is a revised intent (null for v1) */
  readonly revisionReason: string | null;
}

export interface Charter {
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly deliverables: readonly Deliverable[];
  readonly qualityBar: QualityBar;
  /**
   * Optional scope lock — when set, ONLY the listed files may be
   * modified during the run. Set by CharterGenerator when the
   * prompt sanitizer detects a "do not modify anything else"-style
   * catch-all. Differs from `exclusions` (which list specific
   * forbidden paths): a scope lock is an allowlist, so an unlisted
   * file is automatically a violation even if no exclusion names it.
   */
  readonly scopeLock?: ScopeLock | null;
}

export interface ScopeLock {
  readonly allowedFiles: readonly string[];
  /** Short human-readable rationale, surfaced in errors/UI. */
  readonly reason: string;
}

export interface Deliverable {
  readonly description: string;
  readonly targetFiles: readonly string[];
  readonly type: "create" | "modify" | "delete" | "refactor";
}

export type QualityBar = "minimal" | "standard" | "hardened";

export interface Constraint {
  readonly kind: "budget" | "time" | "scope" | "governance" | "rollback";
  readonly description: string;
  readonly hard: boolean;
}

export interface Assumption {
  readonly statement: string;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly confidence: number;
}

// ─── Factory ─────────────────────────────────────────────────────────

export interface CreateIntentParams {
  runId: string;
  userRequest: string;
  charter: Charter;
  constraints: Constraint[];
  acceptedAssumptions?: Assumption[];
  exclusions?: string[];
}

export function createIntent(params: CreateIntentParams): IntentObject {
  return Object.freeze({
    id: randomUUID(),
    runId: params.runId,
    version: 1,
    parentId: null,
    createdAt: new Date().toISOString(),
    userRequest: params.userRequest,
    charter: Object.freeze({ ...params.charter }),
    constraints: Object.freeze([...params.constraints]),
    acceptedAssumptions: Object.freeze([...(params.acceptedAssumptions ?? [])]),
    exclusions: Object.freeze([...(params.exclusions ?? [])]),
    revisionReason: null,
  });
}

// ─── Checkpoint Revision ─────────────────────────────────────────────

export interface ReviseIntentParams {
  reason: string;
  charter?: Partial<Charter>;
  constraints?: Constraint[];
  acceptedAssumptions?: Assumption[];
  exclusions?: string[];
}

/**
 * Create a new IntentObject version at a Coordinator checkpoint.
 * The previous intent is never mutated — a new frozen object is returned.
 */
export function reviseIntent(
  current: IntentObject,
  params: ReviseIntentParams
): IntentObject {
  return Object.freeze({
    id: randomUUID(),
    runId: current.runId,
    version: current.version + 1,
    parentId: current.id,
    createdAt: new Date().toISOString(),
    userRequest: current.userRequest,
    charter: Object.freeze({
      ...current.charter,
      ...(params.charter ?? {}),
    }),
    constraints: Object.freeze([
      ...(params.constraints ?? current.constraints),
    ]),
    acceptedAssumptions: Object.freeze([
      ...current.acceptedAssumptions,
      ...(params.acceptedAssumptions ?? []),
    ]),
    exclusions: Object.freeze([
      ...current.exclusions,
      ...(params.exclusions ?? []),
    ]),
    revisionReason: params.reason,
  });
}

// ─── Validation ──────────────────────────────────────────────────────

export function validateIntent(intent: IntentObject): string[] {
  const errors: string[] = [];

  if (!intent.id) errors.push("Intent missing id");
  if (!intent.runId) errors.push("Intent missing runId");
  if (intent.version < 1) errors.push("Intent version must be >= 1");
  if (!intent.userRequest.trim()) errors.push("Intent missing userRequest");
  if (!intent.charter.objective.trim()) errors.push("Charter missing objective");
  if (intent.charter.successCriteria.length === 0)
    errors.push("Charter must have at least one success criterion");
  if (intent.charter.deliverables.length === 0)
    errors.push("Charter must have at least one deliverable");
  if (intent.version > 1 && !intent.parentId)
    errors.push("Revised intent must reference parent");
  if (intent.version > 1 && !intent.revisionReason)
    errors.push("Revised intent must have a revision reason");

  return errors;
}

// ─── Serialization ───────────────────────────────────────────────────

export function serializeIntent(intent: IntentObject): string {
  return JSON.stringify(intent, null, 2);
}

export function deserializeIntent(json: string): IntentObject {
  const parsed = JSON.parse(json);
  const errors = validateIntent(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid IntentObject: ${errors.join(", ")}`);
  }
  return Object.freeze(parsed);
}
