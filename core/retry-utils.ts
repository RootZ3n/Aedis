/**
 * Retry utilities for transient I/O failures.
 *
 * Used by workers when performing file system or git operations that may
 * fail transiently (ETIMEDOUT, ENETUNREACH, ECONNRESET, EBUSY, EAGAIN).
 *
 * Unlike model-invoker retries (provider-level, handled by invokeModelWithFallback),
 * these utilities cover file I/O, git execFile calls, and external tool
 * invocations where the underlying operation may succeed on retry.
 */

/**
 * Retry an asynchronous operation with exponential backoff.
 *
 * @param fn - The async operation to retry.
 * @param options.maxAttempts - Maximum number of attempts (default: 3).
 * @param options.initialDelayMs - Initial delay before first retry (default: 100ms).
 * @param options.maxDelayMs - Maximum delay cap (default: 2000ms).
 * @param options.retryableErrors - Error codes/message patterns to retry on.
 *   Omit to retry all errors (conservative — better to overshoot than miss a real retryable).
 * @param options.onRetry - Called before each retry with attempt number and error.
 * @returns The result of fn on success.
 * @throws The last error if all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    retryableErrors?: readonly string[];
    onRetry?: (attempt: number, err: unknown, nextDelayMs: number) => void;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 2000,
    retryableErrors,
    onRetry,
  } = options;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Last attempt — don't retry, let the error propagate
      if (attempt === maxAttempts) break;

      // If we have an allow-list of retryable errors, check against it.
      // If not, retry everything (conservative).
      if (retryableErrors && retryableErrors.length > 0) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as NodeJS.ErrnoException).code;
        const isRetryable =
          retryableErrors.some((pattern) => {
            // Match by error code (e.g. "ETIMEDOUT", "ENETUNREACH")
            if (code === pattern) return true;
            // Match by substring in message
            if (msg.includes(pattern)) return true;
            return false;
          });
        if (!isRetryable) {
          // Non-retryable error — break immediately and propagate
          break;
        }
      }

      // Compute exponential backoff with jitter
      const baseDelay = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = Math.random() * 0.3 * baseDelay;
      const delay = Math.floor(baseDelay + jitter);

      onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error codes that represent transient/retryable failures. */
export const TRANSIENT_ERROR_CODES = [
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "EAI_AGAIN",       // DNS lookup transient failure
  "EBUSY",           // Resource busy — try again
  "EAGAIN",          // Resource temporarily unavailable
  "ENOENT",          // Not always transient, but can be on NFS/network fs
] as const;

/**
 * Retryable version of Node's execFile that retries on transient errors.
 *
 * @param file - The executable to run.
 * @param args - Arguments to pass.
 * @param options - execFile options.
 * @param retryOptions - Retry configuration.
 */
export async function execFileWithRetry(
  file: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  },
  retryOptions?: Parameters<typeof withRetry>[1],
): Promise<{ stdout: string; stderr: string }> {
  return withRetry(
    () => {
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const { execFile } = require("node:child_process");
        execFile(file, args, options ?? {}, (err: unknown, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });
    },
    {
      maxAttempts: 3,
      initialDelayMs: 200,
      maxDelayMs: 2000,
      retryableErrors: [...TRANSIENT_ERROR_CODES, "Signal 15", "SIGTERM"],
      ...retryOptions,
    },
  );
}