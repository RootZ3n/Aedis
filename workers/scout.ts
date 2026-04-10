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

    try {
      const targetFiles = assignment.task.targetFiles.length > 0
        ? assignment.task.targetFiles
        : this.extractContextFiles(assignment);

      const reads: ScoutFileRead[] = [];
      const summaries: FileSymbolSummary[] = [];
      const complexity: ComplexityEstimate[] = [];
      const dependencies: DependencyEdge[] = [];
      const patterns: CodePattern[] = [];

      for (const file of targetFiles.slice(0, 8)) {
        const fileRead = await this.readFile(file);
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
        directorySeed ? this.listDir(directorySeed) : Promise.resolve<DirectoryListingEntry | null>(null),
        grepPattern ? this.grepFiles(grepPattern, directorySeed ?? ".") : Promise.resolve<GrepMatch[]>([]),
        this.gitStatus(this.projectRoot).catch(() => null),
        this.gitDiff(this.projectRoot).catch(() => null),
      ]);

      if (directoryListing) {
        this.noteDecision(assignment.task.id, `Scout mapped ${directorySeed}`, "Provides local structure for downstream workers");
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

  async readFile(path: string): Promise<ScoutFileRead> {
    const safePath = this.resolvePath(path);
    const content = await readFile(safePath, "utf8");
    return {
      path: this.toRelative(safePath),
      content,
      lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length,
    };
  }

  summarizeFileContent(path: string, content: string): FileSymbolSummary {
    return this.summarizeSource(content, path);
  }

  async summarizeFile(path: string): Promise<FileSymbolSummary> {
    const read = await this.readFile(path);
    return this.summarizeSource(read.content, read.path);
  }

  async listDir(path: string): Promise<DirectoryListingEntry> {
    const safePath = this.resolvePath(path);
    return this.walkDirectory(safePath);
  }

  async grepFiles(pattern: string, dir: string): Promise<GrepMatch[]> {
    const baseDir = this.resolvePath(dir);
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

      const rel = this.toRelative(current);
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

  async gitStatus(repoPath: string): Promise<GitStatusSummary> {
    const repoRoot = this.resolvePath(repoPath);
    const { stdout } = await exec("git", ["-C", repoRoot, "status", "--short", "--branch"], { maxBuffer: 1024 * 1024 });
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

  async gitDiff(repoPath: string, file?: string): Promise<GitDiffSummary> {
    const repoRoot = this.resolvePath(repoPath);
    const args = ["-C", repoRoot, "diff", "--numstat", "--find-renames"];
    if (file) args.push("--", this.toRelative(this.resolvePath(file)));
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

  async getImports(path: string): Promise<string[]> {
    const read = await this.readFile(path);
    return this.extractImports(read.content);
  }

  async getExports(path: string): Promise<string[]> {
    const read = await this.readFile(path);
    return this.extractExports(read.content);
  }

  async estimateComplexity(path: string): Promise<ComplexityEstimate> {
    const read = await this.readFile(path);
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

  private async walkDirectory(dirPath: string): Promise<DirectoryListingEntry> {
    const info = await stat(dirPath);
    if (!info.isDirectory()) {
      return { path: this.toRelative(dirPath), type: "file" };
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    const children: DirectoryListingEntry[] = [];
    for (const entry of entries) {
      if (this.ignoreDirs.has(entry.name)) continue;
      const childPath = resolve(dirPath, entry.name);
      if (entry.isDirectory()) {
        children.push(await this.walkDirectory(childPath));
      } else {
        children.push({ path: this.toRelative(childPath), type: "file" });
      }
    }
    return { path: this.toRelative(dirPath), type: "directory", children };
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

  private resolvePath(inputPath: string): string {
    const abs = resolve(this.projectRoot, inputPath);
    const normalizedRoot = this.projectRoot.endsWith(sep) ? this.projectRoot : `${this.projectRoot}${sep}`;
    if (abs !== this.projectRoot && !abs.startsWith(normalizedRoot)) {
      throw new Error(`Path outside project root: ${inputPath}`);
    }
    return abs;
  }

  private toRelative(absPath: string): string {
    const rel = relative(this.projectRoot, absPath);
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
