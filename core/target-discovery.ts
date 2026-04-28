import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";

import type { RequestAnalysis } from "./charter.js";
import {
  isNegatedTarget,
  sanitizePromptForFileExtraction,
} from "./prompt-sanitizer.js";

export interface TargetDiscoveryCandidate {
  readonly path: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface TargetDiscoveryRejection {
  readonly path: string;
  readonly reason: string;
}

export interface PreparedTargetSet {
  readonly targets: readonly string[];
  readonly selected: readonly TargetDiscoveryCandidate[];
  readonly rejected: readonly TargetDiscoveryRejection[];
  readonly clarification: string | null;
}

interface DiscoveryFile {
  readonly path: string;
  readonly basename: string;
  readonly ext: string;
  readonly head: string;
}

const IGNORE_DIRS = new Set([
  ".git",
  ".aedis",
  ".zendorium",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
]);

const CONFIG_EXTENSIONS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

const DOC_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".rst",
  ".txt",
]);

const TEST_FILE_RE = /(^|\/).*\.(test|spec)\.[a-z0-9]+$/i;
const BACKEND_KEYWORDS = [
  "health",
  "endpoint",
  "route",
  "router",
  "handler",
  "controller",
  "server",
  "api",
  "provider",
  "model",
  "models",
  "stats",
  "config",
  "validation",
];

export function prepareTargetsForPrompt(input: {
  projectRoot: string;
  prompt: string;
  analysis: RequestAnalysis;
  limit?: number;
}): PreparedTargetSet {
  const projectRoot = resolve(input.projectRoot);
  // Run the same literal-strip + negative-directive sweep the charter
  // applies, so target discovery cannot reintroduce a filename that
  // charter correctly ignored. extractPromptFileMentions/StemMentions
  // run against `sanitized`, never the raw prompt; rawTargets are
  // filtered against `negatedTargets` before any existence check, so
  // a "Do not modify README.md" wins even when README.md exists on
  // disk. This closes the ffe132ed leak.
  const { sanitized, negatedTargets } = sanitizePromptForFileExtraction(input.prompt);
  const rawTargets = uniqueStrings([
    ...input.analysis.targets,
    ...extractPromptFileMentions(sanitized),
    ...extractPromptStemMentions(sanitized),
  ]).filter((target) => !isNegatedTarget(target, negatedTargets));
  const limit = input.limit ?? 4;
  const prompt = input.prompt;
  const promptWords = extractPromptWords(prompt);
  const files = rawTargets.length === 0 ||
    rawTargets.some((target) => isBasenameTarget(target) || looksLikeStemTarget(target))
    ? collectDiscoveryFiles(projectRoot)
    : [];
  const selected: TargetDiscoveryCandidate[] = [];
  const rejected: TargetDiscoveryRejection[] = [];
  const targets: string[] = [];
  const basenameTargets: string[] = [];

  for (const target of rawTargets) {
    const normalized = normalizeTarget(target, projectRoot);
    if (!normalized) continue;
    if (isNegatedTarget(normalized, negatedTargets)) continue;

    const existingType = inspectExistingPath(projectRoot, normalized);
    if (existingType) {
      targets.push(normalized);
      continue;
    }

    const stemResolution = resolveStemTarget({
      target: normalized,
      promptWords,
      analysis: input.analysis,
      files,
    });
    if (stemResolution) {
      targets.push(stemResolution.path);
      selected.push(stemResolution);
      continue;
    }

    // Creation intent: the prompt explicitly says to create this file
    // (e.g. "Then create core/retry-utils.test.ts with …"). Accept the
    // non-existent path so the builder can produce it. Without this,
    // the target gets rejected and the builder never receives the task.
    if (hasCreationIntent(sanitized, normalized)) {
      targets.push(normalized);
      selected.push({
        path: normalized,
        score: 0.9,
        reasons: ["prompt explicitly requests file creation"],
      });
      continue;
    }

    if (isBasenameTarget(normalized)) {
      basenameTargets.push(normalized);
      continue;
    }

    rejected.push({
      path: normalized,
      reason: "target path does not exist in the repo and could not be resolved to a real file",
    });
  }

  let pendingBasenames = [...basenameTargets];
  while (pendingBasenames.length > 0) {
    let progressed = false;
    const remaining: string[] = [];

    for (const basenameTarget of pendingBasenames) {
      const resolution = resolveBasenameTarget({
        basenameTarget,
        projectRoot,
        promptWords,
        analysis: input.analysis,
        files,
        resolvedPaths: targets,
      });
      if (resolution.resolved) {
        targets.push(resolution.resolved.path);
        selected.push(resolution.resolved);
        rejected.push(...resolution.rejected);
        progressed = true;
      } else {
        remaining.push(basenameTarget);
      }
    }

    if (!progressed) {
      for (const basenameTarget of remaining) {
        const resolution = resolveBasenameTarget({
          basenameTarget,
          projectRoot,
          promptWords,
          analysis: input.analysis,
          files,
          resolvedPaths: targets,
        });
        rejected.push(...resolution.rejected);
      }
      break;
    }

    pendingBasenames = remaining;
  }

  if (
    targets.length === 0 &&
    !hasAmbiguousBasenameRejection(rejected) &&
    isBoundedBackendPrompt(prompt, input.analysis)
  ) {
    const discovered = discoverBackendFiles({
      projectRoot,
      promptWords,
      analysis: input.analysis,
      files: files.length > 0 ? files : collectDiscoveryFiles(projectRoot),
      limit,
    });
    if (discovered.length > 0) {
      for (const candidate of discovered) {
        targets.push(candidate.path);
        selected.push(candidate);
      }
    }
  }

  // Backstop: even if a basename/stem resolution or backend discovery
  // produced a path whose basename matches a negated entry (e.g. a
  // bare "Do not modify README.md" pointing at docs/README.md picked
  // by stem resolution), drop it. The early rawTargets filter catches
  // most cases; this guards the post-resolution surface too.
  const dedupedTargets = uniqueStrings(targets).filter(
    (target) => !isNegatedTarget(target, negatedTargets),
  );
  const clarification =
    dedupedTargets.length === 0 && hasAmbiguousBasenameRejection(rejected)
      ? "Multiple files matched the requested basename and the prompt did not disambiguate which one to change."
      : null;

  return {
    targets: dedupedTargets,
    selected: dedupeCandidates(selected).filter(
      (candidate) => !isNegatedTarget(candidate.path, negatedTargets),
    ),
    rejected: dedupeRejections(rejected),
    clarification,
  };
}

