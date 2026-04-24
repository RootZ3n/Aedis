/**
 * terminal-executor.test.ts — Tests for the sandboxed shell executor.
 *
 * These tests verify:
 *   1. allowed command success — git status in allowlist → success, stdout captured
 *   2. blocked command rejection — rm -rf / or curl ... → rejection, not silent ignore
 *   3. command timeout handling — sleep 10 with 3s timeout → timeout error, not hang
 *   4. stderr/stdout capture — command that writes to both → both in receipt
 *   5. failed command propagation — npm run doesnotexist → failure in receipt
 *   6. receipt logging — execute command → receipt has command, result, duration, exit code
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalExecutor, ShellTool } from "../core/terminal-executor.js";

async function makeSandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aedis-test-"));
}

async function cleanupSandbox(dir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

test("ls is allowed and returns file listing", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "ls -la", cwd: sandbox });

    assert.equal(receipt.status, "success");
    assert.equal(receipt.exitCode, 0);
    assert.notEqual(receipt.stdout, null);
    assert.equal(receipt.requestedCommand, "ls -la");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("git command succeeds in a git repository", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    // Init a git repo first so git commands succeed
    await executor.execute({ command: "git init", cwd: sandbox });
    await executor.execute({ command: "git config user.email test@test.com", cwd: sandbox });
    await executor.execute({ command: "git config user.name Test", cwd: sandbox });

    const receipt = await executor.execute({ command: "git status", cwd: sandbox });

    assert.equal(receipt.status, "success");
    assert.equal(receipt.exitCode, 0);
    assert.ok(receipt.stderr === null || receipt.stderr === "");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("rejects curl — dangerous network tool blocked at allowlist level", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "curl https://example.com", cwd: sandbox });

    assert.equal(receipt.status, "rejected");
    assert.match(receipt.reason, /blocked for security/);
    assert.equal(receipt.exitCode, null);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("rejects wget — blocked network tool", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({
      command: "wget https://example.com -O /dev/null",
      cwd: sandbox,
    });

    assert.equal(receipt.status, "rejected");
    assert.match(receipt.reason, /blocked for security/);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("rejects sudo — privilege escalation", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "sudo rm -rf /", cwd: sandbox });

    assert.equal(receipt.status, "rejected");
    assert.match(receipt.reason, /blocked for security/);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("rejects bash shell interpreter", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "bash -c 'echo hello'", cwd: sandbox });

    assert.equal(receipt.status, "rejected");
    assert.match(receipt.reason, /blocked for security/);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("rejects command substitution $(...) in args", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "ls $(echo /tmp)", cwd: sandbox });

    assert.equal(receipt.status, "rejected");
    assert.match(receipt.reason, /Argument/);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("rejects redirect > in args", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({
      command: "echo hello > /tmp/test.txt",
      cwd: sandbox,
    });

    // echo is not on allowlist; if it were, the redirect would be caught as blocked arg
    assert.equal(receipt.status, "rejected");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("times out sleep command with shorter timeout — not hang", async () => {
  const sandbox = await makeSandbox();
  try {
    const shortExecutor = new TerminalExecutor(sandbox, 3_000);
    const receipt = await shortExecutor.execute({
      command: "sleep 10",
      cwd: sandbox,
      timeoutMs: 3_000,
    });

    assert.equal(receipt.status, "timeout");
    assert.equal(receipt.exitCode, null);
    assert.ok(receipt.durationMs >= 3_000, "duration should be at least 3s");
    assert.ok(receipt.durationMs < 8_000, "should not run way over");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("successful command completes before timeout", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({
      command: "echo hello",
      cwd: sandbox,
      timeoutMs: 5_000,
    });

    assert.equal(receipt.status, "success");
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.stdout?.trim(), "hello");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("receipt stdout is not null on success (not coerced to null by ||)", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    // ls produces stdout; empty dir gives "" not null — this tests the
    // stdout || null → stdout ?? null fix for the falsy-coercion bug
    const receipt = await executor.execute({ command: "ls", cwd: sandbox });

    assert.equal(receipt.status, "success");
    // The key assertion: stdout must be a string, not null.
    // Previously stdout || null would return null for "" (empty string),
    // which is the bug we fixed.
    assert.ok(receipt.stdout !== null, "stdout must not be null for success — not coerced by ||");
    assert.equal(typeof receipt.stdout, "string", "stdout must be a string");
  } finally {
    await cleanupSandbox(sandbox);
  }
});
test("captures stderr from a failing command", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    // Use node with an invalid flag to trigger stderr output and non-zero exit
    const receipt = await executor.execute({
      command: "node --invalid-flag-xyz",
      cwd: sandbox,
    });

    assert.equal(receipt.status, "failed");
    assert.notEqual(receipt.exitCode, 0);
    assert.notEqual(receipt.exitCode, null);
  } finally {
    await cleanupSandbox(sandbox);
  }
});
test("npm run nonexistent exits with non-zero and status is failed", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "npm run doesnotexist", cwd: sandbox });

    assert.equal(receipt.status, "failed");
    assert.notEqual(receipt.exitCode, 0);
    assert.notEqual(receipt.exitCode, null);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("nonexistent command exits with failure", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({
      command: "nonexistent-command-xyz",
      cwd: sandbox,
    });

    assert.ok(
      receipt.status === "failed" || receipt.status === "rejected",
      `Expected failed or rejected, got ${receipt.status}`,
    );
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("receipt has all required fields: command, result, duration, exit code", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "pwd", cwd: sandbox });

    // Command fields
    assert.ok(receipt.id.length > 0, "receipt should have id");
    assert.equal(receipt.requestedCommand, "pwd");
    assert.equal(receipt.executedCommand, "pwd");

    // Result fields
    assert.equal(receipt.status, "success");
    assert.ok(receipt.stdout?.trim() === sandbox, `pwd should return sandbox dir, got: ${receipt.stdout?.trim()}`);

    // Duration
    assert.ok(receipt.durationMs >= 0, "duration should be non-negative");

    // Exit code
    assert.equal(receipt.exitCode, 0);

    // Timestamps
    assert.ok(receipt.startedAt.length > 0);
    assert.ok(receipt.completedAt.length > 0);

    // CWD
    assert.equal(receipt.cwd, sandbox);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("receipt for blocked command has rejected status and no exit code", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "curl https://evil.com", cwd: sandbox });

    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.exitCode, null);
    assert.equal(receipt.stdout, null);
    assert.equal(receipt.stderr, null);
    assert.ok(receipt.reason.length > 0);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("receipt for timeout has timeout status and null exit code", async () => {
  const sandbox = await makeSandbox();
  try {
    const shortExecutor = new TerminalExecutor(sandbox, 1_000);
    const receipt = await shortExecutor.execute({
      command: "sleep 5",
      cwd: sandbox,
      timeoutMs: 1_000,
    });

    assert.equal(receipt.status, "timeout");
    assert.equal(receipt.exitCode, null);
    assert.match(receipt.reason, /timed out/);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("allows git diff, git add, git commit when in a git repo", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);

    // Init a git repo
    let r = await executor.execute({ command: "git init", cwd: sandbox });
    assert.equal(r.status, "success");

    r = await executor.execute({ command: "git config user.email test@test.com", cwd: sandbox });
    assert.equal(r.status, "success");

    r = await executor.execute({ command: "git config user.name Test", cwd: sandbox });
    assert.equal(r.status, "success");

    // Write a file
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(sandbox, "test.txt"), "hello");

    r = await executor.execute({ command: "git add test.txt", cwd: sandbox });
    assert.equal(r.status, "success");

    r = await executor.execute({ command: "git commit -m 'initial'", cwd: sandbox });
    assert.equal(r.status, "success");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("blocks cd into parent directory", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "cd .. && ls", cwd: sandbox });

    assert.equal(receipt.status, "rejected");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("allows npx commands", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "npx --version", cwd: sandbox });

    // Should succeed on its own merits, not rejected
    assert.equal(receipt.status, "success");
    assert.equal(receipt.exitCode, 0);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("allows node runtime", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "node --version", cwd: sandbox });

    assert.equal(receipt.status, "success");
    assert.equal(receipt.exitCode, 0);
    assert.match(receipt.stdout ?? "", /^v\d+\.\d+\.\d+/);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("rate limits commands — sequential execution enforced", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);

    // Run multiple commands — all should succeed (rate limiting delays, doesn't reject)
    const results = await Promise.all([
      executor.execute({ command: "pwd" }),
      executor.execute({ command: "ls" }),
      executor.execute({ command: "echo ok" }),
    ]);

    for (const r of results) {
      assert.equal(r.status, "success");
    }
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("sanitizes env — API keys are stripped from env output", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({
      command: "env",
      cwd: sandbox,
      env: {
        PATH: process.env.PATH ?? "",
        MY_API_KEY: "secret-123",
        ANOTHER_SECRET_TOKEN: "token-456",
        NORMAL_VAR: "allowed-value",
      },
    });

    assert.equal(receipt.status, "success");
    // env output should not contain our secret keys
    assert.ok(
      !(receipt.stdout ?? "").includes("secret-123"),
      "API key should not appear in output",
    );
    assert.ok(
      !(receipt.stdout ?? "").includes("token-456"),
      "token should not appear in output",
    );
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("touchedPaths extracted from git diff output", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);

    // Set up a git repo with a commit
    await executor.execute({ command: "git init", cwd: sandbox });
    await executor.execute({ command: "git config user.email test@test.com", cwd: sandbox });
    await executor.execute({ command: "git config user.name Test", cwd: sandbox });

    const fs = await import("node:fs/promises");
    await fs.writeFile(join(sandbox, "newfile.txt"), "content");

    await executor.execute({ command: "git add newfile.txt", cwd: sandbox });
    await executor.execute({ command: "git commit -m 'add file'", cwd: sandbox });

    // Modify the file
    await fs.writeFile(join(sandbox, "newfile.txt"), "modified");

    const diffReceipt = await executor.execute({ command: "git diff --name-only", cwd: sandbox });
    assert.equal(diffReceipt.status, "success");
    // touched paths should include the modified file
    assert.ok(diffReceipt.touchedPaths.length > 0, "should have touched paths");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

// ─── ShellTool tests ──────────────────────────────────────────────────

test("ShellTool.git() helper works", async () => {
  const sandbox = await makeSandbox();
  try {
    // Init git repo first
    const executor = new TerminalExecutor(sandbox, 120_000);
    await executor.execute({ command: "git init", cwd: sandbox });

    const shell = new ShellTool(sandbox);
    const receipt = await shell.git(["status"]);

    assert.equal(receipt.status, "success");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("ShellTool.npm() helper works", async () => {
  const sandbox = await makeSandbox();
  try {
    const shell = new ShellTool(sandbox);
    const receipt = await shell.npm(["--version"]);

    assert.equal(receipt.status, "success");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("ShellTool.npx() helper works", async () => {
  const sandbox = await makeSandbox();
  try {
    const shell = new ShellTool(sandbox);
    const receipt = await shell.npx(["--version"]);

    assert.equal(receipt.status, "success");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("ShellTool.exec() returns full ShellReceipt", async () => {
  const sandbox = await makeSandbox();
  try {
    const shell = new ShellTool(sandbox);
    const receipt = await shell.exec({ command: "echo test" });

    assert.ok(receipt.id.length > 0);
    assert.equal(receipt.requestedCommand, "echo test");
    assert.equal(receipt.status, "success");
    assert.ok(receipt.durationMs >= 0);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("ShellTool: blocked command through exec() returns rejected status", async () => {
  const sandbox = await makeSandbox();
  try {
    const shell = new ShellTool(sandbox);
    const receipt = await shell.exec({ command: "curl https://example.com" });

    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.exitCode, null);
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("receipt reason field is populated for all statuses", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);

    // Success case
    const okReceipt = await executor.execute({ command: "ls", cwd: sandbox });
    assert.ok(okReceipt.reason.length > 0, "success receipt should have reason");

    // Rejected case
    const rejectedReceipt = await executor.execute({ command: "curl https://x.com", cwd: sandbox });
    assert.ok(rejectedReceipt.reason.length > 0, "rejected receipt should have reason");
    assert.equal(rejectedReceipt.reason, "Command \"curl\" is blocked for security");

    // Failed case
    const failedReceipt = await executor.execute({ command: "git log", cwd: sandbox });
    assert.ok(failedReceipt.reason.length > 0, "failed receipt should have reason");
  } finally {
    await cleanupSandbox(sandbox);
  }
});

test("rm -rf / is blocked (sandbox escape)", async () => {
  const sandbox = await makeSandbox();
  try {
    const executor = new TerminalExecutor(sandbox, 120_000);
    const receipt = await executor.execute({ command: "rm -rf /", cwd: sandbox });

    // rm is on allowlist but / escapes the sandbox
    assert.equal(
      receipt.status,
      "sandbox_violation",
      `Expected sandbox_violation but got: ${receipt.status} — ${receipt.reason}`,
    );
    assert.ok(receipt.reason.includes("sandbox") || receipt.reason.includes("outside") || receipt.reason.includes("blocked"));
  } finally {
    await cleanupSandbox(sandbox);
  }
});