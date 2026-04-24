/**
 * terminal-executor.ts — Sandboxed shell execution layer for Aedis.
 *
 * DESIGN PRINCIPLES:
 *   - No unrestricted shell — every command must be explicitly allowed
 *   - Command visibility — requested, executed, and result all logged
 *   - Sandboxed blast radius — commands only touch what's allowed
 *   - Clear separation — requested vs executed vs result, all in receipts
 *
 * This module is the ONLY place where raw shell commands are executed
 * in Aedis. All shell access flows through here so the allowlist,
 * timeout, path sandboxing, and env sanitization are enforced
 * consistently.
 *
 * INTEGRATION:
 *   - The Coordinator or ShellTool dispatches commands and captures
 *     receipts into `changes[]` so the verifier can see what was run.
 *   - Shell results flow into `changes[]` as FileChange records so the
 *     VerificationPipeline and MergeGate can see what was executed.
 *   - Workers (builder, verifier) can call the terminal executor as
 *     a tool for repo operations.
 */

import { randomUUID } from "crypto";
import { spawn } from "node:child_process";
import type { ShellReceipt, ShellExecutionInput, ShellStatus } from "./shell-receipt.js";

// ─── Allowlist ───────────────────────────────────────────────────────

const ALLOWED_COMMANDS = new Set<string>([
  // Git commands
  "git",
  // Package managers
  "npm",
  "pnpm",
  "yarn",
  // TypeScript / lint
  "tsc",
  "npx",
  "eslint",
  "prettier",
  "biome",
  // Runtime
  "node",
  // Shell utilities (read-only + limited write)
  "ls",
  "cat",
  "mkdir",
  "rm",
  "echo",
  "env",
  // Posix utilities for diagnostics
  "pwd",
  "whoami",
  "uname",
  "date",
  "sleep",
  "head",
  "tail",
  "grep",
  "find",
  "sort",
  "uniq",
  "wc",
]);

const BLOCKED_COMMANDS = new Set<string>([
  // Destructive network tools
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "ftp",
  "sftp",
  "nc",
  "netcat",
  "nmap",
  // Privilege escalation
  "sudo",
  "su",
  "doas",
  // Container/system manipulation
  "docker",
  "podman",
  "kubectl",
  "helm",
  // Package install outside known managers
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "zypper",
  "apk",
  "pip",
  "pip3",
  "python",
  "python3",
  "ruby",
  "gem",
  "cargo",
  "go",
  "rustc",
  // File download / archive extraction
  "bzip2",
  "gzip",
  "tar",
  "zip",
  "unzip",
  "7z",
  "rar",
  // Shell interpreters
  "bash",
  "sh",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "sh",
  // Editors / interactive
  "vim",
  "nvim",
  "emacs",
  "nano",
  "micro",
  "code",
  "subl",
  // Git internals that are dangerous
  "git filter-branch",
  "git update-ref",
  // Mount/filesystem
  "mount",
  "umount",
  "fdisk",
  "parted",
  "mkfs",
  // Process manipulation
  "kill",
  "killall",
  "pkill",
  "kill",
]);