function resolveBasenameTarget(input: {
  basenameTarget: string;
  projectRoot: string;
  promptWords: readonly string[];
  analysis: RequestAnalysis;
  files: readonly DiscoveryFile[];
  resolvedPaths: readonly string[];
}): {
  resolved: TargetDiscoveryCandidate | null;
  rejected: TargetDiscoveryRejection[];
} {
  const basenameTarget = input.basenameTarget.replace(/^.*[\\/]/, "");
  const exactMatches = input.files
    .filter((file) => file.basename === basenameTarget)
    .map((file) => {
      const candidate = scoreCandidate(file, input.promptWords, input.analysis, "basename");
      const affinity = scoreResolvedPathAffinity(file.path, input.resolvedPaths);
      return affinity.score > 0
        ? {
            ...candidate,
            score: candidate.score + affinity.score,
            reasons: [...candidate.reasons, ...affinity.reasons],
          }
        : candidate;
    })
    .sort(compareCandidates);

  if (exactMatches.length === 0) {
    return {
      resolved: null,
      rejected: [{
        path: basenameTarget,
        reason: "basename target could not be resolved to a repo-relative file",
      }],
    };
  }

  if (exactMatches.length === 1) {
    return {
      resolved: exactMatches[0],
      rejected: [],
    };
  }

  const top = exactMatches[0];
  const runnerUp = exactMatches[1];
  const gap = top.score - runnerUp.score;
  if (top.score >= 80 && gap >= 20) {
    return {
      resolved: top,
      rejected: exactMatches.slice(1).map((candidate) => ({
        path: candidate.path,
        reason: `ambiguous basename candidate ranked below ${top.path} (${candidate.score} < ${top.score})`,
      })),
    };
  }

  return {
    resolved: null,
    rejected: [{
      path: basenameTarget,
      reason: `ambiguous basename target: ${exactMatches.slice(0, 4).map((candidate) => candidate.path).join(", ")}`,
    }],
  };
}

