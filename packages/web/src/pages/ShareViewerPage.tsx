import { Badge } from "@eric-minassian/design/components/badge";
import { Button } from "@eric-minassian/design/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@eric-minassian/design/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@eric-minassian/design/components/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@eric-minassian/design/components/item";
import { Separator } from "@eric-minassian/design/components/separator";
import { BusyIcon } from "../components/BusyIcon.tsx";
import type { ItineraryItem, ShareTripDTO } from "@tripplan/domain";
import { useEffect, useMemo, useState } from "react";
import {
  createSharePublicApi,
  type SharePublicApi,
} from "../api/client.ts";
import { formatApiError } from "../api/errors.ts";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { InfoAlert } from "../components/InfoAlert.tsx";
import { bucketTripItems } from "../timeline/bucket.ts";
import { formatCivilDateLabel } from "../timeline/datetime.ts";
import {
  itemSubtitle,
  itemTypeBadgeVariant,
  itemTypeLabel,
} from "../timeline/item-display.ts";

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
  | { readonly ok: true; readonly trip: ShareTripDTO }
  | { readonly ok: false; readonly error: unknown };

/**
 * Module-level boot (survives React StrictMode remount).
 * Component refs reset on remount; a process-level promise does not.
 */
let shareViewerBoot: Promise<BootResult> | undefined;

/**
 * Exchange + load once. Clears hash immediately (even when exchange fails).
 * Exported for unit tests.
 */
export async function bootShareViewer(
  api: SharePublicApi,
  options: {
    readonly readToken?: () => string | undefined;
    readonly clearHash?: () => void;
  } = {},
): Promise<BootResult> {
  const readToken = options.readToken ?? readShareHashToken;
  const clearHash = options.clearHash ?? clearShareHash;

  // Capture secret then strip from URL before any await (hygiene on failure too).
  const token = readToken();
  clearHash();

  try {
    if (token !== undefined && token.length > 0) {
      try {
        await api.exchangeSession(token);
      } catch (exchangeError) {
        // Best-effort: existing cookie session may still work.
        try {
          const trip = await api.getTrip();
          return { ok: true, trip };
        } catch {
          return { ok: false, error: exchangeError };
        }
      }
    }

    const trip = await api.getTrip();
    return { ok: true, trip };
  } catch (error) {
    return { ok: false, error };
  }
}

function getOrStartShareBoot(api: SharePublicApi): Promise<BootResult> {
  if (shareViewerBoot === undefined) {
    shareViewerBoot = bootShareViewer(api).finally(() => {
      // Allow a later navigation to /s#other to boot again after a short window.
      setTimeout(() => {
        shareViewerBoot = undefined;
      }, 5_000);
    });
  }
  return shareViewerBoot;
}

/** Reset module boot state (tests only). */
export function resetShareViewerBootForTests(): void {
  shareViewerBoot = undefined;
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
      } else {
        setTrip(undefined);
        setError(formatApiError(result.error));
        setStatusMessage(undefined);
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
      await api.clearSession();
      setTrip(undefined);
      setStatusMessage("Share session cleared on this device.");
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setLeaving(false);
    }
  }

  function renderItemCard(item: ItineraryItem) {
    const timezone = trip?.timezone ?? "UTC";
    const subtitle = itemSubtitle(item, timezone);
    return (
      <Item key={item.itemId} variant="outline" size="sm">
        <ItemContent>
          <ItemTitle className="line-clamp-none flex flex-wrap items-center gap-2">
            <Badge variant={itemTypeBadgeVariant(item.type)}>
              {itemTypeLabel(item.type)}
            </Badge>
            <span>{item.title}</span>
          </ItemTitle>
          {subtitle !== undefined ? (
            <ItemDescription className="line-clamp-none whitespace-pre-wrap">
              {subtitle}
            </ItemDescription>
          ) : null}
        </ItemContent>
      </Item>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Badge variant="outline">Shared trip · read-only</Badge>
            <span>{trip !== undefined ? trip.title : "Shared trip"}</span>
          </CardTitle>
          {trip !== undefined ? (
            <CardDescription className="flex flex-col gap-1">
              <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span>
                  {trip.startDate} → {trip.endDate}
                </span>
                <span className="font-mono text-[0.7rem]">
                  {trip.timezone}
                </span>
              </span>
              <span>Shared by {trip.ownerDisplayName}</span>
            </CardDescription>
          ) : null}
          {trip !== undefined ? (
            <CardAction>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={leaving}
                onClick={() => {
                  void handleLeave();
                }}
              >
                {leaving ? "…" : "Leave share"}
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Opening another shared trip switches your view — only one share
            session is active in this browser at a time.
          </p>
        </CardContent>
      </Card>

      {loading ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <BusyIcon />
            Loading shared trip…
          </CardContent>
        </Card>
      ) : null}

      {error !== undefined ? <ErrorAlert>{error}</ErrorAlert> : null}
      {statusMessage !== undefined ? (
        <InfoAlert>{statusMessage}</InfoAlert>
      ) : null}

      {trip !== undefined && !loading ? (
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {buckets !== undefined &&
            buckets.days.length === 0 &&
            buckets.unscheduled.length === 0 ? (
              <Empty className="border border-dashed py-8">
                <EmptyHeader>
                  <EmptyTitle>No items yet</EmptyTitle>
                  <EmptyDescription>
                    No items on this trip yet.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}

            {buckets !== undefined
              ? buckets.days.map((day, index) => (
                  <div key={day.date} className="flex flex-col gap-2">
                    {index > 0 ? <Separator className="mb-2" /> : null}
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium">
                        Day {day.dayNumber}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatCivilDateLabel(day.date)}
                      </span>
                    </div>
                    <div className="flex w-full flex-col gap-2">
                      {day.items.map((item) => renderItemCard(item))}
                    </div>
                  </div>
                ))
              : null}

            {buckets !== undefined && buckets.unscheduled.length > 0 ? (
              <div className="flex flex-col gap-2">
                {buckets.days.length > 0 ? (
                  <Separator className="mb-2" />
                ) : null}
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium text-muted-foreground">
                    Unscheduled
                  </span>
                  <span className="text-xs text-muted-foreground">
                    No start time
                  </span>
                </div>
                <div className="flex w-full flex-col gap-2">
                  {buckets.unscheduled.map((item) => renderItemCard(item))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
