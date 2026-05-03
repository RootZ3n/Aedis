/**
 * Config routes — Model assignment management.
 *
 * GET  /config/models — Return current model assignments
 * POST /config/models — Update model assignments
 *
 * Persists to .aedis/model-config.json relative to project root.
 * Falls back to the legacy .zendorium/model-config.json location on
 * read so existing installs keep working after the rename. New writes
 * always go to .aedis/.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../index.js";
import {
  DEFAULT_LANE_CONFIG,
  loadLaneConfigFromDisk,
} from "../../core/lane-config.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ModelAssignment {
  model: string;
  provider: string;
  label?: string;
  /**
   * Optional declarative fallback chain. Workers walk these in order
   * after the primary `{provider, model}` fails. Single-entry configs
   * (no chain field) still work — they produce a 1-entry chain at
   * resolution time. Each entry is a plain `{provider, model}` pair;
   * shared `label` is allowed but not used by the invoker.
   *
   * Declaring chains here keeps the per-repo fallback policy in data,
   * not in worker code. Without this, the only fallback was a single
   * hardcoded entry baked into the BuilderWorker constructor.
   */
  chain?: readonly { provider: string; model: string; label?: string }[];
}

export type ModelTier = "fast" | "standard" | "premium";

export interface BuilderTierConfig {
  fast?: ModelAssignment;
  standard?: ModelAssignment;
  premium?: ModelAssignment;
}

export interface ModelConfig {
  scout: ModelAssignment;
  builder: ModelAssignment;
  critic: ModelAssignment;
  verifier: ModelAssignment;
  integrator: ModelAssignment;
  escalation: ModelAssignment;
  coordinator: ModelAssignment;
  builderTiers?: BuilderTierConfig;
}

// ─── Defaults ────────────────────────────────────────────────────────
//
// IMPORTANT: a persisted .aedis/model-config.json file at the project
// root will OVERRIDE these defaults via loadModelConfig() below (with
// .zendorium/model-config.json as the legacy fallback). Changing the
// defaults here only affects projects that have no saved config. To
// change an active build's model selection, either delete that file or
// edit its `builder` / `critic` block directly.
//
// Per-role fallbacks (Builder + Critic) are NOT in this config — they
// are hardcoded in the worker constructors (workers/builder.ts and
// workers/critic.ts). The fallback chain logic lives in
// core/model-invoker.ts (invokeModelWithFallback).
//
// Builder default change history:
//   - was: claude-sonnet-4-6 / anthropic (briefly tried as primary, but
//          ModelStudio turned out to be slow rather than broken)
//   - now: qwen3.6-plus / modelstudio (with anthropic/claude-sonnet-4-6
//          as the worker-level fallback)
//
// Critic default change history:
//   - was: qwen3.5:9b / ollama
//   - was: claude-sonnet-4-6 / anthropic (with ollama/qwen3.5:9b as the
//          worker-level fallback) — Critic gates the pipeline so a
//          stronger model here was thought to pay for itself
//   - now: qwen3.5:9b / ollama (back to local-cheap default — the
//          Anthropic-primary default violated the no-Anthropic-hot-path
//          doctrine documented in DOCTRINE.md and silently routed
//          every empty-config installation to a paid provider for the
//          Critic role. Per-repo `.aedis/model-config.json` can still
//          override this with a stronger model when explicitly chosen.)

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  scout: { model: "local", provider: "local" },
  builder: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
  // No Anthropic in the hot path — see DOCTRINE.md. Per-repo
  // `.aedis/model-config.json` is authoritative; this is only the
  // empty-config fallback.
  critic: { model: "qwen3.5:9b", provider: "ollama" },
  verifier: { model: "local", provider: "local" },
  // Integrator is code-based (heuristic coherence checks, no LLM calls).
  // The model/provider fields exist for receipt completeness only.
  integrator: { model: "local", provider: "local" },
  escalation: { model: "glm-5.1", provider: "zai" },
  coordinator: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
  builderTiers: {},
};

