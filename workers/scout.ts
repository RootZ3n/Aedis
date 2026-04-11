import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { relative, resolve, sep } from "node:path";

import type { RunState, CostEntry } from "../core/runstate.js";
import { recordDecision, recordFileTouch } from "../core/runstate.js";
import type { EventBus } from "../server/websocket.js";
import {
  AbstractWorker,
  type CodePattern,
  type DependencyEdge,
  type RiskAssessment,
  type ScoutOutput,
  type TouchedFile,
  type WorkerAssignment,
  type WorkerResult,
} from "./base.js";

const exec = promisify(execFile);
const DEFAULT_IGNORE = new Set(["node_modules", ".git", "dist", "coverage", ".next"]);

export interface ScoutFileRead {
  readonly path: string;
  readonly content: string;
  readonly lineCount: number;
}

export interface FileSymbolSummary {
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly functions: readonly string[];
  readonly classes: readonly string[];
  readonly patterns: readonly string[];
  readonly summary: string;
}

export interface DirectoryListingEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly children?: readonly DirectoryListingEntry[];
}

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

export interface GitStatusSummary {
  readonly branch: string | null;
  readonly staged: readonly string[];
  readonly modified: readonly string[];
  readonly untracked: readonly string[];
  readonly deleted: readonly string[];
  readonly conflicted: readonly string[];
  readonly clean: boolean;
}

export interface GitDiffSummary {
  readonly files: readonly {
    path: string;
    additions: number;
    deletions: number;
    status: string;
  }[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
}

export interface ComplexityEstimate {
  readonly path: string;
  readonly lineCount: number;
  readonly functionCount: number;
  readonly classCount: number;
  readonly maxNestingDepth: number;
  readonly dependencyCount: number;
  readonly score: number;
  readonly bucket: "low" | "medium" | "high" | "very-high";
}

export interface ScoutInspectionBundle {
  readonly reads: readonly ScoutFileRead[];
  readonly summaries: readonly FileSymbolSummary[];
  readonly directoryListing: DirectoryListingEntry | null;
  readonly grepMatches: readonly GrepMatch[];
  readonly gitStatus: GitStatusSummary | null;
  readonly gitDiff: GitDiffSummary | null;
  readonly complexity: readonly ComplexityEstimate[];
}

export interface ScoutResult extends WorkerResult {
  readonly output: ScoutOutput & {
    readonly inspections: ScoutInspectionBundle;
  };
}

export interface ScoutWorkerConfig {
  readonly projectRoot: string;
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
  readonly ignoreDirs?: readonly string[];
}

/**
 * ScoutWorker — context gathering, dependency mapping, risk assessment.
 *
 * PROJECT ROOT THREADING (Option A refactor):
 * Every method that needs a project root takes it as an explicit parameter
 * rather than reading `this.projectRoot`. The constructor still accepts a
 * `projectRoot` and stores it as `this.projectRoot`, but that field is
 * ONLY used as a fallback in execute() when `assignment.projectRoot` is
 * undefined (the test/standalone-harness path). All internal helpers
 * (resolvePath, toRelative, walkDirectory) and all public file/git methods
 * (readFile, listDir, grepFiles, gitStatus, gitDiff, summarizeFile,
 * getImports, getExports, estimateComplexity) take projectRoot as a
 * parameter so per-task `assignment.projectRoot` overrides work correctly.
 *
 * The Coordinator constructs the ScoutWorker once at boot with the API
 * server's cwd, but per-task submissions can target any repo via the
 * `--repo` CLI flag or the `repoPath` field on POST /tasks. Without
 * threading projectRoot through every helper, Scout would always read
 * from the API server's cwd regardless of which repo the task targets.
 */
export class ScoutWorker extends AbstractWorker {
  readonly type = "scout" as const;
  readonly name = "Scout Worker";

  private readonly projectRoot: string;
  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly ignoreDirs: Set<string>;