function resolveStemTarget(input: {
  target: string;
  promptWords: readonly string[];
  analysis: RequestAnalysis;
  files: readonly DiscoveryFile[];
}): TargetDiscoveryCandidate | null {
  if (!looksLikeStemTarget(input.target)) {
    return null;
  }

  const stem = input.target.toLowerCase();
  const matches = input.files
    .filter((file) =>
      file.path.toLowerCase() === stem ||
      file.path.toLowerCase().startsWith(`${stem}.`) ||
      file.path.toLowerCase().startsWith(`${stem}/index.`),
    )
    .map((file) => {
      const candidate = scoreCandidate(file, input.promptWords, input.analysis, "backend");
      return {
        ...candidate,
        score: candidate.score + 90,
        reasons: uniqueStrings(["directory-qualified stem match", ...candidate.reasons]),
      };
    })
    .sort(compareCandidates);

  if (matches.length === 0) {
    return null;
  }

  const top = matches[0];
  const runnerUp = matches[1];
  if (!runnerUp || top.score - runnerUp.score >= 15) {
    return top;
  }

  return null;
}

function discoverBackendFiles(input: {
  projectRoot: string;
  promptWords: readonly string[];
  analysis: RequestAnalysis;
  files: readonly DiscoveryFile[];
  limit: number;
}): TargetDiscoveryCandidate[] {
  const candidates = input.files
    .map((file) => scoreCandidate(file, input.promptWords, input.analysis, "backend"))
    .filter((candidate) => candidate.score >= 40)
    .sort(compareCandidates);

  const selected: TargetDiscoveryCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.length >= input.limit) break;
    if (selected.some((existing) => existing.path === candidate.path)) continue;
    selected.push(candidate);
  }
  return selected;
}

function scoreResolvedPathAffinity(
  candidatePath: string,
  resolvedPaths: readonly string[],
): { score: number; reasons: string[] } {
  if (resolvedPaths.length === 0) {
    return { score: 0, reasons: [] };
  }

  const candidateDir = candidatePath.includes("/")
    ? candidatePath.slice(0, candidatePath.lastIndexOf("/"))
    : "";
  const candidateTopLevel = candidatePath.split("/")[0] ?? "";
  let score = 0;
  const reasons: string[] = [];

  for (const resolved of resolvedPaths) {
    const resolvedDir = resolved.includes("/")
      ? resolved.slice(0, resolved.lastIndexOf("/"))
      : "";
    const resolvedTopLevel = resolved.split("/")[0] ?? "";

    if (candidateDir && resolvedDir && candidateDir === resolvedDir) {
      score += 30;
      reasons.push(`shared directory with ${resolved}`);
      continue;
    }
    if (candidateTopLevel && resolvedTopLevel && candidateTopLevel === resolvedTopLevel) {
      score += 10;
      reasons.push(`shared top-level module with ${resolved}`);
    }
  }

  return { score, reasons: uniqueStrings(reasons) };
}

