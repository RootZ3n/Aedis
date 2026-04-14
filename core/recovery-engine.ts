/**
 * RecoveryEngine — failure triage and escalation control.
 *
 * Aedis should not jump straight to a more expensive model or a human.
 * This engine classifies what went wrong, chooses the cheapest sane recovery,
 * and records every attempt so the system does not loop itself to death.
 */

import { randomUUID } from "node:crypto";
import type { RunState } from "./runstate.js";

export type FailureType =
  | "misunderstood_task"
  | "bad_context"
  | "scope_too_large"
  | "verification_failure"
  | "generation_failure"
  | "contract_violation"
  | "coherence_failure";

export type RecoveryStrategyName =
  | "retry_clearer_contract"
  | "narrow_scope"
  | "split_task_further"
  | "send_scout_for_context"
  | "compare_similar_file_pattern"
  | "revert_partial_patch"
  | "escalate_same_tier"
  | "escalate_higher_tier"
  | "escalate_funded_model"
  | "block_human_review";

export interface RecoveryResult {
  readonly success: boolean;
  readonly failureSignals?: readonly string[];
  readonly verificationPassed?: boolean;
  readonly contractSatisfied?: boolean;
  readonly coherencePassed?: boolean;
  readonly outputSummary?: string;
  readonly patchApplied?: boolean;
}

export interface CostBudget {
  readonly currentTier: number;
  readonly maxTier: number;
  readonly fundedTier: number;
  readonly spentUsd: number;
  readonly remainingUsd: number;
}

export interface RecoveryStrategy {
  readonly name: RecoveryStrategyName;
  readonly rationale: string;
  readonly costTierDelta: 0 | 1 | 2;
  readonly requiresHumanReview: boolean;
}

export interface RecoveryReceipt {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly reason: string;
  readonly strategy: RecoveryStrategyName;
  readonly outcome: string;
  readonly timestamp: string;
}

export interface RecoveryContext {
  readonly taskId?: string;
  readonly taskDescription?: string;
  readonly targetFiles?: readonly string[];
  readonly previousAttempts?: readonly string[];
  readonly patternMatches?: readonly string[];
}

// Module-level singleton for global circuit breaker state.
// Persists across Coordinator instantiations within the same process.
let _globalEngine: RecoveryEngine | null = null;

export function getGlobalRecoveryEngine(): RecoveryEngine {
  if (!_globalEngine) _globalEngine = new RecoveryEngine();
  return _globalEngine;
}

const STRATEGY_ORDER: readonly RecoveryStrategyName[] = [
  "retry_clearer_contract",
  "narrow_scope",
  "split_task_further",
  "send_scout_for_context",
  "compare_similar_file_pattern",
  "revert_partial_patch",
  "escalate_same_tier",
  "escalate_higher_tier",
  "escalate_funded_model",
  "block_human_review",
];

export interface GlobalRecoveryBudget {
  /** Maximum total USD to spend on recovery across all strategies. */
  readonly maxTotalUsd: number;
  /** Maximum total recovery attempts across all strategies. */
  readonly maxTotalAttempts: number;
  /** Total USD spent on recovery so far. */
  totalSpentUsd: number;
  /** Total recovery attempts across all runs. */
  totalAttempts: number;
  /** Whether the circuit breaker has tripped. */
  tripped: boolean;
  /** Reason the circuit breaker tripped. */
  tripReason: string | null;
}

export class RecoveryEngine {
  private readonly receipts: RecoveryReceipt[] = [];
  private readonly escalationHistory = new Map<string, RecoveryStrategyName[]>();
  private readonly globalBudget: GlobalRecoveryBudget = {
    maxTotalUsd: 2.00, // $2 total recovery budget across all runs
    maxTotalAttempts: 20, // max 20 recovery attempts before circuit breaker trips
    totalSpentUsd: 0,
    totalAttempts: 0,
    tripped: false,
    tripReason: null,
  };

  /**
   * Check if the global circuit breaker has tripped. When tripped,
   * no more recovery attempts are allowed — all tasks go straight
   * to human review.
   */
  isCircuitTripped(): boolean {
    return this.globalBudget.tripped;
  }

  /**
   * Get the current global recovery budget state.
   */
  getGlobalBudget(): GlobalRecoveryBudget {
    return { ...this.globalBudget };
  }

