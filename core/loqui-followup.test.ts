import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractPathOnlyToken,
  resolvePathFollowUp,
} from "./loqui-followup.js";
import { routeLoquiInput } from "./loqui-router.js";

// ─── extractPathOnlyToken ────────────────────────────────────────────

test("extractPathOnlyToken: bare absolute path → token", () => {
  assert.equal(
    extractPathOnlyToken("/mnt/ai/squidley-v2/modules/magister"),
    "/mnt/ai/squidley-v2/modules/magister",
  );
});

test("extractPathOnlyToken: leading hint words are stripped", () => {
  assert.equal(
    extractPathOnlyToken("in /mnt/ai/squidley-v2/modules/magister"),
    "/mnt/ai/squidley-v2/modules/magister",
  );
  assert.equal(
    extractPathOnlyToken("path: modules/magister"),
    "modules/magister",
  );
});

test("extractPathOnlyToken: relative path with slash → token", () => {
  assert.equal(extractPathOnlyToken("modules/magister"), "modules/magister");
});

test("extractPathOnlyToken: bare filename with extension → token", () => {
  assert.equal(extractPathOnlyToken("foo.ts"), "foo.ts");
});

test("extractPathOnlyToken: multi-clause prompt is rejected", () => {
  assert.equal(
    extractPathOnlyToken("Add Instructor Mode to Magister for interactive teaching"),
    null,
  );
});

test("extractPathOnlyToken: URL is rejected", () => {
  assert.equal(extractPathOnlyToken("https://example.com/foo"), null);
});

test("extractPathOnlyToken: bare word with no path markers is rejected", () => {
  assert.equal(extractPathOnlyToken("Magister"), null);
});

// ─── resolvePathFollowUp: A. follow-up path answer ───────────────────

