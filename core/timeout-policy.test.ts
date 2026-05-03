/**
 * Unit tests for the stage-timeout retry policy.
 *
 * Contracts pinned here — these are what the cost-control fix depends on:
 *
 *   1. Default policy NEVER retries a timed-out model in-place
 *      (maxSameModelRetriesAfterTimeout = 0, hardBlock for expensive=true).
 *   2. The decision engine prefers an untouched chain entry over any
 *      retry of a timed-out one — so a configured fallback wins.
 *   3. When all chain entries have timed out (or are blocked by
 *      the cost class), the engine returns `needs_operator_decision`
 *      with no entry — the task-loop pauses instead of looping.
 *   4. Operator override "Retry Same Model" only affects the FIRST
 *      chain entry, never silently retries a fallback.
 *   5. recordTimeout / clearTimeout are pure and increment / reset
 *      the consecutive counter correctly.
 *   6. The UI summary surfaces the right model + fallback target.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TIMEOUT_RETRY_POLICY,
  buildTimeoutRecoverySummary,
  clearTimeout,
  decideNextDispatch,
  recordTimeout,
  type ChainEntry,
  type TimedOutModelEntry,
} from "./timeout-policy.js";

const NOW = "2026-05-03T12:00:00.000Z";

const OPUS: ChainEntry = { provider: "anthropic", model: "claude-opus-4-7", costClass: "expensive" };
const SONNET: ChainEntry = { provider: "anthropic", model: "claude-sonnet-4-6", costClass: "standard" };
const KIMI: ChainEntry = { provider: "openrouter", model: "moonshotai/kimi-k2", costClass: "standard" };
const LOCAL: ChainEntry = { provider: "ollama", model: "qwen3.5:9b", costClass: "standard" };

test("default policy: empty timeout history → dispatch primary", () => {
  const r = decideNextDispatch({ stage: "critic", chain: [OPUS, SONNET], timedOutModels: [] });
  assert.equal(r.kind, "dispatch_entry");
  assert.deepEqual(r.entry, OPUS);
});

test("expensive primary timed out + standard fallback configured → dispatch fallback", () => {
  // The exact production scenario from the bug report: Opus Critic
  // times out, Aedis must NOT retry Opus and SHOULD pick Sonnet.
  const history: TimedOutModelEntry[] = [
    {
      stage: "critic",
      provider: "anthropic",
      model: "claude-opus-4-7",
      at: NOW,
      stageTimeoutMs: 180_000,
      consecutiveTimeouts: 1,
    },
  ];
  const r = decideNextDispatch({ stage: "critic", chain: [OPUS, SONNET], timedOutModels: history });
  assert.equal(r.kind, "dispatch_entry");
  assert.deepEqual(r.entry, SONNET);
  // The skipped log should explain the cost-class block.
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /expensive/i);
});

test("expensive primary timed out, no fallback → needs_operator_decision (NEVER retry blindly)", () => {
  // The exact cost-control hard fail — when the only chain member is
  // an expensive model and it timed out, we must pause for the
  // operator and not burn another 180 seconds + tokens.
  const history: TimedOutModelEntry[] = [
    {
      stage: "critic",
      provider: "anthropic",
      model: "claude-opus-4-7",
      at: NOW,
      stageTimeoutMs: 180_000,
      consecutiveTimeouts: 1,
    },
  ];
  const r = decideNextDispatch({ stage: "critic", chain: [OPUS], timedOutModels: history });
  assert.equal(r.kind, "needs_operator_decision");
  assert.equal(r.entry, null);
  assert.match(r.reason, /Operator must choose/);
});

test("operator override 'Retry Same Model' on primary forces dispatch even after timeout", () => {
  const history: TimedOutModelEntry[] = [
    {
      stage: "critic",
      provider: "anthropic",
      model: "claude-opus-4-7",
      at: NOW,
      stageTimeoutMs: 180_000,
      consecutiveTimeouts: 2,
    },
  ];
  const r = decideNextDispatch({
    stage: "critic",
    chain: [OPUS, SONNET],
    timedOutModels: history,
    operatorRetrySameModel: true,
  });
  assert.equal(r.kind, "dispatch_entry");
  assert.deepEqual(r.entry, OPUS);
  assert.match(r.reason, /Operator override/);
});

test("operator override is NOT applied to fallback entries", () => {
  // Override only affects index 0 of the chain. If the operator
  // clicked Retry Same Model AND the primary was Opus AND Opus
  // already timed out, only Opus is retried — Sonnet is not
  // forcibly selected; if Opus is somehow already past, the next
  // chain member follows the normal rule.
  const history: TimedOutModelEntry[] = [
    {
      stage: "critic",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      at: NOW,
      stageTimeoutMs: 180_000,
      consecutiveTimeouts: 1,
    },
  ];
  const r = decideNextDispatch({
    stage: "critic",
    chain: [OPUS, SONNET], // OPUS untouched — should be picked
    timedOutModels: history,
    operatorRetrySameModel: true,
  });
  // OPUS is dispatched because it has no timeout history; Sonnet's
  // override does NOT apply (override only handles entry 0).
  assert.deepEqual(r.entry, OPUS);
});

test("standard model with one timeout is also blocked by default policy (maxSameModelRetriesAfterTimeout=0)", () => {
  // Even a non-expensive entry must not retry by default — the
  // default is `0` because the cost-control bug reported is
  // generic. Operators that want auto-retry must set the policy
  // explicitly.
  const history: TimedOutModelEntry[] = [
    {
      stage: "critic",
      provider: "openrouter",
      model: "moonshotai/kimi-k2",
      at: NOW,
      stageTimeoutMs: 180_000,
      consecutiveTimeouts: 1,
    },
  ];
  const r = decideNextDispatch({
    stage: "critic",
    chain: [KIMI, LOCAL], // KIMI is timed-out, LOCAL is fresh
    timedOutModels: history,
  });
  assert.deepEqual(r.entry, LOCAL);
});

test("policy.maxSameModelRetriesAfterTimeout=2 allows two retries on a non-expensive entry", () => {
  const history: TimedOutModelEntry[] = [
    {
      stage: "critic",
      provider: "ollama",
      model: "qwen3.5:9b",
      at: NOW,
      stageTimeoutMs: 30_000,
      consecutiveTimeouts: 1,
    },
  ];
  const r = decideNextDispatch({
    stage: "critic",
    chain: [LOCAL],
    timedOutModels: history,
    policy: {
      maxSameModelRetriesAfterTimeout: 2,
      hardBlockExpensiveModelRetry: true,
      preferFallbackAfterTimeout: true,
    },
  });
  assert.equal(r.kind, "dispatch_entry");
  assert.deepEqual(r.entry, LOCAL);
});

test("expensive entry IS retried under explicit override even when hardBlock is on", () => {
  // The "Retry Same Model" UI button is a deliberate cost decision.
  // It must work even on expensive entries; the button label warns
  // the operator about cost.
  const history: TimedOutModelEntry[] = [
    {
      stage: "critic",
      provider: "anthropic",
      model: "claude-opus-4-7",
      at: NOW,
      stageTimeoutMs: 180_000,
      consecutiveTimeouts: 1,
    },
  ];
  const r = decideNextDispatch({
    stage: "critic",
    chain: [OPUS],
    timedOutModels: history,
    operatorRetrySameModel: true,
  });
  assert.equal(r.kind, "dispatch_entry");
  assert.deepEqual(r.entry, OPUS);
});

test("preferFallbackAfterTimeout=false makes the engine pause as soon as any chain entry times out", () => {
  const history: TimedOutModelEntry[] = [
    {
      stage: "critic",
      provider: "anthropic",
      model: "claude-opus-4-7",
      at: NOW,
      stageTimeoutMs: 180_000,
      consecutiveTimeouts: 1,
    },
  ];
  const r = decideNextDispatch({
    stage: "critic",
    chain: [OPUS, SONNET],
    timedOutModels: history,
    policy: {
      ...DEFAULT_TIMEOUT_RETRY_POLICY,
      preferFallbackAfterTimeout: false,
    },
  });
  // We never want a silent retry on expensive Opus, but with
  // preferFallback=false we don't walk to Sonnet either.
  assert.equal(r.kind, "needs_operator_decision");
});

test("recordTimeout: increments consecutive count on the same tuple", () => {
  let history: readonly TimedOutModelEntry[] = [];
  history = recordTimeout(history, {
    stage: "critic", provider: "x", model: "y", at: "t1", stageTimeoutMs: 1,
  });
  history = recordTimeout(history, {
    stage: "critic", provider: "x", model: "y", at: "t2", stageTimeoutMs: 2,
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].consecutiveTimeouts, 2);
  assert.equal(history[0].at, "t2");
  assert.equal(history[0].stageTimeoutMs, 2);
});

test("recordTimeout: distinct tuples keep separate counts", () => {
  let history: readonly TimedOutModelEntry[] = [];
  history = recordTimeout(history, { stage: "critic", provider: "a", model: "1", at: "t1", stageTimeoutMs: 1 });
  history = recordTimeout(history, { stage: "critic", provider: "b", model: "1", at: "t1", stageTimeoutMs: 1 });
  history = recordTimeout(history, { stage: "builder", provider: "a", model: "1", at: "t1", stageTimeoutMs: 1 });
  assert.equal(history.length, 3);
});

test("clearTimeout: removes the matching tuple", () => {
  const history: TimedOutModelEntry[] = [
    { stage: "critic", provider: "a", model: "1", at: "t", stageTimeoutMs: 1, consecutiveTimeouts: 1 },
    { stage: "critic", provider: "b", model: "1", at: "t", stageTimeoutMs: 1, consecutiveTimeouts: 1 },
  ];
  const after = clearTimeout(history, { stage: "critic", provider: "a", model: "1" });
  assert.equal(after.length, 1);
  assert.equal(after[0].provider, "b");
});

test("buildTimeoutRecoverySummary: surfaces the timed-out model and a real fallback target", () => {
  const summary = buildTimeoutRecoverySummary({
    stage: "critic",
    chain: [OPUS, SONNET],
    timedOutModels: [
      { stage: "critic", provider: "anthropic", model: "claude-opus-4-7", at: NOW, stageTimeoutMs: 180_000, consecutiveTimeouts: 1 },
    ],
  });
  assert.match(summary.headline, /Critic timed out on anthropic\/claude-opus-4-7/);
  assert.deepEqual(summary.timedOutModel, { provider: "anthropic", model: "claude-opus-4-7" });
  assert.equal(summary.fallbackAvailable, true);
  assert.deepEqual(summary.fallbackEntry, { provider: "anthropic", model: "claude-sonnet-4-6" });
  assert.equal(summary.lastTimeoutMs, 180_000);
});

test("buildTimeoutRecoverySummary: no fallback available when every chain entry already timed out", () => {
  const summary = buildTimeoutRecoverySummary({
    stage: "critic",
    chain: [OPUS],
    timedOutModels: [
      { stage: "critic", provider: "anthropic", model: "claude-opus-4-7", at: NOW, stageTimeoutMs: 180_000, consecutiveTimeouts: 1 },
    ],
  });
  assert.equal(summary.fallbackAvailable, false);
  assert.equal(summary.fallbackEntry, null);
});
