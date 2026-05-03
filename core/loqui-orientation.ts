/**
 * Loqui Orientation Mode — adaptive system-explanation guide.
 *
 * Pure function: takes a snapshot of the live system state and returns
 * a structured orientation response. The same shape is consumed by the
 * UI panel (rendering sections + quick actions) and by JSON callers
 * (CLI / external tooling).
 *
 * Design constraints:
 *
 *   1. Read-only. No coordinator calls, no mutations, no side effects.
 *      The route handler does the I/O, then hands a snapshot in.
 *   2. Safety-stable. Orientation never proposes auto-running anything.
 *      Quick-action ids map to existing UI buttons; the UI is the only
 *      surface that can fire them (and only on explicit user click).
 *   3. Anti-spam. The trigger predicate `shouldShowOrientation` returns
 *      false during an active task, after the operator dismissed it,
 *      and on repeat loads of the same UI session unless the operator
 *      explicitly asks "what does Aedis do?".
 *   4. Short, plain language. Sections are 4 lines max apiece. We
 *      surface "what / does / does NOT / next" so a fresh user has a
 *      consistent mental model regardless of system state.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type OrientationActionId =
  | "create-task-plan"
  | "view-active-plan"
  | "run-local-smoke"
  | "open-provider-setup";

export interface OrientationAction {
  readonly id: OrientationActionId;
  readonly label: string;
  /**
   * Short human-readable hint shown next to the button. Tells the user
   * *why* this action is being suggested in their current state.
   */
  readonly hint: string;
}

export interface OrientationSections {
  readonly whatAedisIs: readonly string[];
  readonly whatAedisWillDo: readonly string[];
  readonly whatAedisWillNotDo: readonly string[];
  readonly whatYouCanDoNext: readonly string[];
}

export interface OrientationResponse {
  readonly sections: OrientationSections;
  readonly actions: readonly OrientationAction[];
  /**
   * One-line explanation of which state branch produced this response.
   * Useful for debugging + the UI footer ("shown because: …").
   */
  readonly reason: string;
  /** Stable tag for tests + telemetry. */
  readonly variant:
    | "fresh"
    | "local-smoke"
    | "missing-providers"
    | "no-plans"
    | "plan-pending"
    | "plan-paused"
    | "plan-running"
    | "active-task";
}

// ─── State snapshot ─────────────────────────────────────────────────

export interface OrientationStateSnapshot {
  /** AEDIS_MODEL_PROFILE value — "local-smoke" toggles local-only mode. */
  readonly modelProfile: "default" | "local-smoke";
  /**
   * Provider entries sourced from /config/providers. Each entry exposes
   * whether its API key env var is set. Local providers (no apiKeyEnv)
   * report apiKeyPresent=true unconditionally.
   */
  readonly providers: ReadonlyArray<{
    readonly name: string;
    readonly label: string;
    readonly apiKeyPresent: boolean;
    readonly requiresKey: boolean;
  }>;
  /** Number of task plans on disk. */
  readonly planCount: number;
  /**
   * Most relevant plan to surface to the operator. Picked by the route
   * handler as: first paused plan, else first running, else most-recent
   * non-terminal, else null.
   */
  readonly highlightedPlan: {
    readonly taskPlanId: string;
    readonly status:
      | "pending"
      | "running"
      | "paused"
      | "completed"
      | "failed"
      | "cancelled"
      | "interrupted"
      | "blocked"
      | "needs_replan";
    readonly objective: string;
  } | null;
  /** True when the coordinator has any RUNNING task. */
  readonly hasActiveTask: boolean;
  /** True when AEDIS_STATE_ROOT was configured distinctly from projectRoot. */
  readonly stateRootIsolated: boolean;
}

// ─── Trigger predicate ──────────────────────────────────────────────

export interface OrientationTriggerContext {
  /** Has orientation been shown for this UI session already? */
  readonly alreadyShownThisSession: boolean;
  /** Did the operator dismiss the panel? (sticky for this UI session.) */
  readonly dismissedThisSession: boolean;
  /** True if a task is in flight right now. */
  readonly hasActiveTask: boolean;
  /**
   * True when the user explicitly typed an orientation question
   * ("what does Aedis do?" / "help" / "explain Aedis"). Overrides the
   * "already shown" guard but NOT "active task" — running work is
   * never interrupted.
   */
  readonly explicitlyRequested: boolean;
}

/**
 * Decide whether the UI should render the orientation panel.
 *
 * Rules:
 *   - active task → never (don't interrupt running work).
 *   - explicit user request ("what does Aedis do?") → yes, even if
 *     dismissed earlier this session. The operator's typed question
 *     is louder than a one-time dismissal.
 *   - dismissed → no.
 *   - already shown this session → no.
 *   - otherwise → yes (first load).
 */
export function shouldShowOrientation(ctx: OrientationTriggerContext): boolean {
  if (ctx.hasActiveTask) return false;
  if (ctx.explicitlyRequested) return true;
  if (ctx.dismissedThisSession) return false;
  if (ctx.alreadyShownThisSession) return false;
  return true;
}

