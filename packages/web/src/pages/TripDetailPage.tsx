import { useAuth } from "@ericminassian/auth/react";
import type {
  CreateItineraryItem,
  ItineraryItem,
  ItemType,
  UpdateItineraryItem,
} from "@tripplan/domain";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { Link, useParams } from "react-router-dom";
import {
  createTripPlanApi,
  type TripDetailResponse,
} from "../api/client.ts";
import { ApiClientError, formatApiError } from "../api/errors.ts";
import { useAuthClient } from "../auth/AuthClientContext.tsx";
import { ActivityForm } from "../components/ActivityForm.tsx";
import { CustomForm } from "../components/CustomForm.tsx";
import { FlightForm } from "../components/FlightForm.tsx";
import { HotelForm } from "../components/HotelForm.tsx";
import { NoteForm } from "../components/NoteForm.tsx";
import { TicketForm } from "../components/TicketForm.tsx";
import { TrainForm } from "../components/TrainForm.tsx";
import { TransportForm } from "../components/TransportForm.tsx";
import { bucketTripItems } from "../timeline/bucket.ts";
import {
  formatCivilDateLabel,
  formatInstantInZone,
} from "../timeline/datetime.ts";
import {
  canMoveInSection,
  dropWithinSection,
  reorderWithinSection,
  sameStartAtGroup,
} from "../timeline/reorder.ts";

/** Creatable / editable item types on the timeline. */
const CREATABLE_TYPES = [
  "flight",
  "hotel",
  "train",
  "transport",
  "activity",
  "ticket",
  "note",
  "custom",
] as const satisfies ReadonlyArray<ItemType>;

type CreatableType = (typeof CREATABLE_TYPES)[number];

type SectionKey = "unscheduled" | number;

