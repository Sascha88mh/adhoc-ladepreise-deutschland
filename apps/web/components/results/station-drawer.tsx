"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, ExternalLink, LoaderCircle, WalletCards, Zap } from "lucide-react";
import { useState } from "react";
import type { ChargePointDetail, StationDetail } from "@adhoc/shared";

type Props = {
  detail: StationDetail | null;
  loading: boolean;
  open: boolean;
  onClose: () => void;
};

function statusDot(status: ChargePointDetail["status"]) {
  const map: Record<ChargePointDetail["status"], string> = {
    AVAILABLE: "bg-[var(--accent)]",
    CHARGING: "bg-[var(--warning)]",
    RESERVED: "bg-[var(--warning)]",
    BLOCKED: "bg-[#ef4444]",
    OUT_OF_SERVICE: "bg-[#ef4444]",
    MAINTENANCE: "bg-[#ef4444]",
    UNKNOWN: "bg-[var(--muted)]",
  };
  return map[status] ?? "bg-[var(--muted)]";
}

function statusLabel(status: ChargePointDetail["status"]) {
  const map: Record<ChargePointDetail["status"], string> = {
    AVAILABLE: "frei",
    CHARGING: "lädt",
    RESERVED: "reserviert",
    BLOCKED: "gesperrt",
    OUT_OF_SERVICE: "gestört",
    MAINTENANCE: "Wartung",
    UNKNOWN: "unbekannt",
  };
  return map[status] ?? "unbekannt";
}

