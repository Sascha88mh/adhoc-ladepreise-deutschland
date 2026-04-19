"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { AdminStationRecord, FeedConfig, SyncRun } from "@adhoc/shared";
import {
  createAdminFeed,
  deleteAdminFeed,
  deleteStationOverride,
  fetchSyncRuns,
  saveStationOverride,
  searchAdminStations,
  triggerFeedAction,
  updateAdminFeed,
} from "@/lib/client/api";

type Props = {
  dataSource: "demo" | "db";
  initialFeeds: FeedConfig[];
  initialSyncRuns: SyncRun[];
};

type FeedFormState = {
  source: FeedConfig["source"];
  cpoId: string | null;
  name: string;
  mode: FeedConfig["mode"];
  type: FeedConfig["type"];
  subscriptionId: string;
  urlOverride: string | null;
  pollIntervalMinutes: number | null;
  reconciliationIntervalMinutes: number | null;
  isActive: boolean;
  ingestCatalog: boolean;
  ingestPrices: boolean;
  ingestStatus: boolean;
  credentialRef: string | null;
  webhookSecretRef: string | null;
  notes: string;
};

type FeedHealth = {
  label: string;
  tone: string;
  detail: string;
};

const EMPTY_FORM: FeedFormState = {
  source: "mobilithek",
  cpoId: "",
  name: "",
  mode: "hybrid",
  type: "dynamic",
  subscriptionId: "",
  urlOverride: null,
  pollIntervalMinutes: 2,
  reconciliationIntervalMinutes: 2,
  isActive: true,
  ingestCatalog: false,
  ingestPrices: true,
  ingestStatus: true,
  credentialRef: "",
  webhookSecretRef: "",
  notes: "",
};

function formatDateTime(value: string | null) {
  if (!value) {
    return "Noch nie";
  }

  return new Date(value).toLocaleString("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatRelativeMinutes(value: string | null) {
  if (!value) {
    return "keine Aktivität";
  }

  const diffMinutes = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 60000),
  );

  if (diffMinutes < 1) {
    return "gerade eben";
  }

  if (diffMinutes < 60) {
    return `vor ${diffMinutes} Min.`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `vor ${diffHours} Std.`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `vor ${diffDays} Tag${diffDays === 1 ? "" : "en"}`;
}

