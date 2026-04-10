/**
 * RepoIndex — living codebase map for Zendorium.
 *
 * It scans a repo, builds a per-file profile, persists it to .zendorium,
 * and can refresh incrementally when files change.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile, access, watch } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

export interface IndexedFile {
  readonly path: string;
  readonly role: string;
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly frameworkType: string;
  readonly complexityEstimate: number;
  readonly centralityScore: number;
  readonly blastRadius: number;
  readonly changeFrequency: number;
  readonly testCoverageNearby: number;
  readonly isGenerated: boolean;
  readonly isConfig: boolean;
  readonly isSharedContract: boolean;
}

export interface RepoIndexSnapshot {
  readonly repoPath: string;
  readonly generatedPatterns: readonly string[];
  readonly updatedAt: string;
  readonly files: readonly IndexedFile[];
}

export class RepoIndex {
  private repoPath = "";
  private files = new Map<string, IndexedFile>();
  private reverseDeps = new Map<string, Set<string>>();
  private generatedPatterns = new Set<string>();
  private watcherAbort: AbortController | null = null;

  async buildIndex(repoPath: string): Promise<RepoIndexSnapshot> {
    this.repoPath = resolve(repoPath);
    this.files.clear();
    this.reverseDeps.clear();

    const sourceFiles = await this.collectFiles(this.repoPath);
    const entries: IndexedFile[] = [];

    for (const file of sourceFiles) {
      const entry = await this.indexFile(file);
      entries.push(entry);
      this.files.set(entry.path, entry);
    }

    this.rebuildReverseDeps(entries);
    await this.persist();
    await this.ensureWatcher();

    return this.snapshot();
  }

  identifyHotspots(): IndexedFile[] {
    return [...this.files.values()]
      .sort((a, b) => (b.centralityScore + b.changeFrequency) - (a.centralityScore + a.changeFrequency))
      .slice(0, 15);
  }

  identifyRiskyFiles(): IndexedFile[] {
    return [...this.files.values()]
      .sort((a, b) => (b.blastRadius + b.complexityEstimate) - (a.blastRadius + a.complexityEstimate))
      .slice(0, 15);
  }

  getBlastRadius(filePath: string): string[] {
    const resolved = this.normalizePath(filePath);
    const downstream = [...(this.reverseDeps.get(resolved) ?? new Set<string>())];
    return [resolved, ...downstream].filter(Boolean);
  }

  getDependencyChain(filePath: string): { upstream: string[]; downstream: string[] } {
    const resolved = this.normalizePath(filePath);
    const file = this.files.get(resolved);
    return {
      upstream: file ? [...file.imports] : [],
      downstream: [...(this.reverseDeps.get(resolved) ?? new Set<string>())],
    };
  }

  markGenerated(patterns: string[]): void {
    for (const pattern of patterns) this.generatedPatterns.add(pattern);
  }

  exportForContextAssembler(): RepoIndexSnapshot {
    return this.snapshot();
  }

  exportForTrustRouter(): Array<{ path: string; riskScore: number; centralityScore: number; blastRadius: number; isSharedContract: boolean }> {
    return [...this.files.values()].map((file) => ({
      path: file.path,
      riskScore: Number((file.blastRadius * 0.5 + file.centralityScore * 0.3 + file.complexityEstimate * 0.2).toFixed(2)),
      centralityScore: file.centralityScore,
      blastRadius: file.blastRadius,
      isSharedContract: file.isSharedContract,
    }));
  }

  async refreshFile(filePath: string): Promise<void> {
    const resolved = this.normalizePath(filePath);
    try {
      const fileStat = await stat(resolved);
      if (!fileStat.isFile()) return;
      const next = await this.indexFile(resolved);
      this.files.set(next.path, next);
      this.rebuildReverseDeps([...this.files.values()]);
      await this.persist();
    } catch {
      if (this.files.delete(resolved)) {
        this.rebuildReverseDeps([...this.files.values()]);
        await this.persist();
      }
    }
  }

  stopWatcher(): void {
    if (this.watcherAbort) {
      this.watcherAbort.abort();
      this.watcherAbort = null;
    }
  }

  getFile(filePath: string): IndexedFile | undefined {
    return this.files.get(this.normalizePath(filePath));
  }

  getAllFiles(): IndexedFile[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async loadFromDisk(repoPath: string): Promise<RepoIndexSnapshot | null> {
    const indexPath = join(resolve(repoPath), ".zendorium", "repo-index.json");
    try {
      const raw = await readFile(indexPath, "utf-8");
      const snapshot: RepoIndexSnapshot = JSON.parse(raw);
      this.repoPath = snapshot.repoPath;
      this.files.clear();
      this.reverseDeps.clear();
      this.generatedPatterns.clear();

      for (const file of snapshot.files) {
        this.files.set(file.path, file);
      }
      for (const pattern of snapshot.generatedPatterns) {
        this.generatedPatterns.add(pattern);
      }
      this.rebuildReverseDeps([...this.files.values()]);
      return snapshot;
    } catch {
      return null;
    }
  }

  private async ensureWatcher(): Promise<void> {
    if (!this.repoPath || this.watcherAbort) return;
    this.watcherAbort = new AbortController();
    const signal = this.watcherAbort.signal;

    void (async () => {
      try {
        for await (const event of watch(this.repoPath, { recursive: true, signal })) {
          if (!event.filename) continue;
          const changed = resolve(this.repoPath, String(event.filename));
          if (this.shouldIgnore(changed)) continue;
          await this.refreshFile(changed);
        }
      } catch {
        this.watcherAbort = null;
      }
    })();
  }

  private async collectFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(root, entry.name);
      if (this.shouldIgnore(fullPath)) continue;
      if (entry.isDirectory()) {
        out.push(...await this.collectFiles(fullPath));
        continue;
      }
      if (entry.isFile()) out.push(fullPath);
    }
    return out;
  }

  private async indexFile(filePath: string): Promise<IndexedFile> {
    const content = await readFile(filePath, "utf-8").catch(() => "");
    const rel = this.normalizePath(filePath);
    const imports = this.extractImports(content, dirname(filePath));
    const exports = this.extractExports(content);
    const role = this.inferRole(rel, content);
    const frameworkType = this.inferFramework(rel, content);
    const complexityEstimate = this.estimateComplexity(content);
    const centralityScore = this.estimateCentrality(imports, exports, rel);
    const blastRadius = this.estimateBlastRadius(imports, rel);
    const changeFrequency = this.estimateChangeFrequency(rel, content);
    const testCoverageNearby = await this.estimateNearbyTests(filePath);
    const isGenerated = this.matchesGeneratedPattern(rel, content);
    const isConfig = this.isConfigFile(rel);
    const isSharedContract = this.isSharedContractFile(rel, exports);

    return {
      path: rel,
      role,
      imports,
      exports,
      frameworkType,
      complexityEstimate,
      centralityScore,
      blastRadius,
      changeFrequency,
      testCoverageNearby,
      isGenerated,
      isConfig,
      isSharedContract,
    };
  }

  private rebuildReverseDeps(entries: IndexedFile[]): void {
    this.reverseDeps.clear();
    for (const entry of entries) {
      for (const imported of entry.imports) {
        const key = this.normalizePath(imported);
        const group = this.reverseDeps.get(key) ?? new Set<string>();
        group.add(entry.path);
        this.reverseDeps.set(key, group);
      }
    }
  }

  private extractImports(content: string, fromDir: string): string[] {
    const matches = [...content.matchAll(/import\s+(?:type\s+)?(?:[^'";]+?from\s+)?["']([^"']+)["']/g), ...content.matchAll(/require\(["']([^"']+)["']\)/g)];
    return matches
      .map((match) => match[1])
      .filter(Boolean)
      .map((specifier) => specifier.startsWith(".") ? this.normalizePath(resolve(fromDir, specifier)) : specifier);
  }

  private extractExports(content: string): string[] {
    const names = new Set<string>();
    for (const match of content.matchAll(/export\s+(?:const|function|class|type|interface|enum)\s+(\w+)/g)) {
      names.add(match[1]);
    }
    return [...names];
  }

  private inferRole(rel: string, content: string): string {
    if (/test|spec/i.test(rel)) return "test";
    if (/route|controller|endpoint/i.test(rel)) return "api-surface";
    if (/schema|types|contract/i.test(rel)) return "shared-contract";
    if (/config|json$/i.test(rel)) return "config";
    if (/component|view|page/i.test(rel)) return "ui";
    if (/worker|job|queue/i.test(rel)) return "worker";
    if (/class\s+\w+/i.test(content)) return "core-module";
    return "source-module";
  }

  private inferFramework(rel: string, content: string): string {
    if (/react|jsx|tsx|useState|useEffect/.test(content) || /\.tsx$/.test(rel)) return "react";
    if (/fastify|express|hono/.test(content)) return "server";
    if (/vite|tailwind/.test(content)) return "frontend-tooling";
    if (/node:|from\s+"fs|from\s+"path/.test(content)) return "node";
    return "generic";
  }

  private estimateComplexity(content: string): number {
    const branches = (content.match(/\b(if|for|while|switch|catch)\b/g) ?? []).length;
    const functions = (content.match(/\b(function|=>)\b/g) ?? []).length;
    return Math.min(100, branches * 4 + functions * 2 + Math.ceil(content.length / 800));
  }

  private estimateCentrality(imports: readonly string[], exports: readonly string[], rel: string): number {
    const sharedBonus = /index|types|schema|contract/.test(rel) ? 20 : 0;
    return Math.min(100, imports.length * 8 + exports.length * 6 + sharedBonus);
  }

  private estimateBlastRadius(imports: readonly string[], rel: string): number {
    const downstream = this.reverseDeps.get(rel)?.size ?? 0;
    const contractBonus = /schema|types|contract/.test(rel) ? 20 : 0;
    return Math.min(100, imports.length * 3 + downstream * 10 + contractBonus);
  }

  private estimateChangeFrequency(rel: string, content: string): number {
    const hash = createHash("sha1").update(rel + content.length).digest("hex");
    return parseInt(hash.slice(0, 2), 16) % 100;
  }

  private async estimateNearbyTests(filePath: string): Promise<number> {
    const dir = dirname(filePath);
    const stem = filePath.replace(extname(filePath), "");
    const candidates = [
      `${stem}.test${extname(filePath)}`,
      `${stem}.spec${extname(filePath)}`,
      join(dir, "__tests__"),
      join(dirname(dir), "tests"),
    ];

    let score = 0;
    for (const candidate of candidates) {
      try {
        await access(candidate);
        score += 25;
      } catch {
        continue;
      }
    }
    return Math.min(100, score);
  }

  private matchesGeneratedPattern(rel: string, content: string): boolean {
    if (content.includes("@generated") || content.includes("AUTO-GENERATED")) return true;
    for (const pattern of this.generatedPatterns) {
      if (rel.includes(pattern)) return true;
    }
    return false;
  }

  private isConfigFile(rel: string): boolean {
    return /(^|\/)(tsconfig|package|vite|tailwind|eslint|prettier|jest|vitest|docker|compose)|\.json$|\.ya?ml$/.test(rel);
  }

  private isSharedContractFile(rel: string, exports: readonly string[]): boolean {
    return /schema|types|contract|interface/.test(rel) || exports.some((name) => /schema|type|contract/i.test(name));
  }

  private shouldIgnore(pathLike: string): boolean {
    return /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.zendorium)(\/|$)/.test(pathLike);
  }

  private normalizePath(pathLike: string): string {
    const absolute = resolve(pathLike);
    if (!this.repoPath) return absolute;
    return relative(this.repoPath, absolute) || ".";
  }

  private async persist(): Promise<void> {
    if (!this.repoPath) return;
    const stateDir = join(this.repoPath, ".zendorium");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "repo-index.json"), JSON.stringify(this.snapshot(), null, 2), "utf-8");
  }

  private snapshot(): RepoIndexSnapshot {
    return {
      repoPath: this.repoPath,
      generatedPatterns: [...this.generatedPatterns],
      updatedAt: new Date().toISOString(),
      files: [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
}
