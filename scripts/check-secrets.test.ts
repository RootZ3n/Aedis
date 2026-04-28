/**
 * check-secrets allowlist regression — pin the contract that the
 * documented release-readiness gate (`npm run security:secrets`)
 * passes on a clean checkout.
 *
 * Before the fix, the allowlist held only `sk-secret-not-to-leak`,
 * which left 11 key-shaped fixtures in core/redaction.test.ts
 * unallowlisted. Every commit this session had to ignore the
 * blocking exit code, contradicting SECURITY.md's "pre-commit /
 * pre-push gate" claim. The allowlist now covers each test
 * fixture explicitly; this test makes sure that stays true.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("./check-secrets.sh", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("security:secrets passes on a clean checkout (release-readiness gate)", () => {
  // Exit 0 + the explicit OK line is the contract the SECURITY.md
  // doc promises operators. A regression here means the gate is
  // false-positive and operators will start running with --no-verify
  // or skipping `npm run check`.
  const output = execFileSync("bash", [SCRIPT_PATH], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(
    output,
    /OK — no forbidden patterns/,
    `expected clean OK; got:\n${output}`,
  );
});

test("security:secrets allowlist covers every redaction-test fixture string", () => {
  // Static cross-check: every shaped-fake fixture in
  // core/redaction.test.ts must appear verbatim in the allowlist
  // array of check-secrets.sh. Catches the case where a new fixture
  // is added but the allowlist isn't updated.
  const scriptSrc = readFileSync(SCRIPT_PATH, "utf-8");
  const fixtures = [
    "sk-abc123def456ghi789jkl012mno",
    "sk-proj-abc123def456ghi789jkl012mno",
    "sk-or-v1-abc123def456ghi789jkl012",
    "sk-ant-api03-abc123def456ghi789jkl012",
    "Bearer eyABCDEF1234567890abcdef",
    "OPENAI_API_KEY=sk-foo123",
    "ANTHROPIC_API_KEY=sk-ant-xxx",
    "OPENAI_API_KEY=sk-real-key-here",
  ];
  for (const fix of fixtures) {
    assert.ok(
      scriptSrc.includes(fix),
      `allowlist missing fixture: ${fix} — add to allowlist[] in scripts/check-secrets.sh`,
    );
  }
});

test("security:secrets allowlist comment names the convention", () => {
  // Soft pin: the allowlist comment must mention the convention
  // (`abc123def456ghi789jkl012` pattern) so future operators don't
  // think the entries are real-shaped credentials and panic.
  const scriptSrc = readFileSync(SCRIPT_PATH, "utf-8");
  assert.match(
    scriptSrc,
    /test fixtures|non-secrets|exercised|exercise the redactor/i,
    "allowlist must explain WHY entries are safe",
  );
});
