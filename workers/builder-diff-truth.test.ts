import test from "node:test";
import assert from "node:assert/strict";

import { validateUnifiedDiff } from "../core/diff-truth.js";
import { detectNoOpUpdate } from "../core/no-op-detection.js";
import { BuilderWorker } from "./builder.js";

test("builder full-file identical output normalizes to NO_OP and non-approvable diff", () => {
  const builder = new BuilderWorker({ projectRoot: process.cwd() }) as unknown as {
    processModelResponse(raw: string, path: string, original: string, sectionMode: boolean): { updatedContent: string; diff: string };
  };
  const original = "export const message = \"hello\";\n";
  const processed = builder.processModelResponse(original, "src/message.ts", original, false);

  assert.equal(detectNoOpUpdate(original, processed.updatedContent).noOp, true);
  assert.equal(validateUnifiedDiff(processed.diff).ok, false);
});

test("builder full-file modified output produces a renderable real patch", () => {
  const builder = new BuilderWorker({ projectRoot: process.cwd() }) as unknown as {
    processModelResponse(raw: string, path: string, original: string, sectionMode: boolean): { updatedContent: string; diff: string };
  };
  const original = "export const message = \"hello\";\n";
  const updated = "export const message = \"hello from aedis\";\n";
  const processed = builder.processModelResponse(updated, "src/message.ts", original, false);
  const truth = validateUnifiedDiff(processed.diff);

  assert.equal(processed.updatedContent, updated);
  assert.equal(truth.ok, true, truth.reason);
  assert.match(processed.diff, /^diff --git a\/src\/message\.ts b\/src\/message\.ts/m);
});
