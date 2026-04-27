/**
 * Lane builder factory — produces a transient BuilderWorker pinned
 * to a single (provider, model). Used by Phase D lane dispatch so
 * the shadow lane can run on a different model than the primary
 * without:
 *
 *   - mutating WorkerRegistry (other concurrent runs keep using the
 *     registered default Builder),
 *   - editing `.aedis/model-config.json` (no on-disk side effects),
 *   - leaking state across runs (each call returns a fresh instance,
 *     run-context cache is empty, no shared event bus by default).
 *
 * SAFETY:
 *   - This factory ONLY constructs a Builder. The caller is
 *     responsible for routing the resulting candidate through
 *     runShadowBuilder, which preserves the "shadow-never-promotes"
 *     invariant via the workspace-role guard in promoteToSource.
 *   - Unknown providers (not in the Provider union from
 *     core/model-invoker.ts) return null. The caller falls back to
 *     the registry default and logs the gap so a typo in
 *     `.aedis/lane-config.json` doesn't crash the lane silently.
 */

import { BuilderWorker } from "../workers/builder.js";
import type { Provider } from "./model-invoker.js";
import type { EventBus } from "../server/websocket.js";
import type { RunState } from "./runstate.js";

/**
 * Provider strings the Builder can actually dispatch. Mirrors the
 * `Provider` union in core/model-invoker.ts. Kept in sync manually
 * — TypeScript will complain at the cast site if the union ever
 * adds a value the set forgets.
 */
const SUPPORTED_PROVIDERS: ReadonlySet<Provider> = new Set([
  "ollama",
  "modelstudio",
  "openrouter",
  "anthropic",
  "openai",
  "minimax",
  "zai",
  "glm-5.1-openrouter",
  "glm-5.1-direct",
  "portum",
  "local",
] as const);

export function isSupportedProvider(p: string): p is Provider {
  return SUPPORTED_PROVIDERS.has(p as Provider);
}

export interface CreateBuilderForLaneInput {
  /** Effective project root for the lane builder (typically active.projectRoot). */
  readonly projectRoot: string;
  /** Provider string from lane-config — validated against the Provider union. */
  readonly provider: string;
  /** Model id from lane-config — must be non-empty. */
  readonly model: string;
  /** Optional pass-through. The factory does not require these to construct. */
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
}

/**
 * Produce a transient BuilderWorker pinned to (provider, model), or
 * null when the inputs are unusable. Returning null instead of
 * throwing keeps `maybeRunFallbackShadow` resilient — a misconfigured
 * lane falls back to the registered default Builder rather than
 * crashing the run.
 */
export function createBuilderForLane(
  input: CreateBuilderForLaneInput,
): BuilderWorker | null {
  if (!input.projectRoot || input.projectRoot.trim().length === 0) return null;
  if (!isSupportedProvider(input.provider)) return null;
  if (typeof input.model !== "string" || input.model.trim().length === 0) return null;

  return new BuilderWorker({
    projectRoot: input.projectRoot,
    ...(input.eventBus ? { eventBus: input.eventBus } : {}),
    ...(input.runState ? { runState: input.runState } : {}),
    pinnedModel: { provider: input.provider, model: input.model.trim() },
    // Disable the default Anthropic fallback for lane builders. A
    // pinned shadow that silently ran on the legacy fallback would
    // (a) violate the "no-Anthropic-hot-path" doctrine and (b) make
    // the candidate manifest's lane attribution lie about which
    // model produced the change.
    fallbackModel: null,
  });
}