function parseNullableText(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseNullableInt(value: string) {
  if (value.trim() === "") {
    return null;
  }

  return Number(value);
}

function intervalLabel(feed: FeedConfig) {
  if (feed.type === "static") {
    return feed.pollIntervalMinutes ? `${feed.pollIntervalMinutes} Min.` : "manuell";
  }

  if (feed.mode === "pull") {
    return feed.pollIntervalMinutes ? `${feed.pollIntervalMinutes} Min.` : "manuell";
  }

  return feed.reconciliationIntervalMinutes
    ? `Fallback ${feed.reconciliationIntervalMinutes} Min.`
    : "push-only";
}

function statusTone(status: SyncRun["status"]) {
  switch (status) {
    case "success":
      return "bg-[#dff4ea] text-[#166746]";
    case "failed":
      return "bg-[#f8e1da] text-[#9a3f1b]";
    case "running":
      return "bg-[#efe7cb] text-[#7a5f00]";
    default:
      return "bg-[var(--accent-soft)] text-[var(--accent)]";
  }
}

function healthForFeed(feed: FeedConfig, latestRun: SyncRun | undefined): FeedHealth {
  if (!feed.isActive) {
    return {
      label: "deaktiviert",
      tone: "bg-white/80 text-[var(--muted)]",
      detail: "Feed ist ausgeschaltet",
    };
  }

  if (latestRun?.status === "failed" || feed.lastErrorMessage) {
    return {
      label: "Fehler",
      tone: "bg-[#f8e1da] text-[#9a3f1b]",
      detail: feed.lastErrorMessage ?? latestRun?.message ?? "Letzter Lauf fehlgeschlagen",
    };
  }

  if (latestRun?.status === "running") {
    return {
      label: "läuft",
      tone: "bg-[#efe7cb] text-[#7a5f00]",
      detail: latestRun.message,
    };
  }

  if (feed.consecutiveFailures > 0) {
    return {
      label: "instabil",
      tone: "bg-[#f7ecd8] text-[#8a6413]",
      detail: `${feed.consecutiveFailures} Fehler in Folge`,
    };
  }

  if (!feed.lastSuccessAt) {
    return {
      label: "offen",
      tone: "bg-white/80 text-[var(--muted)]",
      detail: "Noch kein erfolgreicher Lauf",
    };
  }

  const interval = feed.type === "static"
    ? feed.pollIntervalMinutes ?? 1440
    : feed.mode === "pull"
      ? feed.pollIntervalMinutes ?? 2
      : feed.reconciliationIntervalMinutes ?? null;

  if (
    interval != null &&
    Date.now() - new Date(feed.lastSuccessAt).getTime() > interval * 60_000 * 2
  ) {
    return {
      label: "stale",
      tone: "bg-[#f7ecd8] text-[#8a6413]",
      detail: `Überfällig seit ${formatRelativeMinutes(feed.lastSuccessAt)}`,
    };
  }

  return {
    label: "ok",
    tone: "bg-[#dff4ea] text-[#166746]",
    detail: `Letzter Erfolg ${formatRelativeMinutes(feed.lastSuccessAt)}`,
  };
}

function stationOverridePayload(station: AdminStationRecord) {
  return {
    displayName: station.override?.displayName ?? null,
    addressLine: station.override?.addressLine ?? null,
    city: station.override?.city ?? null,
    postalCode: station.override?.postalCode ?? null,
    maxPowerKw: station.override?.maxPowerKw ?? null,
    isHidden: station.override?.isHidden ?? false,
    adminNote: station.override?.adminNote ?? null,
  };
}

export function AdminConsole({ dataSource, initialFeeds, initialSyncRuns }: Props) {
  const [feeds, setFeeds] = useState(initialFeeds);
  const [syncRuns, setSyncRuns] = useState(initialSyncRuns);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedFeedId, setSelectedFeedId] = useState<string | null>(
    initialFeeds[0]?.id ?? null,
  );
  const [uiError, setUiError] = useState<string | null>(null);
  const [stationQuery, setStationQuery] = useState("");
  const [stationResults, setStationResults] = useState<AdminStationRecord[]>([]);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [stationError, setStationError] = useState<string | null>(null);
  const [overrideBusy, setOverrideBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const runsByFeed = useMemo(() => {
    return syncRuns.reduce<Record<string, SyncRun[]>>((acc, run) => {
      acc[run.feedId] ??= [];
      acc[run.feedId].push(run);
      return acc;
    }, {});
  }, [syncRuns]);

  const selectedFeed =
    feeds.find((feed) => feed.id === selectedFeedId) ?? feeds[0] ?? null;
  const selectedFeedRuns = selectedFeed ? runsByFeed[selectedFeed.id] ?? [] : [];
  const selectedStation =
    stationResults.find((station) => station.stationId === selectedStationId) ?? null;

  useEffect(() => {
    if (dataSource !== "db") {
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const results = await searchAdminStations(stationQuery);
        startTransition(() => {
          setStationResults(results);
          if (!selectedStationId && results[0]) {
            setSelectedStationId(results[0].stationId);
          }
        });
      } catch (error) {
        setStationError(
          error instanceof Error ? error.message : "Stationen konnten nicht geladen werden.",
        );
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [dataSource, selectedStationId, startTransition, stationQuery]);

  async function refreshSyncRuns() {
    setSyncRuns(await fetchSyncRuns());
  }

  async function handleCreate() {
    setUiError(null);
    try {
      const created = await createAdminFeed({
        ...form,
        cpoId: parseNullableText(form.cpoId ?? ""),
        urlOverride: parseNullableText(form.urlOverride ?? ""),
        credentialRef: parseNullableText(form.credentialRef ?? ""),
        webhookSecretRef: parseNullableText(form.webhookSecretRef ?? ""),
      });
      setFeeds((current) => [created, ...current]);
      setSelectedFeedId(created.id);
      setForm(EMPTY_FORM);
      await refreshSyncRuns();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Feed konnte nicht angelegt werden.");
    }
  }

  async function handleSave(feed: FeedConfig) {
    setBusyId(feed.id);
    setUiError(null);
    try {
      const updated = await updateAdminFeed(feed.id, feed);
      setFeeds((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Feed konnte nicht gespeichert werden.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(feedId: string) {
    setBusyId(feedId);
    setUiError(null);
    try {
      await deleteAdminFeed(feedId);
      const nextFeeds = feeds.filter((feed) => feed.id !== feedId);
      setFeeds(nextFeeds);
      if (selectedFeedId === feedId) {
        setSelectedFeedId(nextFeeds[0]?.id ?? null);
      }
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Feed konnte nicht entfernt werden.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleAction(feedId: string, action: "test" | "sync") {
    setBusyId(feedId);
    setUiError(null);
    const startedAt = Date.now();
    try {
      const run = await triggerFeedAction(feedId, action);
      setSyncRuns((current) => [run, ...current]);
      try {
        await refreshSyncRuns();
      } catch (error) {
        console.error("[admin] refreshSyncRuns failed after action", error);
      }
    } catch (error) {
      if (action === "sync") {
        try {
          const runs = await fetchSyncRuns();
          setSyncRuns(runs);

          const latestForFeed = runs.find((run) => run.feedId === feedId);
          if (
            latestForFeed &&
            new Date(latestForFeed.startedAt).getTime() >= startedAt - 5_000
          ) {
            return;
          }
        } catch (refreshError) {
          console.error("[admin] sync fallback refresh failed", refreshError);
        }
      }

      setUiError(error instanceof Error ? error.message : "Aktion konnte nicht ausgeführt werden.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSaveOverride() {
    if (!selectedStation) {
      return;
    }

    setOverrideBusy(selectedStation.stationId);
    setStationError(null);
    try {
      const updated = await saveStationOverride(
        selectedStation.stationId,
        stationOverridePayload(selectedStation),
      );
      setStationResults((current) =>
        current.map((entry) =>
          entry.stationId === updated.stationId ? updated : entry,
        ),
      );
    } catch (error) {
      setStationError(
        error instanceof Error ? error.message : "Override konnte nicht gespeichert werden.",
      );
    } finally {
      setOverrideBusy(null);
    }
  }

  async function handleClearOverride() {
    if (!selectedStation) {
      return;
    }

    setOverrideBusy(selectedStation.stationId);
    setStationError(null);
    try {
      await deleteStationOverride(selectedStation.stationId);
      setStationResults((current) =>
        current.map((entry) =>
          entry.stationId === selectedStation.stationId
            ? {
                ...entry,
                effectiveName: entry.sourceName,
                effectiveAddressLine: entry.sourceAddressLine,
                effectiveCity: entry.sourceCity,
                effectivePostalCode: entry.sourcePostalCode,
                effectiveMaxPowerKw: entry.sourceMaxPowerKw,
                isHidden: false,
                override: null,
              }
            : entry,
        ),
      );
    } catch (error) {
      setStationError(
        error instanceof Error ? error.message : "Override konnte nicht entfernt werden.",
      );
    } finally {
      setOverrideBusy(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
      <section className="glass-panel-strong rounded-[30px] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="metric-label mb-2">Control Plane</p>
            <h1 className="font-[var(--font-heading)] text-3xl font-semibold tracking-[-0.04em]">
              Mobilithek Feed-Management
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
              Feeds, automatische Syncs, Fehlerdiagnose und kuratierte Stations-Overrides.
            </p>
          </div>
          <div className="rounded-full bg-white/80 px-4 py-2 text-sm text-[var(--muted)]">
            Datenquelle: {dataSource === "db" ? "Supabase / Postgres" : "Demo / Fixture"}
          </div>
        </div>
        {uiError ? (
          <div className="mt-4 rounded-2xl border border-[#e6b8a7] bg-[#fff3ee] px-4 py-3 text-sm text-[#9a3f1b]">
            {uiError}
          </div>
        ) : null}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr),minmax(360px,0.75fr)]">
        <section className="space-y-4">
          <div className="glass-panel-strong rounded-[30px] p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="metric-label">Feeds</p>
                <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
                  Datenfeed-Liste
                </h2>
              </div>
              <div className="rounded-full bg-white/80 px-3 py-2 text-sm text-[var(--muted)]">
                {feeds.length} Feed{feeds.length === 1 ? "" : "s"}
              </div>
            </div>

            <div className="space-y-3">
              {feeds.map((feed) => {
                const latestRun = runsByFeed[feed.id]?.[0];
                const health = healthForFeed(feed, latestRun);

                return (
                  <button
                    key={feed.id}
                    type="button"
                    onClick={() => setSelectedFeedId(feed.id)}
                    className={`w-full rounded-[26px] border px-4 py-4 text-left transition ${
                      selectedFeed?.id === feed.id
                        ? "border-[var(--accent)] bg-white shadow-[0_20px_60px_rgba(15,23,42,0.08)]"
                        : "border-[var(--line)] bg-white/80"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="metric-label">
                            {feed.type} · {feed.mode}
                          </span>
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${health.tone}`}>
                            {health.label}
                          </span>
                          <span className="rounded-full bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--muted)]">
                            {feed.cpoId ?? "ohne CPO"}
                          </span>
                        </div>
                        <h3 className="font-[var(--font-heading)] text-xl font-semibold tracking-[-0.03em]">
                          {feed.name}
                        </h3>
                        <p className="mt-1 text-sm text-[var(--muted)]">
                          {feed.subscriptionId}
                        </p>
                      </div>
                      <div className="text-right text-xs text-[var(--muted)]">
                        <div>Letzter Erfolg</div>
                        <div className="mt-1 font-medium text-slate-700">
                          {formatDateTime(feed.lastSuccessAt)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 text-sm md:grid-cols-4">
                      <div className="rounded-2xl bg-[var(--surface)] px-3 py-2">
                        <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
                          Health
                        </div>
                        <div className="mt-1 font-medium text-slate-700">{health.detail}</div>
                      </div>
                      <div className="rounded-2xl bg-[var(--surface)] px-3 py-2">
                        <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
                          Intervall
                        </div>
                        <div className="mt-1 font-medium text-slate-700">{intervalLabel(feed)}</div>
                      </div>
                      <div className="rounded-2xl bg-[var(--surface)] px-3 py-2">
                        <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
                          Toggles
                        </div>
                        <div className="mt-1 font-medium text-slate-700">
                          {[feed.ingestCatalog && "Catalog", feed.ingestPrices && "Preis", feed.ingestStatus && "Status"]
                            .filter(Boolean)
                            .join(" · ") || "keine"}
                        </div>
                      </div>
                      <div className="rounded-2xl bg-[var(--surface)] px-3 py-2">
                        <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
                          Fehler
                        </div>
                        <div className="mt-1 font-medium text-slate-700">
                          {feed.lastErrorMessage ?? "Keine"}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="glass-panel-strong rounded-[30px] p-5">
            <p className="metric-label mb-3">Neuen Feed anlegen</p>
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={form.cpoId ?? ""}
                onChange={(event) => setForm({ ...form, cpoId: event.target.value })}
                placeholder="CPO-ID"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Feed Name"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <input
                value={form.subscriptionId}
                onChange={(event) => setForm({ ...form, subscriptionId: event.target.value })}
                placeholder="Subscription-ID"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <input
                value={form.urlOverride ?? ""}
                onChange={(event) => setForm({ ...form, urlOverride: event.target.value })}
                placeholder="URL Override (optional)"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <select
                value={form.type}
                onChange={(event) =>
                  setForm({
                    ...form,
                    type: event.target.value as FeedConfig["type"],
                    ingestCatalog: event.target.value === "static",
                    ingestStatus: event.target.value === "dynamic",
                  })
                }
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              >
                <option value="dynamic">dynamic</option>
                <option value="static">static</option>
              </select>
              <select
                value={form.mode}
                onChange={(event) =>
                  setForm({ ...form, mode: event.target.value as FeedConfig["mode"] })
                }
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              >
                <option value="push">push</option>
                <option value="pull">pull</option>
                <option value="hybrid">hybrid</option>
              </select>
              <input
                type="number"
                value={form.pollIntervalMinutes ?? ""}
                onChange={(event) =>
                  setForm({
                    ...form,
                    pollIntervalMinutes: parseNullableInt(event.target.value),
                  })
                }
                placeholder="Pull-Intervall"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <input
                type="number"
                value={form.reconciliationIntervalMinutes ?? ""}
                onChange={(event) =>
                  setForm({
                    ...form,
                    reconciliationIntervalMinutes: parseNullableInt(event.target.value),
                  })
                }
                placeholder="Reconciliation"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <input
                value={form.credentialRef ?? ""}
                onChange={(event) =>
                  setForm({ ...form, credentialRef: event.target.value })
                }
                placeholder="Credential-Ref"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <input
                value={form.webhookSecretRef ?? ""}
                onChange={(event) =>
                  setForm({ ...form, webhookSecretRef: event.target.value })
                }
                placeholder="Webhook-Secret-Ref"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <label className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/80 px-4 py-3 text-sm">
                Catalog ingest
                <input
                  type="checkbox"
                  checked={form.ingestCatalog}
                  onChange={(event) =>
                    setForm({ ...form, ingestCatalog: event.target.checked })
                  }
                  className="accent-[var(--accent)]"
                />
              </label>
              <label className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/80 px-4 py-3 text-sm">
                Preis ingest
                <input
                  type="checkbox"
                  checked={form.ingestPrices}
                  onChange={(event) =>
                    setForm({ ...form, ingestPrices: event.target.checked })
                  }
                  className="accent-[var(--accent)]"
                />
              </label>
              <label className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/80 px-4 py-3 text-sm">
                Status ingest
                <input
                  type="checkbox"
                  checked={form.ingestStatus}
                  onChange={(event) =>
                    setForm({ ...form, ingestStatus: event.target.checked })
                  }
                  className="accent-[var(--accent)]"
                />
              </label>
              <label className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/80 px-4 py-3 text-sm">
                Feed aktiv
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
                  className="accent-[var(--accent)]"
                />
              </label>
              <textarea
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                placeholder="Notizen"
                className="min-h-24 rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 md:col-span-2"
              />
            </div>

            <button
              type="button"
              onClick={handleCreate}
              className="mt-4 rounded-2xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white"
            >
              Feed anlegen
            </button>
          </div>

          <div className="glass-panel-strong rounded-[30px] p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="metric-label">Overrides</p>
                <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
                  Stations-Korrekturen
                </h2>
              </div>
              {dataSource !== "db" ? (
                <div className="rounded-full bg-[#fff3ee] px-3 py-2 text-sm text-[#9a3f1b]">
                  Nur in DB-Modus aktiv
                </div>
              ) : null}
            </div>

            {dataSource === "db" ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr),minmax(0,1.1fr)]">
                <div className="space-y-3">
                  <input
                    value={stationQuery}
                    onChange={(event) => setStationQuery(event.target.value)}
                    placeholder="Station, CPO, Adresse oder Code suchen"
                    className="w-full rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
                  />
                  <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                    {stationResults.map((station) => (
                      <button
                        key={station.stationId}
                        type="button"
                        onClick={() => setSelectedStationId(station.stationId)}
                        className={`w-full rounded-2xl border px-4 py-3 text-left ${
                          selectedStation?.stationId === station.stationId
                            ? "border-[var(--accent)] bg-white"
                            : "border-[var(--line)] bg-white/80"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="font-medium text-slate-800">{station.effectiveName}</div>
                            <div className="text-sm text-[var(--muted)]">
                              {station.cpoName} · {station.stationCode}
                            </div>
                          </div>
                          {station.override ? (
                            <span className="rounded-full bg-[#efe7cb] px-2.5 py-1 text-xs text-[#7a5f00]">
                              Override
                            </span>
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  {selectedStation ? (
                    <>
                      <div className="rounded-[24px] border border-[var(--line)] bg-white/80 p-4">
                        <div className="font-semibold text-slate-800">{selectedStation.sourceName}</div>
                        <div className="mt-1 text-sm text-[var(--muted)]">
                          Quelle: {selectedStation.cpoName} · {selectedStation.stationCode}
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="grid gap-1 text-sm text-[var(--muted)]">
                          Display Name
                          <input
                            value={selectedStation.override?.displayName ?? ""}
                            onChange={(event) =>
                              setStationResults((current) =>
                                current.map((entry) =>
                                  entry.stationId === selectedStation.stationId
                                    ? {
                                        ...entry,
                                        effectiveName: event.target.value || entry.sourceName,
                                        override: {
                                          stationId: entry.stationId,
                                          displayName: parseNullableText(event.target.value),
                                          addressLine: entry.override?.addressLine ?? null,
                                          city: entry.override?.city ?? null,
                                          postalCode: entry.override?.postalCode ?? null,
                                          maxPowerKw: entry.override?.maxPowerKw ?? null,
                                          isHidden: entry.override?.isHidden ?? false,
                                          adminNote: entry.override?.adminNote ?? null,
                                          updatedAt: entry.override?.updatedAt ?? new Date().toISOString(),
                                        },
                                      }
                                    : entry,
                                ),
                              )
                            }
                            className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                          />
                        </label>
                        <label className="grid gap-1 text-sm text-[var(--muted)]">
                          Adresse
                          <input
                            value={selectedStation.override?.addressLine ?? ""}
                            onChange={(event) =>
                              setStationResults((current) =>
                                current.map((entry) =>
                                  entry.stationId === selectedStation.stationId
                                    ? {
                                        ...entry,
                                        effectiveAddressLine:
                                          event.target.value || entry.sourceAddressLine,
                                        override: {
                                          stationId: entry.stationId,
                                          displayName: entry.override?.displayName ?? null,
                                          addressLine: parseNullableText(event.target.value),
                                          city: entry.override?.city ?? null,
                                          postalCode: entry.override?.postalCode ?? null,
                                          maxPowerKw: entry.override?.maxPowerKw ?? null,
                                          isHidden: entry.override?.isHidden ?? false,
                                          adminNote: entry.override?.adminNote ?? null,
                                          updatedAt: entry.override?.updatedAt ?? new Date().toISOString(),
                                        },
                                      }
                                    : entry,
                                ),
                              )
                            }
                            className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                          />
                        </label>
                        <label className="grid gap-1 text-sm text-[var(--muted)]">
                          Stadt
                          <input
                            value={selectedStation.override?.city ?? ""}
                            onChange={(event) =>
                              setStationResults((current) =>
                                current.map((entry) =>
                                  entry.stationId === selectedStation.stationId
                                    ? {
                                        ...entry,
                                        effectiveCity: event.target.value || entry.sourceCity,
                                        override: {
                                          stationId: entry.stationId,
                                          displayName: entry.override?.displayName ?? null,
                                          addressLine: entry.override?.addressLine ?? null,
                                          city: parseNullableText(event.target.value),
                                          postalCode: entry.override?.postalCode ?? null,
                                          maxPowerKw: entry.override?.maxPowerKw ?? null,
                                          isHidden: entry.override?.isHidden ?? false,
                                          adminNote: entry.override?.adminNote ?? null,
                                          updatedAt: entry.override?.updatedAt ?? new Date().toISOString(),
                                        },
                                      }
                                    : entry,
                                ),
                              )
                            }
                            className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                          />
                        </label>
                        <label className="grid gap-1 text-sm text-[var(--muted)]">
                          PLZ
                          <input
                            value={selectedStation.override?.postalCode ?? ""}
                            onChange={(event) =>
                              setStationResults((current) =>
                                current.map((entry) =>
                                  entry.stationId === selectedStation.stationId
                                    ? {
                                        ...entry,
                                        effectivePostalCode:
                                          event.target.value || entry.sourcePostalCode,
                                        override: {
                                          stationId: entry.stationId,
                                          displayName: entry.override?.displayName ?? null,
                                          addressLine: entry.override?.addressLine ?? null,
                                          city: entry.override?.city ?? null,
                                          postalCode: parseNullableText(event.target.value),
                                          maxPowerKw: entry.override?.maxPowerKw ?? null,
                                          isHidden: entry.override?.isHidden ?? false,
                                          adminNote: entry.override?.adminNote ?? null,
                                          updatedAt: entry.override?.updatedAt ?? new Date().toISOString(),
                                        },
                                      }
                                    : entry,
                                ),
                              )
                            }
                            className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                          />
                        </label>
                        <label className="grid gap-1 text-sm text-[var(--muted)]">
                          Max kW
                          <input
                            type="number"
                            value={selectedStation.override?.maxPowerKw ?? ""}
                            onChange={(event) =>
                              setStationResults((current) =>
                                current.map((entry) =>
                                  entry.stationId === selectedStation.stationId
                                    ? {
                                        ...entry,
                                        effectiveMaxPowerKw:
                                          parseNullableInt(event.target.value) ?? entry.sourceMaxPowerKw,
                                        override: {
                                          stationId: entry.stationId,
                                          displayName: entry.override?.displayName ?? null,
                                          addressLine: entry.override?.addressLine ?? null,
                                          city: entry.override?.city ?? null,
                                          postalCode: entry.override?.postalCode ?? null,
                                          maxPowerKw: parseNullableInt(event.target.value),
                                          isHidden: entry.override?.isHidden ?? false,
                                          adminNote: entry.override?.adminNote ?? null,
                                          updatedAt: entry.override?.updatedAt ?? new Date().toISOString(),
                                        },
                                      }
                                    : entry,
                                ),
                              )
                            }
                            className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                          />
                        </label>
                        <label className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/80 px-4 py-3 text-sm">
                          Verstecken
                          <input
                            type="checkbox"
                            checked={selectedStation.override?.isHidden ?? false}
                            onChange={(event) =>
                              setStationResults((current) =>
                                current.map((entry) =>
                                  entry.stationId === selectedStation.stationId
                                    ? {
                                        ...entry,
                                        isHidden: event.target.checked,
                                        override: {
                                          stationId: entry.stationId,
                                          displayName: entry.override?.displayName ?? null,
                                          addressLine: entry.override?.addressLine ?? null,
                                          city: entry.override?.city ?? null,
                                          postalCode: entry.override?.postalCode ?? null,
                                          maxPowerKw: entry.override?.maxPowerKw ?? null,
                                          isHidden: event.target.checked,
                                          adminNote: entry.override?.adminNote ?? null,
                                          updatedAt: entry.override?.updatedAt ?? new Date().toISOString(),
                                        },
                                      }
                                    : entry,
                                ),
                              )
                            }
                            className="accent-[var(--accent)]"
                          />
                        </label>
                      </div>

                      <label className="grid gap-1 text-sm text-[var(--muted)]">
                        Admin Note
                        <textarea
                          value={selectedStation.override?.adminNote ?? ""}
                          onChange={(event) =>
                            setStationResults((current) =>
                              current.map((entry) =>
                                entry.stationId === selectedStation.stationId
                                  ? {
                                      ...entry,
                                      override: {
                                        stationId: entry.stationId,
                                        displayName: entry.override?.displayName ?? null,
                                        addressLine: entry.override?.addressLine ?? null,
                                        city: entry.override?.city ?? null,
                                        postalCode: entry.override?.postalCode ?? null,
                                        maxPowerKw: entry.override?.maxPowerKw ?? null,
                                        isHidden: entry.override?.isHidden ?? false,
                                        adminNote: parseNullableText(event.target.value),
                                        updatedAt: entry.override?.updatedAt ?? new Date().toISOString(),
                                      },
                                    }
                                  : entry,
                              ),
                            )
                          }
                          className="min-h-24 rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                        />
                      </label>

                      {stationError ? (
                        <div className="rounded-2xl border border-[#e6b8a7] bg-[#fff3ee] px-4 py-3 text-sm text-[#9a3f1b]">
                          {stationError}
                        </div>
                      ) : null}

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={overrideBusy === selectedStation.stationId}
                          onClick={handleSaveOverride}
                          className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-60"
                        >
                          Override speichern
                        </button>
                        <button
                          type="button"
                          disabled={overrideBusy === selectedStation.stationId}
                          onClick={handleClearOverride}
                          className="rounded-full border border-[var(--line)] px-4 py-2 text-sm"
                        >
                          Override entfernen
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-[24px] border border-dashed border-[var(--line)] px-4 py-6 text-sm text-[var(--muted)]">
                      Eine Station aus der Suche auswählen, um kuratierte Overrides zu setzen.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-[24px] border border-dashed border-[var(--line)] px-4 py-6 text-sm text-[var(--muted)]">
                Overrides sind nur aktiv, wenn `APP_DATA_SOURCE=db` gesetzt ist und eine Datenbank verbunden ist.
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="glass-panel-strong rounded-[30px] p-5">
            <p className="metric-label mb-2">Ausgewählter Feed</p>
            {selectedFeed ? (
              <>
                <div className="mb-4">
                  <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
                    {selectedFeed.name}
                  </h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {selectedFeed.subscriptionId}
                  </p>
                </div>

                <div className="grid gap-3">
                  <label className="grid gap-1 text-sm text-[var(--muted)]">
                    CPO-ID
                    <input
                      value={selectedFeed.cpoId ?? ""}
                      onChange={(event) =>
                        setFeeds((current) =>
                          current.map((entry) =>
                            entry.id === selectedFeed.id
                              ? { ...entry, cpoId: parseNullableText(event.target.value) }
                              : entry,
                          ),
                        )
                      }
                      className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                    />
                  </label>

                  <label className="grid gap-1 text-sm text-[var(--muted)]">
                    Modus
                    <select
                      value={selectedFeed.mode}
                      onChange={(event) =>
                        setFeeds((current) =>
                          current.map((entry) =>
                            entry.id === selectedFeed.id
                              ? {
                                  ...entry,
                                  mode: event.target.value as FeedConfig["mode"],
                                }
                              : entry,
                          ),
                        )
                      }
                      className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                    >
                      <option value="push">push</option>
                      <option value="pull">pull</option>
                      <option value="hybrid">hybrid</option>
                    </select>
                  </label>

                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="grid gap-1 text-sm text-[var(--muted)]">
                      Pull-Intervall
                      <input
                        type="number"
                        value={selectedFeed.pollIntervalMinutes ?? ""}
                        onChange={(event) =>
                          setFeeds((current) =>
                            current.map((entry) =>
                              entry.id === selectedFeed.id
                                ? {
                                    ...entry,
                                    pollIntervalMinutes: parseNullableInt(event.target.value),
                                  }
                                : entry,
                            ),
                          )
                        }
                        className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                      />
                    </label>

                    <label className="grid gap-1 text-sm text-[var(--muted)]">
                      Reconciliation
                      <input
                        type="number"
                        value={selectedFeed.reconciliationIntervalMinutes ?? ""}
                        onChange={(event) =>
                          setFeeds((current) =>
                            current.map((entry) =>
                              entry.id === selectedFeed.id
                                ? {
                                    ...entry,
                                    reconciliationIntervalMinutes: parseNullableInt(
                                      event.target.value,
                                    ),
                                  }
                                : entry,
                            ),
                          )
                        }
                        className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="grid gap-1 text-sm text-[var(--muted)]">
                      Credential-Ref
                      <input
                        value={selectedFeed.credentialRef ?? ""}
                        onChange={(event) =>
                          setFeeds((current) =>
                            current.map((entry) =>
                              entry.id === selectedFeed.id
                                ? { ...entry, credentialRef: parseNullableText(event.target.value) }
                                : entry,
                            ),
                          )
                        }
                        className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                      />
                    </label>

                    <label className="grid gap-1 text-sm text-[var(--muted)]">
                      Webhook-Secret-Ref
                      <input
                        value={selectedFeed.webhookSecretRef ?? ""}
                        onChange={(event) =>
                          setFeeds((current) =>
                            current.map((entry) =>
                              entry.id === selectedFeed.id
                                ? {
                                    ...entry,
                                    webhookSecretRef: parseNullableText(event.target.value),
                                  }
                                : entry,
                            ),
                          )
                        }
                        className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/80 px-4 py-3 text-sm">
                      Feed aktiv
                      <input
                        type="checkbox"
                        checked={selectedFeed.isActive}
                        onChange={(event) =>
                          setFeeds((current) =>
                            current.map((entry) =>
                              entry.id === selectedFeed.id
                                ? { ...entry, isActive: event.target.checked }
                                : entry,
                            ),
                          )
                        }
                        className="accent-[var(--accent)]"
                      />
                    </label>

                    <label className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/80 px-4 py-3 text-sm">
                      Catalog ingest
                      <input
                        type="checkbox"
                        checked={selectedFeed.ingestCatalog}
                        onChange={(event) =>
                          setFeeds((current) =>
                            current.map((entry) =>
                              entry.id === selectedFeed.id
                                ? { ...entry, ingestCatalog: event.target.checked }
                                : entry,
                            ),
                          )
                        }
                        className="accent-[var(--accent)]"
                      />
                    </label>

                    <label className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/80 px-4 py-3 text-sm">
                      Preis ingest
                      <input
                        type="checkbox"
                        checked={selectedFeed.ingestPrices}
                        onChange={(event) =>
                          setFeeds((current) =>
                            current.map((entry) =>
                              entry.id === selectedFeed.id
                                ? { ...entry, ingestPrices: event.target.checked }
                                : entry,
                            ),
                          )
                        }
                        className="accent-[var(--accent)]"
                      />
                    </label>

                    <label className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/80 px-4 py-3 text-sm">
                      Status ingest
                      <input
                        type="checkbox"
                        checked={selectedFeed.ingestStatus}
                        onChange={(event) =>
                          setFeeds((current) =>
                            current.map((entry) =>
                              entry.id === selectedFeed.id
                                ? { ...entry, ingestStatus: event.target.checked }
                                : entry,
                            ),
                          )
                        }
                        className="accent-[var(--accent)]"
                      />
                    </label>
                  </div>

                  <label className="grid gap-1 text-sm text-[var(--muted)]">
                    Notizen
                    <textarea
                      value={selectedFeed.notes}
                      onChange={(event) =>
                        setFeeds((current) =>
                          current.map((entry) =>
                            entry.id === selectedFeed.id
                              ? { ...entry, notes: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      className="min-h-24 rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2 text-slate-900"
                    />
                  </label>
                </div>

                <div className="mt-4 grid gap-3 text-sm">
                  <div className="rounded-2xl bg-[var(--surface)] px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
                      Letzte Fehlermeldung
                    </div>
                    <div className="mt-1 text-slate-700">
                      {selectedFeed.lastErrorMessage ?? "Keine"}
                    </div>
                  </div>
                  <div className="rounded-2xl bg-[var(--surface)] px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
                      Cursor State
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-slate-700">
                      {selectedFeed.cursorState
                        ? JSON.stringify(selectedFeed.cursorState)
                        : "leer"}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2 text-sm">
                  <button
                    type="button"
                    disabled={busyId === selectedFeed.id}
                    onClick={() => handleSave(selectedFeed)}
                    className="rounded-full bg-[var(--accent)] px-4 py-2 text-white disabled:opacity-60"
                  >
                    Speichern
                  </button>
                  <button
                    type="button"
                    disabled={busyId === selectedFeed.id}
                    onClick={() => handleAction(selectedFeed.id, "test")}
                    className="rounded-full border border-[var(--line)] px-4 py-2"
                  >
                    Testen
                  </button>
                  <button
                    type="button"
                    disabled={busyId === selectedFeed.id}
                    onClick={() => handleAction(selectedFeed.id, "sync")}
                    className="rounded-full border border-[var(--line)] px-4 py-2"
                  >
                    Sync
                  </button>
                  <button
                    type="button"
                    disabled={busyId === selectedFeed.id}
                    onClick={() => handleDelete(selectedFeed.id)}
                    className="rounded-full border border-[#d8b3a0] px-4 py-2 text-[#9c4110]"
                  >
                    Entfernen
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-[var(--muted)]">
                Wähle links einen Feed aus, um Details zu bearbeiten.
              </p>
            )}
          </section>

          <section className="glass-panel-strong rounded-[30px] p-5">
            <p className="metric-label mb-2">Status & Fehler</p>
            <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
              Letzte Läufe
            </h2>
            <div className="mt-4 space-y-3">
              {(selectedFeedRuns.length ? selectedFeedRuns : syncRuns.slice(0, 8)).map((run) => (
                <div
                  key={run.id}
                  className="rounded-[24px] border border-[var(--line)] bg-white/80 p-4"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <strong>{run.kind}</strong>
                      <p className="text-xs text-[var(--muted)]">{run.feedId}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs ${statusTone(run.status)}`}>
                      {run.status}
                    </span>
                  </div>
                  <p className="text-sm text-slate-700">{run.message}</p>
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                    <span>{new Date(run.startedAt).toLocaleString("de-DE")}</span>
                    <span>Delta {run.deltaCount}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
