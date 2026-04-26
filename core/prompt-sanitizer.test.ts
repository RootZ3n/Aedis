import test from "node:test";
import assert from "node:assert/strict";

import {
  isNegatedTarget,
  sanitizePromptForFileExtraction,
} from "./prompt-sanitizer.js";

// ─── sanitization: literal-content stripping ────────────────────────

test("sanitizer strips triple-backtick fenced code blocks", () => {
  const { sanitized } = sanitizePromptForFileExtraction(
    "Edit start.sh.\n```bash\ncat README.md\n```\nDone.",
  );
  assert.match(sanitized, /Edit start\.sh\./);
  assert.doesNotMatch(sanitized, /README\.md/);
});

test("sanitizer strips double-quoted regions", () => {
  const { sanitized } = sanitizePromptForFileExtraction(
    'Edit start.sh and add "# See README.md for usage." then stop.',
  );
  assert.match(sanitized, /Edit start\.sh/);
  assert.doesNotMatch(sanitized, /README\.md/);
});

test("sanitizer strips backtick code spans", () => {
  const { sanitized } = sanitizePromptForFileExtraction(
    "Edit start.sh and add `# See README.md for usage.` to the end.",
  );
  assert.match(sanitized, /Edit start\.sh/);
  assert.doesNotMatch(sanitized, /README\.md/);
});

test("sanitizer strips single-quoted regions but preserves contractions", () => {
  const { sanitized } = sanitizePromptForFileExtraction(
    "Aedis's run doesn't normally edit start.sh, but add '# See README.md' to it.",
  );
  // Contractions survive (apostrophes inside letters).
  assert.match(sanitized, /Aedis's/);
  assert.match(sanitized, /doesn't/);
  assert.match(sanitized, /start\.sh/);
  // Genuinely-quoted README.md is gone.
  assert.doesNotMatch(sanitized, /README\.md/);
});

// ─── sanitization: negative-directive collection ────────────────────

test("sanitizer captures 'do not modify X' as a negated target", () => {
  const { negatedTargets } = sanitizePromptForFileExtraction(
    "In start.sh, append a line. Do not modify README.md.",
  );
  assert.ok(negatedTargets.has("README.md"));
});

test("sanitizer captures 'don't change X' / 'don't edit X'", () => {
  const a = sanitizePromptForFileExtraction("Edit start.sh. Don't change README.md.");
  assert.ok(a.negatedTargets.has("README.md"));

  const b = sanitizePromptForFileExtraction("Edit start.sh. Don't edit hymns.txt.");
  assert.ok(b.negatedTargets.has("hymns.txt"));
});

test("sanitizer captures 'without touching X' (first file after the verb)", () => {
  // Existing charter behavior captures only the file directly after
  // the verb — "or Y" trailing forms are a known limitation that
  // would expand the regex's scope. Mirror that contract here so the
  // helper stays drop-in compatible with the charter's prior strip.
  const { negatedTargets } = sanitizePromptForFileExtraction(
    "Refactor start.sh without touching README.md or hymns.txt.",
  );
  assert.ok(negatedTargets.has("README.md"));
});

test("sanitizer captures 'leave X unchanged/untouched/alone'", () => {
  const a = sanitizePromptForFileExtraction("Edit start.sh; leave README.md unchanged.");
  assert.ok(a.negatedTargets.has("README.md"));

  const b = sanitizePromptForFileExtraction("Edit start.sh; leave the hymns.txt untouched.");
  assert.ok(b.negatedTargets.has("hymns.txt"));

  const c = sanitizePromptForFileExtraction("Edit start.sh; leave config.yaml alone.");
  assert.ok(c.negatedTargets.has("config.yaml"));
});

test("sanitizer does NOT fire negation for filenames inside literal/comment content", () => {
  // The "do not modify config.yaml" phrase is the literal payload the
  // user wants Aedis to insert as a comment — NOT a directive to the
  // planner. Negation must be detected on the SANITIZED text only.
  const { negatedTargets } = sanitizePromptForFileExtraction(
    'Add a comment to start.sh that says "do not modify config.yaml" verbatim.',
  );
  assert.equal(negatedTargets.has("config.yaml"), false);
});

// ─── isNegatedTarget: matching semantics ────────────────────────────

test("isNegatedTarget exact match", () => {
  const set = new Set(["README.md"]);
  assert.equal(isNegatedTarget("README.md", set), true);
});

test("isNegatedTarget basename match for bare negation", () => {
  // "Do not modify README.md" → set has "README.md" — should also
  // block docs/README.md, since the user pointed at a basename.
  const set = new Set(["README.md"]);
  assert.equal(isNegatedTarget("docs/README.md", set), true);
});

test("isNegatedTarget does NOT bleed across directories for path-qualified negation", () => {
  // "Don't modify src/lib/helper.ts" → set has "src/lib/helper.ts"
  // — must NOT block workers/helper.ts elsewhere.
  const set = new Set(["src/lib/helper.ts"]);
  assert.equal(isNegatedTarget("src/lib/helper.ts", set), true);
  assert.equal(isNegatedTarget("workers/helper.ts", set), false);
});

test("isNegatedTarget returns false for unrelated targets", () => {
  const set = new Set(["README.md"]);
  assert.equal(isNegatedTarget("start.sh", set), false);
  assert.equal(isNegatedTarget("scripts/start.sh", set), false);
});

// ─── end-to-end: the ffe132ed regression input ──────────────────────

test("sanitizer + isNegatedTarget cleanly handle the ffe132ed prompt", () => {
  const prompt =
    "In start.sh, add the trailing comment '# See README.md for usage details.' to the final executable command line. Do not modify README.md.";
  const { sanitized, negatedTargets } = sanitizePromptForFileExtraction(prompt);
  // The single-quoted comment is gone; the negative directive is captured.
  assert.match(sanitized, /In start\.sh/);
  assert.doesNotMatch(sanitized, /'# See README\.md/);
  assert.ok(negatedTargets.has("README.md"));
  // Any downstream resolver that consults negatedTargets will refuse
  // to add README.md even when README.md exists on disk.
  assert.equal(isNegatedTarget("README.md", negatedTargets), true);
  assert.equal(isNegatedTarget("start.sh", negatedTargets), false);
});
