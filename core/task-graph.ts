/**
 * TaskGraph — Ordered task DAG with dependency edges, merge groups,
 * verification checkpoints, and escalation boundaries.
 *
 * The Coordinator decomposes a Charter into tasks. The TaskGraph
 * structures those tasks into a directed acyclic graph that enforces:
 *   - Dependency ordering (Scout before Builder, Builder before Critic)
 *   - Merge groups (tasks that must be integrated together)
 *   - Verification checkpoints (gates where all prior work is validated)
 *   - Escalation boundaries (complexity thresholds that trigger tier upgrades)
 *
 * The graph is the Coordinator's execution plan. Workers don't see it —
 * they see their assignment. The graph ensures assignments arrive in
 * the right order with the right upstream results.
 */

import { randomUUID } from "crypto";
import type { WorkerType, WorkerTier } from "../workers/base.js";

// ─── Node Types ──────────────────────────────────────────────────────

export interface TaskNode {
  readonly id: string;
  /** Human-readable label for logs and UI */
  readonly label: string;
  /** Which worker type executes this node */
  readonly workerType: WorkerType;
  /** Target files this node operates on */
  readonly targetFiles: readonly string[];
  /** Metadata the Coordinator attaches for routing context */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Current execution status */
  status: TaskNodeStatus;
  /** Assigned tier after routing (null until routed) */
  assignedTier: WorkerTier | null;
  /** RunState task ID once the node is materialized into a RunTask */
  runTaskId: string | null;
}

export type TaskNodeStatus =
  | "planned"     // In the graph but not yet ready
  | "ready"       // All dependencies satisfied, can be dispatched
  | "dispatched"  // Sent to a worker
  | "completed"   // Worker returned success
  | "failed"      // Worker returned failure
  | "skipped"     // Bypassed (e.g., no tests to run)
  | "blocked";    // Dependency failed, cannot proceed

// ─── Edge Types ──────────────────────────────────────────────────────

export interface DependencyEdge {
  /** Source node — must complete before target can start */
  readonly from: string;
  /** Target node — depends on source */
  readonly to: string;
  /** Edge type determines how failure propagates */
  readonly type: EdgeType;
}

export type EdgeType =
  | "hard"      // Target cannot start if source fails
  | "soft"      // Target can start even if source fails (with degraded context)
  | "data"      // Target needs source's output as input
  | "ordering"; // Sequencing only, no data dependency

// ─── Merge Groups ────────────────────────────────────────────────────

/**
 * A MergeGroup is a set of tasks whose outputs must be integrated
 * together in a single Integrator pass. This prevents partial applies
 * and ensures cross-file coherence within related changes.
 */
export interface MergeGroup {
  readonly id: string;
  readonly label: string;
  /** Node IDs that belong to this group */
  readonly nodeIds: readonly string[];
  /** The Integrator node that merges this group's outputs */
  readonly integratorNodeId: string;
}

// ─── Verification Checkpoints ────────────────────────────────────────

/**
 * A VerificationCheckpoint is a gate in the graph where all upstream
 * work must pass validation before downstream work begins. Checkpoints
 * are where the Coordinator can revise the IntentObject if needed.
 */
export interface VerificationCheckpoint {
  readonly id: string;
  readonly label: string;
  /** Node IDs that must complete before this checkpoint */
  readonly upstreamNodeIds: readonly string[];
  /** Node IDs that are gated by this checkpoint */
  readonly downstreamNodeIds: readonly string[];
  /** What checks run at this checkpoint */
  readonly checks: readonly CheckpointCheck[];
  /** Whether the Coordinator may revise intent at this checkpoint */
  readonly allowsIntentRevision: boolean;
  /** Current checkpoint status */
  status: "pending" | "evaluating" | "passed" | "failed";
}

export interface CheckpointCheck {
  readonly name: string;
  readonly type: "coherence" | "verification" | "cost-gate" | "approval";
  readonly required: boolean;
}

// ─── Escalation Boundaries ───────────────────────────────────────────

/**
 * An EscalationBoundary marks where task complexity or risk crosses
 * a threshold that requires tier upgrade. The TrustRouter sets these
 * based on its analysis; the graph enforces them during dispatch.
 */
export interface EscalationBoundary {
  readonly id: string;
  /** Node ID where escalation applies */
  readonly nodeId: string;
  /** Minimum tier required beyond this boundary */
  readonly minimumTier: WorkerTier;
  /** Why this escalation exists */
  readonly reason: string;
  /** Whether this escalation was set by TrustRouter or manually */
  readonly source: "trust-router" | "coordinator" | "manual";
}

