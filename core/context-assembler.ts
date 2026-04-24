/**
 * ContextAssembler — Layered context pull for workers.
 *
 * Workers need context to do their job well, but flooding them with
 * the entire codebase is wasteful and confusing. The ContextAssembler
 * builds a relevance-ranked context window from multiple layers:
 *
 *   Layer 1: Target file(s) — the files being modified
 *   Layer 2: Direct dependencies — imports/exports of target files
 *   Layer 3: Patterns — similar code patterns in the codebase
 *   Layer 4: Tests — existing test coverage for targets
 *   Layer 5: Similar implementations — files doing comparable work
 *
 * Each layer is optional and budget-aware. The assembler respects
 * a token budget and fills from Layer 1 outward.
 */

import { readFile, stat } from "fs/promises";
import { resolve, dirname, extname } from "path";
import { glob } from "glob";

// ─── Types ───────────────────────────────────────────────────────────

export interface ContextLayer {
  readonly name: string;
  readonly priority: number;
  readonly files: ContextFile[];
  readonly tokenEstimate: number;
}

export interface ContextFile {
  readonly path: string;
  readonly content: string;
  readonly relevance: ContextRelevance;
  readonly tokenEstimate: number;
}

export type ContextRelevance =
  | "target"          // Layer 1: the file being changed
  | "direct-dep"      // Layer 2: imported by or imports target
  | "pattern"         // Layer 3: similar code pattern
  | "test"            // Layer 4: test file for target
  | "similar-impl";   // Layer 5: comparable implementation

export interface AssembledContext {
  readonly layers: readonly ContextLayer[];
  readonly totalTokens: number;
  readonly budgetUsed: number;
  readonly budgetTotal: number;
  readonly truncated: boolean;
  readonly fileCount: number;
}

export interface ContextAssemblerConfig {
  /** Root directory of the project */
  projectRoot: string;
  /** Maximum token budget for assembled context */
  tokenBudget: number;
  /** Approximate chars per token for estimation */
  charsPerToken: number;
  /** File extensions to consider as source code */
  sourceExtensions: string[];
  /** Directories to ignore */
  ignoreDirs: string[];
  /** Maximum characters per file — prevents a single large file from consuming the entire context budget */
  maxFileChars: number;
}

const DEFAULT_CONFIG: Omit<ContextAssemblerConfig, "projectRoot"> = {
  tokenBudget: 32_000,
  charsPerToken: 4,
  maxFileChars: 3_500,
  sourceExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
  ignoreDirs: ["node_modules", ".git", "dist", ".next", "coverage"],
};

// ─── Assembler ───────────────────────────────────────────────────────

export class ContextAssembler {
  private config: ContextAssemblerConfig;

