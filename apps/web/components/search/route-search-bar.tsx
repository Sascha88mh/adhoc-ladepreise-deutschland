"use client";

import { ArrowRight, LocateFixed, Route, Zap } from "lucide-react";

type QueryState = {
  origin: string;
  destination: string;
  profile: "auto" | "truck";
};

type Props = {
  query: QueryState;
  onChange: (next: QueryState) => void;
  onSubmit: () => void;
  pending: boolean;
};

export function RouteSearchBar({ query, onChange, onSubmit, pending }: Props) {
  return (
    <section className="glass-panel-strong relative overflow-hidden rounded-[28px] p-4 sm:p-5">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-[radial-gradient(circle_at_top_left,rgba(21,111,99,0.18),transparent_55%)]" />
      <div className="relative flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <p className="metric-label mb-2 flex items-center gap-2">
              <Zap className="h-3.5 w-3.5" />
              Ad-Hoc Ladepreise Deutschland
            </p>
            <h1 className="font-[var(--font-heading)] text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              Route zuerst. Danach nur die Ladepunkte, die preislich wirklich passen.
            </h1>
          </div>

          <div className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm text-[var(--muted)]">
            Öffentliche Website · Deutschland · DATEX-II / Mobilithek
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr),minmax(0,1fr),12rem,12rem]">
          <label className="glass-panel flex items-center gap-3 rounded-[22px] px-4 py-3">
            <LocateFixed className="h-4 w-4 text-[var(--muted)]" />
            <input
              value={query.origin}
              onChange={(event) => onChange({ ...query, origin: event.target.value })}
              placeholder="Start, z. B. Berlin"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--muted)]"
            />
          </label>

          <label className="glass-panel flex items-center gap-3 rounded-[22px] px-4 py-3">
            <ArrowRight className="h-4 w-4 text-[var(--muted)]" />
            <input
              value={query.destination}
              onChange={(event) =>
                onChange({ ...query, destination: event.target.value })
              }
              placeholder="Ziel, z. B. Hamburg"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--muted)]"
            />
          </label>

          <label className="glass-panel flex items-center gap-3 rounded-[22px] px-4 py-3">
            <Route className="h-4 w-4 text-[var(--muted)]" />
            <select
              value={query.profile}
              onChange={(event) =>
                onChange({
                  ...query,
                  profile: event.target.value as QueryState["profile"],
                })
              }
              className="w-full bg-transparent text-sm outline-none"
            >
              <option value="auto">PKW</option>
              <option value="truck">Transporter / LKW</option>
            </select>
          </label>

          <button
            type="button"
            onClick={onSubmit}
            className="rounded-[22px] bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_35px_rgba(21,111,99,0.26)] transition hover:bg-[#11594f]"
          >
            {pending ? "Plane Route..." : "Route planen"}
          </button>
        </div>
      </div>
    </section>
  );
}
