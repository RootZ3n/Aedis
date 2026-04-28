/**
 * Runtime safety policy — projection of the runtime knobs that decide
 * whether Aedis can mutate the operator's source repo without explicit
 * confirmation. Surfaced on /health, in the TUI dashboard, and on the
 * run-detail view so the operator never has to guess what the running
 * server is allowed to do.
 *
 * The policy is *derived* from CoordinatorConfig + lane-config — it
 * carries no settings of its own. Tests assert the projection so the
 * defaults can't quietly drift toward auto-mutate behavior.
 *
 * Architectural invariants surfaced as fields:
 *   - shadowPromoteAllowed is structurally always false. The promote
 *     path checks workspace.role === "primary"; shadows can never
 *     reach it. The field exists so the operator sees the guarantee
 *     in the same panel as everything else, not buried in source.
 */
import type { CoordinatorConfig } from "./coordinator.js";
import type { LaneMode } from "./lane-config.js";

export interface RuntimePolicy {
  /** Whether a clean run auto-promotes its workspace commit to source. */
  readonly autoPromote: boolean;
  /** Whether human approval is required before a successful run promotes. */
  readonly approvalRequired: boolean;
  /**
   * Whether destructive operations (auto-commit + auto-promote together)
   * may run without approval. "blocked" when any guard requires human
   * confirmation; "allowed" only when every guard is opted out of.
   */
  readonly destructiveOps: "blocked" | "allowed";
  /** Lane mode in effect for the project. */
  readonly laneMode: LaneMode | "unset";
  /** Architectural invariant: shadow candidates cannot promote. Always false. */
  readonly shadowPromoteAllowed: false;
  /**
   * Whether the source repo is mutated as a last-resort when workspace
   * creation fails. Safe default = true (workspace required).
   */
  readonly requireWorkspace: boolean;
}

export interface DeriveRuntimePolicyInput {
  readonly autoPromoteOnSuccess: boolean;
  readonly requireApproval: boolean;
  readonly requireWorkspace: boolean;
  readonly laneMode?: LaneMode;
}

/**
 * Project a RuntimePolicy from the live CoordinatorConfig (or the subset
 * of it the lane policy needs). Pure function — no I/O. Operator-facing.
 */
export function deriveRuntimePolicy(
  input: DeriveRuntimePolicyInput,
): RuntimePolicy {
  const autoPromote = input.autoPromoteOnSuccess;
  const approvalRequired = input.requireApproval;
  // Destructive = source repo mutated automatically.
  // It's only "allowed" when BOTH (a) auto-promote is on AND (b) no
  // approval gate stands between the run and source. Either guard
  // alone is enough to block.
  const destructiveOps: "blocked" | "allowed" =
    autoPromote && !approvalRequired ? "allowed" : "blocked";

  return {
    autoPromote,
    approvalRequired,
    destructiveOps,
    laneMode: input.laneMode ?? "unset",
    shadowPromoteAllowed: false,
    requireWorkspace: input.requireWorkspace,
  };
}

/**
 * Apply the safe-default mode to a partial CoordinatorConfig. Used at
 * server boot to bias production toward "approval required, no
 * automatic promotion" while leaving tests free to construct
 * Coordinator directly with their own config.
 *
 * Operator overrides:
 *   - AEDIS_AUTO_PROMOTE=true  → autoPromote on
 *   - AEDIS_REQUIRE_APPROVAL=false → approval gate off
 *
 * Anything not set explicitly defaults to the safe value.
 */
export interface SafeDefaultsInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SafeDefaultsResult {
  readonly autoPromoteOnSuccess: boolean;
  readonly requireApproval: boolean;
  readonly requireWorkspace: boolean;
  readonly source: {
    readonly autoPromoteOnSuccess: "default-safe" | "env-override";
    readonly requireApproval: "default-safe" | "env-override";
  };
}

export function safeDefaults(input: SafeDefaultsInput = {}): SafeDefaultsResult {
  const env = input.env ?? process.env;
  // Auto-promote: explicit opt-in only. Default is OFF.
  const autoPromoteRaw = env["AEDIS_AUTO_PROMOTE"];
  const autoPromoteOnSuccess = autoPromoteRaw === "true";
  // Approval: required by default. Operator must explicitly set
  // AEDIS_REQUIRE_APPROVAL=false to disable. The double-negative is
  // intentional — it forces the operator to type the unsafe value.
  const approvalRaw = env["AEDIS_REQUIRE_APPROVAL"];
  const requireApproval = approvalRaw !== "false";
  return {
    autoPromoteOnSuccess,
    requireApproval,
    // Workspace strictness is not env-toggleable from this helper —
    // the unsafe legacy mode (requireWorkspace=false) is reserved for
    // explicit programmatic config so it never accidentally trips on
    // a misset env var.
    requireWorkspace: true,
    source: {
      autoPromoteOnSuccess: autoPromoteRaw === "true" ? "env-override" : "default-safe",
      requireApproval: approvalRaw === "false" ? "env-override" : "default-safe",
    },
  };
}

/** Helper to build a RuntimePolicy directly from a CoordinatorConfig. */
export function policyFromCoordinatorConfig(
  config: Pick<CoordinatorConfig, "autoPromoteOnSuccess" | "requireApproval" | "requireWorkspace">,
  laneMode?: LaneMode,
): RuntimePolicy {
  return deriveRuntimePolicy({
    autoPromoteOnSuccess: config.autoPromoteOnSuccess,
    requireApproval: config.requireApproval,
    requireWorkspace: config.requireWorkspace,
    ...(laneMode !== undefined ? { laneMode } : {}),
  });
}