// ─── Task Graph ──────────────────────────────────────────────────────

export interface TaskGraphState {
  readonly id: string;
  readonly intentId: string;
  readonly createdAt: string;
  nodes: TaskNode[];
  edges: DependencyEdge[];
  mergeGroups: MergeGroup[];
  checkpoints: VerificationCheckpoint[];
  escalationBoundaries: EscalationBoundary[];
}

// ─── Factory ─────────────────────────────────────────────────────────

export function createTaskGraph(intentId: string): TaskGraphState {
  return {
    id: randomUUID(),
    intentId,
    createdAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    mergeGroups: [],
    checkpoints: [],
    escalationBoundaries: [],
  };
}

// ─── Node Operations ─────────────────────────────────────────────────

export function addNode(
  graph: TaskGraphState,
  params: Omit<TaskNode, "id" | "status" | "assignedTier" | "runTaskId">
): TaskNode {
  const node: TaskNode = {
    ...params,
    id: randomUUID(),
    status: "planned",
    assignedTier: null,
    runTaskId: null,
  };
  graph.nodes.push(node);
  return node;
}

export function addEdge(
  graph: TaskGraphState,
  from: string,
  to: string,
  type: EdgeType = "hard"
): DependencyEdge {
  assertNodeExists(graph, from);
  assertNodeExists(graph, to);

  if (from === to) {
    throw new TaskGraphError("Self-edges are not allowed");
  }

  // Check for duplicate
  const existing = graph.edges.find((e) => e.from === from && e.to === to);
  if (existing) {
    throw new TaskGraphError(`Edge ${from} → ${to} already exists`);
  }

  const edge: DependencyEdge = { from, to, type };
  graph.edges.push(edge);

  // Validate no cycles were introduced
  if (hasCycle(graph)) {
    graph.edges.pop();
    throw new TaskGraphError(`Edge ${from} → ${to} would create a cycle`);
  }

  return edge;
}

export function addMergeGroup(
  graph: TaskGraphState,
  label: string,
  nodeIds: string[],
  integratorNodeId: string
): MergeGroup {
  nodeIds.forEach((id) => assertNodeExists(graph, id));
  assertNodeExists(graph, integratorNodeId);

  const group: MergeGroup = {
    id: randomUUID(),
    label,
    nodeIds: [...nodeIds],
    integratorNodeId,
  };
  graph.mergeGroups.push(group);
  return group;
}

export function addCheckpoint(
  graph: TaskGraphState,
  params: Omit<VerificationCheckpoint, "id" | "status">
): VerificationCheckpoint {
  params.upstreamNodeIds.forEach((id) => assertNodeExists(graph, id));
  params.downstreamNodeIds.forEach((id) => assertNodeExists(graph, id));

  const checkpoint: VerificationCheckpoint = {
    ...params,
    id: randomUUID(),
    status: "pending",
  };
  graph.checkpoints.push(checkpoint);
  return checkpoint;
}

export function addEscalationBoundary(
  graph: TaskGraphState,
  nodeId: string,
  minimumTier: WorkerTier,
  reason: string,
  source: EscalationBoundary["source"] = "trust-router"
): EscalationBoundary {
  assertNodeExists(graph, nodeId);

  const boundary: EscalationBoundary = {
    id: randomUUID(),
    nodeId,
    minimumTier,
    reason,
    source,
  };
  graph.escalationBoundaries.push(boundary);
  return boundary;
}

// ─── Status Transitions ──────────────────────────────────────────────

export function markReady(graph: TaskGraphState, nodeId: string): void {
  const node = findNode(graph, nodeId);
  if (node.status !== "planned") {
    throw new TaskGraphError(`Node ${nodeId} is "${node.status}", cannot mark ready`);
  }

  // Verify all hard/data dependencies are completed
  const deps = getUpstreamNodes(graph, nodeId);
  for (const dep of deps) {
    const edge = graph.edges.find((e) => e.from === dep.id && e.to === nodeId)!;
    if (edge.type === "hard" || edge.type === "data") {
      if (dep.status !== "completed" && dep.status !== "skipped") {
        throw new TaskGraphError(
          `Cannot ready node ${nodeId}: hard dependency ${dep.id} is "${dep.status}"`
        );
      }
    }
  }

  node.status = "ready";
}

