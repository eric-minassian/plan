import type { ItineraryItem, ShareTripDTO } from "@tripplan/domain";
import { useEffect, useMemo, useState } from "react";
import {
  createSharePublicApi,
  type SharePublicApi,
} from "../api/client.ts";
import { ApiClientError, formatApiError } from "../api/errors.ts";
import {
  clearAllShareOfflineStores,
  formatCacheAge,
  loadLastShareTrip,
  saveLastShareTrip,
  type LastShareTripCache,
} from "../share/offline-cache.ts";
import { bucketTripItems } from "../timeline/bucket.ts";
import {
  formatCivilDateLabel,
  formatInstantInZone,
} from "../timeline/datetime.ts";

function itemTypeLabel(type: ItineraryItem["type"]): string {
  switch (type) {
    case "flight":
      return "Flight";
    case "note":
      return "Note";
    case "hotel":
      return "Hotel";
    case "train":
      return "Train";
    case "transport":
      return "Transport";
    case "activity":
      return "Activity";
    case "ticket":
      return "Ticket";
    case "custom":
      return "Custom";
  }
}

function itemSubtitle(
  item: ItineraryItem,
  timezone: string,
): string | undefined {
  const start = formatInstantInZone(item.startAt, timezone);
  const end = formatInstantInZone(item.endAt, timezone);
  if (item.type === "flight") {
    const route = [
      item.details.departureAirport,
      item.details.arrivalAirport,
    ]
      .filter((x): x is string => x !== undefined && x.length > 0)
      .join(" → ");
    const bits = [
      item.details.airlineCode !== undefined
        ? `${item.details.airlineCode}${item.details.flightNumber}`
        : item.details.flightNumber,
      route.length > 0 ? route : undefined,
      start,
      end !== undefined ? `→ ${end}` : undefined,
    ].filter((x): x is string => x !== undefined);
    return bits.join(" · ");
  }
  if (item.type === "note") {
    const body = item.notes?.trim();
    if (body !== undefined && body.length > 0) {
      return body.length > 120 ? `${body.slice(0, 117)}…` : body;
    }
    return start;
  }
  return start;
}