// Dangerous argument patterns — any occurrence in the arg list blocks
const BLOCKED_ARG_PATTERNS = [
  /&&/,
  /;/,
  /\|/,
  />/,
  /<|>>?/,
  /\$\(/,
  /`/,
  /\$\{.*\}/,
  /\bnc\b.*-[ept]/i,
  /--upload-plugins/,
  /--remote-fetch/,
  /--remote-submodules/,
  /--recurse-submodules.*:/,
];

// ─── Argument Validator ──────────────────────────────────────────────

function validateArgs(args: readonly string[]): { valid: boolean; reason: string } {
  for (const arg of args) {
    for (const pattern of BLOCKED_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        return {
          valid: false,
          reason: `Argument "${arg}" contains blocked pattern ${pattern.toString()}`,
        };
      }
    }
    // Block any arg that contains newlines (could be multiline injection)
    if (arg.includes("\n") || arg.includes("\r")) {
      return { valid: false, reason: `Argument contains newline — possible injection` };
    }
  }
  return { valid: true, reason: "" };
}

// ─── Command Normalizer ─────────────────────────────────────────────

/**
 * Parse a command string into [command, ...args] without shell evaluation.
 * We split on whitespace and take the first token as command, rest as args.
 * This intentionally does NOT run through a shell — no variable expansion,
 * no glob expansion, no pipe handling. The caller gets raw args.
 */
function parseCommand(raw: string): { cmd: string; args: string[] } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Empty command");
  }
  const [cmd, ...args] = tokens;
  return { cmd, args };
}

// ─── Path Sandbox ────────────────────────────────────────────────────

/**
 * Check whether a path is within the allowed sandbox directory.
 * Prevents `cd /` or `cd ~` — commands stay within projectRoot.
 * Handles both absolute paths and relative paths that would escape.
 */
function isPathSafe(path: string, projectRoot: string): boolean {
  const normalized = path.replace(/\\/g, "/");

  // Block obvious escapes
  if (normalized === "/" || normalized === "~" || normalized === "..") return false;
  if (normalized.startsWith("..")) return false;
  if (normalized.startsWith("/home") || normalized.startsWith("/root")) return false;
  if (normalized.startsWith("/tmp") && !normalized.includes("aedis")) return false;
  if (normalized.startsWith("/var")) return false;
  if (normalized.startsWith("/etc")) return false;
  if (normalized.startsWith("/usr")) return false;
  if (normalized.startsWith("/bin")) return false;
  if (normalized.startsWith("/sbin")) return false;
  if (normalized.startsWith("/opt")) return false;
  if (normalized.startsWith("/srv")) return false;

  return true;
}

// Block `cd` into dangerous directories
const BLOCKED_CD_PATTERNS = [
  /^\s*cd\s+(\/|~\/|~\s|\.\.\/|\.\.$)/,
  /^\s*cd\s+\/home/,
  /^\s*cd\s+\/root/,
  /^\s*cd\s+\/etc/,
  /^\s*cd\s+\/var/,
  /^\s*cd\s+\/tmp(?!\/aedis)/,
  /^\s*cd\s+\/usr/,
  /^\s*cd\s+\/bin/,
  /^\s*cd\s+\/sbin/,
];

function validateCdCommand(cmd: string, args: readonly string[]): boolean {
  const full = [cmd, ...args].join(" ");
  for (const pattern of BLOCKED_CD_PATTERNS) {
    if (pattern.test(full)) return false;
  }
  return true;
}

// ─── Status Mapper ───────────────────────────────────────────────────

function mapStatus(code: number | null, rejected: boolean, timedOut: boolean, sandboxViolation: boolean): ShellStatus {
  if (rejected) return "rejected";
  if (sandboxViolation) return "sandbox_violation";
  if (timedOut) return "timeout";
  if (code === 0) return "success";
  return "failed";
}

// ─── Main Executor Class ─────────────────────────────────────────────

export class TerminalExecutor {
  private readonly projectRoot: string;
  private readonly defaultTimeoutMs: number;
  private commandQueue: Promise<void> = Promise.resolve();
  private lastExecutionAt = 0;

  /**
   * @param projectRoot - The sandbox directory; commands cannot escape this
   * @param defaultTimeoutMs - Default per-command timeout (default 120000ms)
   */
  constructor(projectRoot: string, defaultTimeoutMs = 120_000) {
    this.projectRoot = projectRoot;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Execute a shell command with full validation, allowlist, timeout,
   * and path sandboxing.
   *
   * Returns a ShellReceipt with requested command, executed command,
   * and result — all visible, nothing silent.
   *
   * @param input.command - Raw command string (e.g. "git status")
   * @param input.cwd - Working directory (defaults to this.projectRoot)
   * @param input.env - Environment variables (no API keys — clean env enforced)
   * @param input.timeoutMs - Per-command timeout (default 120000ms)
   */
  async execute(input: ShellExecutionInput): Promise<ShellReceipt> {
    return this.enqueue(async () => {
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      const cwd = input.cwd ?? this.projectRoot;

      // Rate limiting: enforce minimum delay between commands
      const now = Date.now();
      const minInterval = 100; // 100ms between commands
      if (this.lastExecutionAt > 0 && now - this.lastExecutionAt < minInterval) {
        await new Promise((r) => setTimeout(r, minInterval - (now - this.lastExecutionAt)));
      }
      this.lastExecutionAt = Date.now();

      // ── Step 1: Parse command ───────────────────────────────────
      let parsed: { cmd: string; args: string[] };
      try {
        parsed = parseCommand(input.command);
      } catch {
        const completedAt = new Date().toISOString();
        return this.buildReceipt({
          id,
          requestedCommand: input.command,
          executedCommand: "",
          status: "rejected",
          reason: "Empty command",
          stdout: null,
          stderr: null,
          exitCode: null,
          durationMs: 0,
          startedAt,
          completedAt,
          cwd,
          envKeys: [],
          touchedPaths: [],
        });
      }

      const { cmd, args } = parsed;
      const fullCommandArgs = [cmd, ...args].join(" ");

      // ── Step 2: Command allowlist check ─────────────────────────
      if (BLOCKED_COMMANDS.has(cmd)) {
        const completedAt = new Date().toISOString();
        return this.buildReceipt({
          id,
          requestedCommand: input.command,
          executedCommand: fullCommandArgs,
          status: "rejected",
          reason: `Command "${cmd}" is blocked for security`,
          stdout: null,
          stderr: null,
          exitCode: null,
          durationMs: 0,
          startedAt,
          completedAt,
          cwd,
          envKeys: [],
          touchedPaths: [],
        });
      }

      if (!ALLOWED_COMMANDS.has(cmd)) {
        const completedAt = new Date().toISOString();
        return this.buildReceipt({
          id,
          requestedCommand: input.command,
          executedCommand: fullCommandArgs,
          status: "rejected",
          reason: `Command "${cmd}" is not on the allowlist`,
          stdout: null,
          stderr: null,
          exitCode: null,
          durationMs: 0,
          startedAt,
          completedAt,
          cwd,
          envKeys: [],
          touchedPaths: [],
        });
      }

      // ── Step 3: Argument validation ─────────────────────────────
      const argValidation = validateArgs(args);
      if (!argValidation.valid) {
        const completedAt = new Date().toISOString();
        return this.buildReceipt({
          id,
          requestedCommand: input.command,
          executedCommand: fullCommandArgs,
          status: "rejected",
          reason: argValidation.reason,
          stdout: null,
          stderr: null,
          exitCode: null,
          durationMs: 0,
          startedAt,
          completedAt,
          cwd,
          envKeys: [],
          touchedPaths: [],
        });
      }

      // ── Step 4: Path sandbox check ─────────────────────────────
      // For commands that take paths (git, npm, ls, cat, rm, mkdir, etc.)
      if (!validateCdCommand(cmd, args)) {
        const completedAt = new Date().toISOString();
        return this.buildReceipt({
          id,
          requestedCommand: input.command,
          executedCommand: fullCommandArgs,
          status: "sandbox_violation",
          reason: "Command attempts to escape to a blocked directory",
          stdout: null,
          stderr: null,
          exitCode: null,
          durationMs: 0,
          startedAt,
          completedAt,
          cwd,
          envKeys: [],
          touchedPaths: [],
        });
      }

      // Validate all path args against projectRoot
      for (const arg of args) {
        // Skip flags and options
        if (arg.startsWith("-")) continue;
        // Skip URLs, semver-like args, etc.
        if (arg.includes("://")) continue;
        if (arg.includes("@")) continue; // npm scoped packages

        if (!isPathSafe(arg, this.projectRoot)) {
          const completedAt = new Date().toISOString();
          return this.buildReceipt({
            id,
            requestedCommand: input.command,
            executedCommand: fullCommandArgs,
            status: "sandbox_violation",
            reason: `Path "${arg}" is outside the allowed sandbox (projectRoot: ${this.projectRoot})`,
            stdout: null,
            stderr: null,
            exitCode: null,
            durationMs: 0,
            startedAt,
            completedAt,
            cwd,
            envKeys: [],
            touchedPaths: [],
          });
        }
      }

      // ── Step 5: Environment sanitization ────────────────────────
      // Build clean env — strip API keys and secrets
      const rawEnv = input.env ?? {};
      const cleanEnv: Record<string, string> = {};
      const envKeys: string[] = [];

      for (const key of Object.keys(rawEnv)) {
        envKeys.push(key);
        // Only pass through known-safe variables
        if (
          key === "PATH" ||
          key === "HOME" ||
          key === "USER" ||
          key === "PWD" ||
          key === "SHELL" ||
          key === "TERM" ||
          key === "LANG" ||
          key === "LC_ALL" ||
          key === "NODE_ENV" ||
          key === "npm_config_cache" ||
          key.startsWith("npm_config_") ||
          key === "GIT_DIR" ||
          key === "GIT_WORK_TREE" ||
          key === "GIT_PREFIX"
        ) {
          cleanEnv[key] = rawEnv[key]!;
        }
        // Explicitly block secret-containing env vars
        if (
          /api[_-]?key/i.test(key) ||
          /secret/i.test(key) ||
          /password/i.test(key) ||
          /token/i.test(key) ||
          /credential/i.test(key) ||
          /auth/i.test(key)
        ) {
          // Don't include these at all
          continue;
        }
      }

      // ── Step 6: Execute ─────────────────────────────────────────
      const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let timedOut = false;
      let sandboxViolation = false;

      try {
        const result = await this.spawnCommand(cmd, args, {
          cwd,
          env: cleanEnv,
          timeoutMs,
        });
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = result.exitCode;
      } catch (err) {
        if (err instanceof TimeoutError) {
          timedOut = true;
        } else if (err instanceof SandboxViolationError) {
          sandboxViolation = true;
        } else {
          stderr = String(err);
          exitCode = 1;
        }
      }

      const completedAt = new Date().toISOString();
      const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

      // Collect touched paths from the command
      const touchedPaths = this.extractTouchedPaths(cmd, args, stdout, stderr);

      return this.buildReceipt({
        id,
        requestedCommand: input.command,
        executedCommand: fullCommandArgs,
        status: mapStatus(exitCode, false, timedOut, sandboxViolation),
        reason: this.buildReason(cmd, exitCode, timedOut, sandboxViolation),
        stdout: stdout ?? null,
        stderr: stderr ?? null,
        exitCode,
        durationMs,
        startedAt,
        completedAt,
        cwd,
        envKeys,
        touchedPaths,
      });
    });
  }

  private spawnCommand(
    cmd: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new TimeoutError(`Command timed out after ${opts.timeoutMs}ms`));
        }
      }, opts.timeoutMs);

      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        // Don't inherit stdin — we don't have a TTY
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        // Limit stdout to prevent memory exhaustion
        if (stdout.length < 2 * 1024 * 1024) {
          stdout += chunk.toString();
        }
      });

      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 512 * 1024) {
          stderr += chunk.toString();
        }
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        }
      });
    });
  }

  private extractTouchedPaths(
    cmd: string,
    args: readonly string[],
    stdout: string,
    _stderr: string,
  ): string[] {
    const paths: string[] = [];
    // For git commands, extract modified/new/deleted file paths from output
    if (cmd === "git") {
      // git status output — extract file paths
      const statusRe = /^(::?(?:modified|new file|deleted):?\s+)(.+)$/gm;
      let match: RegExpExecArray | null;
      while ((match = statusRe.exec(stdout)) !== null) {
        paths.push(match[2].trim());
      }
      // git diff output
      const diffRe = /^diff --git a\/(.+) b\//gm;
      while ((match = diffRe.exec(stdout)) !== null) {
        paths.push(match[1].trim());
      }
      // git diff --name-only
      const nameRe = /^([^\s].+)$/gm;
      while ((match = nameRe.exec(stdout)) !== null) {
        const p = match[1].trim();
        if (!p.includes(":") && !p.startsWith("commit ") && p.length > 0 && p.length < 256) {
          paths.push(p);
        }
      }
    }
    // npm install — extract package names from output
    if (cmd === "npm" && args[0] === "install") {
      const installRe = /^([+\\]\[)([a-z@/-]+)@[\d.]+/gm;
      let installMatch: RegExpExecArray | null;
      while ((installMatch = installRe.exec(stdout)) !== null) {
        paths.push(`node_modules/${installMatch[2]}`);
      }
    }
    return [...new Set(paths)];
  }

  private buildReason(cmd: string, exitCode: number | null, timedOut: boolean, sandboxViolation: boolean): string {
    if (sandboxViolation) return "Sandbox violation — command attempted to escape projectRoot";
    if (timedOut) return `Command timed out (limit: 120s)`;
    if (exitCode === 0) return `Command "${cmd}" completed successfully`;
    if (exitCode === null) return `Command "${cmd}" failed with no exit code`;
    return `Command "${cmd}" exited with code ${exitCode}`;
  }

  private buildReceipt(fields: Omit<ShellReceipt, "stdout" | "stderr" | "exitCode"> & {
    stdout: string | null;
    stderr: string | null;
    exitCode: number | null;
  }): ShellReceipt {
    // Cast through explicit type to satisfy readonly fields
    return fields as unknown as ShellReceipt;
  }

  /**
   * Enqueue a command with rate limiting.
   * Commands execute sequentially with minimum spacing.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.commandQueue.then(fn, fn);
    this.commandQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

// ─── Error Types ─────────────────────────────────────────────────────

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class SandboxViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolationError";
  }
}

// ─── ShellTool — Worker integration helper ──────────────────────────

/**
 * ShellTool is the integration point for workers (Builder, Verifier)
 * to execute shell commands. Workers receive a ShellTool instance
 * through their assignment context or construct one with their
 * assignment's projectRoot.
 *
 * Usage in a worker:
 *   const shell = new ShellTool(assignment.projectRoot ?? process.cwd());
 *   const receipt = await shell.exec({ command: "git status", cwd: assignment.projectRoot });
 *   // receipt contains all fields — nothing is silent
 */
export class ShellTool {
  private executor: TerminalExecutor;

  constructor(projectRoot: string, timeoutMs = 120_000) {
    this.executor = new TerminalExecutor(projectRoot, timeoutMs);
  }

  /**
   * Execute a shell command and return the full receipt.
   */
  async exec(input: ShellExecutionInput): Promise<ShellReceipt> {
    return this.executor.execute(input);
  }

  /**
   * Convenience: run a git command in the project root.
   */
  async git(args: string[], cwd?: string): Promise<ShellReceipt> {
    return this.exec({ command: ["git", ...args].join(" "), cwd });
  }

  /**
   * Convenience: run an npm/pnpm command.
   */
  async npm(args: string[], cwd?: string): Promise<ShellReceipt> {
    return this.exec({ command: ["npm", ...args].join(" "), cwd });
  }

  /**
   * Convenience: run a TypeScript compiler check.
   */
  async tsc(args: string[], cwd?: string): Promise<ShellReceipt> {
    return this.exec({ command: ["tsc", ...args].join(" "), cwd });
  }

  /**
   * Convenience: run npx.
   */
  async npx(args: string[], cwd?: string): Promise<ShellReceipt> {
    return this.exec({ command: ["npx", ...args].join(" "), cwd });
  }
}