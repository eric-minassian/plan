import type {
  EnrichPlaceRequest,
  EnrichmentMeta,
  GeoPoint,
  PlaceEnrichmentResponse,
  PlaceSuggestion,
} from "@tripplan/domain";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { formatApiError } from "../api/errors.ts";

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

export interface LocationPickerProps {
  /** Current selected location (suggest-then-confirm; parent owns form state). */
  readonly value: GeoPoint | undefined;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly hint?: string;
  /**
   * Optional proximity bias (trip centroid / last pin) passed to enrich/place.
   */
  readonly proximity?: {
    readonly lat: number;
    readonly lng: number;
  };
  /**
   * Place search (typeahead). When omitted, only manual clear/display works.
   * Parent typically wires `api.enrichPlace`.
   */
  readonly onSearch?: (
    query: EnrichPlaceRequest,
  ) => Promise<PlaceEnrichmentResponse>;
  /**
   * Called when the user picks a suggestion or clears.
   * Never auto-saves itinerary items.
   */
  readonly onChange: (
    location: GeoPoint | undefined,
    meta: EnrichmentMeta | undefined,
  ) => void;
}

/** Map a place suggestion into a GeoPoint for form storage. */
export function geoPointFromSuggestion(
  suggestion: PlaceSuggestion,
): GeoPoint {
  return {
    lat: suggestion.lat,
    lng: suggestion.lng,
    label: suggestion.label,
    placeId: suggestion.placeId,
    ...(suggestion.address !== undefined
      ? { address: suggestion.address }
      : {}),
  };
}

/**
 * Typeahead location picker backed by POST /enrich/place.
 * Prefills geo/address; parent form still requires Save (suggest-then-confirm).
 * Input stays enabled while a request is in flight (generation counter discards races).
 */
export function LocationPicker(props: LocationPickerProps) {
  const {
    value,
    disabled = false,
    label = "Location",
    hint = "Search for a place, then review and save the item.",
    proximity,
    onSearch,
    onChange,
  } = props;

  const listId = useId();
  const optionId = (index: number): string => `${listId}-opt-${String(index)}`;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly PlaceSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [lastProvider, setLastProvider] = useState<string | undefined>(
    undefined,
  );
  const [lastFetchedAt, setLastFetchedAt] = useState<string | undefined>(
    undefined,
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const requestGen = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const runSearch = useCallback(
    async (text: string) => {
      if (onSearch === undefined) {
        return;
      }
      const trimmed = text.trim();
      if (trimmed.length < MIN_QUERY_LENGTH) {
        setResults([]);
        setActiveIndex(-1);
        setOpen(false);
        setMessage(undefined);
        return;
      }

      const gen = ++requestGen.current;
      setBusy(true);
      setError(undefined);
      try {
        const response = await onSearch({
          query: trimmed,
          limit: 6,
          ...(proximity !== undefined ? { proximity } : {}),
        });
        if (gen !== requestGen.current) {
          return;
        }
        setLastProvider(response.provider);
        setLastFetchedAt(response.fetchedAt);
        if (response.status === "not_found" || response.results.length === 0) {
          setResults([]);
          setActiveIndex(-1);
          setOpen(true);
          setMessage("No places found. Try a different query.");
          return;
        }
        setResults(response.results);
        setActiveIndex(0);
        setOpen(true);
        setMessage(undefined);
      } catch (cause) {
        if (gen !== requestGen.current) {
          return;
        }
        setResults([]);
        setActiveIndex(-1);
        setOpen(false);
        setError(formatApiError(cause));
      } finally {
        if (gen === requestGen.current) {
          setBusy(false);
        }
      }
    },
    [onSearch, proximity],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  useEffect(() => {
    function onDocMouseDown(event: MouseEvent): void {
      const root = rootRef.current;
      if (root === null) {
        return;
      }
      if (event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
    };
  }, []);

  function onQueryChange(next: string): void {
    setQuery(next);
    setError(undefined);
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current);
    }
    if (onSearch === undefined) {
      return;
    }
    debounceRef.current = setTimeout(() => {
      void runSearch(next);
    }, DEBOUNCE_MS);
  }

  function applySuggestion(suggestion: PlaceSuggestion): void {
    const geo = geoPointFromSuggestion(suggestion);
    const meta: EnrichmentMeta | undefined =
      lastProvider !== undefined && lastFetchedAt !== undefined
        ? {
            provider: lastProvider,
            fetchedAt: lastFetchedAt,
            ...(suggestion.confidence !== undefined
              ? { confidence: suggestion.confidence }
              : {}),
          }
        : undefined;
    onChange(geo, meta);
    setQuery("");
    setResults([]);
    setActiveIndex(-1);
    setOpen(false);
    setMessage(
      `Selected “${suggestion.label}”. Review fields and save when ready.`,
    );
  }

  function clearLocation(): void {
    onChange(undefined, undefined);
    setQuery("");
    setResults([]);
    setActiveIndex(-1);
    setOpen(false);
    setMessage("Location cleared.");
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (!open || results.length === 0) {
      if (event.key === "Escape") {
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
      return;
    }
    if (event.key === "Enter") {
      const pick =
        activeIndex >= 0 && activeIndex < results.length
          ? results[activeIndex]
          : undefined;
      if (pick !== undefined) {
        event.preventDefault();
        applySuggestion(pick);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  const searchEnabled = onSearch !== undefined;
  const activeDescendant =
    open && activeIndex >= 0 && activeIndex < results.length
      ? optionId(activeIndex)
      : undefined;

  return (
    <div className="location-picker" ref={rootRef}>
      <div className="location-picker__header">
        <span className="field__label">{label}</span>
        {value !== undefined ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={disabled}
            onClick={clearLocation}
          >
            Clear
          </button>
        ) : null}
      </div>
      <p className="field__hint">{hint}</p>

      {value !== undefined ? (
        <div className="location-picker__selected" role="status">
          <strong>{value.label ?? "Selected place"}</strong>
          {value.address !== undefined ? (
            <span className="location-picker__address">{value.address}</span>
          ) : null}
          <span className="location-picker__coords muted">
            {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
          </span>
        </div>
      ) : null}

      {searchEnabled ? (
        <div className="location-picker__search">
          <label className="field">
            <span className="field__label visually-hidden">Search places</span>
            <input
              className="field__input"
              type="search"
              name="placeSearch"
              autoComplete="off"
              disabled={disabled}
              value={query}
              placeholder="Search hotel, venue, or address…"
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded={open}
              aria-activedescendant={activeDescendant}
              onChange={(e) => {
                onQueryChange(e.target.value);
              }}
              onKeyDown={onSearchKeyDown}
              onFocus={() => {
                if (results.length > 0) {
                  setOpen(true);
                }
              }}
            />
          </label>
          {busy ? (
            <p className="field__hint" role="status">
              Searching…
            </p>
          ) : null}
          {open && results.length > 0 ? (
            <ul
              id={listId}
              className="location-picker__results"
              role="listbox"
            >
              {results.map((result, index) => (
                <li
                  key={result.placeId}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                >
                  <button
                    type="button"
                    className={
                      index === activeIndex
                        ? "location-picker__result location-picker__result--active"
                        : "location-picker__result"
                    }
                    disabled={disabled}
                    onClick={() => {
                      applySuggestion(result);
                    }}
                    onMouseEnter={() => {
                      setActiveIndex(index);
                    }}
                  >
                    <span className="location-picker__result-label">
                      {result.label}
                    </span>
                    {result.address !== undefined ? (
                      <span className="location-picker__result-address">
                        {result.address}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {error !== undefined ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}
      {message !== undefined ? (
        <p className="banner banner--info" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
