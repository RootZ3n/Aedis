import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

export interface Invariant {
  readonly type: "type-name" | "function-name" | "route" | "config-key" | "export";
  readonly name: string;
  readonly files: string[];
  readonly description: string;
}

type InvariantType = Invariant["type"];

interface CandidateHit {
  readonly type: InvariantType;
  readonly name: string;
  readonly file: string;
}

const ROUTE_PATTERN = /["'`]((?:\/|https?:\/\/)[^"'`\s]+)["'`]/g;
const FUNCTION_PATTERN = /\bfunction\s+([A-Za-z_$][\w$]*)\b|\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|\basync\s+function\s+([A-Za-z_$][\w$]*)\b/g;
const TYPE_PATTERN = /\b(?:type|interface|class|enum)\s+([A-Za-z_$][\w$]*)\b/g;
const EXPORT_PATTERN = /\bexport\s+(?:async\s+function|function|const|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b|\bexport\s*\{\s*([^}]+)\s*\}/g;
const CONFIG_PATTERN = /\bprocess\.env\.([A-Z][A-Z0-9_]+)\b|["'`]([A-Z][A-Z0-9_]{2,})["'`]\s*:/g;

function normalizeFiles(files: readonly string[], projectRoot: string): string[] {
  const root = resolve(projectRoot);
  return Array.from(
    new Set(
      files
        .map((file) => {
          const resolved = resolve(root, file);
          return relative(root, resolved) || file;
        })
        .map((file) => file.replace(/\\/g, "/"))
        .filter((file) => file.length > 0),
    ),
  );
}

function collectMatches(pattern: RegExp, content: string, file: string, type: InvariantType): CandidateHit[] {
  const hits: CandidateHit[] = [];

  for (const match of content.matchAll(pattern)) {
    const raw = match.slice(1).find((value) => typeof value === "string" && value.trim().length > 0);
    if (!raw) {
      continue;
    }

    if (type === "export" && raw.includes(",")) {
      const names = raw
        .split(",")
        .map((entry) => entry.trim().split(/\s+as\s+/i)[0]?.trim())
        .filter((entry): entry is string => Boolean(entry));
      for (const name of names) {
        hits.push({ type, name, file });
      }
      continue;
    }

    hits.push({ type, name: raw.trim(), file });
  }

  return hits;
}

function describeInvariant(type: InvariantType, name: string, files: readonly string[]): string {
  switch (type) {
    case "type-name":
      return `Type or contract \"${name}\" appears in multiple files and must stay aligned across ${files.length} files.`;
    case "function-name":
      return `Function \"${name}\" is referenced or defined across ${files.length} files and should remain consistent.`;
    case "route":
      return `Route \"${name}\" appears in multiple files and should remain synchronized across handlers and consumers.`;
    case "config-key":
      return `Config key \"${name}\" is shared across ${files.length} files and should remain consistent.`;
    case "export":
      return `Export \"${name}\" is shared across ${files.length} files and should remain stable across the change set.`;
    default:
      return `Invariant \"${name}\" appears in multiple files.`;
  }
}

export async function extractInvariants(files: string[], projectRoot: string): Promise<Invariant[]> {
  const normalizedFiles = normalizeFiles(files, projectRoot);
  const root = resolve(projectRoot);
  const hits: CandidateHit[] = [];

  for (const file of normalizedFiles) {
    const absolutePath = resolve(root, file);
    const content = await readFile(absolutePath, "utf-8").catch(() => "");
    if (!content) {
      continue;
    }

    hits.push(...collectMatches(EXPORT_PATTERN, content, file, "export"));
    hits.push(...collectMatches(FUNCTION_PATTERN, content, file, "function-name"));
    hits.push(...collectMatches(TYPE_PATTERN, content, file, "type-name"));
    hits.push(...collectMatches(ROUTE_PATTERN, content, file, "route"));
    hits.push(...collectMatches(CONFIG_PATTERN, content, file, "config-key"));
  }

  const grouped = new Map<string, { type: InvariantType; files: Set<string> }>();

  for (const hit of hits) {
    const key = `${hit.type}:${hit.name}`;
    const entry = grouped.get(key) ?? { type: hit.type, files: new Set<string>() };
    entry.files.add(hit.file);
    grouped.set(key, entry);
  }

  return [...grouped.entries()]
    .filter(([, entry]) => entry.files.size > 1)
    .map(([key, entry]) => {
      const name = key.slice(key.indexOf(":") + 1);
      const filesForInvariant = [...entry.files].sort();
      return {
        type: entry.type,
        name,
        files: filesForInvariant,
        description: describeInvariant(entry.type, name, filesForInvariant),
      } satisfies Invariant;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
}