const LOCAL_SMOKE_MODEL = "qwen3.5:9b";

const LOCAL_SMOKE_MODEL_CONFIG: ModelConfig = {
  scout: { model: "local", provider: "local" },
  builder: { model: LOCAL_SMOKE_MODEL, provider: "ollama" },
  critic: { model: LOCAL_SMOKE_MODEL, provider: "ollama" },
  verifier: { model: "local", provider: "local" },
  // Integrator is code-based (no LLM calls) — local placeholder for receipts.
  integrator: { model: "local", provider: "local" },
  escalation: { model: LOCAL_SMOKE_MODEL, provider: "ollama" },
  coordinator: { model: LOCAL_SMOKE_MODEL, provider: "ollama" },
  builderTiers: {
    fast: { model: LOCAL_SMOKE_MODEL, provider: "ollama" },
    standard: { model: LOCAL_SMOKE_MODEL, provider: "ollama" },
    premium: { model: LOCAL_SMOKE_MODEL, provider: "ollama" },
  },
};

export type ModelProfile = "default" | "local-smoke";

export function getActiveModelProfile(env: NodeJS.ProcessEnv = process.env): ModelProfile {
  return env["AEDIS_MODEL_PROFILE"] === "local-smoke" ? "local-smoke" : "default";
}

export function getLocalSmokeModel(): string {
  return LOCAL_SMOKE_MODEL;
}

export function getModelProfileConfig(profile: ModelProfile): ModelConfig {
  return normalizeModelConfig(
    profile === "local-smoke" ? LOCAL_SMOKE_MODEL_CONFIG : DEFAULT_MODEL_CONFIG,
  );
}

export function modelConfigRequiresCloudKeys(config: ModelConfig): readonly string[] {
  const required = new Set<string>();
  const inspect = (assignment: ModelAssignment | undefined) => {
    if (!assignment) return;
    for (const entry of resolveAssignmentChain(assignment)) {
      if (entry.provider === "openrouter") required.add("OPENROUTER_API_KEY");
      if (entry.provider === "zai") required.add("ZAI_API_KEY");
    }
  };
  for (const role of VALID_ROLES) inspect(config[role]);
  for (const tier of VALID_TIERS) inspect(config.builderTiers?.[tier]);
  return [...required].sort();
}

const VALID_ROLES = [
  "scout", "builder", "critic", "verifier",
  "integrator", "escalation", "coordinator",
] as const;
const VALID_TIERS: readonly ModelTier[] = ["fast", "standard", "premium"];

function normalizeChainEntry(
  raw: unknown,
): { provider: string; model: string; label?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as { provider?: unknown; model?: unknown; label?: unknown };
  const provider =
    typeof entry.provider === "string" && entry.provider.trim() ? entry.provider.trim() : "";
  const model = typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : "";
  if (!provider || !model) return null;
  const label =
    typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : undefined;
  return label ? { provider, model, label } : { provider, model };
}

function normalizeAssignment(
  raw: unknown,
  fallback: ModelAssignment,
): ModelAssignment {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const entry = raw as Partial<ModelAssignment>;
  const model = typeof entry.model === "string" && entry.model.trim()
    ? entry.model.trim()
    : fallback.model;
  const provider = typeof entry.provider === "string" && entry.provider.trim()
    ? entry.provider.trim()
    : fallback.provider;
  const label = typeof entry.label === "string" && entry.label.trim()
    ? entry.label.trim()
    : undefined;
  // Normalize chain entries — drop malformed rows silently rather than
  // throwing. A chain that contains the primary again is allowed but
  // has no effect (resolveBuilderChainForTier dedupes on identity).
  const chainRaw = Array.isArray(entry.chain) ? entry.chain : [];
  const chain = chainRaw
    .map(normalizeChainEntry)
    .filter((c): c is { provider: string; model: string; label?: string } => c !== null);
  const out: ModelAssignment = label ? { model, provider, label } : { model, provider };
  if (chain.length > 0) out.chain = chain;
  return out;
}

