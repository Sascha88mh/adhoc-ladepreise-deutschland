"use client";

import { useState } from "react";
import type { FeedConfig, SyncRun } from "@adhoc/shared";
import {
  createAdminFeed,
  deleteAdminFeed,
  fetchSyncRuns,
  triggerFeedAction,
  updateAdminFeed,
} from "@/lib/client/api";

type Props = {
  initialFeeds: FeedConfig[];
  initialSyncRuns: SyncRun[];
};

type FeedFormState = {
  name: string;
  mode: FeedConfig["mode"];
  type: FeedConfig["type"];
  subscriptionId: string;
  urlOverride: string | null;
  pollIntervalMinutes: number;
  reconciliationIntervalMinutes: number;
  isActive: boolean;
  notes: string;
};

const EMPTY_FORM: FeedFormState = {
  name: "",
  mode: "hybrid",
  type: "dynamic",
  subscriptionId: "",
  urlOverride: null,
  pollIntervalMinutes: 2,
  reconciliationIntervalMinutes: 2,
  isActive: true,
  notes: "",
};

export function AdminConsole({ initialFeeds, initialSyncRuns }: Props) {
  const [feeds, setFeeds] = useState(initialFeeds);
  const [syncRuns, setSyncRuns] = useState(initialSyncRuns);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refreshSyncRuns() {
    setSyncRuns(await fetchSyncRuns());
  }

  async function handleCreate() {
    const created = await createAdminFeed(form);
    setFeeds((current) => [created, ...current]);
    setForm(EMPTY_FORM);
    await refreshSyncRuns();
  }

  async function handleSave(feed: FeedConfig) {
    setBusyId(feed.id);
    try {
      const updated = await updateAdminFeed(feed.id, feed);
      setFeeds((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(feedId: string) {
    setBusyId(feedId);
    try {
      await deleteAdminFeed(feedId);
      setFeeds((current) => current.filter((feed) => feed.id !== feedId));
    } finally {
      setBusyId(null);
    }
  }

  async function handleAction(feedId: string, action: "test" | "sync") {
    setBusyId(feedId);
    try {
      const run = await triggerFeedAction(feedId, action);
      setSyncRuns((current) => [run, ...current]);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
      <section className="glass-panel-strong rounded-[30px] p-5">
        <p className="metric-label mb-2">Control Plane</p>
        <h1 className="font-[var(--font-heading)] text-3xl font-semibold tracking-[-0.04em]">
          Mobilithek Feed-Management
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
          Feed hinzufügen, Delivery-Modus ändern, Intervalle anpassen, manuell testen oder synchronisieren. Zertifikate und Secrets bleiben außerhalb der UI im Secret-Management.
        </p>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),24rem]">
        <section className="space-y-4">
          <div className="glass-panel-strong rounded-[30px] p-5">
            <p className="metric-label mb-3">Neuen Feed anlegen</p>
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Feed Name"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <input
                value={form.subscriptionId}
                onChange={(event) =>
                  setForm({ ...form, subscriptionId: event.target.value })
                }
                placeholder="Subscription-ID"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <select
                value={form.type}
                onChange={(event) =>
                  setForm({ ...form, type: event.target.value as FeedConfig["type"] })
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
                value={form.pollIntervalMinutes}
                onChange={(event) =>
                  setForm({ ...form, pollIntervalMinutes: Number(event.target.value) })
                }
                placeholder="Pull-Intervall"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
              <input
                type="number"
                value={form.reconciliationIntervalMinutes}
                onChange={(event) =>
                  setForm({
                    ...form,
                    reconciliationIntervalMinutes: Number(event.target.value),
                  })
                }
                placeholder="Reconciliation"
                className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />
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

          {feeds.map((feed) => (
            <div key={feed.id} className="glass-panel-strong rounded-[30px] p-5">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <p className="metric-label mb-2">
                    {feed.type} · {feed.mode}
                  </p>
                  <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
                    {feed.name}
                  </h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Subscription: {feed.subscriptionId}
                  </p>
                </div>
                <label className="flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-sm">
                  aktiv
                  <input
                    type="checkbox"
                    checked={feed.isActive}
                    onChange={(event) =>
                      setFeeds((current) =>
                        current.map((entry) =>
                          entry.id === feed.id
                            ? { ...entry, isActive: event.target.checked }
                            : entry,
                        ),
                      )
                    }
                    className="accent-[var(--accent)]"
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <select
                  value={feed.mode}
                  onChange={(event) =>
                    setFeeds((current) =>
                      current.map((entry) =>
                        entry.id === feed.id
                          ? { ...entry, mode: event.target.value as FeedConfig["mode"] }
                          : entry,
                      ),
                    )
                  }
                  className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
                >
                  <option value="push">push</option>
                  <option value="pull">pull</option>
                  <option value="hybrid">hybrid</option>
                </select>

                <input
                  type="number"
                  value={feed.pollIntervalMinutes}
                  onChange={(event) =>
                    setFeeds((current) =>
                      current.map((entry) =>
                        entry.id === feed.id
                          ? {
                              ...entry,
                              pollIntervalMinutes: Number(event.target.value),
                            }
                          : entry,
                      ),
                    )
                  }
                  className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
                />

                <input
                  type="number"
                  value={feed.reconciliationIntervalMinutes}
                  onChange={(event) =>
                    setFeeds((current) =>
                      current.map((entry) =>
                        entry.id === feed.id
                          ? {
                              ...entry,
                              reconciliationIntervalMinutes: Number(event.target.value),
                            }
                          : entry,
                      ),
                    )
                  }
                  className="rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
                />

                <div className="rounded-2xl bg-white/80 px-3 py-2 text-sm text-[var(--muted)]">
                  Delta zuletzt: {feed.lastDeltaCount}
                </div>
              </div>

              <textarea
                value={feed.notes}
                onChange={(event) =>
                  setFeeds((current) =>
                    current.map((entry) =>
                      entry.id === feed.id ? { ...entry, notes: event.target.value } : entry,
                    ),
                  )
                }
                className="mt-3 min-h-20 w-full rounded-2xl border border-[var(--line)] bg-white/90 px-3 py-2"
              />

              <div className="mt-4 flex flex-wrap gap-2 text-sm">
                <button
                  type="button"
                  disabled={busyId === feed.id}
                  onClick={() => handleSave(feed)}
                  className="rounded-full bg-[var(--accent)] px-4 py-2 text-white disabled:opacity-60"
                >
                  Speichern
                </button>
                <button
                  type="button"
                  disabled={busyId === feed.id}
                  onClick={() => handleAction(feed.id, "test")}
                  className="rounded-full border border-[var(--line)] px-4 py-2"
                >
                  Testen
                </button>
                <button
                  type="button"
                  disabled={busyId === feed.id}
                  onClick={() => handleAction(feed.id, "sync")}
                  className="rounded-full border border-[var(--line)] px-4 py-2"
                >
                  Jetzt synchronisieren
                </button>
                <button
                  type="button"
                  disabled={busyId === feed.id}
                  onClick={() => handleDelete(feed.id)}
                  className="rounded-full border border-[#d8b3a0] px-4 py-2 text-[#9c4110]"
                >
                  Entfernen
                </button>
              </div>
            </div>
          ))}
        </section>

        <aside className="glass-panel-strong rounded-[30px] p-5">
          <p className="metric-label mb-2">Betrieb</p>
          <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
            Letzte Sync-Runs
          </h2>
          <div className="mt-4 space-y-3">
            {syncRuns.map((run) => (
              <div key={run.id} className="rounded-[24px] border border-[var(--line)] bg-white/80 p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <strong>{run.feedId}</strong>
                  <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs text-[var(--accent)]">
                    {run.status}
                  </span>
                </div>
                <p className="text-sm text-[var(--muted)]">{run.message}</p>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  {new Date(run.startedAt).toLocaleString("de-DE")}
                </p>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
