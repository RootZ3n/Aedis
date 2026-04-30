import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPlanAssist, type PlanSuggestion, type PlanAssistClarify, type PlanAssistBlock, type PlanAssistSkip } from "./plan-assist.js";

// ─── Plan-worthy detection ───────────────────────────────────────────

describe("detectPlanAssist — plan-worthy prompts", () => {
  it("scoped large prompt with multiple actions produces plan suggestion", () => {
    const result = detectPlanAssist(
      "Implement a user authentication module with JWT tokens, " +
      "add login and registration endpoints, " +
      "create middleware for route protection, " +
      "and write integration tests for all auth flows",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    assert.ok(plan.subtasks.length >= 2, `Expected >=2 subtasks, got ${plan.subtasks.length}`);
    assert.ok(plan.objective.length > 0);
    assert.ok(plan.confidence > 0.4);
    assert.ok(plan.reason.length > 0);
    // Each subtask has required fields
    for (const sub of plan.subtasks) {
      assert.ok(sub.title.length > 0, "subtask must have title");
      assert.ok(sub.prompt.length > 0, "subtask must have prompt");
      assert.ok(["low", "medium", "high"].includes(sub.risk), "subtask must have valid risk");
      assert.ok(sub.reason.length > 0, "subtask must have reason");
    }
  });

  it("'fix X and update Y and test Z' produces plan", () => {
    const result = detectPlanAssist(
      "Fix the login validation bug and update the error messages and test the registration flow",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    assert.ok(plan.subtasks.length >= 2);
    // Should capture distinct action clauses
    const titles = plan.subtasks.map((s) => s.title.toLowerCase());
    assert.ok(
      titles.some((t) => t.includes("fix") || t.includes("login")),
      "Should capture fix clause",
    );
  });

  it("checklist prompt preserves ordered steps", () => {
    const result = detectPlanAssist(
      "Refactor the auth module:\n" +
      "1. Extract shared validation logic into utils/validate.ts\n" +
      "2. Update login handler to use the shared validator\n" +
      "3. Update registration handler to use the shared validator\n" +
      "4. Add unit tests for the validation utilities\n" +
      "5. Run the full test suite to verify no regressions",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    assert.equal(plan.subtasks.length, 5, "Should have exactly 5 subtasks from checklist");
    // Order must be preserved
    assert.ok(plan.subtasks[0].title.toLowerCase().includes("extract") ||
              plan.subtasks[0].prompt.toLowerCase().includes("extract"));
    assert.ok(plan.subtasks[4].title.toLowerCase().includes("test") ||
              plan.subtasks[4].prompt.toLowerCase().includes("test"));
    // Each should carry "Checklist item" reason
    for (const sub of plan.subtasks) {
      assert.ok(sub.reason.includes("Checklist"), `reason should mention checklist: ${sub.reason}`);
    }
  });

  it("bullet-point checklist detected", () => {
    const result = detectPlanAssist(
      "Update the API:\n" +
      "- add rate limiting middleware\n" +
      "- fix the CORS configuration\n" +
      "- update the health check endpoint",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    assert.equal(plan.subtasks.length, 3);
  });

  it("large build spec with 'implement X with Y, Z, and W' produces plan", () => {
    const result = detectPlanAssist(
      "Implement a notification service with email support, push notifications, " +
      "webhook delivery, and retry logic for failed deliveries",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    assert.ok(plan.subtasks.length >= 2);
  });

  it("multi-sentence prompt with different actions produces plan", () => {
    const result = detectPlanAssist(
      "Add input validation to the login form. " +
      "Update the error handling to show user-friendly messages. " +
      "Create unit tests for the validation logic.",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    assert.ok(plan.subtasks.length >= 2);
  });
});

// ─── Risk assessment ─────────────────────────────────────────────────

describe("detectPlanAssist — risk assessment", () => {
  it("database/migration subtasks flagged as high risk", () => {
    const result = detectPlanAssist(
      "Add a new user table migration and update the auth endpoints and write tests",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    const migrationTask = plan.subtasks.find(
      (s) => s.prompt.toLowerCase().includes("migration"),
    );
    if (migrationTask) {
      assert.equal(migrationTask.risk, "high");
    }
  });

  it("refactor subtasks flagged as medium risk", () => {
    const result = detectPlanAssist(
      "Refactor the logging module and add structured logging and update the config",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    const refactorTask = plan.subtasks.find(
      (s) => s.prompt.toLowerCase().includes("refactor"),
    );
    if (refactorTask) {
      assert.ok(
        refactorTask.risk === "medium" || refactorTask.risk === "high",
        `Expected medium or high risk for refactor, got ${refactorTask.risk}`,
      );
    }
  });
});

// ─── Safety: clarify ─────────────────────────────────────────────────

describe("detectPlanAssist — safety: clarify", () => {
  it("vague 'make repo better' clarifies", () => {
    const result = detectPlanAssist("make it better");
    assert.equal(result.kind, "clarify");
    const clarify = result as PlanAssistClarify;
    assert.ok(clarify.question.length > 0);
    assert.ok(clarify.reason.includes("vague"));
  });

  it("'improve' alone clarifies", () => {
    const result = detectPlanAssist("improve");
    assert.equal(result.kind, "clarify");
  });

  it("'fix everything' clarifies", () => {
    const result = detectPlanAssist("fix everything");
    assert.equal(result.kind, "clarify");
  });

  it("'do something' clarifies", () => {
    const result = detectPlanAssist("do something");
    assert.equal(result.kind, "clarify");
  });
});

// ─── Safety: block ───────────────────────────────────────────────────

describe("detectPlanAssist — safety: block", () => {
  it("unsafe 'rm -rf' prompt blocks", () => {
    const result = detectPlanAssist("rm -rf the database and rebuild from scratch");
    assert.equal(result.kind, "block");
    const block = result as PlanAssistBlock;
    assert.ok(block.reason.includes("unsafe"));
  });

  it("'drop database' blocks", () => {
    const result = detectPlanAssist("drop database users and recreate it");
    assert.equal(result.kind, "block");
  });

  it("'force push' blocks", () => {
    const result = detectPlanAssist("force push to main and delete all branches");
    assert.equal(result.kind, "block");
  });
});

// ─── Skip: simple prompts ────────────────────────────────────────────

describe("detectPlanAssist — skip: simple prompts", () => {
  it("simple single-action prompt skips", () => {
    const result = detectPlanAssist("fix the typo in README.md");
    assert.equal(result.kind, "skip");
  });

  it("question prompt skips", () => {
    const result = detectPlanAssist("what files handle authentication?");
    assert.equal(result.kind, "skip");
  });

  it("empty input skips", () => {
    const result = detectPlanAssist("");
    assert.equal(result.kind, "skip");
  });

  it("short single-verb prompt skips", () => {
    const result = detectPlanAssist("add a hello endpoint");
    assert.equal(result.kind, "skip");
  });
});

// ─── Scope extraction ────────────────────────────────────────────────

describe("detectPlanAssist — scope extraction", () => {
  it("extracts file paths from subtasks", () => {
    const result = detectPlanAssist(
      "Update src/auth.ts to add token refresh and update src/routes/login.ts to handle expired tokens and add tests",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    const authTask = plan.subtasks.find((s) => s.prompt.includes("src/auth.ts"));
    if (authTask) {
      assert.ok(authTask.scope.includes("src/auth.ts"));
    }
  });
});

// ─── Integration: TaskPlan creation ──────────────────────────────────

describe("detectPlanAssist — TaskPlan creation", () => {
  it("user can create TaskPlan from suggestion (shape check)", () => {
    const result = detectPlanAssist(
      "Add a caching layer:\n" +
      "1. Create a cache service in src/cache.ts\n" +
      "2. Add Redis connection configuration\n" +
      "3. Integrate caching into the API routes",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;

    // Verify the shape is compatible with CreateTaskPlanInput
    const createInput = {
      objective: plan.objective,
      repoPath: "/tmp/test-repo",
      subtasks: plan.subtasks.map((s) => ({
        title: s.title,
        prompt: s.prompt,
      })),
    };
    assert.ok(createInput.objective.length > 0);
    assert.ok(createInput.subtasks.length >= 2);
    for (const sub of createInput.subtasks) {
      assert.ok(sub.prompt.length > 0);
    }
  });
});

// ─── Signals ─────────────────────────────────────────────────────────

describe("detectPlanAssist — signals", () => {
  it("includes connector signal for 'X and Y and Z'", () => {
    const result = detectPlanAssist(
      "Fix the auth bug and update the error messages and add retry logic",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    assert.ok(plan.signals.some((s) => s.includes("multi-step")));
  });

  it("includes checklist signal for numbered lists", () => {
    const result = detectPlanAssist(
      "Tasks:\n1. Add validation\n2. Fix error handling\n3. Write tests",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    assert.ok(plan.signals.includes("multi-step:checklist"));
  });

  it("includes large-scope signal for build specs", () => {
    const result = detectPlanAssist(
      "Implement a notification service with email, push, and webhook support " +
      "that should handle retries and dead letter queues",
    );
    assert.equal(result.kind, "plan_suggestion");
    const plan = result as PlanSuggestion;
    assert.ok(plan.signals.some((s) => s.includes("large-scope")));
  });
});