test("A. follow-up: absolute path inside projectRoot binds to combined build", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-followup-A-"));
  try {
    mkdirSync(join(projectRoot, "modules", "magister"), { recursive: true });
    const followUp = resolvePathFollowUp(
      `${projectRoot}/modules/magister`,
      {
        originalPrompt: "Add Instructor Mode to Magister for interactive teaching.",
        projectRoot,
      },
    );
    assert.ok(followUp, "follow-up resolution must fire");
    assert.equal(followUp!.relativePath, "modules/magister");
    assert.equal(followUp!.exists, true);
    assert.equal(followUp!.isDirectory, true);
    assert.match(
      followUp!.combinedPrompt,
      /Add Instructor Mode/,
      "combined prompt must include the original task",
    );
    assert.match(
      followUp!.combinedPrompt,
      /modules\/magister/,
      "combined prompt must name the bound scope",
    );
    assert.match(
      followUp!.reason,
      /Got it.+modules\/magister/i,
      "reason must use the requested wording",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("A. follow-up: router returns build action with combined prompt", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-followup-A2-"));
  try {
    mkdirSync(join(projectRoot, "modules", "magister"), { recursive: true });
    const decision = routeLoquiInput({
      input: `${projectRoot}/modules/magister`,
      context: {
        awaitingScopeFor: "Add Instructor Mode to Magister for interactive teaching.",
        projectRoot,
      },
    });
    assert.equal(decision.action, "build");
    assert.equal(decision.label, "Building");
    assert.equal(decision.clarification, "");
    assert.match(decision.effectivePrompt, /Add Instructor Mode/);
    assert.match(decision.effectivePrompt, /modules\/magister/);
    assert.ok(decision.followUpScope, "router must surface follow-up envelope");
    assert.equal(decision.followUpScope!.relativePath, "modules/magister");
    assert.equal(decision.followUpScope!.isDirectory, true);
    assert.ok(
      decision.signals.includes("followup:path-bound"),
      `expected followup:path-bound signal; got ${decision.signals.join(",")}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── B. Repo-relative normalization ──────────────────────────────────

test("B. repo-relative: absolute path inside root → repo-relative form", () => {
  const projectRoot = "/mnt/ai/squidley-v2";
  // No filesystem touch — pure path arithmetic.
  const followUp = resolvePathFollowUp(
    "/mnt/ai/squidley-v2/modules/magister",
    {
      originalPrompt: "Add Instructor Mode to Magister.",
      projectRoot,
    },
  );
  assert.ok(followUp);
  assert.equal(followUp!.relativePath, "modules/magister");
  assert.equal(
    followUp!.absolutePath,
    "/mnt/ai/squidley-v2/modules/magister",
    "absolutePath must be the resolved absolute form",
  );
});

test("B. repo-relative: absolute path OUTSIDE root stays absolute", () => {
  const projectRoot = "/mnt/ai/squidley-v2";
  const followUp = resolvePathFollowUp(
    "/var/log/system.log",
    {
      originalPrompt: "Look at system log.",
      projectRoot,
    },
  );
  assert.ok(followUp);
  assert.equal(
    followUp!.relativePath,
    "/var/log/system.log",
    "outside-root paths must stay absolute so target discovery doesn't false-match",
  );
});

// ─── C. Directory target discovery ───────────────────────────────────

test("C. directory target: existing dir is reported as directory + scope noun matches", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-followup-C-"));
  try {
    mkdirSync(join(projectRoot, "modules", "magister"), { recursive: true });
    writeFileSync(
      join(projectRoot, "modules", "magister", "index.ts"),
      "export const magister = true;\n",
      "utf-8",
    );
    const followUp = resolvePathFollowUp(
      "modules/magister",
      {
        originalPrompt: "Add Instructor Mode to Magister.",
        projectRoot,
      },
    );
    assert.ok(followUp);
    assert.equal(followUp!.exists, true);
    assert.equal(followUp!.isDirectory, true);
    assert.match(followUp!.combinedPrompt, /\(directory\)/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("C. directory target: file target is reported as file (not directory)", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-followup-C2-"));
  try {
    mkdirSync(join(projectRoot, "core"), { recursive: true });
    writeFileSync(join(projectRoot, "core", "foo.ts"), "// foo\n", "utf-8");
    const followUp = resolvePathFollowUp(
      "core/foo.ts",
      {
        originalPrompt: "Update foo.",
        projectRoot,
      },
    );
    assert.ok(followUp);
    assert.equal(followUp!.exists, true);
    assert.equal(followUp!.isDirectory, false);
    assert.match(followUp!.combinedPrompt, /\(file\)/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── D. Path-only first message ──────────────────────────────────────

test("D. path-only first message: routes to clarify, not build", () => {
  const decision = routeLoquiInput({
    input: "/mnt/ai/squidley-v2/modules/magister",
    context: {},
  });
  assert.equal(decision.action, "clarify");
  assert.equal(decision.intent, "unknown");
  assert.equal(decision.label, "Clarifying");
  assert.match(decision.clarification, /no task|what do you want/i);
  assert.ok(
    decision.signals.includes("clarify:path-only-no-context"),
    `expected clarify:path-only-no-context; got ${decision.signals.join(",")}`,
  );
});

// ─── Misc: follow-up does not fire without originalPrompt ────────────

test("follow-up: no originalPrompt → null", () => {
  const followUp = resolvePathFollowUp("modules/magister", {
    originalPrompt: "",
  });
  assert.equal(followUp, null);
});

test("follow-up: non-path input → null even with originalPrompt", () => {
  const followUp = resolvePathFollowUp("just keep going", {
    originalPrompt: "Add a feature.",
    projectRoot: tmpdir(),
  });
  assert.equal(followUp, null);
});

test("follow-up: unverified path is still bound (creation intent)", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-followup-unverified-"));
  try {
    const followUp = resolvePathFollowUp(
      "modules/magister",
      {
        originalPrompt: "Create Magister.",
        projectRoot,
      },
    );
    assert.ok(followUp);
    assert.equal(followUp!.exists, false);
    assert.equal(followUp!.isDirectory, false);
    // Still produces a combined prompt and acknowledgement so the
    // user gets a clear "I'm using <path>" message even if Aedis
    // ends up creating that directory.
    assert.match(followUp!.combinedPrompt, /modules\/magister/);
    assert.match(followUp!.reason, /Got it/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
