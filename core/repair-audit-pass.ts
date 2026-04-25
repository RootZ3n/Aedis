/**
 * RepairAuditPass — audit-only structural check on a multi-file change-set.
 *
 * IMPORTANT: this pass NEVER modifies any file. It walks the in-scope
 * files, parses imports/exports/local symbols with regex, and reports
 * structural inconsistencies (broken imports, missing exports, stale
 * markers) as a list of `findings`. The result carries an explicit
 * `auditOnly: true` invariant so consumers cannot accidentally treat
 * the audit as a repair.
 *
 * Why audit-only:
 *   - Predecessor `repair-pass` exposed `repairsApplied: number` but
 *     the value was hardcoded `0`. Consumers (merge-gate, aedis-memory,
 *     coordinator log line) read the field as if real repairs had
 *     happened, which built false confidence — exactly the opposite
 *     of Aedis's trust doctrine.
 *   - Implementing real repairs without verifier coverage is the kind
 *     of thing that builds *more* false confidence, so retiring the
 *     misleading shape comes first; a future, separate phase may add
 *     real repair behavior behind a flag with verifier coverage.
 *
 * Output contract:
 *   - `findings`: human-readable strings, one per detected issue
 *   - `findingsCount`: same as `findings.length` (convenience)
 *   - `auditOnly`: literal `true` — type-level invariant that no
 *     repair was performed. Removing this field would break callers,
 *     forcing migrations to acknowledge the audit-only stance.
 *
 * Output explicitly does NOT carry `repairsApplied` or
 * `repairsAttempted`. The previous shape implied repair behavior
 * that did not exist.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import type { ChangeSet } from "./change-set.js";

export interface RepairAuditResult {
  /** Human-readable structural findings — one entry per detected issue. */
  readonly findings: readonly string[];
  /** Convenience: same as findings.length. */
  readonly findingsCount: number;
  /**
   * Type-level invariant: this pass is audit-only and never modifies
   * any file. Always literally `true`. Consumers should rely on this
   * marker rather than infer repair behavior from `findingsCount`.
   */
  readonly auditOnly: true;
}

interface ExportIndexEntry {
  readonly names: Set<string>;
  readonly hasDefault: boolean;
}

