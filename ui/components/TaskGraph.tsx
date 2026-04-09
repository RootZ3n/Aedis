import React, { useMemo } from "react";

export interface TaskNode {
  id: string;
  label: string;
  status: "queued" | "running" | "blocked" | "complete" | "idle";
  dependencies: string[];
  mode: "parallel" | "sequential";
}

export interface TaskGraphProps {
  tasks: TaskNode[];
}

type PositionedNode = TaskNode & { level: number; row: number; x: number; y: number };

const statusColor: Record<TaskNode["status"], string> = {
  queued: "#62a8ff",
  running: "#4df5c8",
  blocked: "#ffb84d",
  complete: "#d8f8ff",
  idle: "#7d8cab",
};

export default function TaskGraph({ tasks }: TaskGraphProps) {
  const graph = useMemo(() => buildGraph(tasks), [tasks]);

  return (
    <section className="rounded-[28px] border border-white/10 bg-slate-950/70 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="mb-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-emerald-300">Task Graph</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-50">Dependency map with parallel lanes.</h2>
      </div>

      <div className="overflow-x-auto rounded-[24px] border border-white/8 bg-slate-900/65 p-4">
        <svg width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} className="min-w-full">
          <defs>
            <marker id="task-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="rgba(98,168,255,0.55)" />
            </marker>
          </defs>

          {graph.edges.map((edge) => (
            <line
              key={`${edge.from.id}-${edge.to.id}`}
              x1={edge.from.x + 224}
              y1={edge.from.y + 44}
              x2={edge.to.x}
              y2={edge.to.y + 44}
              stroke="rgba(98,168,255,0.35)"
              strokeWidth="2"
              markerEnd="url(#task-graph-arrow)"
            />
          ))}

          {graph.nodes.map((node) => (
            <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
              <rect
                width="224"
                height="88"
                rx="22"
                fill="rgba(8, 15, 28, 0.92)"
                stroke="rgba(255,255,255,0.08)"
              />
              <rect
                x="0"
                y="0"
                width="224"
                height="6"
                rx="22"
                fill={statusColor[node.status]}
              />
              <text x="18" y="24" fill="#4df5c8" fontFamily="JetBrains Mono, monospace" fontSize="11" letterSpacing="0.16em">
                {node.mode.toUpperCase()}
              </text>
              <text x="18" y="48" fill="#edf4ff" fontFamily="IBM Plex Sans, sans-serif" fontSize="15" fontWeight="600">
                {node.label}
              </text>
              <text x="18" y="69" fill="#92a1bd" fontFamily="JetBrains Mono, monospace" fontSize="11">
                {node.id}
              </text>
              <text x="154" y="69" fill={statusColor[node.status]} fontFamily="JetBrains Mono, monospace" fontSize="11">
                {node.status}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </section>
  );
}

function buildGraph(tasks: TaskNode[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const levelMemo = new Map<string, number>();

  const levelFor = (task: TaskNode): number => {
    if (levelMemo.has(task.id)) return levelMemo.get(task.id)!;
    if (task.dependencies.length === 0) {
      levelMemo.set(task.id, 0);
      return 0;
    }
    const level = Math.max(
      ...task.dependencies
        .map((depId) => byId.get(depId))
        .filter((dep): dep is TaskNode => Boolean(dep))
        .map((dep) => levelFor(dep) + 1),
    );
    levelMemo.set(task.id, level);
    return level;
  };

  const groups = new Map<number, TaskNode[]>();
  for (const task of tasks) {
    const level = levelFor(task);
    const bucket = groups.get(level) ?? [];
    bucket.push(task);
    groups.set(level, bucket);
  }

  const sortedLevels = [...groups.keys()].sort((a, b) => a - b);
  const positioned: PositionedNode[] = [];

  sortedLevels.forEach((level) => {
    const group = groups.get(level) ?? [];
    group.forEach((task, row) => {
      positioned.push({
        ...task,
        level,
        row,
        x: 40 + level * 288,
        y: 40 + row * 132,
      });
    });
  });

  const posById = new Map(positioned.map((node) => [node.id, node]));
  const edges = positioned.flatMap((node) =>
    node.dependencies
      .map((depId) => posById.get(depId))
      .filter((dep): dep is PositionedNode => Boolean(dep))
      .map((dep) => ({ from: dep, to: node })),
  );

  const maxLevel = sortedLevels.length === 0 ? 0 : Math.max(...sortedLevels);
  const maxRows = positioned.length === 0 ? 1 : Math.max(...positioned.map((node) => node.row + 1));

  return {
    nodes: positioned,
    edges,
    width: 320 + maxLevel * 288,
    height: 132 + maxRows * 132,
  };
}
