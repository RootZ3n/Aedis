import test from "node:test";
import assert from "node:assert/strict";

import {
  describesTopOfFile,
  describesBottomOfFile,
  looksLikeOutsideSectionRefusal,
  extractRelevantSection,
  TOP_OF_FILE_LINE_COUNT,
  BOTTOM_OF_FILE_LINE_COUNT,
  SECTION_LARGE_FILE_THRESHOLD,
  SECTION_MAX_LINES,
} from "./scout.js";

// ─── describesTopOfFile ──────────────────────────────────────────────

test("describesTopOfFile: matches hyphenated 'top-of-file' (the burn-in-01 phrasing)", () => {
  assert.equal(
    describesTopOfFile(
      "In core/run-summary.ts, find the existing top-of-file comment block.",
    ),
    true,
  );
});

test("describesTopOfFile: matches spaced 'top of file'", () => {
  assert.equal(describesTopOfFile("at the top of the file"), true);
  assert.equal(describesTopOfFile("place this at the top"), true);
});

test("describesTopOfFile: matches 'file header' and 'beginning of file'", () => {
  assert.equal(describesTopOfFile("update the file header"), true);
  assert.equal(describesTopOfFile("at the beginning of the file"), true);
  assert.equal(describesTopOfFile("file-header"), true);
});

test("describesTopOfFile: matches header-comment phrasing", () => {
  assert.equal(describesTopOfFile("update the header comment"), true);
  assert.equal(describesTopOfFile("the leading docblock"), true);
  assert.equal(describesTopOfFile("topmost JSDoc"), true);
  assert.equal(describesTopOfFile("the opening comment block"), true);
});

test("describesTopOfFile: ignores unrelated text", () => {
  assert.equal(describesTopOfFile("rename a function in the middle"), false);
  assert.equal(describesTopOfFile("add a parameter to foo()"), false);
  assert.equal(describesTopOfFile(""), false);
  assert.equal(describesTopOfFile(null), false);
  assert.equal(describesTopOfFile(undefined), false);
});

// ─── describesBottomOfFile ───────────────────────────────────────────

test("describesBottomOfFile: matches hyphenated and spaced forms", () => {
  assert.equal(describesBottomOfFile("at the bottom of the file"), true);
  assert.equal(describesBottomOfFile("end-of-file marker"), true);
  assert.equal(describesBottomOfFile("append to the end"), true);
  assert.equal(describesBottomOfFile("append to bottom"), true);
});

test("describesBottomOfFile: ignores unrelated", () => {
  assert.equal(describesBottomOfFile("middle of the file"), false);
  assert.equal(describesBottomOfFile(null), false);
});

// ─── looksLikeOutsideSectionRefusal ──────────────────────────────────

test("looksLikeOutsideSectionRefusal: matches all three real refusals from run 95180956", () => {
  // These are the actual text fragments that came back from
  // deepseek-v4-flash on the failing burn-in-01 attempts. If the
  // detector regresses on any of these, the Builder reverts to the
  // pre-fix behaviour: 3 wasted attempts instead of one full-file
  // retry.
  const refusalA =
    "Blocker: The requested edit targets the top-of-file comment block (lines 1–40), but the provided section is limited to lines 428–577.";
  const refusalB =
    "BLOCKER: The requested edit cannot be applied within the provided section (lines 428–577). The top-of-file comment block (which holds the comment describing the module) exists before line 428, outside";
  const refusalC =
    "Blocker: The designated edit section (lines 428–577) does not include the top-of-file comment block. To add the line at the end of that block, the diff must target lines before 428, which violates the";

  assert.equal(looksLikeOutsideSectionRefusal(refusalA), true);
  assert.equal(looksLikeOutsideSectionRefusal(refusalB), true);
  assert.equal(looksLikeOutsideSectionRefusal(refusalC), true);
});

test("looksLikeOutsideSectionRefusal: doesn't false-positive on real diffs", () => {
  assert.equal(
    looksLikeOutsideSectionRefusal("--- a/foo.ts\n+++ b/foo.ts\n@@ -10,3 +10,4 @@\n line\n+new\n line"),
    false,
  );
  assert.equal(looksLikeOutsideSectionRefusal("Successfully applied the change."), false);
  assert.equal(looksLikeOutsideSectionRefusal("Here is the updated function."), false);
  assert.equal(looksLikeOutsideSectionRefusal(""), false);
  assert.equal(looksLikeOutsideSectionRefusal(null), false);
});

test("looksLikeOutsideSectionRefusal: matches paraphrases the model could plausibly emit", () => {
  assert.equal(
    looksLikeOutsideSectionRefusal("The target lies outside the provided section."),
    true,
  );
  assert.equal(
    looksLikeOutsideSectionRefusal("Cannot edit; the comment is outside this window."),
    true,
  );
  assert.equal(
    looksLikeOutsideSectionRefusal("The provided section does not include the requested area."),
    true,
  );
});