function normalizeBuilderTierConfig(raw: unknown): BuilderTierConfig {
  if (!raw || typeof raw !== "object") return {};
  const entry = raw as BuilderTierConfig;
  const out: BuilderTierConfig = {};
  for (const tier of VALID_TIERS) {
    if (entry[tier]) {
      out[tier] = normalizeAssignment(
        entry[tier],
        tier === "premium" ? DEFAULT_MODEL_CONFIG.escalation : DEFAULT_MODEL_CONFIG.builder,
      );
    }
  }
  return out;
}

function normalizeModelConfig(raw: unknown): ModelConfig {
  const parsed = raw && typeof raw === "object"
    ? raw as Partial<ModelConfig>
    : {};
  return {
    scout: normalizeAssignment(parsed.scout, DEFAULT_MODEL_CONFIG.scout),
    builder: normalizeAssignment(parsed.builder, DEFAULT_MODEL_CONFIG.builder),
    critic: normalizeAssignment(parsed.critic, DEFAULT_MODEL_CONFIG.critic),
    verifier: normalizeAssignment(parsed.verifier, DEFAULT_MODEL_CONFIG.verifier),
    integrator: normalizeAssignment(parsed.integrator, DEFAULT_MODEL_CONFIG.integrator),
    escalation: normalizeAssignment(parsed.escalation, DEFAULT_MODEL_CONFIG.escalation),
    coordinator: normalizeAssignment(parsed.coordinator, DEFAULT_MODEL_CONFIG.coordinator),
    builderTiers: normalizeBuilderTierConfig(parsed.builderTiers),
  };
}

function assignmentIdentity(assignment: ModelAssignment): string {
  return `${assignment.provider}/${assignment.model}`;
}

export interface BuilderTierResolution {
  readonly tier: ModelTier;
  readonly assignment: ModelAssignment;
  readonly identity: string;
  readonly source: "builderTiers" | "builder" | "escalation";
}

export function resolveBuilderModelForTier(
  config: ModelConfig,
  tier: ModelTier,
): BuilderTierResolution {
  const tierConfig = config.builderTiers ?? {};
  if (tierConfig[tier]) {
    const assignment = normalizeAssignment(
      tierConfig[tier],
      tier === "premium" ? config.escalation : config.builder,
    );
    return {
      tier,
      assignment,
      identity: assignmentIdentity(assignment),
      source: "builderTiers",
    };
  }

  if (tier === "premium") {
    const assignment = normalizeAssignment(config.escalation, DEFAULT_MODEL_CONFIG.escalation);
    return {
      tier,
      assignment,
      identity: assignmentIdentity(assignment),
      source: "escalation",
    };
  }

  const assignment = normalizeAssignment(config.builder, DEFAULT_MODEL_CONFIG.builder);
  return {
    tier,
    assignment,
    identity: assignmentIdentity(assignment),
    source: "builder",
  };
}

export function resolveAllBuilderTierModels(
  config: ModelConfig,
): Record<ModelTier, BuilderTierResolution> {
  return {
    fast: resolveBuilderModelForTier(config, "fast"),
    standard: resolveBuilderModelForTier(config, "standard"),
    premium: resolveBuilderModelForTier(config, "premium"),
  };
}

export function builderTierCollapseWarning(config: ModelConfig): string | null {
  const resolved = resolveAllBuilderTierModels(config);
  const identities = new Set(
    VALID_TIERS.map((tier) => resolved[tier].identity),
  );
  if (identities.size > 1) return null;
  const collapsed = resolved.fast.identity;
  return `Builder tier mapping collapses to one model (${collapsed}); capability floor cannot raise model strength until builderTiers or escalation are configured distinctly.`;
}

