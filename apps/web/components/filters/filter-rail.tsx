"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, Filter, WalletCards } from "lucide-react";
import type { CandidateFilters } from "@adhoc/shared";

type Props = {
  filters: CandidateFilters;
  onChange: (next: CandidateFilters) => void;
  hitCount: number;
  priceBand: { min: number | null; max: number | null };
  cpos: Array<{ id: string; name: string; stations: number }>;
  expanded: boolean;
  onToggle: () => void;
};

const MAX_POWER_KW = 350;
const MAX_CHARGE_POINTS = 16;
const DEFAULT_CORRIDOR_KM = 5;
const MAX_CORRIDOR_KM = 25;

function toggleArrayValue<T extends string>(values: T[] | undefined, value: T) {
  if (!values?.includes(value)) {
    return [...(values ?? []), value];
  }

  const next = values.filter((entry) => entry !== value);
  return next.length ? next : undefined;
}

function ToggleChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-sm transition ${
        active
          ? "border-transparent bg-[var(--accent)] text-[var(--accent-fg)]"
          : "border-[var(--line)] bg-white/80 text-[var(--foreground)]"
      }`}
    >
      {label}
    </button>
  );
}

function formatPriceBand(priceBand: { min: number | null; max: number | null }) {
  if (priceBand.min == null || priceBand.max == null) {
    return "Noch kein Preisband";
  }

  return `${priceBand.min.toFixed(2).replace(".", ",")}–${priceBand.max
    .toFixed(2)
    .replace(".", ",")} €/kWh`;
}

export function FilterRail({
  filters,
  onChange,
  hitCount,
  priceBand,
  cpos,
  expanded,
  onToggle,
}: Props) {
  const summaryChips = [
    ...(filters.currentTypes?.includes("AC") ? ["AC"] : []),
    ...(filters.currentTypes?.includes("DC") ? ["DC"] : []),
    ...(filters.minPowerKw && filters.minPowerKw >= 150 ? ["HPC"] : []),
  ];

  return (
    <aside className="min-h-[9.5rem] p-4 sm:min-h-[10.5rem] sm:p-5">
      <div className="mb-1 flex justify-center">
        <div className="h-1.5 w-14 rounded-full bg-[rgba(21,111,99,0.14)]" />
      </div>

      <div className="flex items-start justify-between gap-3 pt-1">
        <div className="min-w-0 flex-1">
          <p className="metric-label mb-2 flex items-center gap-2">
            <Filter className="h-3.5 w-3.5" />
            Filter
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-[var(--font-heading)] text-3xl font-semibold tracking-[-0.04em]">
              {hitCount}
            </p>
            <div
              className={`rounded-full px-3 py-2 text-sm ${
                expanded
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "bg-[rgba(21,111,99,0.10)] text-[rgba(21,111,99,0.72)]"
              }`}
            >
              {formatPriceBand(priceBand)}
            </div>
          </div>
          {!expanded && summaryChips.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {summaryChips.map((chip) => (
                <span
                  key={chip}
                  className="rounded-full border border-[rgba(21,111,99,0.12)] bg-white/56 px-2.5 py-1 text-xs font-medium tracking-[0.04em] text-[rgba(21,38,27,0.7)]"
                >
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onToggle}
          className="rounded-full border border-[var(--line)] bg-white/82 px-3 py-2 text-sm text-[var(--foreground)] transition hover:bg-white"
        >
          <span className="flex items-center gap-1.5">
            {expanded ? "Weniger" : "Mehr Filter"}
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </span>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-5 pt-5">
              <section>
                <p className="metric-label mb-2">Korridor entlang der Route</p>
                <input
                  type="range"
                  min={1}
                  max={MAX_CORRIDOR_KM}
                  step={1}
                  value={filters.corridorKm ?? DEFAULT_CORRIDOR_KM}
                  onChange={(event) =>
                    onChange({
                      ...filters,
                      corridorKm: Number(event.target.value),
                    })
                  }
                  className="w-full accent-[var(--accent)]"
                />
                <div className="mt-2 flex items-center justify-between text-sm text-[var(--muted)]">
                  <span>1 km</span>
                  <strong className="text-[var(--foreground)]">
                    {(filters.corridorKm ?? DEFAULT_CORRIDOR_KM).toFixed(0)} km
                  </strong>
                  <span>{MAX_CORRIDOR_KM} km</span>
                </div>
              </section>

              <section>
                <p className="metric-label mb-2">Preis pro kWh</p>
                <input
                  type="range"
                  min={35}
                  max={80}
                  step={1}
                  value={(filters.maxPriceKwh ?? 60) * 100}
                  onChange={(event) =>
                    onChange({
                      ...filters,
                      maxPriceKwh: Number(event.target.value) / 100,
                    })
                  }
                  className="w-full accent-[var(--accent)]"
                />
                <div className="mt-2 flex items-center justify-between text-sm text-[var(--muted)]">
                  <span>0,35 €</span>
                  <strong className="text-[var(--foreground)]">
                    max. {(filters.maxPriceKwh ?? 0.6).toFixed(2).replace(".", ",")} €
                  </strong>
                  <span>0,80 €</span>
                </div>
              </section>

              <section>
                <p className="metric-label mb-2">Stromart</p>
                <div className="flex flex-wrap gap-2">
                  <ToggleChip
                    active={filters.currentTypes?.includes("AC") ?? false}
                    label="AC"
                    onClick={() =>
                      onChange({
                        ...filters,
                        currentTypes: toggleArrayValue(filters.currentTypes, "AC"),
                      })
                    }
                  />
                  <ToggleChip
                    active={filters.currentTypes?.includes("DC") ?? false}
                    label="DC"
                    onClick={() =>
                      onChange({
                        ...filters,
                        currentTypes: toggleArrayValue(filters.currentTypes, "DC"),
                      })
                    }
                  />
                </div>
              </section>

              <section className="grid grid-cols-2 gap-3">
                <div className="text-sm">
                  <span className="metric-label mb-2 block">Mindest-kW</span>
                  <input
                    type="range"
                    min={0}
                    max={MAX_POWER_KW}
                    step={10}
                    value={filters.minPowerKw ?? 0}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      onChange({
                        ...filters,
                        minPowerKw: value > 0 ? value : undefined,
                      });
                    }}
                    className="w-full accent-[var(--accent)]"
                  />
                  <div className="mt-2 flex items-center justify-between text-sm text-[var(--muted)]">
                    <span>egal</span>
                    <strong className="text-[var(--foreground)]">
                      {filters.minPowerKw ? `ab ${filters.minPowerKw} kW` : "egal"}
                    </strong>
                    <span>{MAX_POWER_KW} kW</span>
                  </div>
                </div>

                <div className="text-sm">
                  <span className="metric-label mb-2 block">Mindestladepunkte</span>
                  <input
                    type="range"
                    min={0}
                    max={MAX_CHARGE_POINTS}
                    step={1}
                    value={filters.minChargePointCount ?? 0}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      onChange({
                        ...filters,
                        minChargePointCount: value > 0 ? value : undefined,
                      });
                    }}
                    className="w-full accent-[var(--accent)]"
                  />
                  <div className="mt-2 flex items-center justify-between text-sm text-[var(--muted)]">
                    <span>egal</span>
                    <strong className="text-[var(--foreground)]">
                      {filters.minChargePointCount
                        ? `mind. ${filters.minChargePointCount}`
                        : "egal"}
                    </strong>
                    <span>{MAX_CHARGE_POINTS}</span>
                  </div>
                </div>
              </section>

              <section>
                <p className="metric-label mb-2 flex items-center gap-2">
                  <WalletCards className="h-3.5 w-3.5" />
                  Bezahlarten
                </p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: "ecCard", label: "EC-Karte" },
                    { id: "creditCard", label: "Kreditkarte" },
                    { id: "applePay", label: "Apple Pay" },
                    { id: "googlePay", label: "Google Pay" },
                    { id: "webQr", label: "Web / QR-Code" },
                  ].map((method) => (
                    <ToggleChip
                      key={method.id}
                      active={filters.paymentMethods?.includes(method.id) ?? false}
                      label={method.label}
                      onClick={() =>
                        onChange({
                          ...filters,
                          paymentMethods: toggleArrayValue(filters.paymentMethods, method.id),
                        })
                      }
                    />
                  ))}
                </div>
              </section>

              <section>
                <p className="metric-label mb-2">Anbieter</p>
                <div className="max-h-44 space-y-2 overflow-auto pr-2 text-sm scroll-shadow">
                  {cpos.map((cpo) => (
                    <label key={cpo.id} className="flex items-center justify-between gap-3 rounded-2xl bg-white/72 px-3 py-2">
                      <span className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={filters.cpoIds?.includes(cpo.id) ?? false}
                          onChange={() =>
                            onChange({
                              ...filters,
                              cpoIds: toggleArrayValue(filters.cpoIds, cpo.id),
                            })
                          }
                          className="accent-[var(--accent)]"
                        />
                        {cpo.name}
                      </span>
                      <span className="text-[var(--muted)]">{cpo.stations}</span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="space-y-2 text-sm">
                {[
                  {
                    key: "availableOnly",
                    label: "nur mit freien Ladepunkten",
                  },
                  {
                    key: "onlyCompletePrices",
                    label: "nur vollständig gemeldete Preise",
                  },
                  {
                    key: "allowSessionFee",
                    label: "Startgebühr erlauben",
                    invert: true,
                  },
                  {
                    key: "allowBlockingFee",
                    label: "Blockiergebühr erlauben",
                    invert: true,
                  },
                ].map((item) => {
                  const raw = filters[item.key as keyof CandidateFilters];
                  const checked = item.invert ? raw !== false : raw === true;

                  return (
                    <label
                      key={item.key}
                      className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/72 px-3 py-2"
                    >
                      <span>{item.label}</span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          onChange({
                            ...filters,
                            [item.key]: item.invert ? event.target.checked : event.target.checked,
                          })
                        }
                        className="accent-[var(--accent)]"
                      />
                    </label>
                  );
                })}
              </section>

              <button
                type="button"
                onClick={() =>
                  onChange({
                    corridorKm: DEFAULT_CORRIDOR_KM,
                    maxPriceKwh: 0.6,
                  })
                }
                className="w-full rounded-2xl border border-[var(--line)] px-3 py-2 text-sm text-[var(--muted)] transition hover:bg-white/80"
              >
                Filter zurücksetzen
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </aside>
  );
}