type EditorState =
  | { readonly kind: "closed" }
  | {
      readonly kind: "create";
      readonly type: CreatableType;
      /** Remount key + Idempotency-Key for this create session. */
      readonly sessionId: string;
    }
  | {
      readonly kind: "edit";
      readonly item: ItineraryItem;
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

function typeOptionLabel(type: CreatableType): string {
  return itemTypeLabel(type);
}

function isCreatableType(value: string): value is CreatableType {
  return (CREATABLE_TYPES as readonly string[]).includes(value);
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
  if (item.type === "hotel") {
    const bits = [
      item.details.propertyName,
      item.details.address,
      start,
      end !== undefined ? `→ ${end}` : undefined,
    ].filter((x): x is string => x !== undefined && x.length > 0);
    return bits.join(" · ");
  }
  if (item.type === "train") {
    const route = [
      item.details.departureStation,
      item.details.arrivalStation,
    ]
      .filter((x): x is string => x !== undefined && x.length > 0)
      .join(" → ");
    const bits = [
      item.details.trainNumber,
      item.details.operator,
      route.length > 0 ? route : undefined,
      start,
      end !== undefined ? `→ ${end}` : undefined,
    ].filter((x): x is string => x !== undefined && x.length > 0);
    return bits.join(" · ");
  }
  if (item.type === "transport") {
    const bits = [
      item.details.mode,
      item.details.provider,
      start,
      end !== undefined ? `→ ${end}` : undefined,
    ].filter((x): x is string => x !== undefined && x.length > 0);
    return bits.join(" · ");
  }
  if (item.type === "activity") {
    const bits = [
      item.details.venueName,
      item.details.category,
      start,
      end !== undefined ? `→ ${end}` : undefined,
    ].filter((x): x is string => x !== undefined && x.length > 0);
    return bits.join(" · ");
  }
  if (item.type === "ticket") {
    const bits = [
      item.details.ticketType,
      item.details.issuer,
      start,
    ].filter((x): x is string => x !== undefined && x.length > 0);
    return bits.join(" · ");
  }
  if (item.type === "custom") {
    const fieldCount = Object.keys(item.details.fields ?? {}).length;
    const bits = [
      fieldCount > 0 ? `${String(fieldCount)} field(s)` : undefined,
      start,
    ].filter((x): x is string => x !== undefined);
    return bits.length > 0 ? bits.join(" · ") : undefined;
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

type FormSharedProps = {
  readonly tripTimezone: string;
  readonly submitting: boolean;
  readonly error: string | undefined;
  readonly onCancel: () => void;
  readonly onCreate: (payload: CreateItineraryItem) => Promise<void>;
  readonly onUpdate: (
    itemId: string,
    version: number,
    payload: UpdateItineraryItem,
  ) => Promise<void>;
};

function renderEditorForm(
  editor: Extract<EditorState, { kind: "create" | "edit" }>,
  formKey: string | undefined,
  shared: FormSharedProps,
) {
  if (editor.kind === "create") {
    switch (editor.type) {
      case "flight":
        return <FlightForm key={formKey} mode={{ kind: "create" }} {...shared} />;
      case "note":
        return <NoteForm key={formKey} mode={{ kind: "create" }} {...shared} />;
      case "hotel":
        return <HotelForm key={formKey} mode={{ kind: "create" }} {...shared} />;
      case "train":
        return <TrainForm key={formKey} mode={{ kind: "create" }} {...shared} />;
      case "transport":
        return (
          <TransportForm key={formKey} mode={{ kind: "create" }} {...shared} />
        );
      case "activity":
        return (
          <ActivityForm key={formKey} mode={{ kind: "create" }} {...shared} />
        );
      case "ticket":
        return <TicketForm key={formKey} mode={{ kind: "create" }} {...shared} />;
      case "custom":
        return <CustomForm key={formKey} mode={{ kind: "create" }} {...shared} />;
    }
  }

  const item = editor.item;
  switch (item.type) {
    case "flight":
      return (
        <FlightForm key={formKey} mode={{ kind: "edit", item }} {...shared} />
      );
    case "note":
      return (
        <NoteForm key={formKey} mode={{ kind: "edit", item }} {...shared} />
      );
    case "hotel":
      return (
        <HotelForm key={formKey} mode={{ kind: "edit", item }} {...shared} />
      );
    case "train":
      return (
        <TrainForm key={formKey} mode={{ kind: "edit", item }} {...shared} />
      );
    case "transport":
      return (
        <TransportForm
          key={formKey}
          mode={{ kind: "edit", item }}
          {...shared}
        />
      );
    case "activity":
      return (
        <ActivityForm
          key={formKey}
          mode={{ kind: "edit", item }}
          {...shared}
        />
      );
    case "ticket":
      return (
        <TicketForm key={formKey} mode={{ kind: "edit", item }} {...shared} />
      );
    case "custom":
      return (
        <CustomForm key={formKey} mode={{ kind: "edit", item }} {...shared} />
      );
  }
}

/** Trip detail: day-grouped timeline + all item editors + scoped reorder (PR 9). */
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
  const [reordering, setReordering] = useState(false);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [dragItemId, setDragItemId] = useState<string | undefined>(undefined);
  const [dragSection, setDragSection] = useState<SectionKey | undefined>(
    undefined,
  );
  const [addType, setAddType] = useState<CreatableType>("flight");

  const loadGeneration = useRef(0);
  /** Synchronous lock so double-click reorder / create+reorder races cannot stack. */
  const itemSetBusyRef = useRef(false);

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

  const itemSetBusy =
    reordering || submitting || deletingId !== undefined;

  function closeEditor(): void {
    setEditor({ kind: "closed" });
    setFormError(undefined);
  }

  function openCreate(type: CreatableType): void {
    if (itemSetBusyRef.current || itemSetBusy) {
      return;
    }
    setFormError(undefined);
    setEditor({ kind: "create", type, sessionId: newSessionId() });
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
    setEditor({ kind: "edit", item: live });
    setFormError(
      "Someone else updated this item — review the latest version and save again.",
    );
  }

  async function handleCreate(payload: CreateItineraryItem): Promise<void> {
    if (tripId === undefined || itemSetBusyRef.current) {
      return;
    }
    const sessionId =
      editor.kind === "create" ? editor.sessionId : newSessionId();
    itemSetBusyRef.current = true;
    setSubmitting(true);
    setFormError(undefined);
    try {
      await api.createItem(tripId, payload, {
        idempotencyKey: sessionId,
      });
      // Re-GET so trip version matches server (create bumps trip; idempotent
      // replay must not leave local version ahead of the server).
      await loadTrip();
      closeEditor();
    } catch (cause) {
      setFormError(formatApiError(cause));
    } finally {
      itemSetBusyRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleUpdate(
    itemId: string,
    version: number,
    payload: UpdateItineraryItem,
  ): Promise<void> {
    if (tripId === undefined || itemSetBusyRef.current) {
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
    if (tripId === undefined || itemSetBusyRef.current) {
      return;
    }
    const ok = window.confirm(`Delete “${item.title}”?`);
    if (!ok) {
      return;
    }
    itemSetBusyRef.current = true;
    setDeletingId(item.itemId);
    setListError(undefined);
    try {
      await api.deleteItem(tripId, item.itemId);
      if (editor.kind === "edit" && editor.item.itemId === item.itemId) {
        closeEditor();
      }
      // Re-GET for trip version + authoritative item set after delete bump.
      await loadTrip();
    } catch (cause) {
      setListError(formatApiError(cause));
    } finally {
      itemSetBusyRef.current = false;
      setDeletingId(undefined);
    }
  }

  async function applyReorder(nextIds: readonly string[]): Promise<void> {
    if (tripId === undefined || detail === undefined) {
      return;
    }
    if (itemSetBusyRef.current) {
      return;
    }
    itemSetBusyRef.current = true;
    const previous = detail;
    // Optimistic: reorder local items by new id list + bump version.
    const byId = new Map(previous.items.map((i) => [i.itemId, i]));
    const reorderedItems: ItineraryItem[] = [];
    for (let i = 0; i < nextIds.length; i += 1) {
      const id = nextIds[i];
      if (id === undefined) {
        continue;
      }
      const item = byId.get(id);
      if (item !== undefined) {
        reorderedItems.push({
          ...item,
          sortKey: (i + 1) * 1000,
        });
      }
    }
    setDetail({
      ...previous,
      version: previous.version + 1,
      items: reorderedItems,
    });
    setReordering(true);
    setListError(undefined);
    try {
      const result = await api.reorderItems(
        tripId,
        previous.version,
        nextIds,
      );
      setDetail(result);
    } catch (cause) {
      setDetail(previous);
      if (
        cause instanceof ApiClientError &&
        (cause.status === 409 || cause.type === "Conflict")
      ) {
        await loadTrip();
        setListError(
          "Timeline changed elsewhere — reloaded the latest order. Try again.",
        );
      } else {
        setListError(formatApiError(cause));
      }
    } finally {
      itemSetBusyRef.current = false;
      setReordering(false);
    }
  }

  async function handleMove(
    sectionKey: SectionKey,
    itemId: string,
    direction: "up" | "down",
  ): Promise<void> {
    if (buckets === undefined) {
      return;
    }
    const next = reorderWithinSection(buckets, sectionKey, itemId, direction);
    if (next === undefined) {
      return;
    }
    await applyReorder(next);
  }

  async function handleDropOn(
    sectionKey: SectionKey,
    targetItemId: string,
  ): Promise<void> {
    if (
      buckets === undefined ||
      dragItemId === undefined ||
      dragSection === undefined
    ) {
      return;
    }
    if (dragSection !== sectionKey) {
      setDragItemId(undefined);
      setDragSection(undefined);
      return;
    }
    const next = dropWithinSection(
      buckets,
      sectionKey,
      dragItemId,
      targetItemId,
    );
    setDragItemId(undefined);
    setDragSection(undefined);
    if (next === undefined) {
      return;
    }
    await applyReorder(next);
  }

  function openEdit(item: ItineraryItem): void {
    setFormError(undefined);
    setEditor({ kind: "edit", item });
  }

  function renderItemCard(
    item: ItineraryItem,
    sectionKey: SectionKey,
    sectionItems: readonly ItineraryItem[],
  ) {
    const timezone = detail?.timezone ?? "UTC";
    const subtitle = itemSubtitle(item, timezone);
    const busy = itemSetBusy;
    const canMoveUp = canMoveInSection(sectionItems, item.itemId, "up");
    const canMoveDown = canMoveInSection(sectionItems, item.itemId, "down");
    const reorderable = canMoveUp || canMoveDown;

    return (
      <li
        key={item.itemId}
        className={
          dragItemId === item.itemId
            ? "item-card item-card--dragging"
            : "item-card"
        }
        onDragOver={(event: DragEvent<HTMLLIElement>) => {
          if (
            dragItemId === undefined ||
            dragItemId === item.itemId ||
            dragSection !== sectionKey
          ) {
            return;
          }
          const source = sectionItems.find((i) => i.itemId === dragItemId);
          if (
            source === undefined ||
            !sameStartAtGroup(source.startAt, item.startAt)
          ) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event: DragEvent<HTMLLIElement>) => {
          event.preventDefault();
          void handleDropOn(sectionKey, item.itemId);
        }}
      >
        <div className="item-card__reorder">
          <span
            className={
              reorderable && !busy
                ? "item-card__handle"
                : "item-card__handle item-card__handle--disabled"
            }
            draggable={reorderable && !busy}
            title={
              reorderable
                ? "Drag to reorder within same time group"
                : "Reorder only among items with the same start time (or unscheduled)"
            }
            aria-label={
              reorderable
                ? `Drag to reorder ${item.title}`
                : `Cannot reorder ${item.title}`
            }
            onDragStart={(event: DragEvent<HTMLSpanElement>) => {
              if (!reorderable || busy) {
                event.preventDefault();
                return;
              }
              setDragItemId(item.itemId);
              setDragSection(sectionKey);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.itemId);
            }}
            onDragEnd={() => {
              setDragItemId(undefined);
              setDragSection(undefined);
            }}
          >
            ⋮⋮
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            aria-label={`Move ${item.title} up`}
            disabled={busy || !canMoveUp}
            onClick={() => {
              void handleMove(sectionKey, item.itemId, "up");
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            aria-label={`Move ${item.title} down`}
            disabled={busy || !canMoveDown}
            onClick={() => {
              void handleMove(sectionKey, item.itemId, "down");
            }}
          >
            ↓
          </button>
        </div>
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
          {hasConfirmation(item) ? (
            <p className="item-card__meta">
              Confirmation: {item.confirmationCode}
            </p>
          ) : null}
        </div>
        <div className="item-card__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => {
              openEdit(item);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
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

  function renderItemList(
    items: readonly ItineraryItem[],
    sectionKey: SectionKey,
  ) {
    return (
      <ul className="item-list">
        {items.map((item) => renderItemCard(item, sectionKey, items))}
      </ul>
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
  const formKey =
    editor.kind === "create"
      ? `create-${editor.type}-${editor.sessionId}`
      : editor.kind === "edit"
        ? `edit-${editor.item.type}-${editor.item.itemId}-v${String(editor.item.version)}`
        : undefined;

  const formShared = {
    tripTimezone: detail?.timezone ?? "UTC",
    submitting,
    error: formError,
    onCancel: closeEditor,
    onCreate: handleCreate,
    onUpdate: handleUpdate,
  };

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
                disabled={loading || itemSetBusy}
              >
                Refresh
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel__header">
              <h2>Timeline</h2>
              <div className="trip-detail__add">
                <label className="trip-detail__add-type">
                  <span className="visually-hidden">Item type</span>
                  <select
                    className="field__input trip-detail__add-select"
                    value={addType}
                    disabled={itemSetBusy}
                    onChange={(e) => {
                      if (isCreatableType(e.target.value)) {
                        setAddType(e.target.value);
                      }
                    }}
                  >
                    {CREATABLE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {typeOptionLabel(type)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={itemSetBusy}
                  onClick={() => {
                    openCreate(addType);
                  }}
                >
                  Add item
                </button>
              </div>
            </div>

            {editor.kind === "create" || editor.kind === "edit" ? (
              <div className="item-form-wrap">
                {renderEditorForm(editor, formKey, formShared)}
              </div>
            ) : null}

            {buckets !== undefined &&
            buckets.days.length === 0 &&
            buckets.unscheduled.length === 0 ? (
              <p className="muted">
                No items yet. Use Add item to build the timeline. Reorder
                (⋮⋮ or ↑/↓) applies among unscheduled items and same-start-time
                ties — day placement follows each item’s start time.
              </p>
            ) : (
              <p className="field__hint trip-detail__reorder-hint">
                Reorder with ⋮⋮ or ↑/↓ among unscheduled items or items that
                share the same start time. Changing the day requires editing
                the start time.
              </p>
            )}

            {reordering ? (
              <p className="muted" aria-live="polite">
                Saving order…
              </p>
            ) : null}

            {buckets !== undefined
              ? buckets.days.map((day, dayIndex) => (
                  <div key={day.date} className="day-bucket">
                    <header className="day-bucket__header">
                      <span className="day-bucket__num">Day {day.dayNumber}</span>
                      <span className="day-bucket__date">
                        {formatCivilDateLabel(day.date)}
                      </span>
                    </header>
                    {renderItemList(day.items, dayIndex)}
                  </div>
                ))
              : null}

            {buckets !== undefined && buckets.unscheduled.length > 0 ? (
              <div className="day-bucket day-bucket--unscheduled">
                <header className="day-bucket__header">
                  <span className="day-bucket__num">Unscheduled</span>
                  <span className="day-bucket__date">No start time</span>
                </header>
                {renderItemList(buckets.unscheduled, "unscheduled")}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