export function findNextStrongerBuilderTier(
  config: ModelConfig,
  currentTier: ModelTier,
): BuilderTierResolution | null {
  const order: readonly ModelTier[] = ["fast", "standard", "premium"];
  const current = resolveBuilderModelForTier(config, currentTier);
  const start = order.indexOf(currentTier);
  for (let index = start + 1; index < order.length; index += 1) {
    const candidate = resolveBuilderModelForTier(config, order[index]);
    if (candidate.identity !== current.identity) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve the full ordered fallback chain for the builder at a given
 * tier: primary first, then any declared `chain[]` entries in order,
 * deduped on `provider/model` identity. Single-entry configs (no
 * chain field) produce a 1-entry result — backwards compatible with
 * every existing model-config.json.
 *
 * Returned entries are plain `{provider, model, label?}` so callers
 * can hand them to invokeModelWithFallback as InvokeConfig templates.
 */
export interface BuilderChainResolution {
  readonly tier: ModelTier;
  readonly source: "builderTiers" | "builder" | "escalation";
  readonly primaryIdentity: string;
  /** Ordered chain — primary at index 0, then declared fallbacks. */
  readonly chain: readonly { provider: string; model: string; label?: string }[];
}

/**
 * Resolve the full invocation chain for a non-tier-aware ModelAssignment
 * (currently used by Critic; suitable for any worker whose role-level
 * assignment is a single ModelAssignment with optional `chain[]`). The
 * primary `{provider, model}` is always head; declared chain entries
 * follow in order, deduped by `provider/model` so a self-referencing
 * declaration can't cause an invocation loop.
 *
 * Returns an empty array when `assignment` is undefined — callers that
 * see [] should fall back to their constructor-level default rather
 * than treat it as "no fallback wanted."
 *
 * Mirrors `resolveBuilderChainForTier` (which is tier-aware and
 * builder-specific) so both surfaces produce the same shape for
 * consumers like `invokeModelWithFallback`.
 */
export function resolveAssignmentChain(
  assignment: ModelAssignment | undefined,
): readonly { provider: string; model: string; label?: string }[] {
  if (!assignment) return [];
  const chain: { provider: string; model: string; label?: string }[] = [];
  const seen = new Set<string>();
  const head: { provider: string; model: string; label?: string } = assignment.label
    ? { provider: assignment.provider, model: assignment.model, label: assignment.label }
    : { provider: assignment.provider, model: assignment.model };
  chain.push(head);
  seen.add(`${head.provider}/${head.model}`);
  for (const entry of assignment.chain ?? []) {
    const id = `${entry.provider}/${entry.model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push({ ...entry });
  }
  return chain;
}

export function resolveBuilderChainForTier(
  config: ModelConfig,
  tier: ModelTier,
): BuilderChainResolution {
  const single = resolveBuilderModelForTier(config, tier);
  const primary = single.assignment;
  const seen = new Set<string>();
  const chain: { provider: string; model: string; label?: string }[] = [];
  const head: { provider: string; model: string; label?: string } = primary.label
    ? { provider: primary.provider, model: primary.model, label: primary.label }
    : { provider: primary.provider, model: primary.model };
  chain.push(head);
  seen.add(`${head.provider}/${head.model}`);
  for (const entry of primary.chain ?? []) {
    const id = `${entry.provider}/${entry.model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push({ ...entry });
  }
  return {
    tier,
    source: single.source,
    primaryIdentity: single.identity,
    chain,
  };
}

/**
 * Hot-path roles for the no-Anthropic doctrine. Builder/critic/integrator
 * are the worker types that drive real edits + reviews + merges; if
 * they reach for Anthropic by default the cheap-build promise is gone.
 * Scout and Verifier are local; Coordinator is meta-orchestration;
 * Escalation is the explicit emergency tier and may opt to use a
 * stronger model — including Anthropic if the user explicitly enables
 * it via AEDIS_ALLOW_ANTHROPIC=1.
 */
const ANTHROPIC_HOT_PATH_ROLES = ["builder", "critic", "integrator"] as const;

export interface DoctrineViolation {
  readonly role: string;
  readonly tier?: ModelTier;
  readonly source: "primary" | "chain" | "builderTiers";
  readonly model: string;
  readonly index?: number;
}

/**
 * Inspect a ModelConfig for Anthropic providers in hot-path roles.
 * Returns one entry per violation. Respects AEDIS_ALLOW_ANTHROPIC=1
 * (no violations reported when set). Pure — does not warn or throw;
 * callers decide whether to log or block.
 */
export function checkAnthropicHotPathDoctrine(config: ModelConfig): DoctrineViolation[] {
  if (process.env.AEDIS_ALLOW_ANTHROPIC === "1") return [];
  const violations: DoctrineViolation[] = [];
  for (const role of ANTHROPIC_HOT_PATH_ROLES) {
    const assignment = config[role as keyof ModelConfig] as ModelAssignment | undefined;
    if (!assignment) continue;
    if (assignment.provider === "anthropic") {
      violations.push({ role, source: "primary", model: assignment.model });
    }
    (assignment.chain ?? []).forEach((entry, index) => {
      if (entry.provider === "anthropic") {
        violations.push({ role, source: "chain", model: entry.model, index });
      }
    });
  }
  // builderTiers hot-path check — each tier-level builder is also hot.
  for (const tier of VALID_TIERS) {
    const t = config.builderTiers?.[tier];
    if (!t) continue;
    if (t.provider === "anthropic") {
      violations.push({ role: "builder", tier, source: "builderTiers", model: t.model });
    }
    (t.chain ?? []).forEach((entry, index) => {
      if (entry.provider === "anthropic") {
        violations.push({ role: "builder", tier, source: "chain", model: entry.model, index });
      }
    });
  }
  return violations;
}

// ─── Persistence ─────────────────────────────────────────────────────

/** Canonical Aedis state directory. Always used for writes. */
function configDir(projectRoot: string): string {
  return join(projectRoot, ".aedis");
}

/** Legacy Zendorium state directory, read-only fallback during the rename. */
function legacyConfigDir(projectRoot: string): string {
  return join(projectRoot, ".zendorium");
}

function configPath(projectRoot: string): string {
  return join(configDir(projectRoot), "model-config.json");
}

function legacyConfigPath(projectRoot: string): string {
  return join(legacyConfigDir(projectRoot), "model-config.json");
}

// Track which project roots we've already warned about for doctrine
// violations. loadModelConfig is called many times per dispatch — we
// don't want to spam the log.
const doctrineWarnedRoots = new Set<string>();

/**
 * Per-role provenance for the assignment surfaced on GET /config/models.
 *
 *   "profile"  — the value comes from AEDIS_MODEL_PROFILE (currently
 *                local-smoke). The saved .aedis/model-config.json (if
 *                any) is *ignored* under this profile, so the UI must
 *                show the value as read-only.
 *   "saved"    — value came from .aedis/model-config.json (or the
 *                legacy .zendorium path). The operator's last save
 *                is in effect.
 *   "default"  — neither a profile override nor a saved file applies;
 *                the role uses DEFAULT_MODEL_CONFIG. Surfaced so the
 *                operator can tell "this is what Aedis ships with"
 *                apart from "this is what I configured."
 */
export type ModelAssignmentSource = "profile" | "saved" | "default";

export interface ModelConfigSourceMap {
  scout: ModelAssignmentSource;
  builder: ModelAssignmentSource;
  critic: ModelAssignmentSource;
  verifier: ModelAssignmentSource;
  integrator: ModelAssignmentSource;
  escalation: ModelAssignmentSource;
  coordinator: ModelAssignmentSource;
}

export interface ResolvedModelConfig {
  readonly config: ModelConfig;
  readonly profile: ModelProfile;
  readonly source: ModelConfigSourceMap;
  readonly configFilePresent: boolean;
}

/**
 * Resolve the active model config and tag each role with where its
 * value came from. Pure-ish — touches the filesystem to detect the
 * saved file, but never mutates anything. Returned shape is the
 * single source of truth the UI displays so the model selector and
 * worker cards stop disagreeing.
 *
 * SAFETY: missing cloud API keys do NOT silently rewrite a saved
 * `xiaomi/mimo-v2.5/openrouter` entry into a local fallback. The
 * server reports the truthful saved value; the UI shows it; the
 * worker would simply fail to dispatch if the key is genuinely
 * missing. This was the doctrine asked for in the bug report.
 */
export function resolveModelConfigForResponse(projectRoot: string): ResolvedModelConfig {
  const profile = getActiveModelProfile();
  if (profile === "local-smoke") {
    const config = getModelProfileConfig("local-smoke");
    return {
      config,
      profile,
      // Every role under local-smoke is forced by the env var, not by
      // the saved file. Mark uniformly as "profile" so the UI knows
      // to surface the lock icon + read-only state.
      source: {
        scout: "profile",
        builder: "profile",
        critic: "profile",
        verifier: "profile",
        integrator: "profile",
        escalation: "profile",
        coordinator: "profile",
      },
      configFilePresent: existsSync(configPath(projectRoot)) || existsSync(legacyConfigPath(projectRoot)),
    };
  }

  // Default profile: prefer saved file, fall back to defaults per-role.
  const canonical = configPath(projectRoot);
  const legacy = legacyConfigPath(projectRoot);
  let saved: Partial<ModelConfig> | null = null;
  let configFilePresent = false;
  for (const path of [canonical, legacy]) {
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        saved = JSON.parse(raw) as Partial<ModelConfig>;
        configFilePresent = true;
        break;
      }
    } catch {
      // Corrupt or unreadable — treat as no saved file.
    }
  }

  const config = loadModelConfig(projectRoot); // already merges + normalizes
  // Per-role source: "saved" when the saved file actually carried a
  // non-empty assignment for that role. Anything else falls back to
  // "default" — never silently to "profile" (only the env profile
  // does that).
  const source = (Object.keys(config) as Array<keyof ModelConfig>).reduce(
    (acc, role) => {
      if (role === "builderTiers") return acc;
      const savedRow = saved && (saved as Record<string, unknown>)[role];
      const hasSaved =
        !!savedRow &&
        typeof savedRow === "object" &&
        typeof (savedRow as Record<string, unknown>).model === "string" &&
        ((savedRow as Record<string, unknown>).model as string).trim().length > 0;
      acc[role as keyof ModelConfigSourceMap] = hasSaved ? "saved" : "default";
      return acc;
    },
    { scout: "default", builder: "default", critic: "default", verifier: "default", integrator: "default", escalation: "default", coordinator: "default" } as ModelConfigSourceMap,
  );
  return { config, profile, source, configFilePresent };
}

export function loadModelConfig(projectRoot: string): ModelConfig {
  const profile = getActiveModelProfile();
  if (profile === "local-smoke") {
    return getModelProfileConfig("local-smoke");
  }

  // Prefer the canonical .aedis/ path. Fall back to the legacy
  // .zendorium/ path so installs that were configured before the
  // rename still load their saved assignments. Writes always go to
  // the canonical path, so the legacy file stops being read the next
  // time the config is saved.
  const canonical = configPath(projectRoot);
  const legacy = legacyConfigPath(projectRoot);
  const pathsToTry = [canonical, legacy];

  let config: ModelConfig | null = null;
  for (const path of pathsToTry) {
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw);
        config = normalizeModelConfig(parsed);
        break;
      }
    } catch {
      // Corrupt file — try the next candidate, or fall through to defaults.
    }
  }
  if (!config) config = normalizeModelConfig(DEFAULT_MODEL_CONFIG);

  // No-Anthropic-in-hot-path doctrine — warn once per project root.
  // Configurable opt-out via AEDIS_ALLOW_ANTHROPIC=1; opt-out is
  // re-evaluated on each load so an env-var change takes effect
  // without a process restart (the warned-roots cache is keyed by
  // project root only, so once warned, always warned this process).
  if (!doctrineWarnedRoots.has(projectRoot)) {
    const violations = checkAnthropicHotPathDoctrine(config);
    if (violations.length > 0) {
      doctrineWarnedRoots.add(projectRoot);
      console.warn(
        `[model-config] DOCTRINE WARNING (${projectRoot}): Anthropic detected in hot-path role(s) — ` +
        `${violations.map((v) => `${v.role}${v.tier ? `:${v.tier}` : ""}/${v.source}=${v.model}`).join(", ")}. ` +
        `Aedis's economic pitch is sub-cent builds; route this role to ollama/MiniMax/GLM instead, ` +
        `or set AEDIS_ALLOW_ANTHROPIC=1 if you've explicitly chosen Anthropic for this build.`,
      );
    }
  }

  return config;
}

