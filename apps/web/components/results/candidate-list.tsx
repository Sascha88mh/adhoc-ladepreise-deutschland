"use client";

import { motion } from "framer-motion";
import { ArrowUpRight, Clock3, Download, MapPinned, Milestone, PlugZap, Zap } from "lucide-react";
import type { RouteCandidate } from "@adhoc/shared";
import { priceLabel } from "@/lib/client/api";

type Props = {
  candidates: RouteCandidate[];
  selectedStationId: string | null;
  hoveredStationId: string | null;
  selectedForExportIds: Set<string>;
  onSelect: (stationId: string) => void;
  onHover: (stationId: string | null) => void;
  onToggleExport: (stationId: string) => void;
  onExportSelected: () => void;
  loading: boolean;
  totalCandidateCount?: number;
};

function feeLabel(candidate: RouteCandidate) {
  const parts = [];
  if ((candidate.tariffSummary.sessionFee ?? 0) > 0) {
    parts.push(
      `Start ${candidate.tariffSummary.sessionFee?.toFixed(2).replace(".", ",")} €`,
    );
  }
  if ((candidate.tariffSummary.blockingFeePerMinute ?? 0) > 0) {
    parts.push(
      `Block ab ${candidate.tariffSummary.blockingFeeStartsAfterMinutes} Min.`,
    );
  }
  return parts.length ? parts.join(" · ") : "Keine Zusatzgebühr";
}

export function CandidateList({
  candidates,
  selectedStationId,
  hoveredStationId,
  selectedForExportIds,
  onSelect,
  onHover,
  onToggleExport,
  onExportSelected,
  loading,
  totalCandidateCount,
}: Props) {
  const shownCount = candidates.length;
  const totalCount = totalCandidateCount ?? shownCount;
  const countLabel =
    loading
      ? "aktualisiere..."
      : totalCount > shownCount
        ? `${shownCount} von ${totalCount}`
        : `${shownCount} Treffer`;

  return (
    <aside className="flex h-full flex-col">
      <div className="border-b border-[var(--line)] px-5 py-4">
        <p className="metric-label mb-2">Ergebnisse entlang der Route</p>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
            Passende Ladepunkte
          </h2>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-white/80 px-3 py-1 text-sm text-[var(--muted)]">
              {countLabel}
            </span>
            <button
              type="button"
              onClick={onExportSelected}
              disabled={selectedForExportIds.size === 0}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--line)] bg-white/82 text-[var(--foreground)] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
              title="Ausgewählte Ladepunkte exportieren"
              aria-label="Ausgewählte Ladepunkte exportieren"
            >
              <Download className="h-4 w-4" />
            </button>
          </div>
        </div>
        {selectedForExportIds.size > 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">
            {selectedForExportIds.size} für den Export ausgewählt
          </p>
        ) : null}
      </div>

      <div className="scroll-shadow flex-1 space-y-3 overflow-auto px-4 py-4">
        {candidates.length === 0 ? (
          <div className="rounded-[26px] border border-dashed border-[var(--line)] bg-white/60 p-6 text-sm text-[var(--muted)]">
            Für diese Route und die aktiven Filter gibt es derzeit keine passenden Kandidaten.
          </div>
        ) : null}

        {candidates.map((candidate, index) => {
          const active =
            candidate.stationId === selectedStationId ||
            candidate.stationId === hoveredStationId;
          const available = candidate.availabilitySummary.available;
          const checked = selectedForExportIds.has(candidate.stationId);

          return (
            <motion.article
              key={candidate.stationId}
              role="button"
              tabIndex={0}
              layout
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.03 }}
              onMouseEnter={() => onHover(candidate.stationId)}
              onMouseLeave={() => onHover(null)}
              onClick={() => onSelect(candidate.stationId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(candidate.stationId);
                }
              }}
              className={`w-full rounded-[26px] border px-4 py-4 text-left transition ${
                active
                  ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                  : checked
                    ? "border-[var(--accent)] bg-white/92"
                    : "border-[var(--line)] bg-white/78 hover:bg-white"
              }`}
            >
              <div className="mb-3 flex items-start justify-between gap-4">
                <div className="flex min-w-0 gap-3">
                  <label
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--line)] bg-white/90"
                    onClick={(event) => event.stopPropagation()}
                    title="Für Export auswählen"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleExport(candidate.stationId)}
                      className="h-4 w-4 accent-[var(--accent)]"
                      aria-label={`${candidate.stationName} für Export auswählen`}
                    />
                  </label>
                  <div className="min-w-0">
                  <p className="metric-label mb-2">{candidate.cpoName}</p>
                  <h3 className="font-[var(--font-heading)] text-xl font-semibold tracking-[-0.04em]">
                    {candidate.stationName}
                  </h3>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {candidate.addressLine}, {candidate.city}
                  </p>
                  </div>
                </div>

                <div className="text-right">
                  <p className="metric-label mb-1">Preis</p>
                  <p className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.05em] text-[var(--accent)]">
                    {priceLabel(candidate)}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted)]">{feeLabel(candidate)}</p>
                </div>
              </div>

              <div className="grid gap-2 text-sm text-[var(--muted)] sm:grid-cols-2">
                <p className="flex items-center gap-2">
                  <Milestone className="h-4 w-4" />
                  nach {candidate.distanceFromStartKm.toFixed(1).replace(".", ",")} km
                </p>
                <p className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4" />
                  {candidate.detourMinutes} Min. D-Tour
                </p>
                <p className="flex items-center gap-2">
                  <MapPinned className="h-4 w-4" />
                  {candidate.distanceFromRouteKm.toFixed(1).replace(".", ",")} km von der Route
                </p>
                <p className="flex items-center gap-2">
                  <Zap className="h-4 w-4" />
                  bis {candidate.maxPowerKw} kW · {candidate.chargePointCount} Ladepunkte
                </p>
                <p className="flex items-center gap-2">
                  <PlugZap className="h-4 w-4" />
                  {candidate.currentTypes.join(" / ")} · {available} frei
                </p>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {candidate.paymentMethods.slice(0, 4).map((method) => (
                  <span
                    key={method}
                    className="rounded-full bg-white/90 px-2.5 py-1 text-[var(--muted)]"
                  >
                    {method}
                  </span>
                ))}
                <span className="ml-auto flex items-center gap-1 text-[var(--muted)]">
                  Detail öffnen
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
              </div>
            </motion.article>
          );
        })}
      </div>
    </aside>
  );
}
