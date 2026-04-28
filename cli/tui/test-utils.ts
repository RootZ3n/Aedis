/**
 * Test utilities for ink-based TUI tests. Replaces the ad-hoc
 * `await wait(40)` pattern that was flaking under parallel-runner
 * load — 40ms is enough on an idle box but not enough when
 * `npx tsx --test` is parsing 30+ test files concurrently and
 * react/ink's render cycle gets crowded out.
 *
 * The helper polls `lastFrame()` against a predicate (string,
 * RegExp, or boolean function) and resolves as soon as the
 * predicate is satisfied. Default budget is 1 second — long
 * enough to absorb load spikes, short enough that a real failure
 * (the predicate will NEVER be satisfied) doesn't sit forever.
 */

export type FramePredicate =
  | string
  | RegExp
  | ((frame: string) => boolean);

export interface WaitForFrameOptions {
  /** Total budget before throwing. Default 1000ms. */
  readonly timeoutMs?: number;
  /** Poll interval. Default 5ms — fast enough that the success path is near-instant. */
  readonly pollMs?: number;
  /** Optional message included in the throw if the budget elapses. */
  readonly message?: string;
}

function frameMatches(frame: string, predicate: FramePredicate): boolean {
  if (typeof predicate === "string") return frame.includes(predicate);
  if (predicate instanceof RegExp) return predicate.test(frame);
  return predicate(frame);
}

/**
 * Resolve as soon as `lastFrame()` satisfies `predicate`. Throws
 * with the last-seen frame on the timeout path so the failure
 * message shows the actual render rather than a bare "timed out".
 *
 * Use this instead of `await wait(40)` whenever the assertion
 * depends on an async state load (api fetch, useEffect resolution,
 * polling tick) — the wait pattern races render time vs sleep
 * time, while this helper races render time vs the actual data
 * the test cares about.
 */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: FramePredicate,
  opts: WaitForFrameOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const pollMs = opts.pollMs ?? 5;
  const start = Date.now();
  let frame = lastFrame() ?? "";
  if (frameMatches(frame, predicate)) return frame;
  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    frame = lastFrame() ?? "";
    if (frameMatches(frame, predicate)) return frame;
  }
  const label = opts.message ?? "predicate";
  const printable = String(predicate);
  throw new Error(
    `waitForFrame: ${label} (${printable}) not satisfied within ${timeoutMs}ms.\n` +
    `Last frame:\n${frame}`,
  );
}