/**
 * Test-only escape hatch for the doctrine-warning cache. Tests that
 * exercise loadModelConfig with different configs need to clear the
 * cache between runs to assert warning behavior.
 */
export function _resetDoctrineWarningCache(): void {
  doctrineWarnedRoots.clear();
}

function saveModelConfig(projectRoot: string, config: ModelConfig): void {
  const dir = configDir(projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath(projectRoot), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function validateModelConfig(body: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null) {
    return { valid: false, errors: ["Body must be a JSON object"] };
  }

  const obj = body as Record<string, unknown>;

  for (const role of VALID_ROLES) {
    if (role in obj) {
      const entry = obj[role] as any;
      if (typeof entry !== "object" || entry === null) {
        errors.push(`${role} must be an object with { model, provider }`);
        continue;
      }
      if (typeof entry.model !== "string" || !entry.model.trim()) {
        errors.push(`${role}.model must be a non-empty string`);
      }
      if (typeof entry.provider !== "string" || !entry.provider.trim()) {
        errors.push(`${role}.provider must be a non-empty string`);
      }
    }
  }

  if ("builderTiers" in obj) {
    const tiers = obj.builderTiers as any;
    if (typeof tiers !== "object" || tiers === null) {
      errors.push("builderTiers must be an object with fast/standard/premium entries");
    } else {
      for (const tier of VALID_TIERS) {
        if (!(tier in tiers)) continue;
        const entry = tiers[tier];
        if (typeof entry !== "object" || entry === null) {
          errors.push(`builderTiers.${tier} must be an object with { model, provider }`);
          continue;
        }
        if (typeof entry.model !== "string" || !entry.model.trim()) {
          errors.push(`builderTiers.${tier}.model must be a non-empty string`);
        }
        if (typeof entry.provider !== "string" || !entry.provider.trim()) {
          errors.push(`builderTiers.${tier}.provider must be a non-empty string`);
        }
      }
      for (const key of Object.keys(tiers)) {
        if (!VALID_TIERS.includes(key as ModelTier)) {
          errors.push(`Unknown builder tier "${key}" — ignored`);
        }
      }
    }
  }

  // Warn about unknown keys but don't fail
  for (const key of Object.keys(obj)) {
    if (!VALID_ROLES.includes(key as any) && key !== "builderTiers") {
      errors.push(`Unknown role "${key}" — ignored`);
    }
  }

  return { valid: errors.filter((e) => !e.includes("ignored")).length === 0, errors };
}

// ─── Routes ──────────────────────────────────────────────────────────

export const configRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  /**
   * GET /config/lanes — Read-only lane / model profile snapshot.
   *
   * Joins the live `.aedis/lane-config.json`, the active model profile
   * (default vs local-smoke), and the lane-config file path into one
   * payload the UI can render in a "Lane Profile" panel without
   * making three round-trips.
   *
   * Read-only by design: lane assignments are configured via the
   * lane-config file and the env-var profile, not the HTTP API. The
   * response surfaces the config path so the operator knows where to
   * edit. The UI never offers a writable form for these fields.
   */
  fastify.get(
    "/lanes",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const projectRoot = ctx().config.projectRoot;
      const laneCfg = loadLaneConfigFromDisk(projectRoot);
      const profile = getActiveModelProfile();
      const localSmoke = profile === "local-smoke";
      // Determine "shadow active" — true when the lane mode declares a
      // shadow lane and the file actually carried a shadow assignment.
      const shadowActive = laneCfg.mode !== "primary_only" && Boolean(laneCfg.shadow);
      reply.send({
        profile,
        localSmokeActive: localSmoke,
        localSmokeModel: getLocalSmokeModel(),
        laneMode: laneCfg.mode,
        primary: { ...laneCfg.primary },
        shadow: laneCfg.shadow ? { ...laneCfg.shadow } : null,
        shadowActive,
        // Architectural invariant — kept here for the UI to display
        // alongside the lane assignments rather than buried elsewhere.
        shadowPromoteAllowed: false as const,
        configPath: join(projectRoot, ".aedis", "lane-config.json"),
        configEditable: false,
        configNote:
          "Model selection is configured through .aedis/lane-config.json " +
          "and the AEDIS_MODEL_PROFILE env var. This endpoint is read-only.",
        defaults: { ...DEFAULT_LANE_CONFIG },
      });
    },
  );

  /**
   * GET /config/models — Return current model assignments + provenance.
   *
   * Response shape:
   *   {
   *     models: ModelConfig,
   *     profile: "default" | "local-smoke",
   *     source: { <role>: "profile" | "saved" | "default" },
   *     config_file_present: boolean,
   *     config_path, roles, builder_tiers
   *   }
   *
   * The UI's model selector keys off `profile` and `source` so the
   * operator never sees a dropdown that disagrees with the actual
   * worker dispatch. See bug "model selection menu shows wrong
   * defaults" — the UI was guessing client-side and lost track of
   * the server's real values.
   */
  fastify.get(
    "/models",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const resolved = resolveModelConfigForResponse(ctx().config.projectRoot);
      reply.send({
        models: resolved.config,
        profile: resolved.profile,
        source: resolved.source,
        config_file_present: resolved.configFilePresent,
        config_path: configPath(ctx().config.projectRoot),
        roles: VALID_ROLES,
        builder_tiers: VALID_TIERS,
      });
    }
  );

  /**
   * POST /config/models — Update model assignments.
   * Accepts a partial or full ModelConfig. Missing roles keep their current values.
   */
  fastify.post<{ Body: Partial<ModelConfig> | { models: Partial<ModelConfig> } }>(
    "/models",
    async (request, reply: FastifyReply) => {
      // Accept both shapes: the UI posts `{ models: {...} }`, early
      // CLI callers posted the flat ModelConfig directly. Unwrap once
      // here so downstream merge/validate logic only sees the role map.
      const raw = request.body as any;
      const assignments: Record<string, unknown> =
        raw && typeof raw === "object" && raw.models && typeof raw.models === "object"
          ? raw.models
          : (raw ?? {});

      const { valid, errors } = validateModelConfig(assignments);

      if (!valid) {
        reply.code(400).send({
          error: "Validation failed",
          errors,
        });
        return;
      }

      const projectRoot = ctx().config.projectRoot;
      const current = loadModelConfig(projectRoot);

      // Merge incoming assignments with current config
      const updated: ModelConfig = {
        ...current,
        builderTiers: { ...(current.builderTiers ?? {}) },
      };
      for (const role of VALID_ROLES) {
        if (role in assignments) {
          (updated as any)[role] = (assignments as any)[role];
        }
      }
      if ("builderTiers" in assignments) {
        updated.builderTiers = {
          ...(current.builderTiers ?? {}),
          ...normalizeBuilderTierConfig((assignments as any).builderTiers),
        };
      }

      const normalized = normalizeModelConfig(updated);

      saveModelConfig(projectRoot, normalized);

      // Emit config change event
      ctx().eventBus.emit({
        type: "config_event",
        payload: {
          kind: "config_update",
          summary: "Model configuration updated",
          models: normalized,
        },
      });

      reply.send({
        models: normalized,
        updated_roles: [
          ...VALID_ROLES.filter((role) => role in assignments),
          ...("builderTiers" in assignments ? ["builderTiers"] : []),
        ],
        message: "Model configuration saved. Changes take effect on next run.",
        warnings: errors.filter((e) => e.includes("ignored")),
      });
    }
  );
};
