/**
 * Validator — run the full planning pipeline (charter → scope → plan →
 * implementation brief) against a real repo, without dispatching any
 * workers or hitting any model. Produces a machine-readable summary of
 * the brief so we can verify in Phase 9 that selected files, rejected
 * candidates, stages, non-goals, verification hints, and capability
 * floor all land correctly when driven by a real path.
 *
 * Usage:
 *   npx tsx scripts/validate-brief-against-repo.ts <projectRoot> "<prompt>"
 *
 * Example:
 *   npx tsx scripts/validate-brief-against-repo.ts /path/to/repo "improve provider error handling in apps/api/src"
 */

import { randomUUID } from "crypto";
import { CharterGenerator } from "../core/charter.js";
import { classifyScope } from "../core/scope-classifier.js";
import { createChangeSet } from "../core/change-set.js";
import { planChangeSet } from "../core/multi-file-planner.js";
import { createIntent } from "../core/intent.js";
import {
  buildImplementationBrief,
  capabilityFloorForBrief,
  formatBriefForBuilder,
  briefToReceiptJson,
} from "../core/implementation-brief.js";

async function main() {
  const [, , projectRoot, ...rest] = process.argv;
  const prompt = rest.join(" ").trim();

  if (!projectRoot || !prompt) {
    console.error("usage: tsx scripts/validate-brief-against-repo.ts <projectRoot> \"<prompt>\"");
    process.exit(1);
  }

  console.log(`\n=== Implementation Brief Validator ===`);
  console.log(`Repo   : ${projectRoot}`);
  console.log(`Prompt : ${prompt}\n`);

  const charterGen = new CharterGenerator();
  const analysis = charterGen.analyzeRequest(prompt);
  console.log(`[charter] category=${analysis.category} scope=${analysis.scopeEstimate} targets=${JSON.stringify(analysis.targets)} risks=${JSON.stringify(analysis.riskSignals)} ambiguities=${JSON.stringify(analysis.ambiguities)}`);

  const charter = charterGen.generateCharter(analysis);
  const charterTargets = Array.from(new Set(charter.deliverables.flatMap((d) => [...d.targetFiles])));
  const scope = classifyScope(prompt, charterTargets);
  console.log(`[scope]   type=${scope.type} blastRadius=${scope.blastRadius} decompose=${scope.recommendDecompose}`);

  const intent = createIntent({
    runId: randomUUID(),
    userRequest: prompt,
    charter,
    constraints: charterGen.generateDefaultConstraints(analysis),
  });
  const changeSet = createChangeSet(intent, charterTargets, undefined, projectRoot);
  const plan = scope.type === "multi-file" || scope.type === "architectural" || scope.governance.wavesRequired
    ? planChangeSet(changeSet, prompt)
    : undefined;
  if (plan) {
    console.log(`[plan]    waves=${plan.waves.length} files=${plan.changeSet.length}`);
  } else {
    console.log(`[plan]    skipped (scope=${scope.type} — no plan)`);
  }

  const brief = buildImplementationBrief({
    intent,
    analysis,
    charter,
    scope,
    changeSet,
    plan,
    rawUserPrompt: prompt,
    normalizedPrompt: prompt,
    dispatchableFiles: charterTargets,
  });

  const floor = capabilityFloorForBrief(brief);

  console.log("\n--- Brief summary ---");
  console.log(`taskType           : ${brief.taskType}`);
  console.log(`scope              : ${brief.scope}`);
  console.log(`scopeType          : ${brief.scopeType}`);
  console.log(`riskLevel          : ${brief.riskLevel}`);
  console.log(`riskFactors        : ${JSON.stringify(brief.riskFactors)}`);
  console.log(`selectedFiles (${brief.selectedFiles.length}):`);
  for (const f of brief.selectedFiles) {
    console.log(`  - ${f.path} [${f.role}${f.waveId != null ? `, wave=${f.waveId}` : ""}] — ${f.rationale}`);
  }
  console.log(`stages (${brief.stages.length}):`);
  for (const s of brief.stages) {
    console.log(`  ${s.id}. ${s.name} — ${s.files.length} file(s)${s.dependsOn.length ? ` (depends on ${s.dependsOn.join(", ")})` : ""}`);
  }
  console.log(`nonGoals           : ${brief.nonGoals.length} entries`);
  console.log(`verification       : ${brief.verificationCommands.join(" ; ")}`);
  console.log(`fallbackPlan       : ${brief.fallbackPlan}`);
  console.log(`needsClarification : ${brief.needsClarification}`);
  console.log(`openQuestions      : ${JSON.stringify(brief.openQuestions)}`);
  console.log(`capabilityFloor    : ${floor.floor} (${floor.reason})`);

  // Also format for builder consumption to prove it renders under the prompt budget.
  const builderBlock = formatBriefForBuilder(brief);
  console.log(`\n--- Builder block (${builderBlock.length} chars) ---`);
  console.log(builderBlock);

  // Emit the receipt-ready JSON too, to verify it round-trips.
  const receiptJson = briefToReceiptJson(brief);
  const serialized = JSON.stringify(receiptJson);
  console.log(`\n--- Receipt JSON size: ${serialized.length} bytes ---`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
