import React from "react";

export interface RunStateProps {
  runId: string;
  title: string;
  phase: string;
  status: "idle" | "planning" | "running" | "blocked" | "complete" | "failed";
  progress: number;
  elapsedLabel: string;
  tokenCount: number;
  estimatedCostUsd?: number;
  confidence?: "high" | "moderate" | "low";
  activeWorkers?: number;
  summary?: string;
}

const toneMap: Record<RunStateProps["status"], string> = {
  idle: "border-slate-500/20 text-slate-300 bg-slate-400/10",
  planning: "border-sky-400/30 text-sky-200 bg-sky-400/10",
  running: "border-emerald-400/30 text-emerald-200 bg-emerald-400/10",
  blocked: "border-amber-400/30 text-amber-200 bg-amber-400/10",
  complete: "border-cyan-300/30 text-cyan-100 bg-cyan-300/10",
  failed: "border-rose-400/30 text-rose-200 bg-rose-400/10",
};

export default function RunState({
  runId,
  title,
  phase,
  status,
  progress,
  elapsedLabel,
  tokenCount,
  estimatedCostUsd,
  confidence = "moderate",
  activeWorkers = 0,
  summary,
}: RunStateProps) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <section className="rounded-[28px] border border-white/10 bg-slate-950/70 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-emerald-300">Run State</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-50">{title}</h2>
          <p className="mt-2 font-mono text-xs text-slate-400">{runId}</p>
        </div>

        <span className={`rounded-full border px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] ${toneMap[status]}`}>
          {status}
        </span>
      </div>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between font-mono text-xs uppercase tracking-[0.12em] text-slate-400">
          <span>{phase}</span>
          <span>{pct}%</span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-slate-900/90 ring-1 ring-white/5">
          <div
            className="h-full rounded-full bg-[linear-gradient(90deg,rgba(77,245,200,0.75),rgba(98,168,255,0.95))] shadow-[0_0_22px_rgba(77,245,200,0.25)] transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Elapsed" value={elapsedLabel} />
        <Metric label="Tokens" value={tokenCount.toLocaleString()} />
        <Metric label="Workers" value={String(activeWorkers)} />
        <Metric label="Confidence" value={confidence} />
      </div>

      {typeof estimatedCostUsd === "number" && (
        <div className="mt-4 rounded-2xl border border-cyan-400/15 bg-cyan-400/5 px-4 py-3 font-mono text-sm text-cyan-100">
          Estimated cost: ${estimatedCostUsd.toFixed(4)}
        </div>
      )}

      {summary && (
        <p className="mt-4 text-sm leading-7 text-slate-300">
          {summary}
        </p>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-slate-900/70 px-4 py-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-lg font-semibold text-slate-100">{value}</p>
    </div>
  );
}
