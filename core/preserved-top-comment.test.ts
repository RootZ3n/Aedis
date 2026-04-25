import test from "node:test";
import assert from "node:assert/strict";

import {
  enforcePreservedTopComment,
  extractTopCommentBlock,
  looksLikeAddOrPrependDirective,
} from "./preserved-top-comment.js";

// ─── extractTopCommentBlock ──────────────────────────────────────────

test("extractTopCommentBlock: detects multi-line python docstring", () => {
  const content = `#!/usr/bin/env python3
"""
Absent Pianist - Hymn Library Generator

For each hymn: downloads source MIDI, splits into intro/verse/refrain.
"""

import argparse
`;
  const block = extractTopCommentBlock(content);
  assert.equal(block.kind, "py-docstring");
  assert.ok(block.lineCount >= 4, `expected multi-line, got ${block.lineCount}`);
  assert.ok(block.text.includes("Hymn Library Generator"));
});

test("extractTopCommentBlock: detects single-line python docstring", () => {
  const content = `#!/usr/bin/env python3
"""Hymn generation helpers."""

import argparse
`;
  const block = extractTopCommentBlock(content);
  assert.equal(block.kind, "py-docstring");
  assert.equal(block.lineCount, 1);
});

test("extractTopCommentBlock: detects JSDoc block", () => {
  const content = `/**
 * Failure explainer — turns merge-gate findings into human-readable summaries.
 *
 * Background and rationale here.
 */

export function foo() {}
`;
  const block = extractTopCommentBlock(content);
  assert.equal(block.kind, "jsdoc");
  assert.ok(block.lineCount >= 4);
});

test("extractTopCommentBlock: detects contiguous line comments", () => {
  const content = `// this is a header
// with two lines

export const x = 1;
`;
  const block = extractTopCommentBlock(content);
  assert.equal(block.kind, "line-comments");
  assert.equal(block.lineCount, 2);
});

test("extractTopCommentBlock: returns 'none' on a file with no top doc", () => {
  const content = `import argparse

x = 1
`;
  const block = extractTopCommentBlock(content);
  assert.equal(block.kind, "none");
});

test("extractTopCommentBlock: shebang-only file has no doc", () => {
  const content = `#!/usr/bin/env python3
import argparse
`;
  const block = extractTopCommentBlock(content);
  assert.equal(block.kind, "none");
});

// ─── looksLikeAddOrPrependDirective ──────────────────────────────────

test("looksLikeAddOrPrependDirective: matches the absent-pianist prompt", () => {
  assert.equal(
    looksLikeAddOrPrependDirective(
      'Add a one-line module docstring at the top of generate.py: "Hymn generation helpers."',
    ),
    true,
  );
});

test("looksLikeAddOrPrependDirective: matches 'add a JSDoc above' phrasing", () => {
  assert.equal(
    looksLikeAddOrPrependDirective("In foo.ts, add a JSDoc above the bar function explaining what it does."),
    true,
  );
});

test("looksLikeAddOrPrependDirective: rejects 'replace the docstring'", () => {
  assert.equal(
    looksLikeAddOrPrependDirective("Replace the docstring with a one-liner."),
    false,
  );
});

test("looksLikeAddOrPrependDirective: rejects 'rewrite the header'", () => {
  assert.equal(
    looksLikeAddOrPrependDirective("Rewrite the header comment to be shorter."),
    false,
  );
});

test("looksLikeAddOrPrependDirective: rejects 'shorten the existing docstring'", () => {
  assert.equal(
    looksLikeAddOrPrependDirective("Shorten the existing docstring to a single line."),
    false,
  );
});

test("looksLikeAddOrPrependDirective: rejects unrelated prompts", () => {
  assert.equal(looksLikeAddOrPrependDirective("Fix the off-by-one in the loop."), false);
  assert.equal(looksLikeAddOrPrependDirective(""), false);
});

// ─── enforcePreservedTopComment ──────────────────────────────────────

const ABSENT_PIANIST_BEFORE = `#!/usr/bin/env python3
"""
Absent Pianist - Hymn Library Generator

Generates a complete music file library for small churches without a pianist.
For each hymn: downloads source MIDI, splits into intro/verse/refrain sections,
converts to MusicXML, and renders to WAV via FluidSynth.

Output per hymn: 9 files (intro/verse/refrain x MIDI/MusicXML/WAV)
"""

import argparse
`;

const ABSENT_PIANIST_AFTER_BAD = `#!/usr/bin/env python3
"""Hymn generation helpers."""

import argparse
`;

const ABSENT_PIANIST_AFTER_GOOD = `#!/usr/bin/env python3
"""
Hymn generation helpers.

Absent Pianist - Hymn Library Generator

Generates a complete music file library for small churches without a pianist.
For each hymn: downloads source MIDI, splits into intro/verse/refrain sections,
converts to MusicXML, and renders to WAV via FluidSynth.

Output per hymn: 9 files (intro/verse/refrain x MIDI/MusicXML/WAV)
"""

import argparse
`;

