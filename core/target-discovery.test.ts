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
