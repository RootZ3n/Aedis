/**
 * Preserved-top-comment guard.
 *
 * Detects the failure mode that produced commit 5838aad on
 * absent-pianist: a prompt that says "add a one-line module docstring"
 * applied to a file that already has a multi-line top-of-file
 * docstring, and the model REPLACES the existing block with the new
 * one-liner instead of prepending. The diff "succeeds" mechanically
 * but loses the existing documentation.
 *
 * This guard is intentionally narrow: it only fires when
 *   1. the user prompt clearly asks to ADD/PREPEND/INSERT a
 *      top-of-file comment or docstring,
 *   2. AND the original file already has a multi-line top-of-file
 *      doc/comment block,
 *   3. AND the updated file's top-of-file block is materially shorter.
 * That keeps it from tripping on legitimate prompts like "shorten the
 * file header" or "rewrite the docstring to one line".
 *
 * Distinct from enforcePreservedExports — that guard checks symbol
 * surface; this one checks documentation surface. Both throw on trip
 * so Builder.execute records a guard rejection on the attempt record.
 */

const SHEBANG_RE = /^#!.*\n/;

const ADD_OR_PREPEND_RE =
  /\b(add|prepend|insert)\b[^.]{0,80}?\b(line|comment|docstring|note|jsdoc|description|summary|header|doc-comment)\b/i;

interface TopCommentBlock {
  readonly kind: "jsdoc" | "py-docstring" | "line-comments" | "none";
  readonly text: string;
  readonly lineCount: number;
}

function stripShebang(content: string): string {
  return content.replace(SHEBANG_RE, "");
}

/**
 * Extract the top-of-file documentation block — the first JSDoc,
 * Python triple-quoted docstring, or contiguous run of single-line
 * comments. Returns kind="none" when no such block exists. Skips a
 * leading shebang so Python `#!/usr/bin/env python3` is handled.
 */
export function extractTopCommentBlock(content: string): TopCommentBlock {
  const body = stripShebang(content);
  const trimmed = body.replace(/^\s*\n+/, "");

  if (trimmed.startsWith("/**")) {
    const end = trimmed.indexOf("*/");
    if (end > 0) {
      const text = trimmed.slice(0, end + 2);
      return { kind: "jsdoc", text, lineCount: text.split("\n").length };
    }
  }

  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
    const quote = trimmed.slice(0, 3);
    const end = trimmed.indexOf(quote, 3);
    if (end > 0) {
      const text = trimmed.slice(0, end + 3);
      return { kind: "py-docstring", text, lineCount: text.split("\n").length };
    }
  }

  // Contiguous // line comments at the top (TS/JS) or # line comments
  // (Python after shebang stripping). Stop at the first non-comment,
  // non-blank line.
  const lines = trimmed.split("\n");
  const commentLines: string[] = [];
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("#")) {
      commentLines.push(line);
      continue;
    }
    if (t === "") {
      // Blank line inside the comment block is allowed only between
      // comment runs, so we stop counting if the next non-blank line
      // isn't a comment. Cheap heuristic: stop here and require a
      // continuous run.
      break;
    }
    break;
  }
  if (commentLines.length >= 2) {
    return {
      kind: "line-comments",
      text: commentLines.join("\n"),
      lineCount: commentLines.length,
    };
  }

  return { kind: "none", text: "", lineCount: 0 };
}

/**
 * True when the user request reads like a request to ADD/PREPEND a
 * comment or docstring rather than to rewrite/replace one.
 */
export function looksLikeAddOrPrependDirective(userRequest: string): boolean {
  if (!userRequest) return false;
  // Negative signals — if the prompt explicitly mentions
  // replacing/rewriting/shortening, treat the directive as authorized.
  if (/\b(replace|rewrite|shorten|trim|simplify|condense|collapse)\b/i.test(userRequest)) {
    return false;
  }
  return ADD_OR_PREPEND_RE.test(userRequest);
}

/**
 * Throw a SAFETY error when the diff replaces an existing multi-line
 * top-of-file doc/comment with a shorter one despite the prompt
 * asking to ADD/PREPEND. No-op when:
 *   - userRequest is missing or doesn't look like an add/prepend ask
 *   - original has no top-of-file doc/comment to preserve
 *   - the updated block is the same length or longer
 *   - the original was tiny (<= 2 lines) so there's nothing to lose
 */
export function enforcePreservedTopComment(
  originalContent: string,
  updatedContent: string,
  filePath: string,
  userRequest?: string | null,
): void {
  if (!userRequest) return;
  if (!looksLikeAddOrPrependDirective(userRequest)) return;

  const original = extractTopCommentBlock(originalContent);
  if (original.kind === "none") return;
  // A 1-2 line existing block carries little context to lose.
  if (original.lineCount <= 2) return;

  const updated = extractTopCommentBlock(updatedContent);
  if (updated.kind === "none") return; // doc was wholly removed — let other guards handle that
  if (updated.lineCount >= original.lineCount) return;

  // Trip: prompt said "add", file had a real top doc, new top doc is
  // shorter. Almost certainly a wholesale replacement.
  throw new Error(
    `SAFETY: Builder output replaced an existing ${original.lineCount}-line top-of-file ` +
      `${original.kind} with a ${updated.lineCount}-line one in ${filePath}. The user request ` +
      `(${userRequest.slice(0, 80)}${userRequest.length > 80 ? "…" : ""}) asked to ADD/PREPEND ` +
      `documentation, not replace it. Either preserve the original block and prepend the new ` +
      `content, or have the user re-issue the prompt with explicit "replace"/"rewrite" wording.`,
  );
}