const IMPORT_PATTERN = /import\s+(?:type\s+)?([^;]+?)\s+from\s+["']([^"']+)["']/g;
const EXPORT_PATTERN = /\bexport\s+(?:async\s+function|function|const|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b|\bexport\s*\{\s*([^}]+)\s*\}|\bexport\s+default\b/g;
const LOCAL_SYMBOL_PATTERN = /\b(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/g;

function normalizeScopeFiles(changeSet: ChangeSet): string[] {
  return Array.from(
    new Set(
      changeSet.filesInScope
        .map((entry) => entry.path.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

async function readChangedFiles(
  files: readonly string[],
  projectRoot: string,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();

  for (const file of files) {
    const absolute = resolve(projectRoot, file);
    const content = await readFile(absolute, "utf-8").catch(() => "");
    contents.set(file, content);
  }

  return contents;
}

function resolveImportTarget(importer: string, specifier: string, scopeFiles: readonly string[]): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const importerDir = dirname(importer);
  const baseCandidate = resolve(importerDir, specifier).replace(/\\/g, "/");
  const candidates = [
    baseCandidate,
    `${baseCandidate}.ts`,
    `${baseCandidate}.tsx`,
    `${baseCandidate}.js`,
    `${baseCandidate}.mjs`,
    `${baseCandidate}.cjs`,
    `${baseCandidate}/index.ts`,
    `${baseCandidate}/index.tsx`,
    `${baseCandidate}/index.js`,
  ];

  for (const candidate of candidates) {
    const match = scopeFiles.find((file) => file === candidate || resolve(file).replace(/\\/g, "/") === candidate);
    if (match) {
      return match;
    }
  }

  return candidates[0] ?? null;
}

function buildExportIndex(contents: Map<string, string>): Map<string, ExportIndexEntry> {
  const index = new Map<string, ExportIndexEntry>();

  for (const [file, content] of contents) {
    const names = new Set<string>();
    let hasDefault = false;

    for (const match of content.matchAll(EXPORT_PATTERN)) {
      if (match[0].includes("export default")) {
        hasDefault = true;
      }

      const directName = match[1]?.trim();
      if (directName) {
        names.add(directName);
      }

      const blockNames = match[2]
        ?.split(",")
        .map((entry) => entry.trim().split(/\s+as\s+/i)[0]?.trim())
        .filter((entry): entry is string => Boolean(entry));
      for (const name of blockNames ?? []) {
        names.add(name);
      }
    }

    index.set(file, { names, hasDefault });
  }

  return index;
}

function collectLocalSymbols(content: string): Set<string> {
  const symbols = new Set<string>();

  for (const match of content.matchAll(LOCAL_SYMBOL_PATTERN)) {
    const name = match[1]?.trim();
    if (name) {
      symbols.add(name);
    }
  }

  return symbols;
}

function findBrokenImports(
  file: string,
  content: string,
  scopeFiles: readonly string[],
  exportIndex: Map<string, ExportIndexEntry>,
): string[] {
  const issues: string[] = [];

  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const clause = match[1]?.trim() ?? "";
    const specifier = match[2]?.trim() ?? "";
    const target = resolveImportTarget(file, specifier, scopeFiles);

    if (specifier.startsWith(".") && target && !scopeFiles.includes(target)) {
      issues.push(`${file}: broken import target \"${specifier}\"`);
      continue;
    }

    if (!target || !scopeFiles.includes(target)) {
      continue;
    }

    const exported = exportIndex.get(target);
    if (!exported) {
      issues.push(`${file}: import target \"${specifier}\" has no export index entry`);
      continue;
    }

    const defaultImportMatch = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    const namedImportsMatch = clause.match(/\{([^}]+)\}/);

    if (defaultImportMatch && !clause.startsWith("{") && !exported.hasDefault) {
      issues.push(`${file}: default import from \"${specifier}\" but target has no default export`);
    }

    const namedImports = namedImportsMatch?.[1]
      ?.split(",")
      .map((entry) => entry.trim().split(/\s+as\s+/i)[0]?.trim())
      .filter((entry): entry is string => Boolean(entry)) ?? [];

    for (const importedName of namedImports) {
      if (!exported.names.has(importedName)) {
        issues.push(`${file}: named import \"${importedName}\" missing from ${target}`);
      }
    }
  }

  return issues;
}

function findStaleReferences(file: string, content: string): string[] {
  const issues: string[] = [];
  const localSymbols = collectLocalSymbols(content);
  const stalePatterns = ["TODO rename", "FIXME stale", "@deprecated", "legacy-"];

  for (const pattern of stalePatterns) {
    if (content.includes(pattern)) {
      issues.push(`${file}: stale reference marker detected (${pattern})`);
    }
  }

  const extension = extname(file);
  if ((extension === ".ts" || extension === ".tsx") && localSymbols.size === 0 && content.includes("import ")) {
    issues.push(`${file}: imports present but no local symbols detected after change`);
  }

  return issues;
}

function findMismatchedExports(
  file: string,
  exportIndex: Map<string, ExportIndexEntry>,
  dependencyRelationships: Readonly<Record<string, readonly string[]>>,
): string[] {
  const issues: string[] = [];
  const current = exportIndex.get(file);
  if (!current) {
    return issues;
  }

  for (const dependency of dependencyRelationships[file] ?? []) {
    const target = exportIndex.get(dependency);
    if (!target) {
      continue;
    }

    if (current.names.size === 0 && target.names.size > 0) {
      issues.push(`${file}: mismatched exports compared to dependency ${dependency}`);
      continue;
    }

    const overlap = [...current.names].filter((name) => target.names.has(name));
    if (overlap.length === 0 && current.names.size > 0 && target.names.size > 0) {
      issues.push(`${file}: no shared exported names with dependency ${dependency}`);
    }
  }

  return issues;
}

/**
 * Run an audit-only structural pass over the change-set's in-scope
 * files. Reports findings; never modifies any file. Callers should
 * surface findings as advisory signals — they are NOT a "repair was
 * attempted" claim.
 */
export async function runRepairAuditPass(
  changeSet: ChangeSet,
  projectRoot: string,
): Promise<RepairAuditResult> {
  try {
    const scopeFiles = normalizeScopeFiles(changeSet);
    if (scopeFiles.length === 0) {
      return {
        findings: ["repair-audit: no files in scope (no repairs attempted; this pass is audit-only)"],
        findingsCount: 1,
        auditOnly: true,
      };
    }

    const existingFiles = scopeFiles.filter((file) => existsSync(resolve(projectRoot, file)));
    const contents = await readChangedFiles(existingFiles, projectRoot);
    const exportIndex = buildExportIndex(contents);
    const findings: string[] = [];

    for (const file of existingFiles) {
      const content = contents.get(file) ?? "";
      findings.push(...findBrokenImports(file, content, existingFiles, exportIndex));
      findings.push(...findStaleReferences(file, content));
      findings.push(...findMismatchedExports(file, exportIndex, changeSet.dependencyRelationships));
    }

    for (const finding of findings) {
      console.log(`[repair-audit] ${finding}`);
    }

    return {
      findings,
      findingsCount: findings.length,
      auditOnly: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[repair-audit] unexpected failure: ${message}`);
    return {
      findings: [`repair-audit failed: ${message} (no repairs attempted; this pass is audit-only)`],
      findingsCount: 1,
      auditOnly: true,
    };
  }
}
