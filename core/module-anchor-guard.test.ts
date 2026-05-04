import test from "node:test";
import assert from "node:assert/strict";

import {
  detectModuleAnchorMismatch,
  type ModuleAnchorInputs,
} from "./module-anchor-guard.js";

function fakeLister(map: Record<string, readonly string[]>) {
  return (dir: string) => map[dir] ?? [];
}

test("anchor named in prompt + every target outside it → guard fires", () => {
  // listChildren returns repo-relative paths (matching the real
  // Coordinator.listRepoChildren contract: full paths like
  // "magister/router.ts", not bare "router.ts").
  const finding = detectModuleAnchorMismatch({
    prompt: "Add the first atomic step for a new Teach Me Anything mode in Magister project",
    analysis: { category: "feature" },
    charterTargets: [
      "web/app/components/MarkdownMessage.tsx",
      "web/api/proxy/route.ts",
    ],
    listChildren: fakeLister({
      "": ["magister", "web", "package.json", "README.md"],
      "magister": ["magister/router.ts", "magister/modes", "magister/companions"],
      "magister/modes": ["magister/modes/narrator.ts", "magister/modes/tutor.ts"],
      "magister/companions": ["magister/companions/balam.ts"],
    }),
  } as ModuleAnchorInputs);

  assert.ok(finding, "guard must fire on web/-only targets when prompt names magister");
  assert.equal(finding.anchorName, "Magister");
  assert.equal(finding.anchorDirectory, "magister");
  assert.deepEqual(
    [...finding.violatingTargets].sort(),
    ["web/api/proxy/route.ts", "web/app/components/MarkdownMessage.tsx"],
  );
  assert.ok(
    finding.suggestedTargets.includes("magister/router.ts"),
    "must surface code files at the anchor root as suggestions",
  );
  assert.ok(
    finding.suggestedTargets.some((p) => p === "magister/modes/narrator.ts" || p === "magister/modes/tutor.ts"),
    "must surface code files one level below the anchor as suggestions",
  );
});

test("at least one target inside anchor → guard does not fire (mixed dispatch is fine)", () => {
  const finding = detectModuleAnchorMismatch({
    prompt: "Add a new mode in Magister project",
    analysis: { category: "feature" },
    charterTargets: ["magister/router.ts", "web/app/components/Foo.tsx"],
    listChildren: fakeLister({
      "": ["magister", "web"],
      "magister": ["magister/router.ts"],
    }),
  });
  assert.equal(finding, null);
});

test("anchor name not present as top-level directory → guard does not fire", () => {
  // "in Squidley project" but no `squidley/` dir exists — guard
  // cannot anchor, so it must let the run proceed.
  const finding = detectModuleAnchorMismatch({
    prompt: "Refactor logging in Squidley project",
    analysis: { category: "refactor" },
    charterTargets: ["app/logger.ts"],
    listChildren: fakeLister({
      "": ["app", "core"],
      "app": ["logger.ts"],
    }),
  });
  assert.equal(finding, null);
});

test("prompt has no anchor noun → guard does not fire", () => {
  const finding = detectModuleAnchorMismatch({
    prompt: "Update the logger to use JSON output",
    analysis: { category: "refactor" },
    charterTargets: ["web/app/logger.ts"],
    listChildren: fakeLister({
      "": ["web", "magister"],
      "magister": ["router.ts"],
    }),
  });
  assert.equal(finding, null);
});

test("blocklisted anchor names (\"the\", \"new\", \"main\") → guard does not fire", () => {
  const finding = detectModuleAnchorMismatch({
    // "the new project" — "new" is blocklisted; "the" too. No real anchor.
    prompt: "Set up the new project structure for foo",
    analysis: { category: "scaffold" },
    charterTargets: ["src/foo.ts"],
    listChildren: fakeLister({
      "": ["src", "new"],
      "new": ["index.ts"],
    }),
  });
  assert.equal(finding, null);
});

test("zero charter targets → guard does not fire (no-targets path handles this)", () => {
  const finding = detectModuleAnchorMismatch({
    prompt: "Add a new mode in Magister project",
    analysis: { category: "feature" },
    charterTargets: [],
    listChildren: fakeLister({ "": ["magister"] }),
  });
  assert.equal(finding, null);
});

test("anchor matched case-insensitively against directory name", () => {
  const finding = detectModuleAnchorMismatch({
    prompt: "Add an endpoint in MAGISTER project",
    analysis: { category: "feature" },
    charterTargets: ["server/index.ts"],
    listChildren: fakeLister({
      "": ["magister", "server"],
      "magister": ["magister/router.ts"],
    }),
  });
  assert.ok(finding, "case mismatch must not defeat the guard");
  assert.equal(finding.anchorDirectory, "magister");
});

test("multiple anchor candidates — only the one matching a real directory wins", () => {
  // "in foo module … in magister project" — both noun phrases. Only
  // magister/ exists on disk, so that is the operative anchor.
  const finding = detectModuleAnchorMismatch({
    prompt: "Plumb a stat in foo module and also in magister project",
    analysis: { category: "feature" },
    charterTargets: ["web/app/foo.tsx"],
    listChildren: fakeLister({
      "": ["web", "magister"],
      "magister": ["magister/router.ts"],
    }),
  });
  assert.ok(finding, "must anchor on magister even if foo appears earlier");
  assert.equal(finding.anchorDirectory, "magister");
});

test("investigation category → guard does not fire (read-only intent)", () => {
  const finding = detectModuleAnchorMismatch({
    prompt: "Investigate why builds are slow in magister project",
    analysis: { category: "investigation" },
    charterTargets: ["docs/perf.md"],
    listChildren: fakeLister({
      "": ["magister", "docs"],
      "magister": ["router.ts"],
    }),
  });
  assert.equal(finding, null);
});