  constructor(config: ScoutWorkerConfig) {
    super();
    this.projectRoot = resolve(config.projectRoot);
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    this.ignoreDirs = new Set(config.ignoreDirs ?? [...DEFAULT_IGNORE]);
  }

  async estimateCost(_assignment: WorkerAssignment): Promise<CostEntry> {
    return this.zeroCost();
  }

  canHandle(_assignment: WorkerAssignment): boolean {
    return true;
  }

  async execute(assignment: WorkerAssignment): Promise<ScoutResult> {
    const startedAt = Date.now();
    const touchedFiles: TouchedFile[] = [];

    // Resolve effective projectRoot for this submission. Coordinator.dispatchNode
    // populates assignment.projectRoot per-task; this.projectRoot is the
    // constructor-time fallback for tests and stand-alone harnesses that
    // bypass the assignment-based wiring. Threaded through every helper
    // method below so all path operations honor the per-task root.
    const projectRoot = assignment.projectRoot ?? this.projectRoot;

    try {
      const baseTargetFiles = assignment.task.targetFiles.length > 0
        ? assignment.task.targetFiles
        : this.extractContextFiles(assignment);
      const recentFiles = assignment.recentContext?.relevantFiles ?? [];
      console.log(`[scout] recentContext: ${recentFiles.length} relevant files`);
      const targetFiles = Array.from(new Set([
        ...recentFiles,
        ...baseTargetFiles,
      ]));

      const reads: ScoutFileRead[] = [];
      const summaries: FileSymbolSummary[] = [];
      const complexity: ComplexityEstimate[] = [];
      const dependencies: DependencyEdge[] = [];
      const patterns: CodePattern[] = [];

      for (const file of targetFiles.slice(0, 8)) {
        const fileRead = await this.readFile(file, projectRoot);
        reads.push(fileRead);
        touchedFiles.push({ path: fileRead.path, operation: "read" });
        this.logFileTouch(assignment.task.id, fileRead.path, "read");

        const summary = this.summarizeSource(fileRead.content);
        summaries.push(summary);
        complexity.push(this.estimateComplexityFromContent(fileRead.path, fileRead.content));
        dependencies.push(...summary.imports.map((imp) => ({ from: fileRead.path, to: imp, type: "import" as const })));

        if (summary.classes.length > 0) {
          patterns.push({
            name: "class-based-module",
            description: `Class-oriented module pattern in ${fileRead.path}`,
            examples: [fileRead.path],
          });
        }
        if (summary.functions.length > 2) {
          patterns.push({
            name: "function-cluster",
            description: `Function-heavy implementation in ${fileRead.path}`,
            examples: [fileRead.path],
          });
        }
      }

      const grepPattern = this.buildTaskPattern(assignment.task.description);
      const directorySeed = this.inferDirectorySeed(targetFiles);
      const [directoryListing, grepMatches, gitStatus, gitDiff] = await Promise.all([
        directorySeed ? this.listDir(directorySeed, projectRoot) : Promise.resolve<DirectoryListingEntry | null>(null),
        grepPattern ? this.grepFiles(grepPattern, directorySeed ?? ".", projectRoot) : Promise.resolve<GrepMatch[]>([]),
        this.gitStatus(projectRoot).catch(() => null),
        this.gitDiff(projectRoot).catch(() => null),
      ]);

      if (directoryListing) {
        this.noteDecision(assignment.task.id, `Scout mapped ${directorySeed} (in ${projectRoot})`, "Provides local structure for downstream workers");
      }

      const riskAssessment = this.buildRiskAssessment(assignment, complexity, gitStatus, gitDiff);
      const suggestedApproach = this.buildApproach(assignment, summaries, complexity, riskAssessment);

      const output: ScoutResult["output"] = {
        kind: "scout",
        dependencies,
        patterns: this.uniquePatterns(patterns),
        riskAssessment,
        suggestedApproach,
        inspections: {
          reads,
          summaries,
          directoryListing,
          grepMatches,
          gitStatus,
          gitDiff,
          complexity,
        },
      };

      this.eventBus?.emit({
        type: "scout_complete",
        payload: {
          taskId: assignment.task.id,
          workerType: this.type,
          touchedFiles: touchedFiles.map((file) => file.path),
          risk: riskAssessment.level,
        },
      });

      return this.success(assignment, output, {
        cost: this.zeroCost(),
        confidence: 0.92,
        touchedFiles,
        issues: [],
        durationMs: Date.now() - startedAt,
      }) as ScoutResult;
    } catch (error) {
      this.eventBus?.emit({
        type: "task_failed",
        payload: {
          taskId: assignment.task.id,
          workerType: this.type,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return this.failure(
        assignment,
        error instanceof Error ? error.message : String(error),
        this.zeroCost(),
        Date.now() - startedAt,
      ) as ScoutResult;
    }
  }

  /**
   * Read a file relative to projectRoot. The path is resolved against the
   * supplied projectRoot (not this.projectRoot) so per-task overrides work.
   */
  async readFile(path: string, projectRoot: string): Promise<ScoutFileRead> {
    const safePath = this.resolvePath(path, projectRoot);
    const content = await readFile(safePath, "utf8");
    return {
      path: this.toRelative(safePath, projectRoot),
      content,
      lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length,
    };
  }

  summarizeFileContent(path: string, content: string): FileSymbolSummary {
    return this.summarizeSource(content, path);
  }

  /**
   * Read a file via readFile (using the supplied projectRoot) and produce
   * a symbol summary from its content.
   */
  async summarizeFile(path: string, projectRoot: string): Promise<FileSymbolSummary> {
    const read = await this.readFile(path, projectRoot);
    return this.summarizeSource(read.content, read.path);
  }

  /**
   * List a directory relative to projectRoot.
   */
  async listDir(path: string, projectRoot: string): Promise<DirectoryListingEntry> {
    const safePath = this.resolvePath(path, projectRoot);
    return this.walkDirectory(safePath, projectRoot);
  }

  /**
   * Grep for a pattern within projectRoot, starting from `dir` (relative
   * to projectRoot). Honors the configured ignoreDirs.
   */
  async grepFiles(pattern: string, dir: string, projectRoot: string): Promise<GrepMatch[]> {
    const baseDir = this.resolvePath(dir, projectRoot);
    const regex = new RegExp(pattern, "i");
    const matches: GrepMatch[] = [];

    const visit = async (current: string): Promise<void> => {
      const info = await stat(current);
      if (info.isDirectory()) {
        if (this.ignoreDirs.has(current.split(sep).pop() ?? "")) return;
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          await visit(resolve(current, entry.name));
        }
        return;
      }

      const rel = this.toRelative(current, projectRoot);
      const content = await readFile(current, "utf8").catch(() => "");
      if (!content) return;
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (regex.test(line)) {
          matches.push({ path: rel, line: index + 1, snippet: line.trim().slice(0, 240) });
          if (matches.length >= 100) return;
        }
      }
    };

    await visit(baseDir);
    return matches;
  }

  /**
   * Run `git -C projectRoot status --short --branch` and parse the output.
   * The signature changed from `gitStatus(repoPath)` to `gitStatus(projectRoot)`
   * because the previous "repoPath" parameter was always the project root
   * — there was never a separate repo root. The new name reflects that.
   */
  async gitStatus(projectRoot: string): Promise<GitStatusSummary> {
    const { stdout } = await exec("git", ["-C", projectRoot, "status", "--short", "--branch"], { maxBuffer: 1024 * 1024 });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const branch = lines[0]?.startsWith("## ") ? lines[0].replace(/^##\s+/, "") : null;
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    const deleted: string[] = [];
    const conflicted: string[] = [];

    for (const line of lines.slice(branch ? 1 : 0)) {
      const status = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (status.includes("U")) conflicted.push(file);
      else if (status === "??") untracked.push(file);
      else {
        if (status[0] !== " ") staged.push(file);
        if (status[1] === "M") modified.push(file);
        if (status.includes("D")) deleted.push(file);
      }
    }

    return {
      branch,
      staged,
      modified,
      untracked,
      deleted,
      conflicted,
      clean: staged.length === 0 && modified.length === 0 && untracked.length === 0 && deleted.length === 0 && conflicted.length === 0,
    };
  }

  /**
   * Run `git -C projectRoot diff --numstat`. The optional `file` argument
   * scopes the diff to a single file (resolved against projectRoot first).
   */
  async gitDiff(projectRoot: string, file?: string): Promise<GitDiffSummary> {
    const args = ["-C", projectRoot, "diff", "--numstat", "--find-renames"];
    if (file) {
      const absFile = this.resolvePath(file, projectRoot);
      args.push("--", this.toRelative(absFile, projectRoot));
    }
    const { stdout } = await exec("git", args, { maxBuffer: 1024 * 1024 });
    const files = stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [adds, dels, path] = line.split(/\t+/);
        return {
          path,
          additions: Number.parseInt(adds, 10) || 0,
          deletions: Number.parseInt(dels, 10) || 0,
          status: (Number.parseInt(adds, 10) || 0) > 0 && (Number.parseInt(dels, 10) || 0) > 0 ? "modified" : (Number.parseInt(adds, 10) || 0) > 0 ? "added" : "deleted",
        };
      });

    return {
      files,
      totalAdditions: files.reduce((sum, item) => sum + item.additions, 0),
      totalDeletions: files.reduce((sum, item) => sum + item.deletions, 0),
    };
  }

