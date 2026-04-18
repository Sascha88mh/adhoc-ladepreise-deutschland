"use client";

import { Filter, WalletCards } from "lucide-react";
import type { CandidateFilters } from "@adhoc/shared";

type Props = {
  filters: CandidateFilters;
  onChange: (next: CandidateFilters) => void;
  hitCount: number;
  priceBand: { min: number | null; max: number | null };
  cpos: Array<{ id: string; name: string; stations: number }>;
};

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
          ? "border-transparent bg-[var(--accent)] text-white"
          : "border-[var(--line)] bg-white/80 text-[var(--foreground)]"
      }`}
    >
      {label}
    </button>
  );
}

export function FilterRail({ filters, onChange, hitCount, priceBand, cpos }: Props) {
  return (
    <aside className="glass-panel-strong order-3 rounded-[30px] p-4 lg:order-1">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="metric-label mb-2 flex items-center gap-2">
            <Filter className="h-3.5 w-3.5" />
            Treffer
          </p>
          <p className="font-[var(--font-heading)] text-3xl font-semibold tracking-[-0.04em]">
            {hitCount}
          </p>
        </div>
        <div className="rounded-2xl bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--accent)]">
          {priceBand.min != null && priceBand.max != null
            ? `${priceBand.min.toFixed(2).replace(".", ",")}–${priceBand.max.toFixed(2).replace(".", ",")} €/kWh`
            : "Noch kein Preisband"}
        </div>
      </div>

      <div className="space-y-5">
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
          <label className="text-sm">
            <span className="metric-label mb-2 block">Mindest-kW</span>
            <select
              value={filters.minPowerKw ?? ""}
              onChange={(event) =>
                onChange({
                  ...filters,
                  minPowerKw: event.target.value ? Number(event.target.value) : undefined,
                })
              }
              className="w-full rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
            >
              <option value="">egal</option>
              <option value="22">ab 22 kW</option>
              <option value="150">ab 150 kW</option>
              <option value="250">ab 250 kW</option>
            </select>
          </label>

          <label className="text-sm">
            <span className="metric-label mb-2 block">Ladepunkte</span>
            <select
              value={filters.minChargePointCount ?? ""}
              onChange={(event) =>
                onChange({
                  ...filters,
                  minChargePointCount: event.target.value
                    ? Number(event.target.value)
                    : undefined,
                })
              }
              className="w-full rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
            >
              <option value="">egal</option>
              <option value="4">mind. 4</option>
              <option value="8">mind. 8</option>
              <option value="12">mind. 12</option>
            </select>
          </label>
        </section>

        <section>
          <p className="metric-label mb-2 flex items-center gap-2">
            <WalletCards className="h-3.5 w-3.5" />
            Bezahlarten
          </p>
          <div className="flex flex-wrap gap-2">
            {[
              { id: "emv", label: "Karte" },
              { id: "applePay", label: "Apple Pay" },
              { id: "googlePay", label: "Google Pay" },
              { id: "website", label: "Web" },
              { id: "rfid", label: "RFID" },
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
          onClick={() => onChange({ maxPriceKwh: 0.6 })}
          className="w-full rounded-2xl border border-[var(--line)] px-3 py-2 text-sm text-[var(--muted)] transition hover:bg-white/80"
        >
          Filter zurücksetzen
        </button>
      </div>
    </aside>
  );
}