  constructor(config: Pick<ContextAssemblerConfig, "projectRoot"> & Partial<ContextAssemblerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Assemble context for a set of target files, respecting token budget.
   * Fills layers in priority order, stopping when budget is exhausted.
   */
  async assemble(targetFiles: string[]): Promise<AssembledContext> {
    const layers: ContextLayer[] = [];
    let remainingBudget = this.config.tokenBudget;

    // Layer 1: Target files (always included, highest priority)
    const targetLayer = await this.buildTargetLayer(targetFiles);
    layers.push(targetLayer);
    remainingBudget -= targetLayer.tokenEstimate;

    if (remainingBudget <= 0) {
      return this.buildResult(layers, true);
    }

    // Layer 2: Direct dependencies
    const depLayer = await this.buildDependencyLayer(targetFiles, remainingBudget);
    layers.push(depLayer);
    remainingBudget -= depLayer.tokenEstimate;

    if (remainingBudget <= 0) {
      return this.buildResult(layers, true);
    }

    // Layer 3: Patterns (type definitions, interfaces used by targets)
    const patternLayer = await this.buildPatternLayer(targetFiles, remainingBudget);
    layers.push(patternLayer);
    remainingBudget -= patternLayer.tokenEstimate;

    if (remainingBudget <= 0) {
      return this.buildResult(layers, true);
    }

    // Layer 4: Tests
    const testLayer = await this.buildTestLayer(targetFiles, remainingBudget);
    layers.push(testLayer);
    remainingBudget -= testLayer.tokenEstimate;

    if (remainingBudget <= 0) {
      return this.buildResult(layers, true);
    }

    // Layer 5: Similar implementations
    const similarLayer = await this.buildSimilarLayer(targetFiles, remainingBudget);
    layers.push(similarLayer);

    return this.buildResult(layers, false);
  }

  // ─── Layer Builders ──────────────────────────────────────────────

  private async buildTargetLayer(targetFiles: string[]): Promise<ContextLayer> {
    const files: ContextFile[] = [];
    for (const filePath of targetFiles) {
      const content = await this.safeReadFile(filePath);
      if (content !== null) {
        files.push({
          path: filePath,
          content,
          relevance: "target",
          tokenEstimate: this.estimateTokens(content),
        });
      }
    }
    return {
      name: "targets",
      priority: 1,
      files,
      tokenEstimate: files.reduce((sum, f) => sum + f.tokenEstimate, 0),
    };
  }

  private async buildDependencyLayer(targetFiles: string[], budget: number): Promise<ContextLayer> {
    const depPaths = new Set<string>();

    for (const filePath of targetFiles) {
      const content = await this.safeReadFile(filePath);
      if (content) {
        const imports = this.extractImports(content, filePath);
        imports.forEach((imp) => depPaths.add(imp));
      }
    }

    // Remove targets themselves
    targetFiles.forEach((t) => depPaths.delete(resolve(this.config.projectRoot, t)));

    const files = await this.readFilesWithBudget(
      [...depPaths],
      "direct-dep",
      budget
    );

    return {
      name: "dependencies",
      priority: 2,
      files,
      tokenEstimate: files.reduce((sum, f) => sum + f.tokenEstimate, 0),
    };
  }

  private async buildPatternLayer(targetFiles: string[], budget: number): Promise<ContextLayer> {
    // Extract exported type/interface names from targets, find other files using them
    const typeNames = new Set<string>();

    for (const filePath of targetFiles) {
      const content = await this.safeReadFile(filePath);
      if (content) {
        const matches = content.matchAll(/export\s+(?:interface|type|enum)\s+(\w+)/g);
        for (const match of matches) {
          typeNames.add(match[1]);
        }
      }
    }

    if (typeNames.size === 0) {
      return { name: "patterns", priority: 3, files: [], tokenEstimate: 0 };
    }

    // Find files that import these types
    const pattern = [...typeNames].join("|");
    const allSourceFiles = await this.findSourceFiles();
    const matchingFiles: string[] = [];

    for (const file of allSourceFiles) {
      if (targetFiles.includes(file)) continue;
      const content = await this.safeReadFile(file);
      if (content && new RegExp(`\\b(${pattern})\\b`).test(content)) {
        matchingFiles.push(file);
        if (matchingFiles.length >= 5) break; // Cap pattern matches
      }
    }

    const files = await this.readFilesWithBudget(matchingFiles, "pattern", budget);

    return {
      name: "patterns",
      priority: 3,
      files,
      tokenEstimate: files.reduce((sum, f) => sum + f.tokenEstimate, 0),
    };
  }

  private async buildTestLayer(targetFiles: string[], budget: number): Promise<ContextLayer> {
    const testPaths: string[] = [];

    for (const filePath of targetFiles) {
      const ext = extname(filePath);
      const base = filePath.slice(0, -ext.length);

      // Common test file patterns
      const candidates = [
        `${base}.test${ext}`,
        `${base}.spec${ext}`,
        `${base}.test.ts`,
        `${base}.spec.ts`,
        filePath.replace(/\/src\//, "/__tests__/").replace(ext, `.test${ext}`),
      ];

      for (const candidate of candidates) {
        if (await this.fileExists(candidate)) {
          testPaths.push(candidate);
          break;
        }
      }
    }

    const files = await this.readFilesWithBudget(testPaths, "test", budget);

    return {
      name: "tests",
      priority: 4,
      files,
      tokenEstimate: files.reduce((sum, f) => sum + f.tokenEstimate, 0),
    };
  }

  private async buildSimilarLayer(targetFiles: string[], budget: number): Promise<ContextLayer> {
    // Find files in the same directory or sibling directories
    const dirs = new Set(targetFiles.map((f) => dirname(resolve(this.config.projectRoot, f))));
    const siblingFiles: string[] = [];

    for (const dir of dirs) {
      try {
        const pattern = `${dir}/*{${this.config.sourceExtensions.join(",")}}`;
        const matches = await glob(pattern, { ignore: this.config.ignoreDirs.map((d) => `**/${d}/**`) });
        for (const match of matches) {
          const rel = match.replace(this.config.projectRoot + "/", "");
          if (!targetFiles.includes(rel) && !siblingFiles.includes(rel)) {
            siblingFiles.push(rel);
          }
        }
      } catch {
        // Directory might not exist for new files
      }
    }

    const files = await this.readFilesWithBudget(
      siblingFiles.slice(0, 5),
      "similar-impl",
      budget
    );

    return {
      name: "similar",
      priority: 5,
      files,
      tokenEstimate: files.reduce((sum, f) => sum + f.tokenEstimate, 0),
    };
  }

  // ─── Utilities ───────────────────────────────────────────────────

  private extractImports(content: string, fromFile: string): string[] {
    const imports: string[] = [];
    const dir = dirname(resolve(this.config.projectRoot, fromFile));

    // Match: import ... from "./path" or import ... from "../path"
    const regex = /from\s+['"](\.\.?\/[^'"]+)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const importPath = match[1];
      let resolved = resolve(dir, importPath);

      // Try common extensions
      for (const ext of this.config.sourceExtensions) {
        if (!resolved.endsWith(ext)) {
          const withExt = resolved + ext;
          imports.push(withExt);
        }
      }
      imports.push(resolved);
    }

    return imports;
  }

  private async readFilesWithBudget(
    paths: string[],
    relevance: ContextRelevance,
    budget: number
  ): Promise<ContextFile[]> {
    const files: ContextFile[] = [];
    let used = 0;

    for (const filePath of paths) {
      if (used >= budget) break;
      const content = await this.safeReadFile(filePath);
      if (content) {
        // Truncate large files before checking budget so they don't
        // consume the budget in full when they could still contribute.
        const truncated = content.length > this.config.maxFileChars
          ? content.slice(0, this.config.maxFileChars) + "\n// ... [truncated]"
          : content;
        const tokens = this.estimateTokens(truncated);
        if (used + tokens <= budget) {
          files.push({ path: filePath, content: truncated, relevance, tokenEstimate: tokens });
          used += tokens;
        }
      }
    }

    return files;
  }

  private async safeReadFile(filePath: string): Promise<string | null> {
    try {
      const absolute = resolve(this.config.projectRoot, filePath);
      return await readFile(absolute, "utf-8");
    } catch {
      return null;
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(resolve(this.config.projectRoot, filePath));
      return true;
    } catch {
      return false;
    }
  }

  private async findSourceFiles(): Promise<string[]> {
    const pattern = `**/*{${this.config.sourceExtensions.join(",")}}`;
    const matches = await glob(pattern, {
      cwd: this.config.projectRoot,
      ignore: this.config.ignoreDirs.map((d) => `**/${d}/**`),
    });
    return matches;
  }

  private estimateTokens(content: string): number {
    return Math.ceil(content.length / this.config.charsPerToken);
  }

  private buildResult(layers: ContextLayer[], truncated: boolean): AssembledContext {
    const totalTokens = layers.reduce((sum, l) => sum + l.tokenEstimate, 0);
    const fileCount = layers.reduce((sum, l) => sum + l.files.length, 0);

    return {
      layers,
      totalTokens,
      budgetUsed: totalTokens,
      budgetTotal: this.config.tokenBudget,
      truncated,
      fileCount,
    };
  }
}

// ─── Formatting ──────────────────────────────────────────────────────

/**
 * Format assembled context into a string suitable for LLM consumption.
 */
export function formatContext(ctx: AssembledContext): string {
  const sections: string[] = [];

  for (const layer of ctx.layers) {
    if (layer.files.length === 0) continue;

    sections.push(`\n--- ${layer.name.toUpperCase()} (${layer.files.length} files, ~${layer.tokenEstimate} tokens) ---\n`);

    for (const file of layer.files) {
      sections.push(`\n### ${file.path} [${file.relevance}]\n\`\`\`\n${file.content}\n\`\`\`\n`);
    }
  }

  if (ctx.truncated) {
    sections.push(
      `\n⚠ Context truncated at ${ctx.budgetTotal} token budget. ${ctx.fileCount} files included.\n`
    );
  }

  return sections.join("");
}