function scoreCandidate(
  file: DiscoveryFile,
  promptWords: readonly string[],
  analysis: RequestAnalysis,
  mode: "basename" | "backend",
): TargetDiscoveryCandidate {
  const pathLower = file.path.toLowerCase();
  const basenameLower = file.basename.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (mode === "basename") {
    score += 120;
    reasons.push("exact basename match");
  }

  if (pathLower.startsWith("src/")) {
    score += 18;
    reasons.push("source tree");
  }
  if (/(^|\/)(server|router|routes|route|handler|controller)(\/|\.|$)/.test(pathLower)) {
    score += 28;
    reasons.push("backend entrypoint path");
  }
  if (/(^|\/)(provider|providers|config|schema|contract)(\/|\.|$)/.test(pathLower)) {
    score += 18;
    reasons.push("shared backend/config contract path");
  }
  if (TEST_FILE_RE.test(pathLower)) {
    if (analysis.category === "test") {
      score += 20;
      reasons.push("test file for test task");
    } else {
      score -= 12;
    }
  }
  if (DOC_EXTENSIONS.has(file.ext)) {
    if (analysis.category === "docs") {
      score += 24;
      reasons.push("documentation file");
    } else {
      score -= 10;
    }
  }
  if (CONFIG_EXTENSIONS.has(file.ext) && /\b(config|validation|schema|env|setting)\b/.test(analysis.raw.toLowerCase())) {
    score += 16;
    reasons.push("config/validation file");
  }

  for (const word of promptWords) {
    if (basenameLower.includes(word)) {
      score += 16;
      reasons.push(`basename matched "${word}"`);
    } else if (pathLower.includes(word)) {
      score += 10;
      reasons.push(`path matched "${word}"`);
    }

    if (file.head.includes(word)) {
      score += 5;
      reasons.push(`file content matched "${word}"`);
    }
  }

  if (analysis.category === "feature" && /\b(add|introduce|implement|create)\b/.test(analysis.raw.toLowerCase())) {
    if (/(server|router|route)/.test(pathLower)) {
      score += 12;
      reasons.push("feature edit likely lands in route registration");
    }
  }
  if (analysis.category === "refactor" && /(router|server|provider|config)/.test(pathLower)) {
    score += 10;
    reasons.push("refactor target likely spans backend boundary");
  }

  return {
    path: file.path,
    score,
    reasons: uniqueStrings(reasons).slice(0, 6),
  };
}

function compareCandidates(a: TargetDiscoveryCandidate, b: TargetDiscoveryCandidate): number {
  return b.score - a.score || a.path.localeCompare(b.path);
}

function collectDiscoveryFiles(projectRoot: string): DiscoveryFile[] {
  const out: DiscoveryFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(resolve(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const absolute = resolve(dir, entry.name);
      const rel = relative(projectRoot, absolute).replace(/\\/g, "/");
      const ext = extname(rel).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext) && !CONFIG_EXTENSIONS.has(ext) && !DOC_EXTENSIONS.has(ext)) continue;
      const lower = rel.toLowerCase();
      if (/(^|\/)(node_modules|dist|coverage|build|\.git|\.aedis|\.zendorium)(\/|$)/.test(lower)) continue;
      if (/\.generated\./i.test(lower)) continue;
      let head = "";
      try {
        head = readFileSync(absolute, "utf-8").slice(0, 4096).toLowerCase();
      } catch {
        head = "";
      }
      out.push({
        path: rel,
        basename: basename(rel).toLowerCase(),
        ext,
        head,
      });
    }
  };
  walk(projectRoot);
  return out;
}

function inspectExistingPath(projectRoot: string, target: string): "file" | "directory" | null {
  try {
    const info = statSync(resolve(projectRoot, target));
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
  } catch {
    return null;
  }
  return null;
}

function normalizeTarget(target: string, projectRoot: string): string {
  const trimmed = target.trim().replace(/[),:;]+$/g, "").replace(/\.$/, "");
  if (!trimmed) return "";
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
    if (trimmed.startsWith(projectRoot)) {
      return trimmed.slice(projectRoot.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    }
  }
  return trimmed.replace(/\\/g, "/");
}

function isBasenameTarget(target: string): boolean {
  if (!target) return false;
  if (target.includes("/")) return false;
  return /\.[a-z0-9]+$/i.test(target);
}

function looksLikeStemTarget(target: string): boolean {
  if (!target) return false;
  if (!target.includes("/")) return false;
  if (/\.[a-z0-9]+$/i.test(target)) return false;
  return /^[\w./-]+$/.test(target);
}

