import React from "react";

export interface ReceiptRecord {
  id: string;
  at: string;
  worker: string;
  kind: string;
  summary: string;
}

export interface ReceiptFeedProps {
  receipts: ReceiptRecord[];
}

export default function ReceiptFeed({ receipts }: ReceiptFeedProps) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-slate-950/70 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="mb-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-emerald-300">Receipt Feed</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-50">Live receipts as work lands.</h2>
      </div>

      <div className="space-y-3">
        {receipts.map((receipt) => (
          <article key={receipt.id} className="rounded-[22px] border border-white/8 bg-slate-900/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-300 shadow-[0_0_14px_rgba(77,245,200,0.4)]" />
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-slate-400">{receipt.kind}</p>
              </div>
              <p className="font-mono text-xs text-slate-500">{receipt.at}</p>
            </div>

            <p className="mt-3 text-sm leading-7 text-slate-200">{receipt.summary}</p>

            <div className="mt-3 flex items-center justify-between gap-3 font-mono text-xs">
              <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-cyan-100">
                {receipt.worker}
              </span>
              <span className="text-slate-500">{receipt.id}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
