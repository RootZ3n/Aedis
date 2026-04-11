# Aedis Memory Integration

This phase connects Aedis to the shared lab memory substrate so project history survives across runs and can influence future execution without dumping large context blocks into prompts.

## What Aedis writes

Aedis now writes durable entries for:

- `aedis/project/<repo-id>`
  - task intent
  - normalized prompt
  - scope classification
  - change summary
  - follow-up suggestions
- `aedis/runs`
  - per-run execution summary
  - verification and merge outcome
  - repo/file provenance
- `aedis/failures`
  - failed run patterns
  - merge blockers
  - regression indicators
  - repair-pass fallout
- `aedis/success`
  - successful patterns
  - safe scoped approaches
- `aedis/files`
  - file-level touch history
  - cluster peers
  - file-scoped outcome lineage

Entries preserve repo id, file paths, evidence refs, relationships, tags, and readable raw JSON.

## Retrieval

Before execution, the coordinator asks the adapter for a narrow memory-backed context using:

- repo id
- current prompt
- classified scope
- target files
- file-cluster peers from `.aedis/memory.json`
- risky nearby files from `.aedis/repo-index.json` when available

Retrieval is limited to:

- the same repo
- the same files or cluster peers
- Aedis run/project/failure/success/file spaces
- a small max-entry / max-char budget

The adapter returns:

- relevant files
- recent task summaries
- landmine warnings
- prior successful approaches
- concise memory notes
- follow-up suggestions

## Context gating

The existing `GatedContext` stays small. Memory adds only high-signal fields:

- `clusterFiles`
- `landmines`
- `safeApproaches`
- `memoryNotes`
- `suggestedNextSteps`
- `strictVerification`

The scout uses those signals to widen inspection only around related files, raise risk, and mention known safe/unsafe patterns. Multi-file wave gating inherits the same memory warnings without exposing broad repo history.

## Clusters and landmines

Cluster awareness comes from:

- `.aedis/memory.json` file clusters
- `.aedis/repo-index.json` risky nearby files

Landmines are surfaced when:

- the same file has repeated prior failures
- a touched file has high blast radius or complexity in the repo index
- the current scope overlaps fragile cluster peers

Those warnings currently influence:

- pre-run context
- scout risk assessment
- builder escalation boundaries
- follow-up suggestions

## Integration points

- `core/aedis-memory.ts`
  - adapter, mapping, retrieval, cluster expansion, landmine detection
- `core/coordinator.ts`
  - pre-run retrieval
  - memory-backed gated context
  - post-run persistence
- `core/context-gate.ts`
  - mergeable memory-aware gated context
- `workers/scout.ts`
  - landmine/safe-pattern aware risk and approach synthesis
- `core/project-memory.ts`
  - richer local task summaries preserved in `.aedis/memory.json`

## Runtime dependency

Aedis loads the shared substrate dynamically from Squidley core via:

- `AEDIS_LAB_MEMORY_MODULE`
- default: `/mnt/ai/squidley-v2/core/dist/memory/index.js`

If the module is unavailable, Aedis keeps running and falls back to its local `.aedis/memory.json` behavior.
