import { useAuth } from "@ericminassian/auth/react";
import type {
  CreateItineraryItem,
  ItineraryItem,
  UpdateItineraryItem,
} from "@tripplan/domain";
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
import { FlightForm } from "../components/FlightForm.tsx";
import { NoteForm } from "../components/NoteForm.tsx";
import { itemHasMapGeo, TripMapPanel, useAirportsIndex } from "../map/index.ts";
import { bucketTripItems } from "../timeline/bucket.ts";
import {
  formatCivilDateLabel,
  formatInstantInZone,
} from "../timeline/datetime.ts";

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

function hasConfirmation(item: ItineraryItem): boolean {
  return (item.confirmationCode ?? "").trim().length > 0;
}

/** Trip detail: day-grouped timeline + map + flight/note editors (PR 8b/13). */
export function TripDetailPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const authClient = useAuthClient();
  const { signOut } = useAuth();
  const airportsLoad = useAirportsIndex();

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
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(
    undefined,
  );

  const loadGeneration = useRef(0);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    setSelectedItemId(undefined);
  }, [tripId]);

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
      if (selectedItemId === item.itemId) {
        setSelectedItemId(undefined);
      }
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

  function selectItem(itemId: string | undefined): void {
    setSelectedItemId(itemId);
    if (itemId === undefined) {
      return;
    }
    const el = itemRefs.current.get(itemId);
    if (el !== undefined) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function renderItemCard(item: ItineraryItem) {
    const timezone = detail?.timezone ?? "UTC";
    const editable = item.type === "flight" || item.type === "note";
    const subtitle = itemSubtitle(item, timezone);
    const selected = selectedItemId === item.itemId;
    // Suppress badge while airports load so IATA-only flights don't flash "Add location".
    const showAddLocation =
      airportsLoad.status === "ready" &&
      !itemHasMapGeo(item, airportsLoad.index);
    return (
      <li
        key={item.itemId}
        className={`item-card${selected ? " item-card--selected" : ""}`}
        ref={(node) => {
          if (node === null) {
            itemRefs.current.delete(item.itemId);
          } else {
            itemRefs.current.set(item.itemId, node);
          }
        }}
      >
        <button
          type="button"
          className="item-card__select"
          onClick={() => {
            selectItem(item.itemId);
          }}
        >
          <div className="item-card__main">
            <div className="item-card__head">
              <span className={`item-type item-type--${item.type}`}>
                {itemTypeLabel(item.type)}
              </span>
              <span className="item-card__title">{item.title}</span>
              {showAddLocation ? (
                <span className="item-badge item-badge--location">
                  Add location
                </span>
              ) : null}
            </div>
            {subtitle !== undefined ? (
              <p className="item-card__sub">{subtitle}</p>
            ) : null}
            {item.type === "flight" && hasConfirmation(item) ? (
              <p className="item-card__meta">
                Confirmation: {item.confirmationCode}
              </p>
            ) : null}
          </div>
        </button>
        <div className="item-card__actions">
          {editable ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                openEdit(item);
              }}
            >
              Edit
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={deletingId === item.itemId}
            onClick={() => {
              void handleDelete(item);
            }}
          >
            {deletingId === item.itemId ? "…" : "Delete"}
          </button>
        </div>
      </li>
    );
  }

  if (tripId === undefined || tripId.length === 0) {
    return (
      <div className="panel panel--error">
        <p className="banner banner--error" role="alert">
          Missing trip id.
        </p>
        <Link to="/">Back to trips</Link>
      </div>
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
    <div className="trip-detail">
      <div className="trip-detail__nav">
        <Link to="/" className="trip-detail__back">
          ← All trips
        </Link>
      </div>

      {loading && detail === undefined ? (
        <section className="panel">
          <p className="muted">Loading trip…</p>
        </section>
      ) : null}

      {listError !== undefined ? (
        <p className="banner banner--error" role="alert">
          {listError}
        </p>
      ) : null}

      {detail !== undefined ? (
        <>
          <section className="panel">
            <div className="panel__header">
              <div>
                <h2>{detail.title}</h2>
                <p className="trip-detail__meta muted">
                  {detail.startDate} → {detail.endDate}
                  <span className="trip-detail__tz">{detail.timezone}</span>
                </p>
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  void loadTrip();
                }}
                disabled={loading}
              >
                Refresh
              </button>
            </div>
          </section>

          <div className="trip-workspace">
            <section className="panel trip-workspace__timeline">
              <div className="panel__header">
                <h2>Timeline</h2>
                <div className="trip-detail__add">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={openCreateFlight}
                  >
                    + Flight
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={openCreateNote}
                  >
                    + Note
                  </button>
                </div>
              </div>

              {editor.kind === "create-flight" ||
              editor.kind === "edit-flight" ? (
                <div className="item-form-wrap">
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
                  />
                </div>
              ) : null}

              {editor.kind === "create-note" || editor.kind === "edit-note" ? (
                <div className="item-form-wrap">
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
                <p className="muted">
                  No items yet. Add a flight or note to start the timeline.
                </p>
              ) : null}

              {buckets !== undefined
                ? buckets.days.map((day) => (
                    <div key={day.date} className="day-bucket">
                      <header className="day-bucket__header">
                        <span className="day-bucket__num">
                          Day {day.dayNumber}
                        </span>
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

            <div className="trip-workspace__map">
              <TripMapPanel
                items={detail.items}
                tripTimezone={detail.timezone}
                tripStartDate={detail.startDate}
                airports={airportsLoad}
                onRetryAirports={airportsLoad.retry}
                selectedItemId={selectedItemId}
                onSelectItem={selectItem}
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