  async getImports(path: string, projectRoot: string): Promise<string[]> {
    const read = await this.readFile(path, projectRoot);
    return this.extractImports(read.content);
  }

  async getExports(path: string, projectRoot: string): Promise<string[]> {
    const read = await this.readFile(path, projectRoot);
    return this.extractExports(read.content);
  }

  async estimateComplexity(path: string, projectRoot: string): Promise<ComplexityEstimate> {
    const read = await this.readFile(path, projectRoot);
    return this.estimateComplexityFromContent(read.path, read.content);
  }

  protected emptyOutput(): ScoutOutput {
    return {
      kind: "scout",
      dependencies: [],
      patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "",
    };
  }

  private extractContextFiles(assignment: WorkerAssignment): string[] {
    return assignment.context.layers.flatMap((layer) => layer.files.map((file) => file.path));
  }

  private summarizeSource(content: string, path?: string): FileSymbolSummary {
    const imports = this.extractImports(content);
    const exports = this.extractExports(content);
    const functions = [...content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g)]
      .map((match) => match[1] ?? match[2])
      .filter(Boolean);
    const classes = [...content.matchAll(/class\s+(\w+)/g)].map((match) => match[1]);
    const patterns = [
      imports.length > 0 ? "imports" : null,
      exports.length > 0 ? "exports" : null,
      classes.length > 0 ? "class-based" : null,
      /describe\(|it\(|test\(/.test(content) ? "test-file" : null,
      /fetch\(|axios\./.test(content) ? "network-call" : null,
    ].filter((value): value is string => Boolean(value));

    const parts = [
      path ? `${path}:` : null,
      imports.length > 0 ? `${imports.length} imports` : null,
      exports.length > 0 ? `${exports.length} exports` : null,
      functions.length > 0 ? `${functions.length} functions` : null,
      classes.length > 0 ? `${classes.length} classes` : null,
      patterns.length > 0 ? `patterns ${patterns.join(", ")}` : null,
    ].filter(Boolean);

    const summary = parts.join("; ").slice(0, 380);

    return {
      imports,
      exports,
      functions,
      classes,
      patterns,
      summary,
    };
  }

  private extractImports(content: string): string[] {
    return [...content.matchAll(/import\s+[^;]+?from\s+["']([^"']+)["']|require\(["']([^"']+)["']\)/g)]
      .map((match) => match[1] ?? match[2])
      .filter((value): value is string => Boolean(value));
  }

  private extractExports(content: string): string[] {
    return [...content.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g)]
      .map((match) => match[1])
      .filter(Boolean);
  }

  private estimateComplexityFromContent(path: string, content: string): ComplexityEstimate {
    const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
    const functionCount = [...content.matchAll(/(?:function\s+\w+|=>\s*\{|\w+\s*\([^)]*\)\s*\{)/g)].length;
    const classCount = [...content.matchAll(/class\s+\w+/g)].length;
    const dependencyCount = this.extractImports(content).length;
    const maxNestingDepth = this.computeNestingDepth(content);
    const score = Math.round(lineCount * 0.1 + functionCount * 4 + classCount * 5 + dependencyCount * 2 + maxNestingDepth * 6);
    const bucket = score >= 120 ? "very-high" : score >= 75 ? "high" : score >= 35 ? "medium" : "low";
    return {
      path,
      lineCount,
      functionCount,
      classCount,
      maxNestingDepth,
      dependencyCount,
      score,
      bucket,
    };
  }

  private computeNestingDepth(content: string): number {
    let depth = 0;
    let maxDepth = 0;
    for (const char of content) {
      if (char === "{") {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
      } else if (char === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
    return maxDepth;
  }

  /**
   * Walk a directory tree starting at dirPath. Takes projectRoot as a
   * parameter so the relative paths in the resulting tree honor the
   * per-task root rather than this.projectRoot.
   */
  private async walkDirectory(dirPath: string, projectRoot: string): Promise<DirectoryListingEntry> {
    const info = await stat(dirPath);
    if (!info.isDirectory()) {
      return { path: this.toRelative(dirPath, projectRoot), type: "file" };
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    const children: DirectoryListingEntry[] = [];
    for (const entry of entries) {
      if (this.ignoreDirs.has(entry.name)) continue;
      const childPath = resolve(dirPath, entry.name);
      if (entry.isDirectory()) {
        children.push(await this.walkDirectory(childPath, projectRoot));
      } else {
        children.push({ path: this.toRelative(childPath, projectRoot), type: "file" });
      }
    }
    return { path: this.toRelative(dirPath, projectRoot), type: "directory", children };
  }

  private buildTaskPattern(description: string): string | null {
    const words = description
      .split(/\s+/)
      .map((word) => word.replace(/[^a-zA-Z0-9_-]/g, ""))
      .filter((word) => word.length >= 4);
    return words[0] ?? null;
  }

  private inferDirectorySeed(files: readonly string[]): string | null {
    const first = files[0];
    if (!first) return null;
    const normalized = first.replace(/\\/g, "/");
    const idx = normalized.lastIndexOf("/");
    return idx === -1 ? "." : normalized.slice(0, idx);
  }

  private buildRiskAssessment(
    assignment: WorkerAssignment,
    complexity: readonly ComplexityEstimate[],
    gitStatus: GitStatusSummary | null,
    gitDiff: GitDiffSummary | null,
  ): RiskAssessment {
    const factors: string[] = [];
    const mitigations: string[] = [];

    if (complexity.some((item) => item.bucket === "very-high" || item.bucket === "high")) {
      factors.push("Target includes high-complexity files");
      mitigations.push("Keep scope tight and verify interface boundaries before editing");
    }
    if ((gitStatus?.modified.length ?? 0) > 0 || (gitStatus?.staged.length ?? 0) > 0) {
      factors.push("Repository already has in-flight changes");
      mitigations.push("Avoid reverting unrelated edits and review diff summary before patching");
    }
    if ((gitDiff?.files.length ?? 0) > 20) {
      factors.push("Large existing diff raises merge risk");
      mitigations.push("Prefer single-file contracts and explicit follow-up verification");
    }
    if (assignment.task.targetFiles.length > 3) {
      factors.push("Task spans multiple files");
      mitigations.push("Scout similar files first and split work if needed");
    }

    const level = factors.length >= 4 ? "critical" : factors.length >= 3 ? "high" : factors.length >= 2 ? "medium" : "low";
    return { level, factors, mitigations };
  }

  private buildApproach(
    assignment: WorkerAssignment,
    summaries: readonly FileSymbolSummary[],
    complexity: readonly ComplexityEstimate[],
    risk: RiskAssessment,
  ): string {
    const keyFiles = assignment.task.targetFiles.slice(0, 3).join(", ") || "the scoped files";
    const exported = summaries.flatMap((item) => item.exports).slice(0, 4);
    const complex = complexity.filter((item) => item.bucket === "high" || item.bucket === "very-high").map((item) => item.path);
    const parts = [
      `Start with ${keyFiles}.`,
      exported.length > 0 ? `Watch exports ${exported.join(", ")}.` : null,
      complex.length > 0 ? `High-complexity files: ${complex.join(", ")}.` : null,
      risk.level !== "low" ? `Risk is ${risk.level}; keep edits narrow.` : "Risk is low; follow existing patterns.",
    ].filter(Boolean);
    return parts.join(" ");
  }

  private uniquePatterns(patterns: readonly CodePattern[]): CodePattern[] {
    const seen = new Set<string>();
    return patterns.filter((pattern) => {
      const key = `${pattern.name}:${pattern.examples.join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Resolve a path against the supplied projectRoot, verify it stays
   * within projectRoot, return the absolute path. Takes projectRoot as
   * a parameter (rather than reading this.projectRoot) so per-task
   * overrides via assignment.projectRoot work correctly.
   */
  private resolvePath(inputPath: string, projectRoot: string): string {
    const abs = resolve(projectRoot, inputPath);
    const normalizedRoot = projectRoot.endsWith(sep) ? projectRoot : `${projectRoot}${sep}`;
    if (abs !== projectRoot && !abs.startsWith(normalizedRoot)) {
      throw new Error(`Path outside project root: ${inputPath}`);
    }
    return abs;
  }

  /**
   * Express an absolute path as a forward-slashed path relative to the
   * supplied projectRoot. Takes projectRoot as a parameter so per-task
   * overrides work correctly.
   */
  private toRelative(absPath: string, projectRoot: string): string {
    const rel = relative(projectRoot, absPath);
    return rel === "" ? "." : rel.replace(/\\/g, "/");
  }

  private logFileTouch(taskId: string, path: string, operation: "read" | "create" | "modify" | "delete"): void {
    if (!this.runState) return;
    recordFileTouch(this.runState, { filePath: path, operation, taskId });
  }

  private noteDecision(taskId: string, description: string, rationale: string): void {
    if (!this.runState) return;
    recordDecision(this.runState, {
      description,
      madeBy: this.name,
      taskId,
      alternatives: [],
      rationale,
    });
  }
}

// ─── Section Extraction (exported utility) ───────────────────────────
//
// Used by workers/builder.ts when a target file is too large to fit in the
// prompt budget. Finds the most relevant function/method for a task and
// returns a windowed section of the file plus surrounding context, with
// line-number metadata so the Builder can ask the model to generate a
// unified diff that uses ORIGINAL file line numbers.
//
// Pure function — no Scout instance, no I/O, no state. Builder imports
// it directly without instantiating ScoutWorker. The function is colocated
// here because Scout owns "context extraction" conceptually, but it is
// used as a library by Builder, not as a worker capability.

export interface SectionExtraction {
  readonly section: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly matchedFunction: string | null;
  readonly funcStart: number;
  readonly funcEnd: number;
  readonly extractionMethod:
    | "function-keyword-match"
    | "longest-function-fallback"
    | "middle-of-file-fallback"
    | "top-of-file-keyword";
  readonly keywordsUsed: readonly string[];
}

interface FunctionLocation {
  readonly name: string;
  readonly startLine: number; // 0-indexed internally
  readonly endLine: number;   // 0-indexed internally
}

export const SECTION_LARGE_FILE_THRESHOLD = 16_000;
export const SECTION_MAX_LINES = 150;
export const SECTION_PADDING_LINES = 100;

export const TOP_OF_FILE_LINE_COUNT = 50;
const TOP_OF_FILE_PATTERN = /\b(?:top of (?:the )?file|(?:at|to) the top|file header|beginning of (?:the )?file)\b/i;

const SECTION_STOP_WORDS = new Set([
  "the", "a", "an", "to", "in", "on", "at", "of", "for", "with", "and", "or",
  "but", "is", "are", "was", "were", "be", "been", "being", "have", "has",
  "had", "do", "does", "did", "will", "would", "should", "could", "may",
  "might", "this", "that", "these", "those", "it", "its", "they", "them",
  "their", "method", "function", "class", "file", "code", "line", "section",
  "from", "into", "out", "off", "use", "uses", "using", "all", "any", "some",
  "add", "remove", "fix", "update", "change", "modify", "edit", "create",
  "make", "delete", "implement", "implements", "implementation", "new",
  "very", "much", "more", "less", "than", "then", "when", "where", "what",
  "which", "who", "whom", "how", "why", "if", "so", "as", "by", "up", "down",
]);

const FN_REGEX_WORDS_TO_SKIP = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "return", "throw",
  "catch", "try", "finally", "await", "async", "yield", "new", "typeof",
  "instanceof", "void", "delete", "in", "of", "let", "const", "var",
  "function", "class", "interface", "type", "enum", "import", "export",
  "from", "as", "default", "public", "private", "protected", "static",
  "readonly", "abstract", "override", "true", "false", "null", "undefined",
  "this", "super", "constructor",
]);

export function extractRelevantSection(
  filePath: string,
  fullContent: string,
  taskDescription: string,
): SectionExtraction | null {
  if (fullContent.length <= SECTION_LARGE_FILE_THRESHOLD) {
    return null;
  }

  const lines = fullContent.split(/\r?\n/);
  const totalLines = lines.length;

  if (totalLines <= SECTION_MAX_LINES) {
    return null;
  }

  // ─── STEP 0: TOP-OF-FILE PRE-CHECK ─────────────────────────────────
  if (TOP_OF_FILE_PATTERN.test(taskDescription)) {
    const endLineZeroIdx = Math.min(TOP_OF_FILE_LINE_COUNT - 1, totalLines - 1);
    const sectionLines = lines.slice(0, endLineZeroIdx + 1);
    const endLineOneIdx = endLineZeroIdx + 1;
    return {
      section: sectionLines.join("\n"),
      startLine: 1,
      endLine: endLineOneIdx,
      totalLines,
      matchedFunction: "file-header",
      funcStart: 1,
      funcEnd: endLineOneIdx,
      extractionMethod: "top-of-file-keyword",
      keywordsUsed: extractTaskKeywords(taskDescription),
    };
  }

  const keywords = extractTaskKeywords(taskDescription);
  const functions = findFunctionLocations(lines);

  let bestFunction: FunctionLocation | null = null;
  let bestScore = -1;
  for (const fn of functions) {
    const score = scoreFunctionForKeywords(fn, lines, keywords);
    if (score > bestScore) {
      bestScore = score;
      bestFunction = fn;
    }
  }

  let funcStart: number;
  let funcEnd: number;
  let matchedFunction: string | null = null;
  let extractionMethod: SectionExtraction["extractionMethod"];

  if (bestFunction && bestScore > 0) {
    funcStart = bestFunction.startLine;
    funcEnd = bestFunction.endLine;
    matchedFunction = bestFunction.name;
    extractionMethod = "function-keyword-match";
  } else if (functions.length > 0) {
    const longest = functions.reduce((a, b) =>
      (b.endLine - b.startLine) > (a.endLine - a.startLine) ? b : a,
    );
    funcStart = longest.startLine;
    funcEnd = longest.endLine;
    matchedFunction = longest.name;
    extractionMethod = "longest-function-fallback";
  } else {
    const mid = Math.floor(totalLines / 2);
    funcStart = mid;
    funcEnd = mid;
    extractionMethod = "middle-of-file-fallback";
  }

  let sectionStart = Math.max(0, funcStart - SECTION_PADDING_LINES);
  let sectionEnd = Math.min(totalLines - 1, funcEnd + SECTION_PADDING_LINES);

  if (sectionEnd - sectionStart + 1 > SECTION_MAX_LINES) {
    const funcMid = Math.floor((funcStart + funcEnd) / 2);
    const half = Math.floor(SECTION_MAX_LINES / 2);
    sectionStart = Math.max(0, funcMid - half);
    sectionEnd = Math.min(totalLines - 1, sectionStart + SECTION_MAX_LINES - 1);
    if (sectionEnd === totalLines - 1) {
      sectionStart = Math.max(0, sectionEnd - SECTION_MAX_LINES + 1);
    }
  }

  const sectionLines = lines.slice(sectionStart, sectionEnd + 1);
  const section = sectionLines.join("\n");

  return {
    section,
    startLine: sectionStart + 1,
    endLine: sectionEnd + 1,
    totalLines,
    matchedFunction,
    funcStart: funcStart + 1,
    funcEnd: funcEnd + 1,
    extractionMethod,
    keywordsUsed: keywords,
  };
}

function extractTaskKeywords(taskDescription: string): string[] {
  const tokens = taskDescription
    .replace(/[()[\]{}.,;:!?'"`/]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !SECTION_STOP_WORDS.has(t.toLowerCase()));
  return [...new Set(tokens.map((t) => t.toLowerCase()))];
}

function findFunctionLocations(lines: readonly string[]): FunctionLocation[] {
  const functions: FunctionLocation[] = [];
  const declRegex = /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = line.match(declRegex);
    if (!match) continue;

    const name = match[1];
    if (FN_REGEX_WORDS_TO_SKIP.has(name)) continue;

    if (/^\s*(?:const|let|var)\s+\w+\s*=/.test(line)) continue;

    const trimmed = line.trimEnd();
    const lastChar = trimmed.slice(-1);
    if (
      lastChar !== "{" &&
      lastChar !== "(" &&
      lastChar !== "," &&
      lastChar !== ":" &&
      !trimmed.includes("=>")
    ) {
      let foundBrace = false;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const next = lines[j] ?? "";
        if (next.includes("{")) {
          foundBrace = true;
          break;
        }
        if (next.trim().endsWith(";")) break;
      }
      if (!foundBrace) continue;
    }

    const endLine = findFunctionEnd(lines, i);
    if (endLine > i) {
      functions.push({ name, startLine: i, endLine });
    }
  }

  return functions;
}

function findFunctionEnd(lines: readonly string[], startLine: number): number {
  let braceDepth = 0;
  let foundOpen = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const char of line) {
      if (char === "{") {
        braceDepth++;
        foundOpen = true;
      } else if (char === "}") {
        braceDepth--;
        if (foundOpen && braceDepth === 0) {
          return i;
        }
      }
    }
  }
  return startLine;
}

function scoreFunctionForKeywords(
  fn: FunctionLocation,
  lines: readonly string[],
  keywords: readonly string[],
): number {
  if (keywords.length === 0) return 0;

  let score = 0;
  const nameLower = fn.name.toLowerCase();

  for (const kw of keywords) {
    if (nameLower === kw) score += 100;
    else if (nameLower.includes(kw)) score += 50;
    else if (kw.length >= 4 && kw.includes(nameLower)) score += 30;
  }

  const body = lines.slice(fn.startLine, fn.endLine + 1).join("\n").toLowerCase();
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = body.match(new RegExp(escaped, "g"));
    if (matches) score += matches.length * 2;
  }

  return score;
}
