import React from "react";

export type WorkerRole = "Scout" | "Builder" | "Critic" | "Verifier" | "Integrator";
export type WorkerState = "idle" | "queued" | "running" | "waiting" | "complete" | "failed";

export interface WorkerRecord {
  role: WorkerRole;
  status: WorkerState;
  model: string;
  currentTask: string;
  note?: string;
}

export interface WorkerStatusProps {
  workers: WorkerRecord[];
}

const stateStyles: Record<WorkerState, string> = {
  idle: "border-slate-500/20 bg-slate-500/10 text-slate-300",
  queued: "border-sky-400/25 bg-sky-400/10 text-sky-200",
  running: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  waiting: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  complete: "border-cyan-300/25 bg-cyan-300/10 text-cyan-100",
  failed: "border-rose-400/25 bg-rose-400/10 text-rose-200",
};

export default function WorkerStatus({ workers }: WorkerStatusProps) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-slate-950/70 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-emerald-300">Worker Status</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-50">Role assignments and live activity.</h2>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {workers.map((worker) => (
          <article key={worker.role} className="rounded-[24px] border border-white/8 bg-slate-900/65 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500">{worker.role}</p>
                <p className="mt-2 text-lg font-semibold text-slate-100">{worker.currentTask}</p>
              </div>
              <span className={`rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] ${stateStyles[worker.status]}`}>
                {worker.status}
              </span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Info label="Model" value={worker.model} />
              <Info label="Task" value={worker.currentTask} />
            </div>

            {worker.note && (
              <p className="mt-4 text-sm leading-7 text-slate-300">
                {worker.note}
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/6 bg-slate-950/75 px-4 py-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 break-words text-sm text-slate-200">{value}</p>
    </div>
  );
}
