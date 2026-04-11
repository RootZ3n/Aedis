import type { IntentObject } from "./intent.js";

export type FileStatus =
  | "planned"
  | "in-progress"
  | "blocked"
  | "complete"
  | "verified";

export interface FileInclusion {
  readonly path: string;
  readonly whyIncluded: string;
  readonly dependsOn: readonly string[];
  readonly status: FileStatus;
}

export interface CoherenceVerdict {
  readonly coherent: boolean;
  readonly reason: string;
}

export interface ChangeSet {
  readonly intent: IntentObject;
  readonly filesInScope: readonly FileInclusion[];
  readonly dependencyRelationships: Readonly<Record<string, readonly string[]>>;
  readonly sharedInvariants: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly coherenceVerdict: CoherenceVerdict;
}

function normalizeFiles(files: readonly string[]): string[] {
  return Array.from(
    new Set(
      files
        .map((file) => file.trim())
        .filter((file) => file.length > 0),
    ),
  );
}

function inferWhyIncluded(intent: IntentObject, file: string): string {
  const deliverable = intent.charter.deliverables.find((entry) => entry.targetFiles.includes(file));

  if (deliverable) {
    return `${deliverable.type} required for deliverable: ${deliverable.description}`;
  }

  if (intent.charter.objective.toLowerCase().includes(file.toLowerCase())) {
    return `Referenced directly by charter objective: ${intent.charter.objective}`;
  }

  return `Included to satisfy intent objective: ${intent.charter.objective}`;
}

function inferDependencies(files: readonly string[]): Map<string, string[]> {
  const byDirectory = new Map<string, string[]>();
  const dependencies = new Map<string, string[]>();

  for (const file of files) {
    const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    const group = byDirectory.get(directory) ?? [];
    group.push(file);
    byDirectory.set(directory, group);
  }

  for (const file of files) {
    const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    const siblingFiles = (byDirectory.get(directory) ?? []).filter((candidate) => candidate !== file);
    const inferred = siblingFiles
      .filter((candidate) => candidate.length <= file.length || candidate.endsWith(".d.ts"))
      .slice(0, 4);
    dependencies.set(file, inferred);
  }

  return dependencies;
}

function collectSharedInvariants(intent: IntentObject, files: readonly string[]): string[] {
  const invariants = new Set<string>();

  invariants.add(`Stay within declared intent objective: ${intent.charter.objective}`);
  invariants.add(`Respect exclusions: ${intent.exclusions.join(", ") || "none"}`);
  invariants.add(`Keep affected files coherent across ${files.length} in-scope file(s)`);

  for (const criterion of intent.charter.successCriteria) {
    invariants.add(`Preserve success criterion: ${criterion}`);
  }

  return [...invariants];
}

function deriveAcceptanceCriteria(intent: IntentObject, files: readonly string[]): string[] {
  const criteria = [...intent.charter.successCriteria];
  criteria.push(`All in-scope files remain internally consistent: ${files.join(", ") || "none"}`);
  criteria.push("Dependency relationships are respected during implementation order.");
  return criteria;
}

function deriveCoherenceVerdict(
  files: readonly string[],
  dependencyRelationships: Readonly<Record<string, readonly string[]>>,
): CoherenceVerdict {
  if (files.length === 0) {
    return {
      coherent: false,
      reason: "No files were provided for the change set.",
    };
  }

  const orphaned = files.filter((file) => !(file in dependencyRelationships));
  if (orphaned.length > 0) {
    return {
      coherent: false,
      reason: `Missing dependency metadata for: ${orphaned.join(", ")}`,
    };
  }

  return {
    coherent: true,
    reason: `Change set covers ${files.length} file(s) with dependency metadata and acceptance criteria.`,
  };
}

export function createChangeSet(intent: IntentObject, files: readonly string[]): ChangeSet {
  const normalizedFiles = normalizeFiles(files);
  const dependencyMap = inferDependencies(normalizedFiles);

  const filesInScope: FileInclusion[] = normalizedFiles.map((file) => ({
    path: file,
    whyIncluded: inferWhyIncluded(intent, file),
    dependsOn: dependencyMap.get(file) ?? [],
    status: "planned",
  }));

  const dependencyRelationships = Object.freeze(
    Object.fromEntries(
      normalizedFiles.map((file) => [file, Object.freeze([...(dependencyMap.get(file) ?? [])])]),
    ) as Record<string, readonly string[]>,
  );

  const sharedInvariants = Object.freeze(collectSharedInvariants(intent, normalizedFiles));
  const acceptanceCriteria = Object.freeze(deriveAcceptanceCriteria(intent, normalizedFiles));
  const coherenceVerdict = deriveCoherenceVerdict(normalizedFiles, dependencyRelationships);

  return Object.freeze({
    intent,
    filesInScope: Object.freeze(filesInScope.map((entry) => Object.freeze(entry))),
    dependencyRelationships,
    sharedInvariants,
    acceptanceCriteria,
    coherenceVerdict: Object.freeze(coherenceVerdict),
  });
}