  /**
   * Record a recovery attempt against the global budget. Called by
   * the coordinator after each recovery strategy is executed.
   */
  recordRecoveryAttempt(costUsd: number): void {
    this.globalBudget.totalAttempts++;
    this.globalBudget.totalSpentUsd += costUsd;

    if (this.globalBudget.totalAttempts >= this.globalBudget.maxTotalAttempts) {
      this.globalBudget.tripped = true;
      this.globalBudget.tripReason = "Global recovery attempt limit reached (" + this.globalBudget.maxTotalAttempts + ")";
    }
    if (this.globalBudget.totalSpentUsd >= this.globalBudget.maxTotalUsd) {
      this.globalBudget.tripped = true;
      this.globalBudget.tripReason = "Global recovery cost limit reached ($" + this.globalBudget.totalSpentUsd.toFixed(2) + ")";
    }
  }

  analyzeFailure(result: RecoveryResult): FailureType {
    const signals = (result.failureSignals ?? []).map((signal) => signal.toLowerCase());

    if (signals.some((signal) => signal.includes("instruction") || signal.includes("asked for") || signal.includes("wrong task"))) {
      return "misunderstood_task";
    }
    if (signals.some((signal) => signal.includes("missing context") || signal.includes("not enough context") || signal.includes("couldn't find file"))) {
      return "bad_context";
    }
    if (signals.some((signal) => signal.includes("too large") || signal.includes("too many files") || signal.includes("scope"))) {
      return "scope_too_large";
    }
    if (result.verificationPassed === false || signals.some((signal) => signal.includes("test failed") || signal.includes("verification"))) {
      return "verification_failure";
    }
    if (result.contractSatisfied === false || signals.some((signal) => signal.includes("contract") || signal.includes("format") || signal.includes("schema"))) {
      return "contract_violation";
    }
    if (result.coherencePassed === false || signals.some((signal) => signal.includes("coherence") || signal.includes("contradiction"))) {
      return "coherence_failure";
    }
    return "generation_failure";
  }

  selectStrategy(failureType: FailureType, runState: RunState, costBudget: CostBudget): RecoveryStrategy {
    const history = this.getHistory(runState.id);
    const attempted = new Set(history);

    const preferred = this.preferredStrategies(failureType);
    for (const candidate of preferred) {
      if (attempted.has(candidate)) continue;
      if (!this.canUseStrategy(candidate, costBudget, attempted)) continue;
      return this.materializeStrategy(candidate, failureType);
    }

    return this.materializeStrategy("block_human_review", failureType);
  }

  executeRecovery(strategy: RecoveryStrategy, task: string, context: RecoveryContext): { command: string; notes: string[] } {
    const files = (context.targetFiles ?? []).join(", ") || "no explicit files";
    switch (strategy.name) {
      case "retry_clearer_contract":
        return {
          command: `retry-task:${task}`,
          notes: ["Rewrite the contract in blunt concrete terms.", `Keep target scope on ${files}.`],
        };
      case "narrow_scope":
        return {
          command: `narrow-scope:${task}`,
          notes: ["Reduce to a single outcome.", "Remove adjacent nice-to-have edits."],
        };
      case "split_task_further":
        return {
          command: `split-task:${task}`,
          notes: ["Break work into smaller bounded subtasks.", "Preserve parent task ownership in the run graph."],
        };
      case "send_scout_for_context":
        return {
          command: `dispatch-scout:${task}`,
          notes: ["Collect missing file and dependency context.", "Do not edit during this pass."],
        };
      case "compare_similar_file_pattern":
        return {
          command: `compare-patterns:${task}`,
          notes: ["Find a neighboring implementation with the same contract.", "Use the existing repo pattern before inventing."],
        };
      case "revert_partial_patch":
        return {
          command: `revert-partial:${task}`,
          notes: ["Back out the broken partial state.", "Return to the last coherent checkpoint before retrying."],
        };
      case "escalate_same_tier":
        return {
          command: `reroute-same-tier:${task}`,
          notes: ["Keep cost flat.", "Use a clearer, stricter prompt in the same tier."],
        };
      case "escalate_higher_tier":
        return {
          command: `reroute-higher-tier:${task}`,
          notes: ["Escalate one tier only after cheaper attempts failed.", "Carry forward the verified context bundle."],
        };
      case "escalate_funded_model":
        return {
          command: `reroute-funded:${task}`,
          notes: ["Use the funded model path.", "Do this only after lower-cost recoveries have been exhausted."],
        };
      case "block_human_review":
      default:
        return {
          command: `block-human-review:${task}`,
          notes: ["Automated recovery exhausted.", "Surface precise failure receipts for human review."],
        };
    }
  }