function ChargePointsSection({ chargePoints }: { chargePoints: ChargePointDetail[] }) {
  const [open, setOpen] = useState(false);

  if (!chargePoints.length) return null;

  return (
    <div className="mb-5 rounded-[24px] border border-[var(--line)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium"
      >
        <span>Ladepunkte ({chargePoints.length})</span>
        {open ? <ChevronUp className="h-4 w-4 text-[var(--muted)]" /> : <ChevronDown className="h-4 w-4 text-[var(--muted)]" />}
      </button>

      {open && (
        <div className="border-t border-[var(--line)] divide-y divide-[var(--line)]">
          {chargePoints.map((cp) => (
            <div key={cp.code} className="px-4 py-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${statusDot(cp.status)}`}
                />
                <span className="flex-1 truncate text-xs font-mono text-[var(--muted)]">{cp.code}</span>
                <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs text-[var(--accent)]">
                  {cp.currentType}
                </span>
                {cp.maxPowerKw != null && cp.maxPowerKw > 0 && (
                  <span className="text-xs font-semibold">{cp.maxPowerKw} kW</span>
                )}
              </div>
              <div className="ml-4 flex flex-wrap gap-1.5">
                {cp.connectors.map((conn, i) => (
                  <span
                    key={`${cp.code}-conn-${i}`}
                    className="rounded-full border border-[var(--line)] bg-white/80 px-2 py-0.5 text-xs text-[var(--muted)]"
                  >
                    {conn.type}
                    {conn.maxPowerKw != null && conn.maxPowerKw > 0 ? ` · ${conn.maxPowerKw} kW` : ""}
                  </span>
                ))}
                <span className="ml-auto text-xs text-[var(--muted)]">{statusLabel(cp.status)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function money(value: number | null | undefined) {
  if (value == null) {
    return "nicht gemeldet";
  }
  return `${value.toFixed(2).replace(".", ",")} €`;
}

export function StationDrawer({ detail, loading, open, onClose }: Props) {
  return (
    <AnimatePresence>
      {open && (loading || detail) ? (
        <>
          <motion.button
            type="button"
            aria-label="Details schließen"
            onClick={onClose}
            className="fixed inset-0 z-40 bg-[rgba(21,38,27,0.16)] backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.aside
            initial={{ opacity: 0, x: 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 36 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            className="fixed bottom-4 right-4 top-4 z-50 w-[min(26rem,calc(100vw-2rem))] overflow-auto rounded-[32px] bg-[rgba(255,255,255,0.97)] p-5 shadow-[0_32px_80px_rgba(16,31,27,0.18)]"
          >
            {loading && !detail ? (
              <div className="flex h-full min-h-80 flex-col items-center justify-center gap-4 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent-soft)]">
                  <LoaderCircle className="h-6 w-6 animate-spin text-[var(--accent)]" />
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-[var(--foreground)]">Stationsdetails werden geladen</p>
                  <p className="text-sm text-[var(--muted)]">
                    Die Karte bleibt nutzbar, waehrend die Detaildaten nachgeladen werden.
                  </p>
                </div>
              </div>
            ) : detail ? (
              <>
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <p className="metric-label mb-2">{detail.cpoName}</p>
                    <h3 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
                      {detail.name}
                    </h3>
                    <p className="mt-2 text-sm text-[var(--muted)]">
                      {detail.addressLine}, {detail.city}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full border border-[var(--line)] px-3 py-1 text-sm text-[var(--muted)]"
                  >
                    Schließen
                  </button>
                </div>

                <div className="mb-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-[24px] bg-[var(--accent-soft)] p-4">
                    <p className="metric-label mb-2">Leistung</p>
                    <p className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.05em] text-[var(--accent)]">
                      {detail.maxPowerKw} kW
                    </p>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {detail.currentTypes.join(" / ")} · {detail.chargePointCount} Ladepunkte
                    </p>
                  </div>

                  <div className="rounded-[24px] bg-[rgba(185,103,16,0.08)] p-4">
                    <p className="metric-label mb-2">Verfügbarkeit</p>
                    <p className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.05em] text-[var(--warning)]">
                      {detail.availabilitySummary.available} frei
                    </p>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {detail.availabilitySummary.occupied} belegt ·{" "}
                      {detail.availabilitySummary.outOfService} gestört
                    </p>
                  </div>
                </div>

                <div className="mb-5 space-y-3">
                  {detail.tariffs.length ? (
                    detail.tariffs.map((tariff) => (
                      <div key={tariff.id} className="rounded-[24px] border border-[var(--line)] p-4">
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div>
                            <p className="metric-label mb-1">Tarif</p>
                            <h4 className="font-semibold">{tariff.label}</h4>
                          </div>
                          <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs text-[var(--accent)]">
                            {tariff.isComplete ? "vollständig" : "teilweise"}
                          </span>
                        </div>
                        <div className="grid gap-2 text-sm text-[var(--muted)] sm:grid-cols-2">
                          <p>kWh: {money(tariff.pricePerKwh)}</p>
                          <p>Minute: {money(tariff.pricePerMinute)}</p>
                          <p>Start: {money(tariff.sessionFee)}</p>
                          <p>Preauth: {money(tariff.preauthAmount)}</p>
                          <p>
                            Blockiergebühr:{" "}
                            {tariff.blockingFeePerMinute != null
                              ? `${money(tariff.blockingFeePerMinute)} / Min.`
                              : "nicht gemeldet"}
                          </p>
                          <p>
                            Startet nach:{" "}
                            {tariff.blockingFeeStartsAfterMinutes != null
                              ? `${tariff.blockingFeeStartsAfterMinutes} Min.`
                              : "keine Angabe"}
                          </p>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs">
                          {tariff.paymentMethods.map((method) => (
                            <span
                              key={method}
                              className="rounded-full bg-white px-2.5 py-1 text-[var(--muted)] shadow-sm"
                            >
                              {method}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-[24px] border border-dashed border-[var(--line)] bg-white/72 p-4 text-sm text-[var(--muted)]">
                      Für diesen Standort wurden bisher noch keine Tarifdaten synchronisiert.
                    </div>
                  )}
                </div>

                <ChargePointsSection chargePoints={detail.chargePoints} />

                <div className="mb-5 rounded-[24px] border border-[var(--line)] p-4">
                  <p className="metric-label mb-2 flex items-center gap-2">
                    <WalletCards className="h-3.5 w-3.5" />
                    Export ins Navi
                  </p>
                  <div className="grid gap-2 text-sm">
                    {[
                      ["Google Maps", detail.exportTargets.googleMaps],
                      ["Apple Maps", detail.exportTargets.appleMaps],
                      ["Waze", detail.exportTargets.waze],
                    ].map(([label, url]) => (
                      <a
                        key={label}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between rounded-2xl bg-[var(--accent-soft)] px-3 py-2 text-[var(--accent)]"
                      >
                        <span>{label}</span>
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    ))}
                    <div className="rounded-2xl border border-[var(--line)] px-3 py-2 text-[var(--muted)]">
                      Koordinaten: {detail.exportTargets.coordinates}
                    </div>
                  </div>
                </div>

                <div className="rounded-[24px] bg-white/80 p-4 text-sm text-[var(--muted)]">
                  <p className="mb-2 flex items-center gap-2 font-medium text-[var(--foreground)]">
                    <Zap className="h-4 w-4 text-[var(--accent)]" />
                    Letzte Aktualisierung
                  </p>
                  <p>Preis: {new Date(detail.lastPriceUpdateAt).toLocaleString("de-DE")}</p>
                  <p>Status: {new Date(detail.lastStatusUpdateAt).toLocaleString("de-DE")}</p>
                </div>
              </>
            ) : null}
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
