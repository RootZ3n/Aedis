/**
 * ImportGraph — lightweight import/dependency extractor for Aedis.
 *
 * Scans source files for import/require statements and builds a
 * bidirectional dependency map: file → imports, file → importedBy.
 *
 * This replaces the directory-sibling heuristic in change-set.ts
 * with real import data. It can work standalone (scanning files
 * directly) or pull from an existing RepoIndex snapshot.
 *
 * Design decisions:
 *   - Regex-based, not AST-based. Good enough for dependency
 *     tracking; we don't need type resolution.
 *   - Resolves relative imports against the file's directory.
 *   - Tries common extensions (.ts, .tsx, .js, /index.ts) when
 *     the import specifier omits them.
 *   - External packages (non-relative imports) are tracked but
 *     stored separately — they don't feed into the dependency map
 *     since we can't affect them.
 */

import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, relative } from "node:path";
import { existsSync } from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────

export interface ImportGraphEntry {
  /** Relative path from project root. */
  readonly path: string;
  /** Relative paths this file imports (resolved, within the project). */
  readonly imports: readonly string[];
  /** Relative paths of files that import this file. */
  readonly importedBy: readonly string[];
  /** External package imports (e.g., "react", "node:fs"). */
  readonly externalImports: readonly string[];
}

export interface ImportGraph {
  /** All entries in the graph. */
  readonly entries: ReadonlyMap<string, ImportGraphEntry>;
  /** Get the dependency chain for a file. */
  getImports(filePath: string): readonly string[];
  /** Get reverse imports (who depends on this file). */
  getImportedBy(filePath: string): readonly string[];
  /** Get the full transitive dependency set for a file (upstream). */
  getTransitiveDeps(filePath: string): readonly string[];
  /** Get all files transitively affected by changing this file (downstream). */
  getTransitiveConsumers(filePath: string): readonly string[];
  /**
   * Extract the dependency subgraph for a set of files — only the
   * edges between files in the set. Used by the change-set builder
   * to produce a focused dependency map.
   */
  subgraphFor(files: readonly string[]): Record<string, readonly string[]>;
}

export interface TestPairing {
  /** Implementation file path. */
  readonly implPath: string;
  /** Matched test file path, or null if no test found. */
  readonly testPath: string | null;
  /** How the pairing was inferred. */
  readonly method: "exact-suffix" | "sibling-directory" | "co-located" | "none";
}

// ─── Import Extraction ──────────────────────────────────────────────