  logRecovery(reason: string, strategy: RecoveryStrategy, outcome: string, runId = "unknown", taskId: string | null = null): RecoveryReceipt {
    const receipt: RecoveryReceipt = {
      id: randomUUID(),
      runId,
      taskId,
      reason,
      strategy: strategy.name,
      outcome,
      timestamp: new Date().toISOString(),
    };
    this.receipts.push(receipt);
    const history = this.escalationHistory.get(runId) ?? [];
    history.push(strategy.name);
    this.escalationHistory.set(runId, history);
    return receipt;
  }

  getReceipts(): readonly RecoveryReceipt[] {
    return this.receipts;
  }

  getHistory(runId: string): readonly RecoveryStrategyName[] {
    return this.escalationHistory.get(runId) ?? [];
  }

  private preferredStrategies(failureType: FailureType): readonly RecoveryStrategyName[] {
    switch (failureType) {
      case "misunderstood_task":
        return ["retry_clearer_contract", "narrow_scope", "split_task_further", "escalate_same_tier", "block_human_review"];
      case "bad_context":
        return ["send_scout_for_context", "compare_similar_file_pattern", "retry_clearer_contract", "escalate_same_tier", "block_human_review"];
      case "scope_too_large":
        return ["narrow_scope", "split_task_further", "send_scout_for_context", "escalate_same_tier", "block_human_review"];
      case "verification_failure":
        return ["compare_similar_file_pattern", "revert_partial_patch", "retry_clearer_contract", "escalate_same_tier", "escalate_higher_tier", "block_human_review"];
      case "contract_violation":
        return ["retry_clearer_contract", "narrow_scope", "compare_similar_file_pattern", "escalate_same_tier", "block_human_review"];
      case "coherence_failure":
        return ["revert_partial_patch", "split_task_further", "send_scout_for_context", "escalate_same_tier", "block_human_review"];
      case "generation_failure":
      default:
        return ["retry_clearer_contract", "compare_similar_file_pattern", "escalate_same_tier", "escalate_higher_tier", "escalate_funded_model", "block_human_review"];
    }
  }

  private canUseStrategy(
    strategy: RecoveryStrategyName,
    costBudget: CostBudget,
    attempted: Set<RecoveryStrategyName>,
  ): boolean {
    const index = STRATEGY_ORDER.indexOf(strategy);
    if (index === -1) return false;

    if (strategy === "escalate_higher_tier") {
      if (!(attempted.has("retry_clearer_contract") || attempted.has("narrow_scope") || attempted.has("split_task_further") || attempted.has("send_scout_for_context") || attempted.has("compare_similar_file_pattern") || attempted.has("revert_partial_patch") || attempted.has("escalate_same_tier"))) {
        return false;
      }
      return costBudget.currentTier < costBudget.maxTier;
    }

    if (strategy === "escalate_funded_model") {
      if (!(attempted.has("escalate_higher_tier") || attempted.has("escalate_same_tier"))) {
        return false;
      }
      return costBudget.currentTier < costBudget.fundedTier && costBudget.remainingUsd > 0;
    }

    return true;
  }

  private materializeStrategy(name: RecoveryStrategyName, failureType: FailureType): RecoveryStrategy {
    const rationale = {
      retry_clearer_contract: `Retry with a cleaner contract because the failure looks like ${failureType}.`,
      narrow_scope: `Narrow the surface area because the failure looks like ${failureType}.`,
      split_task_further: `Split the work further because the current task envelope is unstable.`,
      send_scout_for_context: `Pull more context before another expensive attempt.`,
      compare_similar_file_pattern: `Lean on an existing repo pattern before improvising again.`,
      revert_partial_patch: `Restore coherence before retrying.`,
      escalate_same_tier: `Keep the cost flat and try a stricter prompt.`,
      escalate_higher_tier: `Escalate one tier because cheaper recoveries were exhausted.`,
      escalate_funded_model: `Use a funded model only after lower-cost escalations failed.`,
      block_human_review: `Automated recovery is exhausted or unsafe.`,
    } satisfies Record<RecoveryStrategyName, string>;

    const costTierDelta: Record<RecoveryStrategyName, 0 | 1 | 2> = {
      retry_clearer_contract: 0,
      narrow_scope: 0,
      split_task_further: 0,
      send_scout_for_context: 0,
      compare_similar_file_pattern: 0,
      revert_partial_patch: 0,
      escalate_same_tier: 0,
      escalate_higher_tier: 1,
      escalate_funded_model: 2,
      block_human_review: 0,
    };

    return {
      name,
      rationale: rationale[name],
      costTierDelta: costTierDelta[name],
      requiresHumanReview: name === "block_human_review",
    };
  }
}
