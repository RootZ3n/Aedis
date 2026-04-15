/**
 * OpenRouterClient — Typed connection wrapper for OpenRouter.
 *
 * Mirrors the Crucibulum client pattern: small, typed, failure-contained.
 * The checkHealth() helper pings OpenRouter's /api/v1/auth/key endpoint
 * so the UI can show whether the configured API key actually works,
 * without the user having to launch a run to find out.
 *
 * Intentionally NOT a catalog client: the user curates which OpenRouter
 * models are registered in Aedis via .aedis/providers.json. No live
 * model-list fetch.
 *
 * Env:
 *   OPENROUTER_API_KEY — required for authenticated calls. The health
 *                        check returns keyPresent=false when unset,
 *                        rather than raising.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const HEALTH_TIMEOUT_MS = 5_000;

export interface OpenRouterHealth {
  /** True if OpenRouter responded and the key authenticated. */
  readonly ok: boolean;
  /** True if OPENROUTER_API_KEY is set in the environment. */
  readonly keyPresent: boolean;
  /** Human-readable reason string. Stable enough for UI display. */
  readonly reason: string;
  /** Remaining credit in dollars, when reported by OpenRouter. */
  readonly creditRemaining?: number;
  /** The rate-limit bucket OpenRouter assigned this key. */
  readonly rateLimit?: {
    readonly requests: number;
    readonly interval: string;
  };
}

interface OpenRouterAuthKeyResponse {
  readonly data?: {
    readonly label?: string;
    readonly usage?: number;
    readonly limit?: number | null;
    readonly is_free_tier?: boolean;
    readonly rate_limit?: { readonly requests: number; readonly interval: string };
  };
}

export async function checkOpenRouterHealth(): Promise<OpenRouterHealth> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key.length === 0) {
    return { ok: false, keyPresent: false, reason: "OPENROUTER_API_KEY not set" };
  }

  try {
    const response = await fetch(`${OPENROUTER_BASE}/auth/key`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, keyPresent: true, reason: `OpenRouter rejected key (HTTP ${response.status})` };
    }
    if (!response.ok) {
      return { ok: false, keyPresent: true, reason: `OpenRouter returned HTTP ${response.status}` };
    }

    const body = (await response.json()) as OpenRouterAuthKeyResponse;
    const usage = body.data?.usage ?? 0;
    const limit = body.data?.limit;
    const creditRemaining =
      typeof limit === "number" ? Math.max(0, limit - usage) : undefined;

    return {
      ok: true,
      keyPresent: true,
      reason: "Connected",
      ...(creditRemaining !== undefined ? { creditRemaining } : {}),
      ...(body.data?.rate_limit ? { rateLimit: body.data.rate_limit } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, keyPresent: true, reason: `OpenRouter unreachable: ${message}` };
  }
}
