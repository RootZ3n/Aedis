#!/usr/bin/env bash
# Debug trace for stress-01 and stress-09
# Run from /mnt/ai/aedis directory

set -x

node --eval "
import('./dist/cli/index.js').then(async (m) => {
  const { runReliabilityTask } = await import('./dist/core/reliability-harness.js');
  // Import manually since we need to instrument the coordinator
  console.log('Instrumentation placeholder — run manually via npx tsx');
}).catch(console.error);
" 2>&1 | head -5

echo "---"
echo "Checking coordinator logs for stress-01 submit path..."
# Look for submit entry logs
grep -n "submit() entry\|scope:\|charter produced no targets\|large scope detected\|PHASE 4 done\|PHASE 4 FAIL\|prepareDeliverablesForGraph" /mnt/ai/aedis/dist/core/coordinator.js 2>/dev/null | head -20 || echo "No compiled dist found — run from source"

echo "---"
echo "Key lines to instrument in coordinator.ts:"
echo "1. Line ~713: after classifyScope call — log blastRadius, type, recommendDecompose, files array"
echo "2. Line ~2222: before prepareDeliverablesForGraph — log deliverables.length and sample targetFiles"
echo "3. Line ~1322: after buildTaskGraph — log active.graph.nodes.length"
echo "4. Line ~1323: the early-exit bug trigger — log when nodes === 0"