import React from "react";

export interface IntentObjectValue {
  goal: string;
  why: string;
  successDefinition: string[];
  constraints: string[];
  nonGoals?: string[];
  context?: Record<string, string>;
}

export interface IntentObjectProps {
  intent: IntentObjectValue;
}

export default function IntentObject({ intent }: IntentObjectProps) {
  const contextEntries = Object.entries(intent.context ?? {});

  return (
    <section className="rounded-[28px] border border-white/10 bg-slate-950/70 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="mb-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-emerald-300">Intent Object</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-50">Persistent run intent</h2>
      </div>

      <div className="rounded-[24px] border border-white/8 bg-slate-900/70 p-5 font-mono text-sm leading-7 text-slate-200">
        <Block label="goal" value={intent.goal} />
        <Block label="why" value={intent.why} />
        <ListBlock label="successDefinition" values={intent.successDefinition} />
        <ListBlock label="constraints" values={intent.constraints} />
        {intent.nonGoals && intent.nonGoals.length > 0 && <ListBlock label="nonGoals" values={intent.nonGoals} />}
        {contextEntries.length > 0 && (
          <div className="mt-4">
            <p className="text-cyan-300">context: {"{"}</p>
            <div className="ml-4 mt-2 space-y-2">
              {contextEntries.map(([key, value]) => (
                <div key={key}>
                  <span className="text-slate-500">"{key}"</span>: <span className="text-slate-100">"{value}"</span>
                </div>
              ))}
            </div>
            <p className="text-cyan-300">{"}"}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function Block({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-3 first:mt-0">
      <p className="text-cyan-300">{label}: <span className="text-slate-100">"{value}"</span></p>
    </div>
  );
}

function ListBlock({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="mt-4">
      <p className="text-cyan-300">{label}: [</p>
      <div className="ml-4 mt-2 space-y-1">
        {values.map((value) => (
          <div key={value} className="text-slate-100">
            "{value}",
          </div>
        ))}
      </div>
      <p className="text-cyan-300">]</p>
    </div>
  );
}
