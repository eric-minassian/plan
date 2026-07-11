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
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@eric-minassian/design/components/item";
import { Separator } from "@eric-minassian/design/components/separator";
import { BusyIcon } from "../components/BusyIcon.tsx";
import { useAuth } from "@ericminassian/auth/react";
import type {
  CreateItineraryItem,
  ItineraryItem,
  UpdateItineraryItem,
} from "@tripplan/domain";
import { ArrowLeftIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";
import {
  createTripPlanApi,
  type TripDetailResponse,
} from "../api/client.ts";
import { ApiClientError, formatApiError } from "../api/errors.ts";
import { useAuthClient } from "../auth/AuthClientContext.tsx";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { FlightForm } from "../components/FlightForm.tsx";
import { NoteForm } from "../components/NoteForm.tsx";
import { SharePanel } from "../components/SharePanel.tsx";
import { bucketTripItems } from "../timeline/bucket.ts";
import { formatCivilDateLabel } from "../timeline/datetime.ts";
import {
  itemSubtitle,
  itemTypeBadgeVariant,
  itemTypeLabel,
} from "../timeline/item-display.ts";

type EditorState =
  | { readonly kind: "closed" }
  | {
      readonly kind: "create-flight";
      /** Remount key + Idempotency-Key for this create session. */
      readonly sessionId: string;
    }
  | {
      readonly kind: "create-note";
      readonly sessionId: string;
    }
  | {
      readonly kind: "edit-flight";
      readonly item: Extract<ItineraryItem, { readonly type: "flight" }>;
    }
  | {
      readonly kind: "edit-note";
      readonly item: Extract<ItineraryItem, { readonly type: "note" }>;
    };

function newSessionId(): string {
  return crypto.randomUUID();
}

function hasConfirmation(item: ItineraryItem): boolean {
  return (item.confirmationCode ?? "").trim().length > 0;
}

/** Trip detail: day-grouped timeline + flight/note editors (PR 8b). */
export function TripDetailPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const authClient = useAuthClient();
  const { signOut } = useAuth();

  const onUnauthorized = useCallback(async () => {
    await signOut({ postLogoutRedirectUri: window.location.origin });
  }, [signOut]);

  const api = useMemo(
    () => createTripPlanApi(authClient, { onUnauthorized }),
    [authClient, onUnauthorized],
  );

  const [detail, setDetail] = useState<TripDetailResponse | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });

  const loadGeneration = useRef(0);

  const loadTrip = useCallback(async (): Promise<TripDetailResponse | undefined> => {
    if (tripId === undefined || tripId.length === 0) {
      setListError("Missing trip id");
      setLoading(false);
      return undefined;
    }
    const generation = ++loadGeneration.current;
    setLoading(true);
    setListError(undefined);
    try {
      const next = await api.getTrip(tripId);
      if (generation !== loadGeneration.current) {
        return undefined;
      }
      setDetail(next);
      return next;
    } catch (cause) {
      if (generation !== loadGeneration.current) {
        return undefined;
      }
      setListError(formatApiError(cause));
      setDetail(undefined);
      return undefined;
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
      }
    }
  }, [api, tripId]);

  useEffect(() => {
    void loadTrip();
  }, [loadTrip]);

  const buckets = useMemo(() => {
    if (detail === undefined) {
      return undefined;
    }
    return bucketTripItems(
      detail.items,
      detail.timezone,
      detail.startDate,
    );
  }, [detail]);

  function closeEditor(): void {
    setEditor({ kind: "closed" });
    setFormError(undefined);
  }

  function openCreateFlight(): void {
    setFormError(undefined);
    setEditor({ kind: "create-flight", sessionId: newSessionId() });
  }

  function openCreateNote(): void {
    setFormError(undefined);
    setEditor({ kind: "create-note", sessionId: newSessionId() });
  }

  function upsertItem(item: ItineraryItem): void {
    setDetail((prev) => {
      if (prev === undefined) {
        return prev;
      }
      const idx = prev.items.findIndex((i) => i.itemId === item.itemId);
      if (idx === -1) {
        return { ...prev, items: [...prev.items, item] };
      }
      const items = prev.items.map((i) =>
        i.itemId === item.itemId ? item : i,
      );
      return { ...prev, items };
    });
  }

  function removeItem(itemId: string): void {
    setDetail((prev) => {
      if (prev === undefined) {
        return prev;
      }
      return {
        ...prev,
        items: prev.items.filter((i) => i.itemId !== itemId),
      };
    });
  }

  /** After 409, refresh trip and point the open editor at the live item. */
  async function recoverFromConflict(itemId: string): Promise<void> {
    const next = await loadTrip();
    if (next === undefined) {
      setFormError(
        "This item was updated elsewhere. Refresh failed — reload the page and try again.",
      );
      return;
    }
    const live = next.items.find((i) => i.itemId === itemId);
    if (live === undefined) {
      closeEditor();
      setListError("This item was deleted elsewhere.");
      return;
    }
    if (live.type === "flight") {
      setEditor({ kind: "edit-flight", item: live });
    } else if (live.type === "note") {
      setEditor({ kind: "edit-note", item: live });
    } else {
      closeEditor();
    }
    setFormError(
      "Someone else updated this item — review the latest version and save again.",
    );
  }

  async function handleCreate(payload: CreateItineraryItem): Promise<void> {
    if (tripId === undefined) {
      return;
    }
    const sessionId =
      editor.kind === "create-flight" || editor.kind === "create-note"
        ? editor.sessionId
        : newSessionId();
    setSubmitting(true);
    setFormError(undefined);
    try {
      const created = await api.createItem(tripId, payload, {
        idempotencyKey: sessionId,
      });
      upsertItem(created);
      closeEditor();
    } catch (cause) {
      setFormError(formatApiError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdate(
    itemId: string,
    version: number,
    payload: UpdateItineraryItem,
  ): Promise<void> {
    if (tripId === undefined) {
      return;
    }
    setSubmitting(true);
    setFormError(undefined);
    try {
      const updated = await api.updateItem(tripId, itemId, version, payload);
      upsertItem(updated);
      closeEditor();
    } catch (cause) {
      if (
        cause instanceof ApiClientError &&
        (cause.status === 409 || cause.type === "Conflict")
      ) {
        await recoverFromConflict(itemId);
      } else {
        setFormError(formatApiError(cause));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(item: ItineraryItem): Promise<void> {
    if (tripId === undefined) {
      return;
    }
    const ok = window.confirm(`Delete “${item.title}”?`);
    if (!ok) {
      return;
    }
    setDeletingId(item.itemId);
    setListError(undefined);
    try {
      await api.deleteItem(tripId, item.itemId);
      removeItem(item.itemId);
      if (
        (editor.kind === "edit-flight" || editor.kind === "edit-note") &&
        editor.item.itemId === item.itemId
      ) {
        closeEditor();
      }
    } catch (cause) {
      setListError(formatApiError(cause));
    } finally {
      setDeletingId(undefined);
    }
  }

  function openEdit(item: ItineraryItem): void {
    setFormError(undefined);
    if (item.type === "flight") {
      setEditor({ kind: "edit-flight", item });
      return;
    }
    if (item.type === "note") {
      setEditor({ kind: "edit-note", item });
    }
  }

  function renderItemCard(item: ItineraryItem) {
    const timezone = detail?.timezone ?? "UTC";
    const editable = item.type === "flight" || item.type === "note";
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
          {item.type === "flight" && hasConfirmation(item) ? (
            <ItemDescription className="line-clamp-none">
              Confirmation: {item.confirmationCode}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          {editable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                openEdit(item);
              }}
            >
              Edit
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={deletingId === item.itemId}
            onClick={() => {
              void handleDelete(item);
            }}
          >
            {deletingId === item.itemId ? "…" : "Delete"}
          </Button>
        </ItemActions>
      </Item>
    );
  }

  if (tripId === undefined || tripId.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 pt-(--card-spacing)">
          <ErrorAlert title="Missing trip">Missing trip id.</ErrorAlert>
          <Button variant="outline" asChild>
            <Link to="/">Back to trips</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  // sessionId / itemId(+version) keys remount forms: create sessions stay stable
  // across parent re-renders (submitting/error); version bumps after 409 re-seed
  // from the live row.
  const flightFormKey =
    editor.kind === "create-flight"
      ? `create-flight-${editor.sessionId}`
      : editor.kind === "edit-flight"
        ? `edit-flight-${editor.item.itemId}-v${String(editor.item.version)}`
        : undefined;
  const noteFormKey =
    editor.kind === "create-note"
      ? `create-note-${editor.sessionId}`
      : editor.kind === "edit-note"
        ? `edit-note-${editor.item.itemId}-v${String(editor.item.version)}`
        : undefined;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">
            <ArrowLeftIcon data-icon="inline-start" />
            All trips
          </Link>
        </Button>
      </div>

      {loading && detail === undefined ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <BusyIcon />
            Loading trip…
          </CardContent>
        </Card>
      ) : null}

      {listError !== undefined ? <ErrorAlert>{listError}</ErrorAlert> : null}

      {detail !== undefined ? (
        <>
          <Card>
            <CardHeader className="border-b">
              <CardTitle className="text-base">{detail.title}</CardTitle>
              <CardDescription className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span>
                  {detail.startDate} → {detail.endDate}
                </span>
                <span className="font-mono text-[0.7rem]">
                  {detail.timezone}
                </span>
              </CardDescription>
              <CardAction>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void loadTrip();
                  }}
                  disabled={loading}
                >
                  <RefreshCwIcon
                    data-icon="inline-start"
                    className={loading ? "animate-spin" : undefined}
                  />
                  Refresh
                </Button>
              </CardAction>
            </CardHeader>
          </Card>

          <SharePanel tripId={detail.tripId} api={api} />

          <Card>
            <CardHeader className="border-b">
              <CardTitle>Timeline</CardTitle>
              <CardDescription>
                Flights and notes grouped by day in {detail.timezone}.
              </CardDescription>
              <CardAction className="flex flex-wrap gap-1.5">
                <Button type="button" size="sm" onClick={openCreateFlight}>
                  <PlusIcon data-icon="inline-start" />
                  Flight
                </Button>
                <Button type="button" size="sm" onClick={openCreateNote}>
                  <PlusIcon data-icon="inline-start" />
                  Note
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {editor.kind === "create-flight" ||
              editor.kind === "edit-flight" ? (
                <div className="rounded-lg border bg-muted/30 p-4">
                  <FlightForm
                    key={flightFormKey}
                    mode={
                      editor.kind === "create-flight"
                        ? { kind: "create" }
                        : { kind: "edit", item: editor.item }
                    }
                    tripTimezone={detail.timezone}
                    submitting={submitting}
                    error={formError}
                    onCancel={closeEditor}
                    onCreate={handleCreate}
                    onUpdate={handleUpdate}
                    onEnrichFlight={(query) => api.enrichFlight(query)}
                  />
                </div>
              ) : null}

              {editor.kind === "create-note" || editor.kind === "edit-note" ? (
                <div className="rounded-lg border bg-muted/30 p-4">
                  <NoteForm
                    key={noteFormKey}
                    mode={
                      editor.kind === "create-note"
                        ? { kind: "create" }
                        : { kind: "edit", item: editor.item }
                    }
                    tripTimezone={detail.timezone}
                    submitting={submitting}
                    error={formError}
                    onCancel={closeEditor}
                    onCreate={handleCreate}
                    onUpdate={handleUpdate}
                  />
                </div>
              ) : null}

              {buckets !== undefined &&
              buckets.days.length === 0 &&
              buckets.unscheduled.length === 0 ? (
                <Empty className="border border-dashed py-8">
                  <EmptyHeader>
                    <EmptyTitle>No items yet</EmptyTitle>
                    <EmptyDescription>
                      Add a flight or note to start the timeline.
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
        </>
      ) : null}
    </div>
  );
}
