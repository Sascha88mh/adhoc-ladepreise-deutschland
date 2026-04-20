"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, Filter, WalletCards } from "lucide-react";
import type { CandidateFilters } from "@adhoc/shared";
import { DualRangeSlider } from "@/components/ui/range-slider";

type Props = {
  filters: CandidateFilters;
  onChange: (next: CandidateFilters) => void;
  hitCount: number;
  priceBand: { min: number | null; max: number | null };
  cpos: Array<{ id: string; name: string; stations: number }>;
  expanded: boolean;
  onToggle: () => void;
  showCorridorFilter?: boolean;
};

const MAX_POWER_KW = 1000;
const MAX_CHARGE_POINTS = 50;
const MAX_PRICE_CENTS = 100;
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

function CollapsibleFilterSection({ title, defaultExpanded = false, children }: { title: React.ReactNode; defaultExpanded?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultExpanded);
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group flex w-full items-center justify-between transition-opacity hover:opacity-80 focus:outline-none"
      >
        <div className="metric-label flex items-center gap-2 m-0">{title}</div>
        <ChevronDown 
          className={`h-4 w-4 text-[var(--muted)] transition-transform duration-200 ${open ? "rotate-180" : ""}`} 
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
           <motion.div
             initial={{ height: 0, opacity: 0 }}
             animate={{ height: "auto", opacity: 1 }}
             exit={{ height: 0, opacity: 0 }}
             transition={{ duration: 0.2 }}
             className="overflow-hidden"
           >
             <div className="pt-1">
               {children}
             </div>
           </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AnimatedSegmentedControl({
  options,
  activeId,
  onChange,
}: {
  options: { id: string; label: string }[];
  activeId: string;
  onChange: (id: any) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {options.map((option) => {
        const active = option.id === activeId;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className={`relative rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "text-[var(--accent-fg)]" : "text-[var(--foreground)] hover:bg-black/5"
            }`}
          >
            {active && (
              <motion.div
                layoutId="power-tier-indicator"
                className="absolute inset-0 rounded-full bg-[var(--accent)] shadow-sm"
                transition={{ type: "spring", stiffness: 450, damping: 45 }}
              />
            )}
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </div>
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
  showCorridorFilter = true,
}: Props) {
  function isPowerTierActive(filtersToTest: CandidateFilters, tier: "Alle" | "AC" | "DC" | "HPC") {
    if (tier === "Alle") {
      return !filtersToTest.currentTypes && !filtersToTest.minPowerKw && !filtersToTest.maxPowerKw;
    }
    if (tier === "AC") {
      return filtersToTest.currentTypes?.includes("AC") && filtersToTest.maxPowerKw === 44;
    }
    if (tier === "DC") {
      return filtersToTest.currentTypes?.includes("DC") && filtersToTest.minPowerKw === 45 && filtersToTest.maxPowerKw === 99;
    }
    if (tier === "HPC") {
      return filtersToTest.currentTypes?.includes("DC") && filtersToTest.minPowerKw === 100 && !filtersToTest.maxPowerKw;
    }
    return false;
  }

  function handleToggleTier(tier: "Alle" | "AC" | "DC" | "HPC") {
    if (tier === "Alle" || isPowerTierActive(filters, tier)) {
      const next = { ...filters };
      delete next.currentTypes;
      delete next.minPowerKw;
      delete next.maxPowerKw;
      onChange(next);
      return;
    }

    const next = { ...filters };
    if (tier === "AC") {
      next.currentTypes = ["AC"];
      delete next.minPowerKw;
      next.maxPowerKw = 44;
    } else if (tier === "DC") {
      next.currentTypes = ["DC"];
      next.minPowerKw = 45;
      next.maxPowerKw = 99;
    } else if (tier === "HPC") {
      next.currentTypes = ["DC"];
      next.minPowerKw = 100;
      delete next.maxPowerKw;
    }
    onChange(next);
  }

  let activeTier = "Alle";
  if (isPowerTierActive(filters, "AC")) activeTier = "AC";
  else if (isPowerTierActive(filters, "DC")) activeTier = "DC";
  else if (isPowerTierActive(filters, "HPC")) activeTier = "HPC";

  const appleSpring = { type: "spring", bounce: 0, duration: 0.35 };

  return (
    <aside className="relative flex flex-col h-full min-h-0">
      <AnimatePresence mode="popLayout" initial={false}>
        {!expanded ? (
          <motion.div
            key="collapsed"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1, transition: appleSpring }}
            exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15, ease: "easeOut" } }}
            className="flex items-center justify-between gap-1.5 p-1.5 w-full"
          >
            <div className="flex items-center gap-1.5 rounded-[22px] bg-white/60 p-1 shadow-inner">
              <AnimatedSegmentedControl
                options={[
                  { id: "Alle", label: "Alle" },
                  { id: "AC", label: "AC" },
                  { id: "DC", label: "DC" },
                  { id: "HPC", label: "HPC" },
                ]}
                activeId={activeTier}
                onChange={handleToggleTier}
              />
            </div>
            
            <button
              type="button"
              onClick={onToggle}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/80 text-[var(--foreground)] shadow-sm transition hover:bg-white"
              aria-label="Mehr Filter"
            >
              <Filter className="h-4 w-4" />
            </button>
          </motion.div>
        ) : (
          <motion.div
            layout
            key="expanded"
            initial={{ opacity: 0, y: 15, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: appleSpring }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15, ease: "easeOut" } }}
            className="flex flex-col flex-1 min-h-0 w-full"
          >
            <div className="shrink-0 px-4 pt-4 sm:px-5 sm:pt-5">
              <div className="flex items-center justify-between">
                <p className="metric-label flex items-center gap-2 m-0">
                  <Filter className="h-3.5 w-3.5" />
                  Filter
                </p>

                <button
                  type="button"
                  onClick={onToggle}
                  className="rounded-full border border-[var(--line)] bg-white/82 px-3 py-2 text-sm text-[var(--foreground)] transition hover:bg-white"
                >
                  <span className="flex items-center gap-1.5">
                    Schließen <ChevronDown className="h-4 w-4" />
                  </span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar scroll-shadow px-4 pb-4 sm:px-5 sm:pb-5">
              <div className="space-y-6 pt-5 pb-2">
              {showCorridorFilter ? (
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
              ) : null}

              <section>
                <p className="metric-label mb-3">Preis pro kWh</p>
                <DualRangeSlider
                  min={0}
                  max={MAX_PRICE_CENTS}
                  step={1}
                  value={[
                    filters.minPriceKwh != null ? filters.minPriceKwh * 100 : 0,
                    filters.maxPriceKwh != null ? filters.maxPriceKwh * 100 : MAX_PRICE_CENTS,
                  ]}
                  onChange={([minVal, maxVal]) => {
                    onChange({
                      ...filters,
                      minPriceKwh: minVal > 0 ? minVal / 100 : undefined,
                      maxPriceKwh: maxVal < MAX_PRICE_CENTS ? maxVal / 100 : undefined,
                    });
                  }}
                />
                <div className="mt-3 flex items-center justify-between text-sm text-[var(--muted)]">
                  <span>{filters.minPriceKwh ? `${filters.minPriceKwh.toFixed(2).replace(".", ",")} €` : "0,00 €"}</span>
                  <strong className="text-[var(--foreground)]">
                    {filters.minPriceKwh || filters.maxPriceKwh
                      ? `${filters.minPriceKwh ? filters.minPriceKwh.toFixed(2).replace(".", ",") : "0,00"} – ${filters.maxPriceKwh ? filters.maxPriceKwh.toFixed(2).replace(".", ",") : "1,00"} €`
                      : "kein Preislimit"}
                  </strong>
                  <span>1,00 €</span>
                </div>
              </section>

              <section>
                <p className="metric-label mb-3">Stromart {activeTier !== "Alle" && `(${activeTier})`}</p>
                <div className="flex rounded-2xl bg-white/60 p-1 shadow-inner w-max">
                  <AnimatedSegmentedControl
                    options={[
                      { id: "Alle", label: "Alle" },
                      { id: "AC", label: "AC" },
                      { id: "DC", label: "DC" },
                      { id: "HPC", label: "HPC" },
                    ]}
                    activeId={activeTier}
                    onChange={handleToggleTier}
                  />
                </div>
              </section>

              <div className="space-y-6">
                <section>
                  <span className="metric-label mb-3 block">Leistung (kW)</span>
                  <DualRangeSlider
                    min={0}
                    max={MAX_POWER_KW}
                    step={10}
                    value={[filters.minPowerKw ?? 0, filters.maxPowerKw ?? MAX_POWER_KW]}
                    onChange={([minVal, maxVal]) => {
                      onChange({
                        ...filters,
                        minPowerKw: minVal > 0 ? minVal : undefined,
                        maxPowerKw: maxVal < MAX_POWER_KW ? maxVal : undefined,
                      });
                    }}
                  />
                  <div className="mt-3 flex items-center justify-between text-[13px] text-[var(--muted)]">
                    <span>{filters.minPowerKw ?? 0}</span>
                    <strong className="text-[var(--foreground)]">
                      {filters.minPowerKw || filters.maxPowerKw ? `${filters.minPowerKw ?? 0}–${filters.maxPowerKw ?? MAX_POWER_KW} kW` : "egal"}
                    </strong>
                    <span>{MAX_POWER_KW}</span>
                  </div>
                </section>

                <section>
                  <span className="metric-label mb-3 block">Ladepunkte</span>
                  <DualRangeSlider
                    min={0}
                    max={MAX_CHARGE_POINTS}
                    step={1}
                    value={[filters.minChargePointCount ?? 0, filters.maxChargePointCount ?? MAX_CHARGE_POINTS]}
                    onChange={([minVal, maxVal]) => {
                      onChange({
                        ...filters,
                        minChargePointCount: minVal > 0 ? minVal : undefined,
                        maxChargePointCount: maxVal < MAX_CHARGE_POINTS ? maxVal : undefined,
                      });
                    }}
                  />
                  <div className="mt-3 flex items-center justify-between text-[13px] text-[var(--muted)]">
                    <span>{filters.minChargePointCount ?? 0}</span>
                    <strong className="text-[var(--foreground)]">
                      {filters.minChargePointCount || filters.maxChargePointCount ? `${filters.minChargePointCount ?? 0}–${filters.maxChargePointCount ?? MAX_CHARGE_POINTS}` : "egal"}
                    </strong>
                    <span>{MAX_CHARGE_POINTS}</span>
                  </div>
                </section>
              </div>

              <CollapsibleFilterSection 
                title={
                  <>
                    <WalletCards className="h-3.5 w-3.5" />
                    Bezahlarten
                  </>
                }
              >
                <div className="flex flex-wrap gap-2 pt-1">
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
              </CollapsibleFilterSection>

              <CollapsibleFilterSection title="Anbieter">
                <div className="max-h-44 space-y-2 overflow-y-auto px-1 -mx-1 text-sm custom-scrollbar scroll-shadow">
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
              </CollapsibleFilterSection>

              <CollapsibleFilterSection title="Sonstige Punkte">
                <div className="space-y-2 text-sm pt-1">
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
                </div>
              </CollapsibleFilterSection>
            </div>
            </div>

            <div className="shrink-0 px-4 pb-4 pt-2 sm:px-5 sm:pb-5">
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...(showCorridorFilter ? { corridorKm: DEFAULT_CORRIDOR_KM } : {}),
                  })
                }
                className="w-full rounded-2xl border border-[var(--line)] px-3 py-2 text-sm text-[var(--muted)] transition hover:bg-white/80"
              >
                Zurücksetzen
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}
