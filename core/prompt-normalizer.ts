import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  const matches = raw.match(/([A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g) ?? [];
  return Array.from(new Set(matches.map(match => match.trim())));
}

async function promptContainsExistingPath(raw: string, projectRoot: string): Promise<boolean> {
  const root = resolve(projectRoot);
  const candidates = extractPathCandidates(raw);

  for (const candidate of candidates) {
    if (await fileExists(join(root, candidate))) {
      return true;
    }
  }

  return false;
}

async function rewriteWithLocalModel(
  raw: string,
  context: GatedContext,
): Promise<string> {
  const recentFiles = context.relevantFiles.length > 0
    ? context.relevantFiles
    : context.recentTaskSummaries;

  const instruction = [
    "Rewrite the following user request into one explicit engineering prompt.",
    "Prefer the format: in <file>, <action>.",
    "Use the provided recent context when useful.",
    "Return only the rewritten prompt.",
    "",
    `Language: ${context.language}`,
    `Recent context: ${recentFiles.join(" | ") || "none"}`,
    `Raw prompt: ${raw}`,
  ].join("\n");

  try {
    const { stdout } = await exec("ollama", ["run", "qwen3.5:4b", instruction], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    const normalized = stdout.trim();
    return normalized.length > 0 ? normalized : raw;
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
    if (await promptContainsExistingPath(raw, projectRoot)) {
      return raw;
    }

    if (context.relevantFiles.length > 0) {
      return `in ${context.relevantFiles[0]}, ${raw}`;
    }

    return await rewriteWithLocalModel(raw, context);
  } catch {
    return raw;
  }
}