function isBoundedBackendPrompt(prompt: string, analysis: RequestAnalysis): boolean {
  const lower = prompt.toLowerCase();
  const hasBackendKeyword = BACKEND_KEYWORDS.some((keyword) => lower.includes(keyword));
  const hasAction = /\b(add|create|implement|refactor|improve|make|update|clean|simplify|split)\b/.test(lower);
  const isSweep = /\b(every file|all files|rename everywhere|entire repo|whole repo)\b/.test(lower);
  if (isSweep) return false;
  if (analysis.category === "docs" || analysis.category === "investigation") return false;
  return hasBackendKeyword && hasAction;
}

function hasAmbiguousBasenameRejection(
  rejected: readonly TargetDiscoveryRejection[],
): boolean {
  return rejected.some((entry) => entry.reason.startsWith("ambiguous basename target"));
}

function extractPromptWords(prompt: string): string[] {
  return uniqueStrings(
    (prompt.toLowerCase().match(/[a-z]{3,}/g) ?? [])
      .filter((word) => ![
        "the",
        "and",
        "with",
        "from",
        "into",
        "that",
        "this",
        "needed",
        "update",
      ].includes(word)),
  );
}

function extractPromptFileMentions(prompt: string): string[] {
  return uniqueStrings(
    prompt.match(
      /\b[\w./-]+\.(?:gdshader|svelte|scala|swift|tscn|tres|yaml|json|toml|html|scss|sass|less|pyi|mjs|cjs|tsx|jsx|cpp|hpp|php|bash|vue|sh|ts|js|md|yml|py|rs|go|cs|rb|gd|cc|lua|c|h|kt|java|txt|rst)\b/g,
    ) ?? [],
  );
}

function extractPromptStemMentions(prompt: string): string[] {
  const matches = prompt.matchAll(
    /\b(?:modify|update|edit|change|replace|refactor|rename|clean(?:\s+up)?|fix)\s+([a-z][\w-]*)\s+in\s+(src|lib|core|modules|apps|workers|router|scripts|scenes|assets|utils|handlers|routes|services|models|views|templates|tests?|spec)\b/gi,
  );
  return uniqueStrings(
    Array.from(matches, (match) => `${match[2]}/${match[1]}`.replace(/\\/g, "/")),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function dedupeCandidates(
  candidates: readonly TargetDiscoveryCandidate[],
): TargetDiscoveryCandidate[] {
  const seen = new Set<string>();
  const out: TargetDiscoveryCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    out.push(candidate);
  }
  return out;
}

function dedupeRejections(
  rejections: readonly TargetDiscoveryRejection[],
): TargetDiscoveryRejection[] {
  const seen = new Set<string>();
  const out: TargetDiscoveryRejection[] = [];
  for (const rejection of rejections) {
    const key = `${rejection.path}::${rejection.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rejection);
  }
  return out;
}

/**
 * Detect whether `sanitized` contains a creation verb immediately
 * preceding (or closely surrounding) `target`. Matches patterns like
 * "create core/foo.ts", "Then create core/foo.test.ts with …",
 * "add a new core/bar.ts". The check runs against the SANITIZED
 * prompt so quoted examples don't false-positive.
 */
const CREATION_VERBS = "create|scaffold|generate|write|introduce|add";

function hasCreationIntent(sanitized: string, target: string): boolean {
  // Escape dots/slashes in the path for regex safety.
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "create <target>", "create the repository root file <target>",
  // "Then create <target>", "add a new <target>"
  const before = new RegExp(
    `\\b(?:${CREATION_VERBS})\\s+(?:a\\s+|the\\s+)?(?:new\\s+)?(?:(?:repository\\s+)?root\\s+)?(?:file\\s+)?${escaped}\\b`,
    "i",
  );
  if (before.test(sanitized)) return true;
  // "<target> (should be|needs to be) created"
  const after = new RegExp(
    `\\b${escaped}\\s+(?:should|needs?\\s+to|must|will)\\s+be\\s+(?:created|generated|added)\\b`,
    "i",
  );
  return after.test(sanitized);
}