const IMPORT_REGEX = /(?:import\s+(?:type\s+)?(?:[^'";\n]+?\s+from\s+)?["']([^"']+)["']|require\(["']([^"']+)["']\))/g;

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_CANDIDATES = ["index.ts", "index.tsx", "index.js"];

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const match of content.matchAll(IMPORT_REGEX)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function isRelativeImport(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Resolve a relative import specifier to a real file path.
 * Tries the specifier as-is, then with common extensions,
 * then as a directory with an index file.
 */
function resolveRelativeImport(
  specifier: string,
  fromDir: string,
  projectRoot: string,
): string | null {
  const base = resolve(fromDir, specifier);

  // 1. Exact path (already has extension)
  if (existsSync(base) && !isDirectory(base)) {
    return relative(projectRoot, base).replace(/\\/g, "/");
  }

  // 2. Try adding extensions
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const withExt = base + ext;
    if (existsSync(withExt)) {
      return relative(projectRoot, withExt).replace(/\\/g, "/");
    }
  }

  // 3. Try as directory with index
  for (const indexFile of INDEX_CANDIDATES) {
    const indexPath = resolve(base, indexFile);
    if (existsSync(indexPath)) {
      return relative(projectRoot, indexPath).replace(/\\/g, "/");
    }
  }

  // 4. Handle .js → .ts remapping (common in TS projects with
  //    moduleResolution: "node16" or "nodenext")
  if (specifier.endsWith(".js")) {
    const tsCandidate = base.replace(/\.js$/, ".ts");
    if (existsSync(tsCandidate)) {
      return relative(projectRoot, tsCandidate).replace(/\\/g, "/");
    }
  }

  return null;
}

function isDirectory(p: string): boolean {
  try {
    const { statSync } = require("node:fs");
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── Graph Building ─────────────────────────────────────────────────

/**
 * Build an ImportGraph by scanning files on disk. This is the
 * standalone path — no RepoIndex required.
 *
 * @param files - Relative file paths (from projectRoot)
 * @param projectRoot - Absolute path to the project root
 */
export async function buildImportGraph(
  files: readonly string[],
  projectRoot: string,
): Promise<ImportGraph> {
  const imports = new Map<string, string[]>();
  const externalImports = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();

  // Initialize all entries
  for (const file of files) {
    imports.set(file, []);
    externalImports.set(file, []);
    if (!importedBy.has(file)) importedBy.set(file, []);
  }

  // Scan each file
  for (const file of files) {
    const absPath = resolve(projectRoot, file);
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      continue;
    }

    const specifiers = extractImportSpecifiers(content);
    const fileDir = dirname(absPath);

    for (const specifier of specifiers) {
      if (isRelativeImport(specifier)) {
        const resolved = resolveRelativeImport(specifier, fileDir, projectRoot);
        if (resolved) {
          imports.get(file)!.push(resolved);
          const existing = importedBy.get(resolved) ?? [];
          existing.push(file);
          importedBy.set(resolved, existing);
        }
      } else {
        externalImports.get(file)!.push(specifier);
      }
    }
  }

  return createImportGraphFromMaps(imports, importedBy, externalImports);
}

/**
 * Build an ImportGraph from an existing RepoIndex snapshot.
 * Much faster than scanning files — uses pre-computed data.
 */
export function buildImportGraphFromIndex(
  indexEntries: readonly { path: string; imports: readonly string[] }[],
): ImportGraph {
  const imports = new Map<string, string[]>();
  const externalImports = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();

  for (const entry of indexEntries) {
    const localImports: string[] = [];
    const external: string[] = [];

    for (const imp of entry.imports) {
      if (imp.startsWith(".") || imp.startsWith("/") || !imp.includes("/") && !imp.startsWith("node:")) {
        // Heuristic: if RepoIndex resolved it to a relative path, it's local
        if (!imp.includes("node_modules") && !imp.startsWith("node:")) {
          localImports.push(imp);
        } else {
          external.push(imp);
        }
      } else {
        external.push(imp);
      }
    }

    imports.set(entry.path, localImports);
    externalImports.set(entry.path, external);

    for (const dep of localImports) {
      const existing = importedBy.get(dep) ?? [];
      existing.push(entry.path);
      importedBy.set(dep, existing);
    }
  }

  return createImportGraphFromMaps(imports, importedBy, externalImports);
}

function createImportGraphFromMaps(
  imports: Map<string, string[]>,
  importedBy: Map<string, string[]>,
  externalImports: Map<string, string[]>,
): ImportGraph {
  const entries = new Map<string, ImportGraphEntry>();

  // Build entries for all known files
  const allPaths = new Set([...imports.keys(), ...importedBy.keys()]);
  for (const path of allPaths) {
    entries.set(path, {
      path,
      imports: [...new Set(imports.get(path) ?? [])],
      importedBy: [...new Set(importedBy.get(path) ?? [])],
      externalImports: [...new Set(externalImports.get(path) ?? [])],
    });
  }

  return {
    entries,

    getImports(filePath: string): readonly string[] {
      return entries.get(filePath)?.imports ?? [];
    },

    getImportedBy(filePath: string): readonly string[] {
      return entries.get(filePath)?.importedBy ?? [];
    },

    getTransitiveDeps(filePath: string): readonly string[] {
      const visited = new Set<string>();
      const queue = [filePath];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const dep of (entries.get(current)?.imports ?? [])) {
          if (!visited.has(dep)) queue.push(dep);
        }
      }
      visited.delete(filePath);
      return [...visited];
    },

    getTransitiveConsumers(filePath: string): readonly string[] {
      const visited = new Set<string>();
      const queue = [filePath];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const consumer of (entries.get(current)?.importedBy ?? [])) {
          if (!visited.has(consumer)) queue.push(consumer);
        }
      }
      visited.delete(filePath);
      return [...visited];
    },

    subgraphFor(files: readonly string[]): Record<string, readonly string[]> {
      const fileSet = new Set(files);
      const result: Record<string, readonly string[]> = {};
      for (const file of files) {
        const fileDeps = entries.get(file)?.imports ?? [];
        // Only include edges to other files in the set
        result[file] = fileDeps.filter((dep) => fileSet.has(dep));
      }
      return result;
    },
  };
}

// ─── Test ↔ Implementation Pairing ──────────────────────────────────

const TEST_SUFFIXES = [".test", ".spec", "_test", "_spec"];
const TEST_DIRS = ["__tests__", "tests", "test"];

/**
 * Find the test file associated with an implementation file.
 *
 * Strategies (in priority order):
 *   1. Exact suffix match: foo.ts → foo.test.ts / foo.spec.ts
 *   2. Co-located: foo.ts → __tests__/foo.ts or __tests__/foo.test.ts
 *   3. Sibling test directory: src/foo.ts → tests/foo.test.ts
 */
export function findTestForImpl(
  implPath: string,
  projectRoot: string,
): TestPairing {
  const ext = extname(implPath);
  const stem = implPath.slice(0, -ext.length);

  // 1. Exact suffix match in same directory
  for (const suffix of TEST_SUFFIXES) {
    const candidate = stem + suffix + ext;
    if (existsSync(resolve(projectRoot, candidate))) {
      return { implPath, testPath: candidate, method: "exact-suffix" };
    }
  }

  // 2. Co-located in __tests__ directory
  const implDir = dirname(implPath);
  const implBase = implPath.slice(implDir.length + 1);
  const implStem = implBase.slice(0, -ext.length);

  for (const testDir of TEST_DIRS) {
    const testDirPath = implDir ? `${implDir}/${testDir}` : testDir;

    // Try: __tests__/foo.test.ts
    for (const suffix of TEST_SUFFIXES) {
      const candidate = `${testDirPath}/${implStem}${suffix}${ext}`;
      if (existsSync(resolve(projectRoot, candidate))) {
        return { implPath, testPath: candidate, method: "co-located" };
      }
    }

    // Try: __tests__/foo.ts (some projects put tests without suffix)
    const candidate = `${testDirPath}/${implBase}`;
    if (existsSync(resolve(projectRoot, candidate))) {
      return { implPath, testPath: candidate, method: "co-located" };
    }
  }

  // 3. Sibling directory: src/lib/foo.ts → src/lib/../tests/foo.test.ts
  if (implDir) {
    const parentDir = dirname(implDir);
    for (const testDir of TEST_DIRS) {
      const siblingTestDir = parentDir ? `${parentDir}/${testDir}` : testDir;
      for (const suffix of TEST_SUFFIXES) {
        const candidate = `${siblingTestDir}/${implStem}${suffix}${ext}`;
        if (existsSync(resolve(projectRoot, candidate))) {
          return { implPath, testPath: candidate, method: "sibling-directory" };
        }
      }
    }
  }

  return { implPath, testPath: null, method: "none" };
}

/**
 * Find test pairings for all implementation files in a set.
 * Skips files that are already test files.
 */
export function findTestPairings(
  files: readonly string[],
  projectRoot: string,
): readonly TestPairing[] {
  return files
    .filter((f) => !isTestFile(f))
    .map((f) => findTestForImpl(f, projectRoot));
}

/**
 * Given a set of implementation files, return the test files that
 * should be added to scope for adequate verification coverage.
 * Only returns test files that exist but are NOT already in scope.
 */
export function findMissingTestFiles(
  scopeFiles: readonly string[],
  projectRoot: string,
): readonly TestPairing[] {
  const scopeSet = new Set(scopeFiles);
  const pairings = findTestPairings(scopeFiles, projectRoot);
  return pairings.filter(
    (p) => p.testPath !== null && !scopeSet.has(p.testPath),
  );
}

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    TEST_SUFFIXES.some((s) => lower.includes(s)) ||
    TEST_DIRS.some((d) => lower.includes(`/${d}/`) || lower.startsWith(`${d}/`))
  );
}