/** Clear capability secret from the address bar (always, success or failure). */
export function clearShareHash(
  location: Location = window.location,
  history: History = window.history,
): void {
  if (location.hash.length === 0) {
    return;
  }
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}`,
  );
}

export function readShareHashToken(
  location: Location = window.location,
): string | undefined {
  const hash = location.hash.startsWith("#")
    ? location.hash.slice(1)
    : location.hash;
  if (hash.length === 0) {
    return undefined;
  }
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

type BootResult =
  | {
      readonly ok: true;
      readonly trip: ShareTripDTO;
      /** True when the trip came from the local offline cache. */
      readonly fromOfflineCache?: boolean;
      /** ISO timestamp when the offline snapshot was saved (if from cache). */
      readonly cachedAt?: string;
      /**
       * True when a new hash token was present but load fell back to a previous
       * offline snapshot (the opened link was not established).
       */
      readonly offlineCacheWithNewToken?: boolean;
    }
  | { readonly ok: false; readonly error: unknown };

/**
 * Module-level boot (survives React StrictMode remount).
 * Component refs reset on remount; a process-level promise does not.
 */
let shareViewerBoot: Promise<BootResult> | undefined;
let shareViewerBootClearTimer: ReturnType<typeof setTimeout> | undefined;

const NETWORK_ERROR_MESSAGE =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|network error/i;

/** Exported for unit tests. */
export function isLikelyOfflineError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // Fetch network failures are typically TypeError with a known message —
  // do not treat every TypeError (programming bugs) as offline.
  if (error instanceof TypeError) {
    return NETWORK_ERROR_MESSAGE.test(error.message);
  }
  return NETWORK_ERROR_MESSAGE.test(error.message);
}

/**
 * Online API statuses that mean this share is no longer usable —
 * drop durable offline copies so a later airplane-mode visit cannot resurrect them.
 */
export function isDefinitiveShareAccessError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) {
    return false;
  }
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 410
  );
}

/**
 * Exchange + load once. Clears hash immediately (even when exchange fails).
 * On network failure, falls back to the last-opened share trip cache (airplane mode).
 * Exported for unit tests.
 */
export async function bootShareViewer(
  api: SharePublicApi,
  options: {
    readonly readToken?: () => string | undefined;
    readonly clearHash?: () => void;
    readonly saveTrip?: (trip: ShareTripDTO) => void;
    readonly loadCachedTrip?: () => LastShareTripCache | undefined;
    readonly clearOfflineStores?: () => void | Promise<void>;
    /** Override connectivity probe (defaults to `navigator.onLine` when available). */
    readonly isOnline?: () => boolean;
  } = {},
): Promise<BootResult> {
  const readToken = options.readToken ?? readShareHashToken;
  const clearHash = options.clearHash ?? clearShareHash;
  const isOnline = options.isOnline ?? navigatorOnLine;
  const saveTrip =
    options.saveTrip ??
    ((trip: ShareTripDTO) => {
      saveLastShareTrip(trip);
    });
  const loadCachedTrip =
    options.loadCachedTrip ??
    (() => loadLastShareTrip());
  const clearOfflineStores =
    options.clearOfflineStores ??
    (() => clearAllShareOfflineStores());

  // Capture secret then strip from URL before any await (hygiene on failure too).
  const token = readToken();
  const hadToken = token !== undefined && token.length > 0;
  clearHash();

  const succeed = (trip: ShareTripDTO): BootResult => {
    saveTrip(trip);
    return { ok: true, trip };
  };

  const rejectOnline = async (error: unknown): Promise<BootResult> => {
    if (isOnline() && isDefinitiveShareAccessError(error)) {
      await clearOfflineStores();
    }
    return { ok: false, error };
  };

  const offlineFallback = async (error: unknown): Promise<BootResult> => {
    if (!isLikelyOfflineError(error) && isOnline()) {
      return rejectOnline(error);
    }
    const cached = loadCachedTrip();
    if (cached !== undefined) {
      return {
        ok: true,
        trip: cached.trip,
        fromOfflineCache: true,
        cachedAt: cached.savedAt,
        offlineCacheWithNewToken: hadToken ? true : undefined,
      };
    }
    return { ok: false, error };
  };

  try {
    if (hadToken) {
      try {
        await api.exchangeSession(token);
      } catch (exchangeError) {
        // Best-effort: existing cookie session may still work.
        try {
          const trip = await api.getTrip();
          return succeed(trip);
        } catch (getError) {
          const offline = await offlineFallback(getError);
          if (offline.ok) {
            return offline;
          }
          return offlineFallback(exchangeError);
        }
      }
    }

    const trip = await api.getTrip();
    return succeed(trip);
  } catch (error) {
    return offlineFallback(error);
  }
}

function navigatorOnLine(): boolean {
  if (typeof navigator === "undefined") {
    return true;
  }
  // Node / incomplete test globals may expose `navigator` without `onLine`.
  if (typeof navigator.onLine !== "boolean") {
    return true;
  }
  return navigator.onLine;
}

function getOrStartShareBoot(api: SharePublicApi): Promise<BootResult> {
  if (shareViewerBoot === undefined) {
    shareViewerBoot = bootShareViewer(api).finally(() => {
      // Allow a later navigation to /s#other to boot again after a short window.
      if (shareViewerBootClearTimer !== undefined) {
        clearTimeout(shareViewerBootClearTimer);
      }
      shareViewerBootClearTimer = setTimeout(() => {
        shareViewerBoot = undefined;
        shareViewerBootClearTimer = undefined;
      }, 5_000);
    });
  }
  return shareViewerBoot;
}

/**
 * Drop the in-flight / resolved boot memo so remounting `/s` re-runs exchange
 * (required after Leave — otherwise the left trip reappears for ~5s).
 */
export function invalidateShareViewerBoot(): void {
  shareViewerBoot = undefined;
  if (shareViewerBootClearTimer !== undefined) {
    clearTimeout(shareViewerBootClearTimer);
    shareViewerBootClearTimer = undefined;
  }
}

/** Reset module boot state (tests only). */
export function resetShareViewerBootForTests(): void {
  invalidateShareViewerBoot();
}

/**
 * Clear durable offline stores + in-memory boot memo (Leave share).
 * Exported so leave wiring can be unit-tested without mounting React.
 */
export async function leaveShareSession(
  api: SharePublicApi,
  options: {
    readonly clearOfflineStores?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  const clearOfflineStores =
    options.clearOfflineStores ??
    (() => clearAllShareOfflineStores());
  try {
    await api.clearSession();
  } finally {
    // Always drop local + SW copies and the boot memo, even if network clear fails.
    await clearOfflineStores();
    invalidateShareViewerBoot();
  }
}

/**
 * Public share viewer at `/s`.
 * Hash token → session cookie → clear hash → read-only timeline.
 */
export function ShareViewerPage() {
  const api = useMemo(() => createSharePublicApi(), []);
  const [trip, setTrip] = useState<ShareTripDTO | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [statusMessage, setStatusMessage] = useState<string | undefined>(
    undefined,
  );
  const [leaving, setLeaving] = useState(false);
  const [offlineBanner, setOfflineBanner] = useState<string | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void getOrStartShareBoot(api).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setTrip(result.trip);
        setError(undefined);
        setStatusMessage(undefined);
        if (result.fromOfflineCache === true) {
          const age =
            result.cachedAt !== undefined
              ? formatCacheAge(result.cachedAt)
              : "earlier";
          if (result.offlineCacheWithNewToken === true) {
            setOfflineBanner(
              `Could not open the new share link offline. Showing a previously saved trip on this device (saved ${age}). Data may be out of date until you reconnect.`,
            );
          } else {
            setOfflineBanner(
              `Showing the last shared trip saved on this device (saved ${age}). Data may be out of date until you reconnect.`,
            );
          }
        } else {
          setOfflineBanner(undefined);
        }
      } else {
        setTrip(undefined);
        setOfflineBanner(undefined);
        setStatusMessage(undefined);
        setError(formatApiError(result.error));
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const buckets = useMemo(() => {
    if (trip === undefined) {
      return undefined;
    }
    return bucketTripItems(trip.items, trip.timezone, trip.startDate);
  }, [trip]);

  async function handleLeave(): Promise<void> {
    setLeaving(true);
    setError(undefined);
    setStatusMessage(undefined);
    try {
      await leaveShareSession(api);
      setTrip(undefined);
      setOfflineBanner(undefined);
      setStatusMessage("Share session cleared on this device.");
    } catch (cause) {
      // leaveShareSession always clears stores in finally; surface network error if any.
      setTrip(undefined);
      setOfflineBanner(undefined);
      setError(formatApiError(cause));
    } finally {
      setLeaving(false);
    }
  }

  function renderItemCard(item: ItineraryItem) {
    const timezone = trip?.timezone ?? "UTC";
    const subtitle = itemSubtitle(item, timezone);
    return (
      <li key={item.itemId} className="item-card">
        <div className="item-card__main">
          <div className="item-card__head">
            <span className={`item-type item-type--${item.type}`}>
              {itemTypeLabel(item.type)}
            </span>
            <span className="item-card__title">{item.title}</span>
          </div>
          {subtitle !== undefined ? (
            <p className="item-card__sub">{subtitle}</p>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <div className="share-viewer">
      <section className="panel">
        <div className="panel__header">
          <div>
            <p className="share-viewer__badge">Shared trip · read-only</p>
            {trip !== undefined ? (
              <>
                <h2>{trip.title}</h2>
                <p className="trip-detail__meta muted">
                  {trip.startDate} → {trip.endDate}
                  <span className="trip-detail__tz">{trip.timezone}</span>
                </p>
                <p className="muted share-viewer__owner">
                  Shared by {trip.ownerDisplayName}
                </p>
              </>
            ) : (
              <h2>Shared trip</h2>
            )}
          </div>
          {trip !== undefined ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={leaving}
              onClick={() => {
                void handleLeave();
              }}
            >
              {leaving ? "…" : "Leave share"}
            </button>
          ) : null}
        </div>
        <p className="muted share-viewer__note">
          Opening another shared trip switches your view — only one share
          session is active in this browser at a time.
        </p>
        {offlineBanner !== undefined ? (
          <p className="banner banner--info" role="status">
            {offlineBanner}
          </p>
        ) : null}
      </section>

      {loading ? (
        <section className="panel">
          <p className="muted">Loading shared trip…</p>
        </section>
      ) : null}

      {error !== undefined ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}

      {statusMessage !== undefined ? (
        <p className="banner banner--info" role="status">
          {statusMessage}
        </p>
      ) : null}

      {trip !== undefined && !loading ? (
        <section className="panel">
          <div className="panel__header">
            <h2>Timeline</h2>
          </div>

          {buckets !== undefined &&
          buckets.days.length === 0 &&
          buckets.unscheduled.length === 0 ? (
            <p className="muted">No items on this trip yet.</p>
          ) : null}

          {buckets !== undefined
            ? buckets.days.map((day) => (
                <div key={day.date} className="day-bucket">
                  <header className="day-bucket__header">
                    <span className="day-bucket__num">Day {day.dayNumber}</span>
                    <span className="day-bucket__date">
                      {formatCivilDateLabel(day.date)}
                    </span>
                  </header>
                  <ul className="item-list">
                    {day.items.map((item) => renderItemCard(item))}
                  </ul>
                </div>
              ))
            : null}

          {buckets !== undefined && buckets.unscheduled.length > 0 ? (
            <div className="day-bucket day-bucket--unscheduled">
              <header className="day-bucket__header">
                <span className="day-bucket__num">Unscheduled</span>
                <span className="day-bucket__date">No start time</span>
              </header>
              <ul className="item-list">
                {buckets.unscheduled.map((item) => renderItemCard(item))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