test("enforcePreservedTopComment: TRIPS on the absent-pianist 5838aad regression", () => {
  assert.throws(
    () =>
      enforcePreservedTopComment(
        ABSENT_PIANIST_BEFORE,
        ABSENT_PIANIST_AFTER_BAD,
        "generate.py",
        'Add a one-line module docstring at the top of generate.py: "Hymn generation helpers."',
      ),
    /SAFETY: Builder output replaced an existing/,
  );
});

test("enforcePreservedTopComment: ALLOWS prepending while preserving original", () => {
  // This is the right behavior for "Add a docstring" — prepend the new
  // one-liner but keep the existing block. lineCount goes up, not down.
  enforcePreservedTopComment(
    ABSENT_PIANIST_BEFORE,
    ABSENT_PIANIST_AFTER_GOOD,
    "generate.py",
    'Add a one-line module docstring at the top of generate.py: "Hymn generation helpers."',
  );
});

test("enforcePreservedTopComment: ALLOWS shrinkage when prompt says 'replace'", () => {
  // The user explicitly authorized replacement; guard must not fire.
  enforcePreservedTopComment(
    ABSENT_PIANIST_BEFORE,
    ABSENT_PIANIST_AFTER_BAD,
    "generate.py",
    "Replace the docstring at the top of generate.py with a one-liner: 'Hymn generation helpers.'",
  );
});

test("enforcePreservedTopComment: ALLOWS shrinkage when prompt says 'simplify'", () => {
  enforcePreservedTopComment(
    ABSENT_PIANIST_BEFORE,
    ABSENT_PIANIST_AFTER_BAD,
    "generate.py",
    "Simplify the module docstring at the top of generate.py.",
  );
});

test("enforcePreservedTopComment: no-op when there is no userRequest", () => {
  enforcePreservedTopComment(ABSENT_PIANIST_BEFORE, ABSENT_PIANIST_AFTER_BAD, "generate.py");
  enforcePreservedTopComment(ABSENT_PIANIST_BEFORE, ABSENT_PIANIST_AFTER_BAD, "generate.py", null);
});

test("enforcePreservedTopComment: no-op for unrelated prompts", () => {
  enforcePreservedTopComment(
    ABSENT_PIANIST_BEFORE,
    ABSENT_PIANIST_AFTER_BAD,
    "generate.py",
    "Fix the off-by-one bug in the parser.",
  );
});

test("enforcePreservedTopComment: no-op when original had no top doc", () => {
  // Adding a docstring to a file that didn't have one is exactly what
  // 'add' means — never trip in that case.
  enforcePreservedTopComment(
    "import argparse\n\nx = 1\n",
    '"""Hymn helpers."""\n\nimport argparse\n\nx = 1\n',
    "generate.py",
    "Add a module docstring at the top of generate.py.",
  );
});

test("enforcePreservedTopComment: no-op when original was tiny (<= 2 lines)", () => {
  // Prompt says "add" but the existing 1-line docstring is so small
  // there's effectively nothing to lose. Don't trip on this — let
  // the user re-issue with explicit "replace" if needed.
  enforcePreservedTopComment(
    `"""Old short doc."""\n\nimport argparse\n`,
    `"""Hymn helpers."""\n\nimport argparse\n`,
    "generate.py",
    "Add a module docstring describing the module.",
  );
});

test("enforcePreservedTopComment: TRIPS on TS JSDoc replacement under 'add' prompt", () => {
  const before = `/**
 * FailureExplainer — turns merge-gate findings into human-readable summaries.
 *
 * Pulls every failure signal off a RunReceipt and produces a single
 * structured FailureExplanation with code, stage, root cause, and a
 * suggested next step.
 */

export function explainFailure() {}
`;
  const after = `/** Failure explainer summary. */

export function explainFailure() {}
`;
  assert.throws(
    () =>
      enforcePreservedTopComment(
        before,
        after,
        "core/failure-explainer.ts",
        "Add a JSDoc summary at the top of failure-explainer.ts.",
      ),
    /SAFETY: Builder output replaced an existing/,
  );
});

test("enforcePreservedTopComment: ALLOWS same-length wording rewrite (in-place edit)", () => {
  // Same number of lines — this is the d96e4da case after the fix:
  // wording changed inside an existing block, line count unchanged.
  // Guard must not trip.
  const before = `/**
 * Header line one.
 * Header line two.
 */

export const x = 1;
`;
  const after = `/**
 * Header line ONE rewritten.
 * Header line two rewritten.
 */

export const x = 1;
`;
  enforcePreservedTopComment(
    before,
    after,
    "core/foo.ts",
    "Add clarifying wording to the JSDoc at the top.",
  );
});
