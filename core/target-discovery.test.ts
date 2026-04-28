import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CharterGenerator } from "./charter.js";
import { prepareTargetsForPrompt } from "./target-discovery.js";

function makeBackendRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-target-discovery-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "src", "server.ts"),
    [
      "import { routeRequest } from './router.js';",
      "export function registerRoutes() {",
      "  return ['/health', '/stats'];",
      "}",
    ].join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "src", "router.ts"),
    [
      "export function routeRequest() { return 'ok'; }",
      "export function getProviderForModel() { return 'openrouter'; }",
    ].join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "scripts", "server.ts"),
    "export function runLocalServer() { return 'dev'; }\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "test", "router.test.ts"),
    "import { routeRequest } from '../src/router.js';\n",
    "utf-8",
  );
  return dir;
}

test("target discovery: bounded backend prompt without paths selects actionable backend files", () => {
  const projectRoot = makeBackendRepo();
  try {
    const generator = new CharterGenerator();
    const analysis = generator.analyzeRequest(
      "Add a GET /health endpoint that returns ok/status JSON and update any route registration needed.",
    );
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt: analysis.raw,
      analysis,
    });

    assert.ok(
      prepared.targets.includes("src/server.ts"),
      `expected src/server.ts in ${JSON.stringify(prepared.targets)}`,
    );
    assert.ok(
      prepared.targets.includes("src/router.ts"),
      `expected src/router.ts in ${JSON.stringify(prepared.targets)}`,
    );
    assert.equal(prepared.targets.some((target) => !target.includes("/")), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: basename targets resolve to full repo-relative paths", () => {
  const projectRoot = makeBackendRepo();
  try {
    const generator = new CharterGenerator();
    const analysis = generator.analyzeRequest(
      "Refactor provider selection and error shaping so server.ts and router.ts share one source of truth.",
    );
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt: analysis.raw,
      analysis,
    });

    assert.deepEqual(
      [...prepared.targets].sort(),
      ["src/router.ts", "src/server.ts"],
    );
    assert.ok(
      prepared.selected.some((candidate) => candidate.path === "src/server.ts" && candidate.reasons.includes("exact basename match")),
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: explicit root new-file task accepts exact file creation", () => {
  const projectRoot = makeBackendRepo();
  try {
    const generator = new CharterGenerator();
    const analysis = generator.analyzeRequest(
      "Create hello-aedis.txt containing exactly: Aedis RC smoke test.",
    );
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt: analysis.raw,
      analysis,
    });

    assert.ok(
      prepared.targets.includes("hello-aedis.txt"),
      `expected new root file in targets, got ${JSON.stringify(prepared.targets)}`,
    );
    assert.equal(prepared.clarification, null);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: explicit repository-root new-file task accepts exact file creation", () => {
  const projectRoot = makeBackendRepo();
  try {
    const generator = new CharterGenerator();
    const analysis = generator.analyzeRequest(
      "Create the repository root file hello-aedis.txt containing exactly: Aedis RC smoke test.",
    );
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt: analysis.raw,
      analysis,
    });

    assert.ok(
      prepared.targets.includes("hello-aedis.txt"),
      `expected new root file in targets, got ${JSON.stringify(prepared.targets)}`,
    );
    assert.equal(prepared.clarification, null);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: vague repo improvement stays unscoped", () => {
  const projectRoot = makeBackendRepo();
  try {
    const generator = new CharterGenerator();
    const analysis = generator.analyzeRequest("Improve the repo.");
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt: analysis.raw,
      analysis,
    });

    assert.deepEqual(prepared.targets, []);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: create request without path and contents stays ambiguous", () => {
  const projectRoot = makeBackendRepo();
  try {
    const generator = new CharterGenerator();
    const analysis = generator.analyzeRequest("Create a useful file.");
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt: analysis.raw,
      analysis,
    });

    assert.deepEqual(prepared.targets, []);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: ambiguous basename returns bounded clarification instead of guessing", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-target-discovery-amb-"));
  try {
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(join(projectRoot, "workers"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "config.ts"), "export const srcConfig = true;\n", "utf-8");
    writeFileSync(join(projectRoot, "workers", "config.ts"), "export const workerConfig = true;\n", "utf-8");

    const generator = new CharterGenerator();
    const analysis = generator.analyzeRequest(
      "Clean up config.ts so validation is more transparent.",
    );
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt: analysis.raw,
      analysis,
    });

    assert.equal(prepared.targets.length, 0);
    assert.match(prepared.clarification ?? "", /multiple files matched/i);
    assert.ok(prepared.rejected.some((entry) => /ambiguous basename target/i.test(entry.reason)));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: directory-qualified stem resolves extensionless prompt targets", () => {
  const projectRoot = makeBackendRepo();
  try {
    mkdirSync(join(projectRoot, "core"), { recursive: true });
    writeFileSync(join(projectRoot, "core", "widget.ts"), "export const widget = 1;\n", "utf-8");

    const generator = new CharterGenerator();
    const analysis = generator.analyzeRequest("modify widget in core");
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt: analysis.raw,
      analysis,
    });

    assert.deepEqual(prepared.targets, ["core/widget.ts"]);
    assert.ok(
      prepared.selected.some((candidate) =>
        candidate.path === "core/widget.ts" &&
        candidate.reasons.includes("directory-qualified stem match"),
      ),
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: stem extraction does not invent noun targets from bug phrases", () => {
  const projectRoot = makeBackendRepo();
  try {
    mkdirSync(join(projectRoot, "core"), { recursive: true });
    writeFileSync(join(projectRoot, "core", "utils.ts"), "export function fib() { return 1; }\n", "utf-8");

    const generator = new CharterGenerator();
    const analysis = generator.analyzeRequest("fix fibonacci bug in core/utils.ts when n<=1");
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt: analysis.raw,
      analysis,
    });

    assert.ok(prepared.targets.includes("core/utils.ts"));
    assert.equal(prepared.rejected.some((entry) => entry.path === "core/bug"), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── prompt-sanitizer integration: ffe132ed regression ─────────────
//
// These tests guard the boundary that actually leaked: charter
// returned ["start.sh"], but prepareTargetsForPrompt re-extracted
// README.md from the prompt directly and pushed it through the
// existence check, overriding the charter's clean result. After the
// shared-sanitizer refactor target-discovery must:
//   - apply the same literal-strip charter applies, AND
//   - filter explicit negations EVEN WHEN the file exists on disk.

function makeRepoWithReadme(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-target-negation-"));
  writeFileSync(join(dir, "README.md"), "# Repo\nUsage: bash start.sh\n", "utf-8");
  writeFileSync(join(dir, "start.sh"), "#!/usr/bin/env bash\necho hi\n", "utf-8");
  return dir;
}

test("target discovery: single-quoted README.md is ignored (charter target wins)", () => {
  const projectRoot = makeRepoWithReadme();
  try {
    const generator = new CharterGenerator();
    const prompt =
      "In start.sh, add the trailing comment '# See README.md for usage details.' to the final executable command line. Do not modify README.md.";
    const analysis = generator.analyzeRequest(prompt);
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt,
      analysis,
    });

    assert.deepEqual(
      [...prepared.targets].sort(),
      ["start.sh"],
      `expected start.sh only, got ${JSON.stringify(prepared.targets)}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: double-quoted README.md is ignored", () => {
  const projectRoot = makeRepoWithReadme();
  try {
    const generator = new CharterGenerator();
    const prompt =
      'In start.sh, add "# See README.md for usage details." to the final line. Do not modify README.md.';
    const analysis = generator.analyzeRequest(prompt);
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt,
      analysis,
    });

    assert.deepEqual([...prepared.targets].sort(), ["start.sh"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: backtick-fenced README.md is ignored", () => {
  const projectRoot = makeRepoWithReadme();
  try {
    const generator = new CharterGenerator();
    const prompt =
      "In start.sh, add `# See README.md for usage details.` to the final line. Do not modify README.md.";
    const analysis = generator.analyzeRequest(prompt);
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt,
      analysis,
    });

    assert.deepEqual([...prepared.targets].sort(), ["start.sh"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: 'Do not modify README.md' wins even when README.md exists on disk", () => {
  // The leak's defining property: README.md exists in the repo, the
  // raw prompt mentions it, and inspectExistingPath used to push it
  // straight into the changeSet. The negated-target filter must run
  // BEFORE the existence check so on-disk presence is no defense.
  const projectRoot = makeRepoWithReadme();
  try {
    const generator = new CharterGenerator();
    const prompt = "In start.sh, append a comment line. Do not modify README.md.";
    const analysis = generator.analyzeRequest(prompt);
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt,
      analysis,
    });

    assert.equal(
      prepared.targets.includes("README.md"),
      false,
      `negated README.md must NOT be in prepared targets, got ${JSON.stringify(prepared.targets)}`,
    );
    assert.ok(prepared.targets.includes("start.sh"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: explicit 'Update start.sh and README.md' keeps both as targets", () => {
  const projectRoot = makeRepoWithReadme();
  try {
    const generator = new CharterGenerator();
    const prompt = "Update start.sh and README.md to mention the new env var.";
    const analysis = generator.analyzeRequest(prompt);
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt,
      analysis,
    });

    assert.deepEqual(
      [...prepared.targets].sort(),
      ["README.md", "start.sh"],
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: charter ['start.sh'] + quoted+negated README.md prompt yields start.sh only (boundary regression)", () => {
  // Direct reproduction of run ffe132ed-2c34-4f66-9837-7de6c6b1f6c1:
  // charter returned ["start.sh"] correctly, but prepareTargetsForPrompt
  // re-derived README.md from the prompt and overrode the result. Pin
  // the boundary contract so we'd see this fail loudly if either
  // surface drifted.
  const projectRoot = makeRepoWithReadme();
  try {
    const prompt =
      "In start.sh, add the trailing comment '# See README.md for usage details.' to the final executable command line. Do not modify README.md.";
    const analysis: import("./charter.js").RequestAnalysis = {
      raw: prompt,
      category: "docs",
      targets: ["start.sh"],
      scopeEstimate: "small",
      riskSignals: [],
      ambiguities: [],
    };
    const prepared = prepareTargetsForPrompt({
      projectRoot,
      prompt,
      analysis,
    });

    assert.deepEqual([...prepared.targets].sort(), ["start.sh"]);
    assert.equal(prepared.targets.includes("README.md"), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: 'create <path>' accepts a non-existent file as a valid target (burn-in-09 fix)", () => {
  // The prompt explicitly asks to CREATE a file that doesn't exist yet.
  // Target discovery must not reject it — the builder needs it as a
  // dispatch target to produce the new file.
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-create-intent-"));
  try {
    mkdirSync(join(projectRoot, "core"), { recursive: true });
    writeFileSync(join(projectRoot, "core", "retry-utils.ts"), "export function delay() {}\n", "utf-8");
    // NOTE: core/retry-utils.test.ts intentionally does NOT exist.

    const prompt =
      "In core/retry-utils.ts, add a small exported function clampDelay. " +
      "Then create core/retry-utils.test.ts with three focused tests.";
    const analysis: import("./charter.js").RequestAnalysis = {
      raw: prompt,
      category: "feature",
      targets: ["core/retry-utils.ts", "core/retry-utils.test.ts"],
      scopeEstimate: "small",
      riskSignals: [],
      ambiguities: [],
    };
    const prepared = prepareTargetsForPrompt({ projectRoot, prompt, analysis });

    assert.deepEqual(
      [...prepared.targets].sort(),
      ["core/retry-utils.test.ts", "core/retry-utils.ts"],
      "both the existing and to-be-created file must be accepted",
    );
    assert.equal(prepared.rejected.length, 0, "nothing should be rejected");
    const createSelected = prepared.selected.find((s) => s.path === "core/retry-utils.test.ts");
    assert.ok(createSelected, "the created file must appear in selected");
    assert.ok(
      createSelected.reasons.some((r) => /creation/i.test(r)),
      "selection reason must mention creation intent",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("target discovery: non-existent file WITHOUT creation verb is still rejected", () => {
  // Guard against the fix being too permissive — a file mentioned
  // without a creation verb must still be rejected when absent.
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-no-create-"));
  try {
    mkdirSync(join(projectRoot, "core"), { recursive: true });
    writeFileSync(join(projectRoot, "core", "foo.ts"), "// stub\n", "utf-8");

    const prompt = "In core/foo.ts, fix the bug. Also check core/bar.test.ts for regressions.";
    const analysis: import("./charter.js").RequestAnalysis = {
      raw: prompt,
      category: "bugfix",
      targets: ["core/foo.ts", "core/bar.test.ts"],
      scopeEstimate: "small",
      riskSignals: [],
      ambiguities: [],
    };
    const prepared = prepareTargetsForPrompt({ projectRoot, prompt, analysis });

    assert.ok(prepared.targets.includes("core/foo.ts"), "existing file accepted");
    assert.ok(!prepared.targets.includes("core/bar.test.ts"), "non-existent file without create verb must be rejected");
    assert.ok(
      prepared.rejected.some((r) => r.path === "core/bar.test.ts"),
      "rejection must be recorded",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
