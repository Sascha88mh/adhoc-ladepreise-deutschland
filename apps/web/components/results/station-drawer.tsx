"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink, WalletCards, Zap } from "lucide-react";
import type { StationDetail } from "@adhoc/shared";

type Props = {
  detail: StationDetail | null;
  open: boolean;
  onClose: () => void;
};

function money(value: number | null | undefined) {
  if (value == null) {
    return "nicht gemeldet";
  }
  return `${value.toFixed(2).replace(".", ",")} €`;
}

export function StationDrawer({ detail, open, onClose }: Props) {
  return (
    <AnimatePresence>
      {open && detail ? (
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
              {detail.tariffs.map((tariff) => (
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
              ))}
            </div>

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
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