// ─── extractRelevantSection: top-of-file routing ─────────────────────

function makeLargeFile(lines: number, padding = "x".repeat(120)): string {
  // Force length above SECTION_LARGE_FILE_THRESHOLD so section-edit
  // mode actually engages — that's the precondition for the
  // top-of-file pre-check to run.
  return Array.from({ length: lines }, (_, i) => `// line ${i} ${padding}`).join("\n");
}

test("extractRelevantSection: hyphenated top-of-file prompt routes to file head", () => {
  const lineCount = SECTION_MAX_LINES * 4; // ensure > SECTION_MAX_LINES
  const fullContent = makeLargeFile(lineCount);
  assert.ok(
    fullContent.length > SECTION_LARGE_FILE_THRESHOLD,
    "test fixture must exceed large-file threshold",
  );
  const result = extractRelevantSection(
    "core/run-summary.ts",
    fullContent,
    "find the existing top-of-file comment block. Add a single new comment line at the end of that block.",
  );
  assert.ok(result, "expected a section extraction");
  assert.equal(result.startLine, 1, "section should start at line 1");
  assert.equal(result.matchedFunction, "file-header");
  assert.equal(result.extractionMethod, "top-of-file-keyword");
  assert.equal(result.endLine, TOP_OF_FILE_LINE_COUNT);
});

test("extractRelevantSection: spaced 'top of the file' also routes to file head", () => {
  const fullContent = makeLargeFile(SECTION_MAX_LINES * 4);
  const result = extractRelevantSection(
    "core/foo.ts",
    fullContent,
    "Add a comment at the top of the file describing what this module does.",
  );
  assert.ok(result);
  assert.equal(result.startLine, 1);
  assert.equal(result.extractionMethod, "top-of-file-keyword");
});

test("extractRelevantSection: bottom-of-file prompt routes to file tail", () => {
  const lineCount = SECTION_MAX_LINES * 4;
  const fullContent = makeLargeFile(lineCount);
  const result = extractRelevantSection(
    "core/foo.ts",
    fullContent,
    "Append a marker to the end of the file.",
  );
  assert.ok(result);
  assert.equal(result.endLine, lineCount);
  assert.equal(result.matchedFunction, "file-tail");
  assert.equal(result.extractionMethod, "bottom-of-file-keyword");
  assert.equal(result.startLine, lineCount - BOTTOM_OF_FILE_LINE_COUNT + 1);
});

test("extractRelevantSection: mid-file prompt does NOT route to top-of-file", () => {
  // Build a file with a clearly-named function so the
  // function-keyword-match branch picks it. Without a top-of-file
  // signal in the prompt, the head shortcut must NOT fire.
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) lines.push(`// preamble line ${i} ${"x".repeat(120)}`);
  lines.push("export function targetFunctionName() {");
  for (let i = 0; i < 80; i++) lines.push(`  console.log("body ${i}");`);
  lines.push("}");
  for (let i = 0; i < 200; i++) lines.push(`// trailer line ${i} ${"x".repeat(120)}`);
  const fullContent = lines.join("\n");
  assert.ok(fullContent.length > SECTION_LARGE_FILE_THRESHOLD);

  const result = extractRelevantSection(
    "core/foo.ts",
    fullContent,
    "rename targetFunctionName to renamedFunction",
  );
  assert.ok(result);
  assert.notEqual(result.extractionMethod, "top-of-file-keyword");
  assert.notEqual(result.extractionMethod, "bottom-of-file-keyword");
  assert.notEqual(result.startLine, 1);
});

test("extractRelevantSection: small files bypass section-edit entirely", () => {
  // Files under SECTION_LARGE_FILE_THRESHOLD never get sectioned —
  // the Builder ships the full file. This is the "large-file
  // protection only kicks in when needed" half of the contract.
  const small = "// short file\nexport const x = 1;\n";
  const result = extractRelevantSection(
    "core/foo.ts",
    small,
    "find the existing top-of-file comment block",
  );
  assert.equal(result, null, "small file should return null (full-file mode)");
});

test("extractRelevantSection: top-of-file slice is bounded — no full-file leak on huge files", () => {
  // Make a file 10× the section max. The top-of-file slice must
  // still cap at TOP_OF_FILE_LINE_COUNT lines, not return the
  // whole file.
  const huge = makeLargeFile(SECTION_MAX_LINES * 10);
  const result = extractRelevantSection(
    "core/foo.ts",
    huge,
    "update top-of-file comment block",
  );
  assert.ok(result);
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, TOP_OF_FILE_LINE_COUNT);
  // The section text must be roughly TOP_OF_FILE_LINE_COUNT lines
  // and far smaller than the full file.
  assert.ok(result.section.length < huge.length / 5);
});
