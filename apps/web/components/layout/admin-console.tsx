"use client";

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { Database, Activity, MapPin, Search, HardDrive, Edit2, X, RotateCcw, Save, Trash2 } from "lucide-react";
import type { AdminStationRecord, FeedConfig, SyncRun } from "@adhoc/shared";
import {
  cleanupStuckSyncRuns,
  createAdminFeed,
  deleteAdminFeed,
  deleteStationOverride,
  fetchAdminFeeds,
  fetchSyncRuns,
  saveStationOverride,
  searchAdminStations,
  terminateFeedRun,
  triggerFeedAction,
  updateAdminFeed,
} from "@/lib/client/api";

type Props = {
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

type FeedActionState = {
  kind: "create" | "save" | "delete" | "test" | "sync" | "terminate" | "cleanup";
  label: string;
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

const FEED_FIELD_DESCRIPTIONS = {
  cpoId: "Vorhandene CPO-ID aus der DB, normalerweise als lowercase Slug wie enbw oder tesla. Kein Freitext-Name. Leer lassen, wenn der Feed mehrere Betreiber enthält oder der CPO erst aus der Payload kommt.",
  name: "Freier Anzeigename für die Admin-Oberfläche. Am besten Betreiber + Feed-Art, damit du ihn sofort wiederfindest.",
  subscriptionId: "Die Mobilithek-Subscription-ID oder eindeutige Feed-ID. Dieser Wert identifiziert den Feed technisch.",
  urlOverride: "Optionaler direkter Feed-Endpunkt. Nur setzen, wenn der Standard-Endpunkt aus der Subscription nicht verwendet werden soll.",
  type: "Static für Stammdaten, Dynamic für Live-Status oder Preise. Davon hängen sinnvolle Ingest-Toggles und Intervalle ab.",
  mode: "Push = nur Webhook, Pull = nur Abruf, Hybrid = Webhook plus Fallback-Abruf/Reconciliation.",
  pollIntervalMinutes: "Abrufintervall in Minuten für Pull-Feeds. Leer bedeutet: kein automatischer Pull.",
  reconciliationIntervalMinutes: "Fallback-Intervall in Minuten für Push/Hybrid-Feeds. Leer bedeutet: kein zusätzlicher Abgleich.",
  credentialRef: "Schlüssel für Zertifikat oder Zugangsdaten. Muss zu den hinterlegten Secrets passen, z. B. ENBW oder TESLA.",
  webhookSecretRef: "Schlüssel für die Validierung eingehender Webhooks. Nur nötig, wenn der Feed per Push Daten sendet.",
  ingestCatalog: "Aktiviert die Übernahme von Standort- und Stammdaten.",
  ingestPrices: "Aktiviert die Übernahme von Tarifen und Preisständen.",
  ingestStatus: "Aktiviert die Übernahme von Verfügbarkeiten und Live-Status.",
  isActive: "Nur aktive Feeds werden automatisch verarbeitet.",
  notes: "Freie Admin-Notiz für Besonderheiten, Credentials, offene Punkte oder Betriebsdetails.",
} as const;

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

function toggleFeedExpansion(currentId: string | null, nextId: string) {
  return currentId === nextId ? null : nextId;
}

function loadingLabel(kind: FeedActionState["kind"]) {
  switch (kind) {
    case "create":
      return "Feed wird angelegt";
    case "save":
      return "Änderungen werden gespeichert";
    case "delete":
      return "Feed wird entfernt";
    case "test":
      return "Test läuft";
    case "sync":
      return "Sync läuft";
    case "terminate":
      return "Lauf wird beendet";
    case "cleanup":
      return "Timeout-Cleanup läuft";
    default:
      return "Läuft";
  }
}

function ActionSpinner() {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
      läuft
    </span>
  );
}

function FieldHint({ children }: { children: string }) {
  return <span className="text-xs leading-5 text-[var(--muted)]">{children}</span>;
}

function InfoCell({
  children,
  interactive = false,
}: {
  children: ReactNode;
  interactive?: boolean;
}) {
  return (
    <div
      className={
        interactive
          ? "rounded-[14px] border border-slate-200 bg-white px-3 py-2 shadow-sm"
          : "px-2 py-1 flex flex-col justify-center"
      }
    >
      {children}
    </div>
  );
}

type FeedEditorProps = {
  feed: FeedConfig;
  busy: FeedActionState | null;
  latestRun: SyncRun | undefined;
  onChange: (feedId: string, patch: Partial<FeedConfig>) => void;
  onSave: (feed: FeedConfig) => Promise<void>;
  onAction: (feedId: string, action: "test" | "sync") => Promise<void>;
  onDelete: (feedId: string) => Promise<void>;
};

function FeedEditor({
  feed,
  busy,
  latestRun,
  onChange,
  onSave,
  onAction,
  onDelete,
}: FeedEditorProps) {
  const disabled = busy != null;

  return (
    <div className="grid gap-4 rounded-[24px] border border-slate-300 bg-slate-100/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
      <div className="grid gap-4 xl:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          CPO-ID
          <input
            value={feed.cpoId ?? ""}
            onChange={(event) =>
              onChange(feed.id, { cpoId: parseNullableText(event.target.value) })
            }
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.cpoId}</FieldHint>
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          Subscription-ID
          <input
            value={feed.subscriptionId}
            onChange={(event) => onChange(feed.id, { subscriptionId: event.target.value })}
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.subscriptionId}</FieldHint>
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          Feed-Typ
          <select
            value={feed.type}
            onChange={(event) =>
              onChange(feed.id, {
                type: event.target.value as FeedConfig["type"],
              })
            }
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          >
            <option value="dynamic">dynamic</option>
            <option value="static">static</option>
          </select>
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.type}</FieldHint>
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          Modus
          <select
            value={feed.mode}
            onChange={(event) =>
              onChange(feed.id, { mode: event.target.value as FeedConfig["mode"] })
            }
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          >
            <option value="push">push</option>
            <option value="pull">pull</option>
            <option value="hybrid">hybrid</option>
          </select>
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.mode}</FieldHint>
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          Pull-Intervall
          <input
            type="number"
            value={feed.pollIntervalMinutes ?? ""}
            onChange={(event) =>
              onChange(feed.id, {
                pollIntervalMinutes: parseNullableInt(event.target.value),
              })
            }
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.pollIntervalMinutes}</FieldHint>
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          Reconciliation
          <input
            type="number"
            value={feed.reconciliationIntervalMinutes ?? ""}
            onChange={(event) =>
              onChange(feed.id, {
                reconciliationIntervalMinutes: parseNullableInt(event.target.value),
              })
            }
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.reconciliationIntervalMinutes}</FieldHint>
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          URL-Override
          <input
            value={feed.urlOverride ?? ""}
            onChange={(event) =>
              onChange(feed.id, { urlOverride: parseNullableText(event.target.value) })
            }
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.urlOverride}</FieldHint>
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          Credential-Ref
          <input
            value={feed.credentialRef ?? ""}
            onChange={(event) =>
              onChange(feed.id, { credentialRef: parseNullableText(event.target.value) })
            }
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.credentialRef}</FieldHint>
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          Webhook-Secret-Ref
          <input
            value={feed.webhookSecretRef ?? ""}
            onChange={(event) =>
              onChange(feed.id, { webhookSecretRef: parseNullableText(event.target.value) })
            }
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.webhookSecretRef}</FieldHint>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <label className="grid gap-1.5 rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-[var(--accent)] cursor-pointer">
          <span className="flex items-center justify-between gap-3">
            Feed aktiv
            <input
              type="checkbox"
              checked={feed.isActive}
              onChange={(event) => onChange(feed.id, { isActive: event.target.checked })}
              className="accent-[var(--accent)] h-4 w-4"
            />
          </span>
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.isActive}</FieldHint>
        </label>

        <label className="grid gap-1.5 rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-[var(--accent)] cursor-pointer">
          <span className="flex items-center justify-between gap-3">
            Catalog ingest
            <input
              type="checkbox"
              checked={feed.ingestCatalog}
              onChange={(event) => onChange(feed.id, { ingestCatalog: event.target.checked })}
              className="accent-[var(--accent)] h-4 w-4"
            />
          </span>
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.ingestCatalog}</FieldHint>
        </label>

        <label className="grid gap-1.5 rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-[var(--accent)] cursor-pointer">
          <span className="flex items-center justify-between gap-3">
            Preis ingest
            <input
              type="checkbox"
              checked={feed.ingestPrices}
              onChange={(event) => onChange(feed.id, { ingestPrices: event.target.checked })}
              className="accent-[var(--accent)] h-4 w-4"
            />
          </span>
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.ingestPrices}</FieldHint>
        </label>

        <label className="grid gap-1.5 rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-[var(--accent)] cursor-pointer">
          <span className="flex items-center justify-between gap-3">
            Status ingest
            <input
              type="checkbox"
              checked={feed.ingestStatus}
              onChange={(event) => onChange(feed.id, { ingestStatus: event.target.checked })}
              className="accent-[var(--accent)] h-4 w-4"
            />
          </span>
          <FieldHint>{FEED_FIELD_DESCRIPTIONS.ingestStatus}</FieldHint>
        </label>
      </div>

      <label className="grid gap-1.5 text-sm font-medium text-slate-700">
        Notizen
        <textarea
          value={feed.notes}
          onChange={(event) => onChange(feed.id, { notes: event.target.value })}
          className="w-full min-h-[100px] rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
        />
        <FieldHint>{FEED_FIELD_DESCRIPTIONS.notes}</FieldHint>
      </label>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-2xl border border-slate-300 bg-white px-4 py-3 shadow-sm">
            <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
              Letzte Fehlermeldung
            </div>
            <div className="mt-1 text-slate-700">{feed.lastErrorMessage ?? "Keine"}</div>
          </div>
          <div className="rounded-2xl border border-slate-300 bg-white px-4 py-3 shadow-sm">
            <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
              Cursor State
            </div>
            <div className="mt-1 break-all font-mono text-xs text-slate-700">
              {feed.cursorState ? JSON.stringify(feed.cursorState) : "leer"}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-300 bg-white px-4 py-3 shadow-sm">
            <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
              Letzter Lauf
            </div>
            <div className="mt-1 text-slate-700">
              {latestRun ? `${latestRun.kind} · ${latestRun.message}` : "Noch kein Lauf"}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-2 text-sm">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSave(feed)}
            className="rounded-full bg-[var(--accent)] px-4 py-2 text-white disabled:opacity-60"
          >
            {busy?.kind === "save" ? "Speichert..." : "Speichern"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAction(feed.id, "test")}
            className="rounded-full border border-[var(--line)] px-4 py-2 disabled:opacity-60"
          >
            {busy?.kind === "test" ? "Test läuft..." : "Testen"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAction(feed.id, "sync")}
            className="rounded-full border border-[var(--line)] px-4 py-2 disabled:opacity-60"
          >
            {busy?.kind === "sync" ? "Sync läuft..." : "Sync"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onDelete(feed.id)}
            className="rounded-full border border-[#d8b3a0] px-4 py-2 text-[#9c4110] disabled:opacity-60"
          >
            {busy?.kind === "delete" ? "Entfernt..." : "Entfernen"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AdminConsole({ initialFeeds, initialSyncRuns }: Props) {
  const [feeds, setFeeds] = useState(initialFeeds);
  const [syncRuns, setSyncRuns] = useState(initialSyncRuns);
  const [form, setForm] = useState(EMPTY_FORM);
  const [expandedFeedId, setExpandedFeedId] = useState<string | null>(null);
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [stationQuery, setStationQuery] = useState("");
  const [stationResults, setStationResults] = useState<AdminStationRecord[]>([]);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [stationError, setStationError] = useState<string | null>(null);
  const [overrideBusy, setOverrideBusy] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"feeds" | "runs" | "overrides">("feeds");
  const [feedActions, setFeedActions] = useState<Record<string, FeedActionState>>({});
  const [, startTransition] = useTransition();

  const runsByFeed = useMemo(() => {
    return syncRuns.reduce<Record<string, SyncRun[]>>((acc, run) => {
      acc[run.feedId] ??= [];
      acc[run.feedId].push(run);
      acc[run.feedId].sort(
        (left, right) =>
          new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
      );
      return acc;
    }, {});
  }, [syncRuns]);

  const selectedStation =
    stationResults.find((station) => station.stationId === selectedStationId) ?? null;
  const hasRunningRuns = syncRuns.some((run) => run.status === "running");

  useEffect(() => {
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
  }, [selectedStationId, startTransition, stationQuery]);

  useEffect(() => {
    if (!hasRunningRuns) {
      return;
    }

    const interval = window.setInterval(async () => {
      try {
        const [nextFeeds, nextRuns] = await Promise.all([fetchAdminFeeds(), fetchSyncRuns()]);
        setFeeds(nextFeeds);
        setSyncRuns(nextRuns);
      } catch (error) {
        console.error("[admin] polling failed", error);
      }
    }, 2500);

    return () => window.clearInterval(interval);
  }, [hasRunningRuns]);

  function setFeedAction(feedId: string, action: FeedActionState | null) {
    setFeedActions((current) => {
      if (!action) {
        const next = { ...current };
        delete next[feedId];
        return next;
      }

      return {
        ...current,
        [feedId]: action,
      };
    });
  }

  async function refreshAdminData() {
    const [nextFeeds, nextRuns] = await Promise.all([fetchAdminFeeds(), fetchSyncRuns()]);
    setFeeds(nextFeeds);
    setSyncRuns(nextRuns);
  }

  function patchFeed(feedId: string, patch: Partial<FeedConfig>) {
    setFeeds((current) =>
      current.map((entry) => (entry.id === feedId ? { ...entry, ...patch } : entry)),
    );
  }

  async function handleCreate() {
    setUiError(null);
    setFeedAction("__create__", { kind: "create", label: "Feed wird angelegt und synchronisiert" });
    try {
      const created = await createAdminFeed({
        ...form,
        cpoId: parseNullableText(form.cpoId ?? ""),
        urlOverride: parseNullableText(form.urlOverride ?? ""),
        credentialRef: parseNullableText(form.credentialRef ?? ""),
        webhookSecretRef: parseNullableText(form.webhookSecretRef ?? ""),
      });
      setFeeds((current) => [created, ...current]);
      setExpandedFeedId(created.id);
      setCreateFormOpen(false);
      setForm(EMPTY_FORM);

      try {
        const run = await triggerFeedAction(created.id, "sync");
        setSyncRuns((current) => [run, ...current.filter((entry) => entry.id !== run.id)]);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Automatischer Initial-Sync konnte nicht gestartet werden.";
        setUiError(`Feed wurde angelegt, aber der automatische Sync ist fehlgeschlagen: ${message}`);
      }

      await refreshAdminData();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Feed konnte nicht angelegt werden.");
    } finally {
      setFeedAction("__create__", null);
    }
  }

  async function handleSave(feed: FeedConfig) {
    setUiError(null);
    setFeedAction(feed.id, { kind: "save", label: "Änderungen werden gespeichert" });
    try {
      const updated = await updateAdminFeed(feed.id, feed);
      setFeeds((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Feed konnte nicht gespeichert werden.");
    } finally {
      setFeedAction(feed.id, null);
    }
  }

  async function handleDelete(feedId: string) {
    setUiError(null);
    setFeedAction(feedId, { kind: "delete", label: "Feed wird entfernt" });
    try {
      await deleteAdminFeed(feedId);
      setFeeds((current) => current.filter((feed) => feed.id !== feedId));
      setSyncRuns((current) => current.filter((run) => run.feedId !== feedId));
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Feed konnte nicht entfernt werden.");
    } finally {
      setFeedAction(feedId, null);
    }
  }

  async function handleAction(feedId: string, action: "test" | "sync") {
    setUiError(null);
    setFeedAction(feedId, {
      kind: action,
      label: action === "test" ? "Test läuft" : "Sync läuft",
    });

    try {
      const run = await triggerFeedAction(feedId, action);
      setSyncRuns((current) => [run, ...current.filter((entry) => entry.id !== run.id)]);

      if (run.status === "running") {
        await refreshAdminData();
      } else {
        try {
          await refreshAdminData();
        } catch (refreshError) {
          console.error("[admin] refresh after action failed", refreshError);
        }
      }
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Aktion konnte nicht ausgeführt werden.");
    } finally {
      setFeedAction(feedId, null);
    }
  }

  async function handleTerminate(feedId: string) {
    setUiError(null);
    setFeedAction(feedId, { kind: "terminate", label: "Lauf wird beendet" });

    try {
      await terminateFeedRun(feedId);
      await refreshAdminData();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Lauf konnte nicht beendet werden.");
    } finally {
      setFeedAction(feedId, null);
    }
  }

  async function handleCleanupStuckRuns() {
    setUiError(null);
    setFeedAction("__cleanup__", {
      kind: "cleanup",
      label: "Timeout-Cleanup läuft",
    });

    try {
      await cleanupStuckSyncRuns();
      await refreshAdminData();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Cleanup konnte nicht ausgeführt werden.");
    } finally {
      setFeedAction("__cleanup__", null);
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
    <div className="mx-auto flex max-w-[1600px] gap-6 items-start lg:flex-row flex-col">
      {/* Sidebar Navigation */}
      <nav className="sticky top-6 flex w-full flex-col gap-2 rounded-[30px] p-5 glass-panel-strong shadow-[0_20px_40px_rgba(16,31,27,0.08)] lg:w-72 lg:shrink-0">
        <div className="mb-6 px-2">
          <h1 className="font-[var(--font-heading)] text-2xl font-bold tracking-[-0.04em] text-slate-800">
            Adhoc Admin
          </h1>
          <p className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
            <HardDrive className="h-3.5 w-3.5" />
            Postgres / Supabase
          </p>
        </div>

        <button
          onClick={() => setActiveTab("feeds")}
          className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition ${
            activeTab === "feeds"
              ? "bg-[var(--accent)] text-white shadow-md"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Database className="h-4 w-4" />
          Data Feeds
          <span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${activeTab === "feeds" ? 'bg-white/25' : 'bg-slate-200'}`}>
            {feeds.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab("runs")}
          className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition ${
            activeTab === "runs"
              ? "bg-[var(--accent)] text-white shadow-md"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Activity className="h-4 w-4" />
          Sync Läufe
          {hasRunningRuns && (
             <span className="ml-auto flex h-2 w-2 rounded-full bg-[#f59e0b] animate-pulse" />
          )}
        </button>

        <button
          onClick={() => setActiveTab("overrides")}
          className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition ${
            activeTab === "overrides"
              ? "bg-[var(--accent)] text-white shadow-md"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <MapPin className="h-4 w-4" />
          Overrides
        </button>
      </nav>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col gap-5 w-full">
        {uiError ? (
          <div className="rounded-[24px] border border-[#fca5a5] bg-[#fef2f2] px-5 py-4 text-sm font-medium text-[#b91c1c] shadow-sm">
            {uiError}
          </div>
        ) : null}

        {/* FEED TAB */}
        {activeTab === "feeds" && (
          <div className="flex flex-col gap-5 flex-1 animate-in fade-in slide-in-from-bottom-2 duration-300">

      <section className="glass-panel-strong rounded-[30px] p-5">
        <button
          type="button"
          onClick={() => setCreateFormOpen((current) => !current)}
          className="flex w-full items-start justify-between gap-4 rounded-[24px] border border-slate-300 bg-white px-4 py-4 text-left shadow-sm transition hover:border-slate-400 hover:bg-slate-50"
        >
          <div>
            <p className="metric-label">Neuer Feed</p>
            <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
              Feed anlegen
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
              Neues Feed-Setup oben aufklappen, Felder direkt mit Kurzbeschreibung ausfüllen und
              danach sofort testen.
            </p>
          </div>
          <span className="rounded-full border border-slate-300 bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">
            {createFormOpen ? "eingeklappt anzeigen" : "aufklappen"}
          </span>
        </button>

        {createFormOpen ? (
          <div className="mt-5 grid gap-4 rounded-[26px] border border-[var(--line)] bg-white/70 p-4">
            <div className="grid gap-4 xl:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                CPO-ID
                <input
                  value={form.cpoId ?? ""}
                  onChange={(event) => setForm({ ...form, cpoId: event.target.value })}
                  placeholder="z. B. ENBW"
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                />
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.cpoId}</FieldHint>
              </label>

              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Feed-Name
                <input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="z. B. EnBW Dynamic AFIR"
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                />
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.name}</FieldHint>
              </label>

              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Subscription-ID
                <input
                  value={form.subscriptionId}
                  onChange={(event) => setForm({ ...form, subscriptionId: event.target.value })}
                  placeholder="Technische Feed-ID von Mobilithek"
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                />
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.subscriptionId}</FieldHint>
              </label>

              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                URL-Override
                <input
                  value={form.urlOverride ?? ""}
                  onChange={(event) => setForm({ ...form, urlOverride: event.target.value })}
                  placeholder="Optionaler Direktlink"
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                />
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.urlOverride}</FieldHint>
              </label>

              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Feed-Typ
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
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                >
                  <option value="dynamic">dynamic</option>
                  <option value="static">static</option>
                </select>
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.type}</FieldHint>
              </label>

              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Modus
                <select
                  value={form.mode}
                  onChange={(event) =>
                    setForm({ ...form, mode: event.target.value as FeedConfig["mode"] })
                  }
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                >
                  <option value="push">push</option>
                  <option value="pull">pull</option>
                  <option value="hybrid">hybrid</option>
                </select>
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.mode}</FieldHint>
              </label>

              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Pull-Intervall
                <input
                  type="number"
                  value={form.pollIntervalMinutes ?? ""}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      pollIntervalMinutes: parseNullableInt(event.target.value),
                    })
                  }
                  placeholder="z. B. 2"
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                />
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.pollIntervalMinutes}</FieldHint>
              </label>

              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Reconciliation
                <input
                  type="number"
                  value={form.reconciliationIntervalMinutes ?? ""}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      reconciliationIntervalMinutes: parseNullableInt(event.target.value),
                    })
                  }
                  placeholder="z. B. 15"
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                />
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.reconciliationIntervalMinutes}</FieldHint>
              </label>

              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Credential-Ref
                <input
                  value={form.credentialRef ?? ""}
                  onChange={(event) => setForm({ ...form, credentialRef: event.target.value })}
                  placeholder="z. B. ENBW"
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                />
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.credentialRef}</FieldHint>
              </label>

              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Webhook-Secret-Ref
                <input
                  value={form.webhookSecretRef ?? ""}
                  onChange={(event) => setForm({ ...form, webhookSecretRef: event.target.value })}
                  placeholder="z. B. ENBW_WEBHOOK"
                  className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                />
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.webhookSecretRef}</FieldHint>
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <label className="grid gap-1.5 rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-[var(--accent)] cursor-pointer">
                <span className="flex items-center justify-between gap-3">
                  Catalog ingest
                  <input
                    type="checkbox"
                    checked={form.ingestCatalog}
                    onChange={(event) => setForm({ ...form, ingestCatalog: event.target.checked })}
                    className="accent-[var(--accent)] h-4 w-4"
                  />
                </span>
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.ingestCatalog}</FieldHint>
              </label>

              <label className="grid gap-1.5 rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-[var(--accent)] cursor-pointer">
                <span className="flex items-center justify-between gap-3">
                  Preis ingest
                  <input
                    type="checkbox"
                    checked={form.ingestPrices}
                    onChange={(event) => setForm({ ...form, ingestPrices: event.target.checked })}
                    className="accent-[var(--accent)] h-4 w-4"
                  />
                </span>
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.ingestPrices}</FieldHint>
              </label>

              <label className="grid gap-1.5 rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-[var(--accent)] cursor-pointer">
                <span className="flex items-center justify-between gap-3">
                  Status ingest
                  <input
                    type="checkbox"
                    checked={form.ingestStatus}
                    onChange={(event) => setForm({ ...form, ingestStatus: event.target.checked })}
                    className="accent-[var(--accent)] h-4 w-4"
                  />
                </span>
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.ingestStatus}</FieldHint>
              </label>

              <label className="grid gap-1.5 rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-[var(--accent)] cursor-pointer">
                <span className="flex items-center justify-between gap-3">
                  Feed aktiv
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
                    className="accent-[var(--accent)] h-4 w-4"
                  />
                </span>
                <FieldHint>{FEED_FIELD_DESCRIPTIONS.isActive}</FieldHint>
              </label>
            </div>

            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              Notizen
              <textarea
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                placeholder="Besonderheiten, Zertifikats-Hinweise, offene To-dos"
                className="w-full min-h-[100px] rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
              />
              <FieldHint>{FEED_FIELD_DESCRIPTIONS.notes}</FieldHint>
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleCreate}
                disabled={Boolean(feedActions.__create__)}
                className="rounded-2xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {feedActions.__create__ ? "Legt an..." : "Feed anlegen"}
              </button>
              {feedActions.__create__ ? (
                <span className="text-sm text-[var(--muted)]">
                  <ActionSpinner />
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="glass-panel-strong rounded-[30px] p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="metric-label">Feeds</p>
            <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
              Datenfeed-Liste
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
              Kompakte Übersicht wie eine Tabelle. Klick auf eine Zeile öffnet die Details direkt darunter.
            </p>
          </div>
          <div className="rounded-full bg-white/80 px-3 py-2 text-sm text-[var(--muted)]">
            {feeds.length} Feed{feeds.length === 1 ? "" : "s"}
          </div>
        </div>

        <div className="overflow-hidden rounded-[26px] border shadow-sm border-slate-200 bg-white">
          <div className="hidden gap-3 border-b border-slate-100 bg-slate-50/80 px-5 py-3.5 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.2fr)_300px]">
            <span className="px-2">Feed</span>
            <span className="px-2">Typ</span>
            <span className="px-2">Intervall</span>
            <span className="px-2">Letzter Erfolg</span>
            <span className="px-2">Letztes Ergebnis</span>
            <span className="px-2 text-right">Aktionen</span>
          </div>

          <div className="divide-y divide-slate-100">
            {feeds.map((feed) => {
              const latestRun = runsByFeed[feed.id]?.[0];
              const health = healthForFeed(feed, latestRun);
              const isExpanded = expandedFeedId === feed.id;
              const busy = feedActions[feed.id] ?? null;
              const actionStatusText = busy?.label ?? latestRun?.message ?? health.detail;
              const latestRunLabel = latestRun?.status ?? health.label;
              const latestRunTone = latestRun ? statusTone(latestRun.status) : health.tone;

              return (
                <div key={feed.id} className={`transition-colors duration-200 ${isExpanded ? "bg-slate-50/50" : "bg-white hover:bg-slate-50/30"}`}>
                  <div className="px-4 py-4 lg:px-5">
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.2fr)_300px] lg:items-center">
                      <button
                        type="button"
                        onClick={() => setExpandedFeedId((current) => toggleFeedExpansion(current, feed.id))}
                        className="flex min-w-0 items-start gap-4 rounded-[18px] border border-transparent px-2 py-2 text-left transition hover:border-[var(--accent)]/30 hover:bg-[var(--accent)]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/30"
                      >
                        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100/80 text-[10px] font-bold text-slate-600">
                          {isExpanded ? <X className="h-3 w-3" /> : <Edit2 className="h-3 w-3" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-[var(--font-heading)] text-lg font-semibold tracking-[-0.03em] text-slate-900">
                            {feed.name}
                          </span>
                          <span className="mt-1 block truncate text-sm text-[var(--muted)]">
                            {feed.subscriptionId}
                          </span>
                          <span className="mt-2 flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${health.tone}`}>
                              {health.label}
                            </span>
                            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              {feed.cpoId ?? "ohne CPO"}
                            </span>
                          </span>
                        </span>
                      </button>

                      <InfoCell>
                        <div className="flex flex-col items-start gap-1.5 text-sm">
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-600">
                            {feed.type}
                          </span>
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-600">
                            {feed.mode}
                          </span>
                        </div>
                      </InfoCell>

                      <InfoCell>
                        <div className="text-sm text-slate-700">{intervalLabel(feed)}</div>
                      </InfoCell>

                      <InfoCell>
                        <div className="text-sm text-slate-700">
                          <div>{formatDateTime(feed.lastSuccessAt)}</div>
                          <div className="mt-1 text-xs text-[var(--muted)]">
                            {formatRelativeMinutes(feed.lastSuccessAt)}
                          </div>
                        </div>
                      </InfoCell>

                      <InfoCell>
                        <div className="text-sm text-slate-700">
                          <div className="flex items-center gap-2">
                            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${latestRunTone}`}>
                              {busy?.kind === "test" || busy?.kind === "sync" ? (
                                <ActionSpinner />
                              ) : (
                                latestRunLabel
                              )}
                            </span>
                            <span className="truncate text-xs text-[var(--muted)]">
                              {latestRun ? new Date(latestRun.startedAt).toLocaleTimeString("de-DE") : ""}
                            </span>
                          </div>
                          <div className="mt-2 line-clamp-2 text-sm">
                            {busy ? loadingLabel(busy.kind) : actionStatusText}
                          </div>
                        </div>
                      </InfoCell>

                      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => void handleAction(feed.id, "test")}
                          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60 flex items-center gap-2"
                        >
                          <Activity className="h-3.5 w-3.5 text-slate-400" />
                          Testen
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => void handleAction(feed.id, "sync")}
                          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60 flex items-center gap-2"
                        >
                          <RotateCcw className="h-3.5 w-3.5 text-slate-400" />
                          Sync
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => void handleDelete(feed.id)}
                          className="rounded-full border border-[#fca5a5] bg-white px-4 py-2 text-sm font-semibold text-[#ef4444] shadow-sm transition hover:bg-[#fef2f2] disabled:opacity-60"
                        >
                          Entfernen
                        </button>
                      </div>
                    </div>

                    {isExpanded ? (
                      <div className="mt-4 rounded-[26px] bg-slate-50 p-4 border border-slate-200 shadow-inner">
                        <FeedEditor
                          feed={feed}
                          busy={busy}
                          latestRun={latestRun}
                          onChange={patchFeed}
                          onSave={handleSave}
                          onAction={handleAction}
                          onDelete={handleDelete}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
        </div>
        )}

        {/* RUNS TAB */}
        {activeTab === "runs" && (
          <div className="flex flex-col gap-5 flex-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <section className="glass-panel-strong rounded-[30px] p-5 flex-1">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="metric-label">Status & Fehler</p>
              <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
                Letzte Läufe
              </h2>
            </div>
            <div className="flex items-center gap-3">
              {hasRunningRuns ? (
                <div className="rounded-full bg-[#fff8df] px-3 py-2 text-sm text-[#7a5f00]">
                  <ActionSpinner />
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => void handleCleanupStuckRuns()}
                disabled={Boolean(feedActions.__cleanup__)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
              >
                {feedActions.__cleanup__ ? "Bereinigt..." : "Timeout-Cleanup"}
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {syncRuns.slice(0, 12).map((run) => (
              <div
                key={run.id}
                className="rounded-[16px] border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <strong>{run.kind}</strong>
                    <p className="text-xs text-[var(--muted)]">{run.feedId}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs ${statusTone(run.status)}`}>
                    {run.status === "running" ? <ActionSpinner /> : run.status}
                  </span>
                </div>
                <p className="text-sm text-slate-700">{run.message}</p>
                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                  <span>{new Date(run.startedAt).toLocaleString("de-DE")}</span>
                  <div className="flex items-center gap-3">
                    <span>Delta {run.deltaCount}</span>
                    {run.status === "running" ? (
                      <button
                        type="button"
                        onClick={() => void handleTerminate(run.feedId)}
                        disabled={Boolean(feedActions[run.feedId])}
                        className="rounded-full border border-[#fca5a5] bg-white px-3 py-1 text-xs font-semibold text-[#ef4444] shadow-sm transition hover:bg-[#fef2f2] disabled:opacity-60"
                      >
                        {feedActions[run.feedId]?.kind === "terminate"
                          ? "Beendet..."
                          : "Beenden erzwingen"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
            </section>
          </div>
        )}

        {/* OVERRIDES TAB */}
        {activeTab === "overrides" && (
          <div className="flex flex-col gap-5 flex-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <section className="glass-panel-strong rounded-[30px] p-5 flex-1">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="metric-label">Overrides</p>
              <h2 className="font-[var(--font-heading)] text-2xl font-semibold tracking-[-0.04em]">
                Stations-Korrekturen
              </h2>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="space-y-3">
                <div className="relative">
                  <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={stationQuery}
                    onChange={(event) => setStationQuery(event.target.value)}
                    placeholder="Station, CPO, Adresse oder Code suchen"
                    className="w-full rounded-[14px] border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                  />
                </div>
                <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                  {stationResults.map((station) => (
                    <button
                      key={station.stationId}
                      type="button"
                      onClick={() => setSelectedStationId(station.stationId)}
                      className={`w-full rounded-[14px] border px-4 py-3 text-left transition ${
                        selectedStation?.stationId === station.stationId
                          ? "border-[var(--accent)] bg-[var(--accent)]/5 shadow-sm"
                          : "border-slate-200 bg-white hover:border-slate-300"
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
                    <div className="rounded-[16px] border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="font-[var(--font-heading)] text-lg font-semibold text-slate-800">{selectedStation.sourceName}</div>
                      <div className="mt-1 flex items-center gap-2 text-sm text-[var(--muted)]">
                        <Database className="h-3 w-3" />
                        Quelle: {selectedStation.cpoName} · {selectedStation.stationCode}
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="grid gap-1.5 text-sm font-medium text-slate-700">
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
                          className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                        />
                      </label>
                      <label className="grid gap-1.5 text-sm font-medium text-slate-700">
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
                          className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                        />
                      </label>
                      <label className="grid gap-1.5 text-sm font-medium text-slate-700">
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
                          className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                        />
                      </label>
                      <label className="grid gap-1.5 text-sm font-medium text-slate-700">
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
                          className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                        />
                      </label>
                      <label className="grid gap-1.5 text-sm font-medium text-slate-700">
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
                          className="w-full rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                        />
                      </label>
                      <label className="flex items-center justify-between rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-[var(--accent)] cursor-pointer">
                        Verstecken (Nicht anzeigen)
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
                          className="accent-[var(--accent)] h-4 w-4"
                        />
                      </label>
                    </div>

                    <label className="grid gap-1.5 text-sm font-medium text-slate-700">
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
                        className="w-full min-h-[100px] rounded-[14px] border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                      />
                    </label>

                    {stationError ? (
                      <div className="rounded-[14px] border border-[#fca5a5] bg-[#fef2f2] px-4 py-3 text-sm font-medium text-[#b91c1c] shadow-sm">
                        {stationError}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-3 mt-2">
                      <button
                        type="button"
                        disabled={overrideBusy === selectedStation.stationId}
                        onClick={handleSaveOverride}
                        className="flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:bg-[var(--accent-hover)] hover:shadow-lg disabled:opacity-60"
                      >
                        <Save className="h-4 w-4" />
                        Override speichern
                      </button>
                      <button
                        type="button"
                        disabled={overrideBusy === selectedStation.stationId}
                        onClick={handleClearOverride}
                        className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
                      >
                        <Trash2 className="h-4 w-4 text-slate-400" />
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
        </section>
          </div>
        )}
      </div>
    </div>
  );
}