// ─── Trigger detector for typed questions ───────────────────────────

const ORIENTATION_QUESTION_PATTERNS: readonly RegExp[] = [
  /\bwhat (does|is) aedis (do|for)\b/i,
  /\bhow (do i use|does) aedis\b/i,
  /\bhelp(\s+me)?\s+(get\s+started|with\s+aedis|using\s+aedis)\b/i,
  /\b(orient(ation)?|onboard(ing)?|getting started)\b/i,
  /^\s*help\s*\??\s*$/i,
  /^\s*what(\s+can|\s+does)\s+(this|aedis)/i,
];

/**
 * Returns true when a freeform user utterance reads as an orientation
 * request (rather than a build / question / status intent). Pure;
 * never throws; empty/whitespace input → false.
 */
export function isOrientationRequest(input: string): boolean {
  const text = (input ?? "").trim();
  if (text.length === 0) return false;
  for (const re of ORIENTATION_QUESTION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ─── Builder ────────────────────────────────────────────────────────

/**
 * Build the orientation response from a system snapshot. Pure — no
 * I/O, deterministic given the same snapshot. Variant precedence:
 *
 *   active-task → plan-running → plan-paused → plan-pending →
 *   no-plans → missing-providers → local-smoke → fresh
 *
 * "active-task" only fires when the route serves orientation despite a
 * running task (e.g. the operator typed a help question mid-run); the
 * trigger predicate normally blocks that case at the UI layer.
 */
export function buildOrientation(snapshot: OrientationStateSnapshot): OrientationResponse {
  const baseWhat = [
    "Aedis is a governed build orchestrator.",
    "You describe a change; Aedis plans, edits in a sandboxed workspace, verifies, and waits for your approval before it touches your repo.",
    "Every step leaves a receipt so you can replay what happened and why.",
  ];

  const baseWillDo = [
    "Break work into small subtasks and run them one at a time.",
    "Edit files in an isolated workspace and run typecheck, tests, and diff checks.",
    "Show you the proposed diff and pause for approval.",
    "Persist receipts under your state root so reruns are auditable.",
  ];

  const baseWillNotDo = [
    "Push, merge, or modify your source repo without your approval.",
    "Auto-run tasks on first load — every run is started by you.",
    "Bypass safety gates (Velum input, workspace isolation, scope checks).",
    "Send anything to Anthropic in the hot path unless you opt in.",
  ];

  // Prepend a state-root reassurance line when the runtime lives in a
  // different directory than the repo (the daily-driver setup). Helps
  // explain why Aedis "doesn't dirty the repo."
  const willDoLines = snapshot.stateRootIsolated
    ? [...baseWillDo, "Keep runtime files (workspaces, receipts, locks) outside your project tree."]
    : [...baseWillDo];

  // Variant precedence — first match wins. The list is ordered so the
  // most actionable hint comes first.
  if (snapshot.hasActiveTask) {
    return {
      variant: "active-task",
      reason: "A task is running; orientation is informational only.",
      sections: {
        whatAedisIs: baseWhat,
        whatAedisWillDo: willDoLines,
        whatAedisWillNotDo: baseWillNotDo,
        whatYouCanDoNext: [
          "Watch the worker grid and the live log to see progress.",
          "When the run finishes, review the proposed diff and approve or reject.",
          "Use Cancel on the task plan to stop early — Aedis halts after the current subtask.",
        ],
      },
      actions: [
        {
          id: "view-active-plan",
          label: "View Active Plan",
          hint: "Jump to the running plan to watch progress and the current subtask.",
        },
      ],
    };
  }

  if (snapshot.highlightedPlan?.status === "running") {
    return {
      variant: "plan-running",
      reason: "A plan is running; orientation suggests how to monitor and stop it.",
      sections: {
        whatAedisIs: baseWhat,
        whatAedisWillDo: willDoLines,
        whatAedisWillNotDo: baseWillNotDo,
        whatYouCanDoNext: [
          `Plan ${shortId(snapshot.highlightedPlan.taskPlanId)} is running — watch the task plan panel for live status.`,
          "Each subtask completes through the safety pipeline before the next one begins.",
          "Click Cancel on the plan if you want to stop after the current subtask.",
        ],
      },
      actions: [
        {
          id: "view-active-plan",
          label: "View Active Plan",
          hint: "Open the running plan to monitor progress.",
        },
      ],
    };
  }

  if (snapshot.highlightedPlan?.status === "paused") {
    return {
      variant: "plan-paused",
      reason: "A plan is paused for approval; orientation explains the gate and the Continue button.",
      sections: {
        whatAedisIs: baseWhat,
        whatAedisWillDo: willDoLines,
        whatAedisWillNotDo: baseWillNotDo,
        whatYouCanDoNext: [
          `Plan ${shortId(snapshot.highlightedPlan.taskPlanId)} is waiting on you.`,
          "Review the proposed diff, then approve or reject the change.",
          "After approving, click Continue on the plan to advance to the next subtask.",
        ],
      },
      actions: [
        {
          id: "view-active-plan",
          label: "View Active Plan",
          hint: "Open the paused plan to review the diff and approve or reject.",
        },
      ],
    };
  }

  if (snapshot.highlightedPlan?.status === "pending") {
    return {
      variant: "plan-pending",
      reason: "A plan exists but has not been started.",
      sections: {
        whatAedisIs: baseWhat,
        whatAedisWillDo: willDoLines,
        whatAedisWillNotDo: baseWillNotDo,
        whatYouCanDoNext: [
          `Plan ${shortId(snapshot.highlightedPlan.taskPlanId)} is ready to start.`,
          "Click Start on the task plan panel to begin the first subtask.",
          "Aedis will pause for approval before any source-repo change is promoted.",
        ],
      },
      actions: [
        {
          id: "view-active-plan",
          label: "View Active Plan",
          hint: "Open the pending plan and click Start when ready.",
        },
      ],
    };
  }

  // Local-smoke profile is itself a strong signal — surface the
  // local-only constraint before "no plans" so the operator
  // understands the runtime mode they're in.
  if (snapshot.modelProfile === "local-smoke") {
    return {
      variant: "local-smoke",
      reason: "AEDIS_MODEL_PROFILE=local-smoke — local-only mode is active.",
      sections: {
        whatAedisIs: baseWhat,
        whatAedisWillDo: [
          ...willDoLines,
          "Use only the local Ollama model for every worker role; no cloud calls leave the machine.",
        ],
        whatAedisWillNotDo: [
          ...baseWillNotDo,
          "Reach for OpenRouter, ModelStudio, Anthropic, or any cloud provider while local-smoke is active.",
        ],
        whatYouCanDoNext: [
          "Try a small change to validate the local pipeline end-to-end.",
          "Builder/critic capability is lower than a cloud model — expect simpler edits to land cleanly.",
          "Unset AEDIS_MODEL_PROFILE (or set it to default) to use your configured cloud providers.",
        ],
      },
      actions: [
        {
          id: "create-task-plan",
          label: "Create Task Plan",
          hint: "Draft a small objective to exercise the local pipeline.",
        },
      ],
    };
  }

  // Provider-key gap — only relevant on the default profile (local-smoke
  // explicitly forces local providers, so a missing OpenRouter key is
  // not a problem there). Surfaced before "no plans" because creating
  // a plan with no keys would just deadlock the first dispatch.
  {
    const missing = snapshot.providers.filter((p) => p.requiresKey && !p.apiKeyPresent);
    if (missing.length > 0) {
      return {
        variant: "missing-providers",
        reason: `Provider keys missing for: ${missing.map((p) => p.label).join(", ")}.`,
        sections: {
          whatAedisIs: baseWhat,
          whatAedisWillDo: willDoLines,
          whatAedisWillNotDo: baseWillNotDo,
          whatYouCanDoNext: [
            `Set API keys for: ${missing.map((p) => p.label).join(", ")} in Provider Setup.`,
            "Or, switch to local-smoke mode to run end-to-end on Ollama with no cloud keys.",
            "Aedis won't silently fall back from a configured cloud provider — it surfaces the missing key instead.",
          ],
        },
        actions: [
          {
            id: "open-provider-setup",
            label: "Open Provider Setup",
            hint: "Configure provider API keys.",
          },
          {
            id: "run-local-smoke",
            label: "Run Local Smoke Test",
            hint: "Switch to local-only mode (no cloud keys required).",
          },
        ],
      };
    }
  }

  if (snapshot.planCount === 0) {
    return {
      variant: "no-plans",
      reason: "No task plans exist yet; orientation suggests creating one.",
      sections: {
        whatAedisIs: baseWhat,
        whatAedisWillDo: willDoLines,
        whatAedisWillNotDo: baseWillNotDo,
        whatYouCanDoNext: [
          "Create a task plan with a clear objective and one or more subtasks.",
          "Plans don't auto-start — Start is always an explicit click.",
          "Or, ask Loqui a question or describe a small change to try a single run first.",
        ],
      },
      actions: [
        {
          id: "create-task-plan",
          label: "Create Task Plan",
          hint: "Open the New Task Plan form to draft an objective and subtasks.",
        },
      ],
    };
  }

  return {
    variant: "fresh",
    reason: "Default profile, no plans in flight, providers configured — pure first-load orientation.",
    sections: {
      whatAedisIs: baseWhat,
      whatAedisWillDo: willDoLines,
      whatAedisWillNotDo: baseWillNotDo,
      whatYouCanDoNext: [
        "Create a task plan with a clear objective and a few subtasks.",
        "Or, ask Loqui a question about your repo to see how grounding works.",
        "Or, run a local smoke test to see the full pipeline without using cloud credit.",
      ],
    },
    actions: [
      {
        id: "create-task-plan",
        label: "Create Task Plan",
        hint: "Draft an objective and subtasks.",
      },
      {
        id: "run-local-smoke",
        label: "Run Local Smoke Test",
        hint: "Validate the pipeline end-to-end on Ollama only.",
      },
    ],
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function shortId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 12)}…`;
}
