import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { RepoIndex, type IndexedFile, type RepoIndexSnapshot } from "./repo-index.js";

const exec = promisify(execFile);

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "what", "where", "which",
  "about", "when", "does", "show", "find", "have", "your", "there", "their", "would",
  "could", "should", "after", "before", "make", "need", "used", "uses", "using", "repo",
  "code", "file", "files",
]);

export interface GroundedSearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface GroundedFileSnippet {
  readonly path: string;
  readonly reason: string;
  readonly content: string;
}

export interface GroundedRepoContext {
  readonly repoIndex: RepoIndexSnapshot | null;
  readonly relatedFiles: readonly string[];
  readonly searchHits: readonly GroundedSearchHit[];
  readonly snippets: readonly GroundedFileSnippet[];
  readonly reason: string;
}

export async function buildGroundedRepoContext(
  question: string,
  projectRoot: string,
  stateRoot?: string,
): Promise<GroundedRepoContext> {
  const index = new RepoIndex(stateRoot);
  const persisted = await index.loadFromDisk(projectRoot);
  const built = persisted
    ? null
    : await index.buildIndex(projectRoot).catch(() => null);
  if (built) {
    index.stopWatcher();
  }
  const repoIndex = persisted ?? built;

  const keywords = extractKeywords(question);
  const scoredFiles = scoreFiles(repoIndex?.files ?? [], keywords).slice(0, 8);
  const searchHits = await searchRepo(projectRoot, keywords);

  const orderedPaths = uniqueStrings([
    ...searchHits.map((hit) => hit.path),
    ...scoredFiles.map((file) => file.path),
  ]).slice(0, 6);

  const snippets = await Promise.all(
    orderedPaths.slice(0, 4).map(async (path) => ({
      path,
      reason:
        searchHits.some((hit) => hit.path === path)
          ? "matched search terms in repo content"
          : "matched repo index and code structure",
      content: await readSnippet(projectRoot, path),
    })),
  );

  const usableSnippets = snippets.filter((snippet) => snippet.content.trim().length > 0);
  const reasonParts = [
    repoIndex ? `repo index loaded (${repoIndex.files.length} files)` : "repo index unavailable",
    orderedPaths.length > 0 ? `${orderedPaths.length} related file(s)` : "no strong file matches",
    searchHits.length > 0 ? `${searchHits.length} search hit(s)` : "no direct search hits",
  ];

  return {
    repoIndex,
    relatedFiles: orderedPaths,
    searchHits,
    snippets: usableSnippets,
    reason: reasonParts.join(" · "),
  };
}

export function extractKeywords(question: string): string[] {
  return Array.from(
    new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3)
        .filter((part) => !STOP_WORDS.has(part)),
    ),
  ).slice(0, 8);
}

function scoreFiles(files: readonly IndexedFile[], keywords: readonly string[]): IndexedFile[] {
  return [...files]
    .map((file) => ({
      file,
      score: scoreFile(file, keywords),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.file);
}

function scoreFile(file: IndexedFile, keywords: readonly string[]): number {
  const haystacks = [
    file.path.toLowerCase(),
    file.role.toLowerCase(),
    file.frameworkType.toLowerCase(),
    ...file.exports.map((value) => value.toLowerCase()),
    ...file.imports.map((value) => value.toLowerCase()),
  ];

  let score = 0;
  for (const keyword of keywords) {
    if (file.path.toLowerCase().includes(keyword)) score += 6;
    if (haystacks.some((value) => value.includes(keyword))) score += 3;
  }
  score += Math.round(file.centralityScore / 20);
  score += Math.round(file.blastRadius / 25);
  return score;
}

async function searchRepo(projectRoot: string, keywords: readonly string[]): Promise<GroundedSearchHit[]> {
  if (keywords.length === 0) return [];
  const pattern = keywords.map(escapeRegex).join("|");
  if (!pattern) return [];

  try {
    const result = await exec("rg", [
      "-n",
      "--no-heading",
      "--smart-case",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!.git/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!build/**",
      "--glob",
      "!.aedis/**",
      "--max-count",
      "3",
      pattern,
      ".",
    ], {
      cwd: projectRoot,
      timeout: 15_000,
      maxBuffer: 512 * 1024,
    });

    return parseRgOutput(result.stdout).slice(0, 12);
  } catch (err: any) {
    const stdout = typeof err?.stdout === "string" ? err.stdout : "";
    return parseRgOutput(stdout).slice(0, 12);
  }
}

function parseRgOutput(stdout: string): GroundedSearchHit[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.*?):(\d+):(.*)$/);
      if (!match) return null;
      return {
        path: match[1].replace(/^\.\//, ""),
        line: Number(match[2]),
        text: match[3].trim(),
      } satisfies GroundedSearchHit;
    })
    .filter((entry): entry is GroundedSearchHit => entry !== null);
}

async function readSnippet(projectRoot: string, relativePath: string): Promise<string> {
  try {
    const raw = await readFile(join(resolve(projectRoot), relativePath), "utf-8");
    const lines = raw.split("\n").slice(0, 80);
    return lines.join("\n").slice(0, 2200);
  } catch {
    return "";
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