export function markDispatched(graph: TaskGraphState, nodeId: string, runTaskId: string): void {
  const node = findNode(graph, nodeId);
  if (node.status !== "ready") {
    throw new TaskGraphError(`Node ${nodeId} is "${node.status}", cannot dispatch`);
  }
  node.status = "dispatched";
  node.runTaskId = runTaskId;
}

export function markCompleted(graph: TaskGraphState, nodeId: string): void {
  const node = findNode(graph, nodeId);
  if (node.status !== "dispatched") {
    throw new TaskGraphError(`Node ${nodeId} is "${node.status}", cannot complete`);
  }
  node.status = "completed";

  // Auto-ready downstream nodes whose dependencies are now satisfied
  autoReadyDownstream(graph, nodeId);
}

export function markFailed(graph: TaskGraphState, nodeId: string): void {
  const node = findNode(graph, nodeId);
  if (node.status !== "dispatched") {
    throw new TaskGraphError(`Node ${nodeId} is "${node.status}", cannot fail`);
  }
  node.status = "failed";

  // Block downstream nodes with hard dependencies
  propagateBlock(graph, nodeId);
}

export function markSkipped(graph: TaskGraphState, nodeId: string): void {
  const node = findNode(graph, nodeId);
  if (node.status !== "planned" && node.status !== "ready") {
    throw new TaskGraphError(`Node ${nodeId} is "${node.status}", cannot skip`);
  }
  node.status = "skipped";
  autoReadyDownstream(graph, nodeId);
}

// ─── Queries ─────────────────────────────────────────────────────────

export function getReadyNodes(graph: TaskGraphState): TaskNode[] {
  return graph.nodes.filter((n) => n.status === "ready");
}

export function getDispatchableNodes(graph: TaskGraphState): TaskNode[] {
  // Ready nodes that aren't gated by a pending/evaluating checkpoint
  const gatedNodeIds = new Set<string>();
  for (const cp of graph.checkpoints) {
    if (cp.status === "pending" || cp.status === "evaluating") {
      cp.downstreamNodeIds.forEach((id) => gatedNodeIds.add(id));
    }
  }

  return graph.nodes.filter(
    (n) => n.status === "ready" && !gatedNodeIds.has(n.id)
  );
}

export function getUpstreamNodes(graph: TaskGraphState, nodeId: string): TaskNode[] {
  const upstreamIds = graph.edges
    .filter((e) => e.to === nodeId)
    .map((e) => e.from);
  return graph.nodes.filter((n) => upstreamIds.includes(n.id));
}

export function getDownstreamNodes(graph: TaskGraphState, nodeId: string): TaskNode[] {
  const downstreamIds = graph.edges
    .filter((e) => e.from === nodeId)
    .map((e) => e.to);
  return graph.nodes.filter((n) => downstreamIds.includes(n.id));
}

export function getMergeGroupForNode(graph: TaskGraphState, nodeId: string): MergeGroup | undefined {
  return graph.mergeGroups.find((g) => g.nodeIds.includes(nodeId));
}

export function getEscalationForNode(graph: TaskGraphState, nodeId: string): EscalationBoundary | undefined {
  return graph.escalationBoundaries.find((b) => b.nodeId === nodeId);
}

export function getCheckpointsForNode(graph: TaskGraphState, nodeId: string): VerificationCheckpoint[] {
  return graph.checkpoints.filter(
    (cp) => cp.upstreamNodeIds.includes(nodeId) || cp.downstreamNodeIds.includes(nodeId)
  );
}

/**
 * Return nodes in topological order — safe execution order respecting all edges.
 */
export function topologicalSort(graph: TaskGraphState): TaskNode[] {
  const visited = new Set<string>();
  const order: TaskNode[] = [];
  const visiting = new Set<string>();

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      throw new TaskGraphError("Cycle detected during topological sort");
    }

    visiting.add(nodeId);

    const deps = graph.edges
      .filter((e) => e.to === nodeId)
      .map((e) => e.from);

    for (const dep of deps) {
      visit(dep);
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    order.push(findNode(graph, nodeId));
  }

  for (const node of graph.nodes) {
    visit(node.id);
  }

  return order;
}

/**
 * Get the critical path — longest dependency chain determining minimum build time.
 */
