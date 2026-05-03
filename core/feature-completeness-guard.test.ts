import test from "node:test";
import assert from "node:assert/strict";

import {
  detectFeatureUnderspecified,
  type FeatureCompletenessInputs,
} from "./feature-completeness-guard.js";

function fakeLister(map: Record<string, readonly string[]>) {
  return (dir: string) => map[dir] ?? [];
}

test("Magister-style scaffold with 1 target and existing siblings → underspecified", () => {
  const finding = detectFeatureUnderspecified({
    prompt: "Add a new conversational mode called Teach Me Anything to Magister",
    analysis: { category: "scaffold" },
    charterTargets: ["magister/router.ts"],
    listSiblings: fakeLister({
      "magister": ["magister/router.ts", "magister/modes", "magister/companions", "magister/sessions"],
      "magister/modes": ["magister/modes/varros-narrator.ts"],
      "magister/companions": ["magister/companions/balam.ts", "magister/companions/colette.ts"],
      "magister/sessions": ["magister/sessions/narrative-session.ts"],
    }),
  } as FeatureCompletenessInputs);

  assert.ok(finding, "guard must fire on Magister fixture");
  assert.equal(finding.anchorTarget, "magister/router.ts");
  assert.ok(
    finding.suggestedSiblings.includes("magister/modes/varros-narrator.ts"),
    "must surface the existing mode as a sibling so operator sees where the new mode goes",
  );
  assert.ok(
    finding.suggestedSiblings.some((p) => p.startsWith("magister/companions/")),
    "must surface companion files as candidates",
  );
  assert.ok(
    finding.suggestedSiblings.some((p) => p.startsWith("magister/sessions/")),
    "must surface session files as candidates",
  );
  // Bound the payload — no runaway listings.
  assert.ok(finding.suggestedSiblings.length <= 12);
});

test("non-scaffold category → guard does not fire", () => {
  const finding = detectFeatureUnderspecified({
    prompt: "Add a new conversational mode called Teach Me Anything",
    analysis: { category: "bugfix" },
    charterTargets: ["magister/router.ts"],
    listSiblings: fakeLister({ "magister": ["magister/router.ts", "magister/modes"] }),
  });
  assert.equal(finding, null);
});

test("multi-target charter → guard does not fire (operator already specified scope)", () => {
  const finding = detectFeatureUnderspecified({
    prompt: "Add a new mode called Teach Me Anything",
    analysis: { category: "scaffold" },
    charterTargets: ["magister/router.ts", "magister/modes/teach-me-anything.ts"],
    listSiblings: fakeLister({}),
  });
  assert.equal(finding, null);
});

test("scaffold with no new-X-feature wording → guard does not fire", () => {
  const finding = detectFeatureUnderspecified({
    prompt: "Update logging to use structured JSON",
    analysis: { category: "scaffold" },
    charterTargets: ["app/logger.ts"],
    listSiblings: fakeLister({ "app": ["app/logger.ts", "app/server.ts"] }),
  });
  assert.equal(finding, null);
});

test("scaffold with 1 target but no siblings on disk → guard returns null (nothing actionable)", () => {
  // Without sibling files, suggesting "attach more files" is empty
  // advice — we let the run proceed and let downstream layers
  // handle a Builder failure if it happens.
  const finding = detectFeatureUnderspecified({
    prompt: "Add a new mode for X",
    analysis: { category: "scaffold" },
    charterTargets: ["solo-file.ts"],
    listSiblings: fakeLister({}),
  });
  assert.equal(finding, null);
});

test("only test files as siblings → still considered underspecified (operator can pick)", () => {
  const finding = detectFeatureUnderspecified({
    prompt: "Add a new feature for streaming responses",
    analysis: { category: "scaffold" },
    charterTargets: ["src/streaming.ts"],
    listSiblings: fakeLister({
      "src": ["src/streaming.ts", "src/streaming.test.ts", "src/index.ts"],
    }),
  });
  assert.ok(finding);
  // Both peers in the same directory.
  assert.ok(finding!.suggestedSiblings.includes("src/streaming.test.ts"));
  assert.ok(finding!.suggestedSiblings.includes("src/index.ts"));
});

test("payload caps at 12 to keep events bounded", () => {
  const big = Array.from({ length: 30 }, (_, i) => `pkg/sibling-${i}.ts`);
  const finding = detectFeatureUnderspecified({
    prompt: "Add a new mode handler",
    analysis: { category: "scaffold" },
    charterTargets: ["pkg/router.ts"],
    listSiblings: fakeLister({ "pkg": ["pkg/router.ts", ...big] }),
  });
  assert.ok(finding);
  assert.ok(finding!.suggestedSiblings.length <= 12);
});
