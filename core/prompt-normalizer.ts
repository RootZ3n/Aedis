import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { GatedContext } from "./context-gate.js";

const exec = promisify(execFile);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function extractPathCandidates(raw: string): string[] {
  const matches = raw.match(/(?:\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g) ?? [];
  return Array.from(new Set(matches.map(match => match.trim())));
}

async function promptContainsExistingPath(raw: string, projectRoot: string): Promise<boolean> {
  const root = resolve(projectRoot);
  const candidates = extractPathCandidates(raw);

  for (const candidate of candidates) {
    const absoluteCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
    if (await fileExists(absoluteCandidate)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract lowercase words (3+ chars) from a string for overlap checks.
 */
function extractWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().match(/[a-z]{3,}/g) ?? [],
  );
}

async function rewriteWithLocalModel(
  raw: string,
  context: GatedContext,
): Promise<string> {
  const recentFiles = context.relevantFiles.length > 0
    ? context.relevantFiles
    : context.recentTaskSummaries;
  const memoryHints = [
    ...(context.landmines ?? []).slice(0, 2),
    ...(context.safeApproaches ?? []).slice(0, 2),
  ];

  const instruction = [
    "Rewrite the following user request into one explicit engineering prompt.",
    "Prefer the format: in <file>, <action>.",
    "Use the provided recent context when useful.",
    "Return only the rewritten prompt.",
    "",
    `Language: ${context.language}`,
    `Recent context: ${recentFiles.join(" | ") || "none"}`,
    `Memory hints: ${memoryHints.join(" | ") || "none"}`,
    `Raw prompt: ${raw}`,
  ].join("\n");

  try {
    const { stdout } = await exec("ollama", ["run", "qwen3.5:4b", instruction], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    const normalized = stdout.trim();
    if (normalized.length === 0) return raw;

    // Quality gate: reject normalization that looks like garbage.
    // If the result is suspiciously short or shares no words with
    // the original, the model likely hallucinated or mangled it.
    const rawWords = extractWords(raw);
    const normalizedWords = extractWords(normalized);
    const overlap = [...rawWords].filter((w) => normalizedWords.has(w)).length;

    if (normalized.length < 10 || (rawWords.size > 0 && overlap === 0)) {
      console.warn(
        `[normalizer] WARN: normalization may have mangled prompt — ` +
        `raw="${raw.slice(0, 80)}" normalized="${normalized.slice(0, 80)}" ` +
        `(len=${normalized.length}, wordOverlap=${overlap}/${rawWords.size}). Using original.`,
      );
      return raw;
    }

    return normalized;
  } catch {
    return raw;
  }
}

export async function normalizePrompt(
  raw: string,
  context: GatedContext,
  projectRoot: string,
): Promise<string> {
  try {
    // If the user already named an absolute path, preserve the prompt
    // verbatim so downstream gates can validate that exact path instead
    // of having relevance-ranked memory inject an unrelated file.
    if (extractPathCandidates(raw).some((candidate) => isAbsolute(candidate))) {
      return raw;
    }

    if (await promptContainsExistingPath(raw, projectRoot)) {
      return raw;
    }

    if (context.relevantFiles.length > 0) {
      return `in ${context.relevantFiles[0]}, ${raw}`;
    }

    // Fast path: if the prompt already contains an action verb + "in"
    // pattern like "in src/server.ts, add ..." or "add X to Y", skip
    // the expensive ollama rewrite. The charter's analyzeRequest can
    // handle these directly.
    if (/\bin\s+\S+\.\w+[\s,]/i.test(raw) || /\b(add|fix|update|modify|create|remove|refactor)\b/i.test(raw)) {
      console.log("[normalizer] fast-path: prompt has action verb, skipping ollama rewrite");
      return raw;
    }

    return await rewriteWithLocalModel(raw, context);
  } catch {
    return raw;
  }
}