export function getCriticalPath(graph: TaskGraphState): TaskNode[] {
  const sorted = topologicalSort(graph);
  const distances = new Map<string, number>();
  const predecessors = new Map<string, string | null>();

  for (const node of sorted) {
    distances.set(node.id, 0);
    predecessors.set(node.id, null);
  }

  for (const node of sorted) {
    const currentDist = distances.get(node.id)!;
    const downstream = graph.edges
      .filter((e) => e.from === node.id)
      .map((e) => e.to);

    for (const nextId of downstream) {
      if (currentDist + 1 > distances.get(nextId)!) {
        distances.set(nextId, currentDist + 1);
        predecessors.set(nextId, node.id);
      }
    }
  }

  // Find the node with maximum distance
  let maxNode = sorted[0]?.id;
  let maxDist = 0;
  for (const [nodeId, dist] of distances) {
    if (dist > maxDist) {
      maxDist = dist;
      maxNode = nodeId;
    }
  }

  // Walk back predecessors to build path
  const path: TaskNode[] = [];
  let current: string | null = maxNode;
  while (current !== null) {
    path.unshift(findNode(graph, current));
    current = predecessors.get(current) ?? null;
  }

  return path;
}

export function isGraphComplete(graph: TaskGraphState): boolean {
  return graph.nodes.every(
    (n) => n.status === "completed" || n.status === "skipped"
  );
}

export function hasFailedNodes(graph: TaskGraphState): boolean {
  return graph.nodes.some((n) => n.status === "failed" || n.status === "blocked");
}

export function getGraphSummary(graph: TaskGraphState): GraphSummary {
  return {
    totalNodes: graph.nodes.length,
    planned: graph.nodes.filter((n) => n.status === "planned").length,
    ready: graph.nodes.filter((n) => n.status === "ready").length,
    dispatched: graph.nodes.filter((n) => n.status === "dispatched").length,
    completed: graph.nodes.filter((n) => n.status === "completed").length,
    failed: graph.nodes.filter((n) => n.status === "failed").length,
    skipped: graph.nodes.filter((n) => n.status === "skipped").length,
    blocked: graph.nodes.filter((n) => n.status === "blocked").length,
    edgeCount: graph.edges.length,
    mergeGroupCount: graph.mergeGroups.length,
    checkpointCount: graph.checkpoints.length,
    escalationCount: graph.escalationBoundaries.length,
  };
}

export interface GraphSummary {
  totalNodes: number;
  planned: number;
  ready: number;
  dispatched: number;
  completed: number;
  failed: number;
  skipped: number;
  blocked: number;
  edgeCount: number;
  mergeGroupCount: number;
  checkpointCount: number;
  escalationCount: number;
}

// ─── Internals ───────────────────────────────────────────────────────

function findNode(graph: TaskGraphState, nodeId: string): TaskNode {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new TaskGraphError(`Node "${nodeId}" not found`);
  return node;
}

function assertNodeExists(graph: TaskGraphState, nodeId: string): void {
  findNode(graph, nodeId);
}

function hasCycle(graph: TaskGraphState): boolean {
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;

    visiting.add(nodeId);
    const downstream = graph.edges
      .filter((e) => e.from === nodeId)
      .map((e) => e.to);

    for (const next of downstream) {
      if (dfs(next)) return true;
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  }

  for (const node of graph.nodes) {
    if (dfs(node.id)) return true;
  }
  return false;
}

function autoReadyDownstream(graph: TaskGraphState, completedNodeId: string): void {
  const downstream = graph.edges
    .filter((e) => e.from === completedNodeId)
    .map((e) => e.to);

  for (const nextId of downstream) {
    const node = findNode(graph, nextId);
    if (node.status !== "planned") continue;

    // Check if ALL hard/data deps are satisfied
    const allDeps = graph.edges.filter((e) => e.to === nextId);
    const satisfied = allDeps.every((edge) => {
      if (edge.type === "ordering" || edge.type === "soft") return true;
      const dep = findNode(graph, edge.from);
      return dep.status === "completed" || dep.status === "skipped";
    });

    if (satisfied) {
      node.status = "ready";
    }
  }
}

function propagateBlock(graph: TaskGraphState, failedNodeId: string): void {
  const downstream = graph.edges
    .filter((e) => e.from === failedNodeId && e.type === "hard")
    .map((e) => e.to);

  for (const nextId of downstream) {
    const node = findNode(graph, nextId);
    if (node.status === "planned" || node.status === "ready") {
      node.status = "blocked";
      // Recursively block downstream
      propagateBlock(graph, nextId);
    }
  }
}

// ─── Errors ──────────────────────────────────────────────────────────

export class TaskGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskGraphError";
  }
}
