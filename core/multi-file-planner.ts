export interface PlanWave {
  id: number;
  name: string;
  files: string[];
  dependsOn: number[];
  verificationCheckpoint: string;
}

export interface PlanEdge {
  fromWave: number;
  toWave: number;
  reason: string;
}

export interface Plan {
  prompt: string;
  changeSet: string[];
  waves: PlanWave[];
  dependencyEdges: PlanEdge[];
}

function normalizeChangeSet(changeSet: readonly string[]): string[] {
  return Array.from(
    new Set(
      changeSet
        .map((file) => file.trim())
        .filter((file) => file.length > 0),
    ),
  );
}

function classifyWave(file: string): number {
  const normalized = file.toLowerCase();

  if (
    normalized.includes("schema") ||
    normalized.includes("types") ||
    normalized.endsWith(".d.ts") ||
    normalized.includes("interface") ||
    normalized.includes("model")
  ) {
    return 1;
  }

  if (
    normalized.includes("test") ||
    normalized.includes("spec") ||
    normalized.includes("docs") ||
    normalized.endsWith(".md")
  ) {
    return 3;
  }

  if (
    normalized.includes("integration") ||
    normalized.includes("coordinator") ||
    normalized.includes("pipeline") ||
    normalized.includes("router") ||
    normalized.includes("server")
  ) {
    return 4;
  }

  return 2;
}

function buildCheckpoint(waveId: number, prompt: string, files: readonly string[]): string {
  const focus = files.length > 0 ? files.join(", ") : "no files assigned";

  switch (waveId) {
    case 1:
      return `Verify schema/type updates compile cleanly and still support: ${prompt}. Files: ${focus}`;
    case 2:
      return `Verify consumers now match the updated contracts before broader rollout. Files: ${focus}`;
    case 3:
      return `Verify tests/docs reflect the intended behavior and prompt expectations. Files: ${focus}`;
    case 4:
      return `Verify end-to-end integration behavior is coherent after all prior waves. Files: ${focus}`;
    default:
      return `Verify wave ${waveId} changes are internally consistent. Files: ${focus}`;
  }
}

export function planChangeSet(changeSet: readonly string[], prompt: string): Plan {
  const files = normalizeChangeSet(changeSet);
  const buckets = new Map<number, string[]>([
    [1, []],
    [2, []],
    [3, []],
    [4, []],
  ]);

  for (const file of files) {
    const waveId = classifyWave(file);
    buckets.get(waveId)?.push(file);
  }

  const waves: PlanWave[] = [
    {
      id: 1,
      name: "schema/types",
      files: buckets.get(1) ?? [],
      dependsOn: [],
      verificationCheckpoint: buildCheckpoint(1, prompt, buckets.get(1) ?? []),
    },
    {
      id: 2,
      name: "consumers",
      files: buckets.get(2) ?? [],
      dependsOn: [1],
      verificationCheckpoint: buildCheckpoint(2, prompt, buckets.get(2) ?? []),
    },
    {
      id: 3,
      name: "tests/docs",
      files: buckets.get(3) ?? [],
      dependsOn: [1, 2],
      verificationCheckpoint: buildCheckpoint(3, prompt, buckets.get(3) ?? []),
    },
    {
      id: 4,
      name: "integration",
      files: buckets.get(4) ?? [],
      dependsOn: [1, 2, 3],
      verificationCheckpoint: buildCheckpoint(4, prompt, buckets.get(4) ?? []),
    },
  ];

  const dependencyEdges: PlanEdge[] = [
    { fromWave: 1, toWave: 2, reason: "Consumers should follow schema and type changes." },
    { fromWave: 2, toWave: 3, reason: "Tests and docs should reflect updated consumer behavior." },
    { fromWave: 3, toWave: 4, reason: "Integration checks should run after implementation and verification artifacts are aligned." },
  ];

  return {
    prompt,
    changeSet: files,
    waves,
    dependencyEdges,
  };
}
