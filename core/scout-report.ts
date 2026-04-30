/**
 * Scout Report — Structured evidence format for Scout Agent findings.
 *
 * Every scout produces a ScoutReport with typed findings, recommended
 * targets, tests, risks, and cost data. Reports are persisted under
 * AEDIS_STATE_ROOT/state/scout-evidence/ so they survive across
 * sessions and never pollute the target repo.
 *
 * Scout reports are ADVISORY ONLY. The coordinator's safety gates
 * still make the final decision. Target discovery still validates
 * paths. Approval is still required before promotion.
 */

import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export type ScoutReportType =
  | "repo_map"
  | "target_discovery"
  | "test_discovery"
  | "risk"
  | "docs";

export interface ScoutFinding {
  readonly title: string;
  readonly evidence: string;
  readonly files?: readonly string[];
  readonly confidence: number;
}

export interface ScoutReport {
  readonly scoutId: string;
  readonly type: ScoutReportType;
  readonly modelProvider: string;
  readonly modelName: string;
  readonly localOrCloud: "local" | "cloud" | "deterministic";
  readonly confidence: number;
  readonly summary: string;
  readonly findings: readonly ScoutFinding[];
  readonly recommendedTargets: readonly string[];
  readonly recommendedTests: readonly string[];
  readonly risks: readonly string[];
  readonly costUsd: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ScoutEvidence {
  readonly runId: string;
  readonly planId?: string;
  readonly prompt: string;
  readonly repoPath: string;
  readonly reports: readonly ScoutReport[];
  readonly spawnDecision: ScoutSpawnDecision;
  readonly createdAt: string;
}

// ─── Spawn Decision ──────────────────────────────────────────────────

export interface ScoutSpawnDecision {
  readonly spawn: boolean;
  readonly reason: string;
  readonly scoutCount: number;
  readonly scoutTypes: readonly ScoutReportType[];
  readonly localOrCloudRecommendation: "local" | "cloud" | "deterministic";
  readonly expectedEvidence: readonly string[];
}

// ─── Persistence ─────────────────────────────────────────────────────

const SCOUT_EVIDENCE_SUBDIR = "scout-evidence";

export class ScoutEvidenceStore {
  private readonly dir: string;

  constructor(stateRoot: string) {
    this.dir = join(resolve(stateRoot), "state", SCOUT_EVIDENCE_SUBDIR);
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  getEvidencePath(runId: string): string {
    return join(this.dir, `${sanitizeId(runId)}.json`);
  }

  async save(evidence: ScoutEvidence): Promise<void> {
    const path = this.getEvidencePath(evidence.runId);
    const tmp = path + ".tmp";
    await writeFile(tmp, JSON.stringify(evidence, null, 2), "utf-8");
    await rename(tmp, path);
  }

  async load(runId: string): Promise<ScoutEvidence | null> {
    const path = this.getEvidencePath(runId);
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as ScoutEvidence;
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}
