"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowRight,
  Crosshair,
  LocateFixed,
  MapPinned,
  Search,
  X,
} from "lucide-react";
import type { LocationSuggestion } from "@adhoc/shared";
import {
  fetchIpLocation,
  fetchLocationSuggestions,
  fetchReverseLocation,
} from "@/lib/client/api";

type FieldName = "origin" | "destination" | "location";
type SearchMode = "route" | "location";

export type SearchQueryState = {
  mode: SearchMode;
  origin: string;
  originLabel: string;
  destination: string;
  destinationLabel: string;
  location: string;
  locationLabel: string;
};

type Props = {
  query: SearchQueryState;
  onChange: (next: SearchQueryState) => void;
  onSubmit: () => void;
  pending: boolean;
};

function fallbackCurrentLocation(lat: number, lng: number): LocationSuggestion {
  const inputLabel = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  return {
    id: `current-${inputLabel}`,
    label: "Aktuelle Position",
    secondaryLabel: inputLabel,
    inputLabel,
    query: inputLabel,
    coordinates: { lat, lng },
  };
}

export function RouteSearchBar({ query, onChange, onSubmit, pending }: Props) {
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [activeField, setActiveField] = useState<FieldName | null>(null);
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [currentLocationLoading, setCurrentLocationLoading] = useState(false);
  const [currentLocationError, setCurrentLocationError] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const originInputRef = useRef<HTMLInputElement>(null);
  const locationInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mobileExpanded) {
      // Focus after a brief timeout to let the CSS transition run
      setTimeout(() => {
        if (query.mode === "route") {
          originInputRef.current?.focus();
        } else {
          locationInputRef.current?.focus();
        }
      }, 50);
    }
  }, [mobileExpanded, query.mode]);

  function fullSummaryLabel(label: string, fallback: string) {
    const trimmed = label.trim();
    return trimmed || fallback;
  }

  const getSearchSummary = () => {
    if (query.mode === "route") {
      const from = query.originLabel ? query.originLabel.split(",")[0] : 'Start';
      const to = query.destinationLabel ? query.destinationLabel.split(",")[0] : 'Ziel';
      if (!query.originLabel && !query.destinationLabel) return 'Route planen';
      return `${from} → ${to}`;
    }
    return fullSummaryLabel(query.locationLabel, 'Wo möchtest du laden?');
  };

  const activeValue =
    activeField === "origin"
      ? query.originLabel
      : activeField === "destination"
        ? query.destinationLabel
        : activeField === "location"
          ? query.locationLabel
          : "";

  useEffect(() => {
    const trimmed = activeValue.trim();
    if (!activeField || trimmed.length < 2) {
      return;
    }

    let ignore = false;
    const timeout = window.setTimeout(async () => {
      setSuggestionsLoading(true);

      try {
        const next = await fetchLocationSuggestions(trimmed);
        if (!ignore) {
          setSuggestions(next);
          setHighlightedIndex(next.length ? 1 : 0);
        }
      } catch {
        if (!ignore) {
          setSuggestions([]);
          setHighlightedIndex(0);
        }
      } finally {
        if (!ignore) {
          setSuggestionsLoading(false);
        }
      }
    }, 180);

    return () => {
      ignore = true;
      window.clearTimeout(timeout);
    };
  }, [activeField, activeValue]);

  function setFieldText(field: FieldName, value: string) {
    if (field === "origin") {
      onChange({
        ...query,
        origin: value,
        originLabel: value,
      });
      return;
    }

    if (field === "location") {
      onChange({
        ...query,
        location: value,
        locationLabel: value,
      });
      return;
    }

    onChange({
      ...query,
      destination: value,
      destinationLabel: value,
    });
  }

  function applySuggestion(field: FieldName, suggestion: LocationSuggestion) {
    if (field === "origin") {
      onChange({
        ...query,
        origin: suggestion.query,
        originLabel: suggestion.inputLabel,
      });
    } else if (field === "location") {
      onChange({
        ...query,
        location: suggestion.query,
        locationLabel: suggestion.inputLabel,
      });
    } else {
      onChange({
        ...query,
        destination: suggestion.query,
        destinationLabel: suggestion.inputLabel,
      });
    }

    setActiveField(null);
    setSuggestions([]);
    setHighlightedIndex(-1);
    setCurrentLocationError(null);
  }

  function requestCurrentPosition(enableHighAccuracy: boolean) {
    return new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy,
        timeout: enableHighAccuracy ? 8000 : 6000,
        maximumAge: enableHighAccuracy ? 60_000 : 300_000,
      });
    });
  }

  function currentLocationErrorMessage(error?: GeolocationPositionError | null) {
    if (typeof window !== "undefined" && !window.isSecureContext) {
      return "Standort nur in sicherem Kontext verfuegbar.";
    }

    if (!error) {
      return "Aktuelle Position konnte nicht ermittelt werden.";
    }

    if (error.code === error.PERMISSION_DENIED) {
      return "Standortfreigabe im Browser erlauben.";
    }

    if (error.code === error.TIMEOUT) {
      return "Standortsuche hat zu lange gedauert.";
    }

    return "Aktuelle Position konnte nicht ermittelt werden.";
  }

  async function handleCurrentLocation(field: FieldName) {
    if (!("geolocation" in navigator)) {
      setCurrentLocationError("Browser unterstuetzt keine Standortabfrage.");
      return;
    }

    setCurrentLocationError(null);
    setCurrentLocationLoading(true);

    try {
      let position: GeolocationPosition;

      try {
        position = await requestCurrentPosition(true);
      } catch (error) {
        const geoError = error as GeolocationPositionError;
        if (geoError.code === geoError.TIMEOUT) {
          position = await requestCurrentPosition(false);
        } else {
          throw geoError;
        }
      }

      try {
        const suggestion = await fetchReverseLocation(
          position.coords.latitude,
          position.coords.longitude,
        );
        applySuggestion(field, suggestion);
      } catch {
        applySuggestion(
          field,
          fallbackCurrentLocation(position.coords.latitude, position.coords.longitude),
        );
      }
    } catch (error) {
      try {
        const suggestion = await fetchIpLocation();
        applySuggestion(field, suggestion);
        setCurrentLocationError("Nur ungefaehre Position per IP verwendet.");
      } catch {
        setCurrentLocationError(
          currentLocationErrorMessage(error as GeolocationPositionError | null),
        );
      }
    } finally {
      setCurrentLocationLoading(false);
    }
  }

  function selectHighlighted(field: FieldName) {
    if (highlightedIndex === 0) {
      void handleCurrentLocation(field);
      return;
    }

    const suggestion = suggestions[highlightedIndex - 1];
    if (suggestion) {
      applySuggestion(field, suggestion);
    }
  }

  function suggestionPanel(field: FieldName) {
    if (activeField !== field) {
      return null;
    }

    const showPanel =
      activeField === field ||
      currentLocationLoading ||
      Boolean(currentLocationError) ||
      suggestionsLoading ||
      suggestions.length > 0 ||
      activeValue.trim().length > 0;

    if (!showPanel) {
      return null;
    }

    return (
      <div className="overflow-hidden rounded-[26px] border border-white/8 bg-[#111111] text-white shadow-[0_22px_70px_rgba(0,0,0,0.38)]">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void handleCurrentLocation(field)}
          className={`flex w-full items-center gap-3 border-b border-white/10 px-4 py-3 text-left transition hover:bg-white/5 ${
            highlightedIndex === 0 ? "bg-white/6" : ""
          }`}
        >
          <Crosshair className="h-4 w-4 text-white/70" />
          <div>
            <p className="text-[0.95rem]">Meine Position</p>
            <p className={`text-xs ${currentLocationError ? "text-[#ffb3a8]" : "text-white/45"}`}>
              {currentLocationLoading
                ? "Position wird ermittelt..."
                : currentLocationError ?? "Aktuelle Position verwenden"}
            </p>
          </div>
        </button>

        {suggestionsLoading && suggestions.length === 0 ? (
          <div className="px-4 py-3 text-sm text-white/55">Suche Vorschlaege...</div>
        ) : null}

        {suggestions.map((suggestion, index) => (
          <button
            key={suggestion.id}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applySuggestion(field, suggestion)}
            className={`flex w-full items-start gap-3 border-b border-white/10 px-4 py-3 text-left transition last:border-b-0 hover:bg-white/5 ${
              highlightedIndex === index + 1 ? "bg-white/6" : ""
            }`}
          >
            <Search className="mt-0.5 h-4 w-4 shrink-0 text-white/45" />
            <div className="min-w-0">
              <p className="truncate text-[0.95rem] leading-6 text-[#75a7ff]">
                {suggestion.label}
              </p>
              {suggestion.secondaryLabel ? (
                <p className="truncate text-sm text-white/60">{suggestion.secondaryLabel}</p>
              ) : null}
            </div>
          </button>
        ))}
      </div>
    );
  }

  function handleKeyDown(field: FieldName, event: KeyboardEvent<HTMLInputElement>) {
    const optionCount = suggestions.length + 1;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) => {
        const start = suggestions.length ? 1 : 0;
        if (current < 0) {
          return start;
        }
        return Math.min(optionCount - 1, current + 1);
      });
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (event.key === "Escape") {
      setActiveField(null);
      setSuggestions([]);
      setHighlightedIndex(-1);
      return;
    }

    if (event.key === "Enter") {
      if (activeField === field && highlightedIndex >= 0) {
        event.preventDefault();
        selectHighlighted(field);
        return;
      }

      event.preventDefault();
      onSubmit();
    }
  }

  function resetOverlay() {
    setActiveField(null);
    setSuggestions([]);
    setCurrentLocationError(null);
    setHighlightedIndex(-1);
  }

  return (
    <>
      {/* Mobile Pill (Collapsed) */}
      <button 
        type="button" 
        onClick={() => setMobileExpanded(true)}
        className={`flex w-full items-center gap-3 px-5 py-3.5 text-left transition hover:bg-white/50 sm:hidden ${mobileExpanded ? 'hidden' : 'flex'}`}
      >
        <Search className="h-[18px] w-[18px] shrink-0 text-[var(--muted)]" />
        <span className="flex-1 truncate font-medium text-[var(--foreground)] tracking-tight">
          {getSearchSummary()}
        </span>
      </button>

      {/* Expanded Interface & Desktop */}
      <section className={`flex-col p-4 pb-2 sm:p-5 ${mobileExpanded ? 'flex' : 'hidden sm:flex'}`}>
        <div className="relative flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-1">
          <p className="metric-label flex items-center gap-2">
            <MapPinned className="h-3.5 w-3.5" />
            Ladesaeulen-Suche
          </p>
          <div className="rounded-full border border-[var(--line)] bg-white/80 px-2 py-0.5 text-[0.65rem] text-[var(--muted)] shadow-inner">
            DATEX-II / Mobilithek
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              resetOverlay();
              onChange({
                ...query,
                mode: "route",
              });
            }}
            className={`rounded-full px-3 py-1.5 text-sm transition ${
              query.mode === "route"
                ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                : "border border-[var(--line)] bg-white/82 text-[var(--foreground)]"
            }`}
          >
            Route
          </button>
          <button
            type="button"
            onClick={() => {
              resetOverlay();
              onChange({
                ...query,
                mode: "location",
              });
            }}
            className={`rounded-full px-3 py-1.5 text-sm transition ${
              query.mode === "location"
                ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                : "border border-[var(--line)] bg-white/82 text-[var(--foreground)]"
            }`}
          >
            Standort
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {query.mode === "route" ? (
            <>
              <div className="flex flex-col gap-2">
                <label className="glass-panel relative flex items-center gap-2 rounded-2xl px-4 py-2.5">
                  <LocateFixed className="h-4 w-4 shrink-0 text-[var(--muted)]" />
                  <input
                    value={query.originLabel}
                    onFocus={() => {
                      setActiveField("origin");
                      if (query.originLabel.trim().length < 2) {
                        setSuggestions([]);
                        setHighlightedIndex(0);
                      }
                    }}
                    onBlur={() => {
                      window.setTimeout(() => {
                        setActiveField((current) => (current === "origin" ? null : current));
                        setSuggestions([]);
                        setHighlightedIndex(-1);
                      }, 120);
                    }}
                    onKeyDown={(event) => handleKeyDown("origin", event)}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setFieldText("origin", nextValue);
                      if (nextValue.trim().length < 2) {
                        setSuggestions([]);
                        setHighlightedIndex(0);
                      }
                    }}
                    ref={originInputRef}
                    placeholder="Start"
                    className="w-full bg-transparent pr-6 text-sm outline-none placeholder:text-[var(--muted)]"
                  />
                  {query.originLabel && (
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setFieldText("origin", "");
                        originInputRef.current?.focus();
                      }}
                      className="absolute right-3 p-1 text-[var(--muted)] hover:text-[var(--foreground)] outline-none"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </label>
                {suggestionPanel("origin")}
              </div>

              <div className="flex flex-col gap-2">
                <label className="glass-panel relative flex items-center gap-2 rounded-2xl px-4 py-2.5">
                  <ArrowRight className="h-4 w-4 shrink-0 text-[var(--muted)]" />
                  <input
                    value={query.destinationLabel}
                    onFocus={() => {
                      setActiveField("destination");
                      if (query.destinationLabel.trim().length < 2) {
                        setSuggestions([]);
                        setHighlightedIndex(0);
                      }
                    }}
                    onBlur={() => {
                      window.setTimeout(() => {
                        setActiveField((current) => (current === "destination" ? null : current));
                        setSuggestions([]);
                        setHighlightedIndex(-1);
                      }, 120);
                    }}
                    onKeyDown={(event) => handleKeyDown("destination", event)}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setFieldText("destination", nextValue);
                      if (nextValue.trim().length < 2) {
                        setSuggestions([]);
                        setHighlightedIndex(0);
                      }
                    }}
                    placeholder="Ziel"
                    className="w-full bg-transparent pr-6 text-sm outline-none placeholder:text-[var(--muted)]"
                  />
                  {query.destinationLabel && (
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setFieldText("destination", "");
                      }}
                      className="absolute right-3 p-1 text-[var(--muted)] hover:text-[var(--foreground)] outline-none"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </label>
                {suggestionPanel("destination")}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="glass-panel relative flex items-center gap-2 rounded-2xl px-4 py-2.5">
                <LocateFixed className="h-4 w-4 shrink-0 text-[var(--muted)]" />
                <input
                  value={query.locationLabel}
                  onFocus={() => {
                    setActiveField("location");
                    if (query.locationLabel.trim().length < 2) {
                      setSuggestions([]);
                      setHighlightedIndex(0);
                    }
                  }}
                  onBlur={() => {
                    window.setTimeout(() => {
                      setActiveField((current) => (current === "location" ? null : current));
                      setSuggestions([]);
                      setHighlightedIndex(-1);
                    }, 120);
                  }}
                  onKeyDown={(event) => handleKeyDown("location", event)}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setFieldText("location", nextValue);
                    if (nextValue.trim().length < 2) {
                      setSuggestions([]);
                      setHighlightedIndex(0);
                    }
                  }}
                  ref={locationInputRef}
                  placeholder="Ort oder Adresse"
                  className="w-full bg-transparent pr-6 text-sm outline-none placeholder:text-[var(--muted)]"
                />
                {query.locationLabel && (
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setFieldText("location", "");
                      locationInputRef.current?.focus();
                    }}
                    className="absolute right-3 p-1 text-[var(--muted)] hover:text-[var(--foreground)] outline-none"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </label>
              {suggestionPanel("location")}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              onSubmit();
              setMobileExpanded(false);
            }}
            className="mt-1 rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-[var(--accent-fg)] shadow-[0_10px_20px_rgba(21,111,99,0.2)] transition hover:brightness-110"
          >
            {pending ? "..." : query.mode === "route" ? "Route berechnen" : "Standort suchen"}
          </button>

          {/* Mobile close button */}
          <button
            type="button"
            onClick={() => setMobileExpanded(false)}
            className="sm:hidden mt-2 w-full text-center text-sm font-medium text-[var(--muted)] py-2 active:opacity-60"
          >
            Schließen
          </button>
        </div>
        </div>
      </section>
    </>
  );
}
