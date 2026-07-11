import type {
  CreateItineraryItem,
  EnrichPlaceRequest,
  EnrichmentMeta,
  GeoPoint,
  ItineraryItem,
  PlaceEnrichmentResponse,
  UpdateItineraryItem,
} from "@tripplan/domain";
import { Either } from "effect";
import { useState, type FormEvent } from "react";
import { decodeCreateItem, decodeUpdateItem } from "../api/decode.ts";
import { instantToWallClockLocal } from "../timeline/datetime.ts";
import {
  assignOptionalDetails,
  optionalTrim,
  parseOptionalInstant,
} from "./form-utils.ts";
import { LocationPicker } from "./LocationPicker.tsx";

export type ActivityFormMode =
  | { readonly kind: "create" }
  | {
      readonly kind: "edit";
      readonly item: Extract<ItineraryItem, { readonly type: "activity" }>;
    };

export interface ActivityFormProps {
  readonly mode: ActivityFormMode;
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
  /**
   * Optional place typeahead (suggest-then-confirm). When omitted, location
   * picker search is hidden.
   */
  readonly onEnrichPlace?: (
    query: EnrichPlaceRequest,
  ) => Promise<PlaceEnrichmentResponse>;
  /** Optional proximity bias for place search (trip region). */
  readonly placeProximity?: {
    readonly lat: number;
    readonly lng: number;
  };
}

interface FormState {
  title: string;
  category: string;
  venueName: string;
  bookingUrl: string;
  bookingReference: string;
  confirmationCode: string;
  notes: string;
  startAtLocal: string;
  endAtLocal: string;
  startLocation: GeoPoint | undefined;
}

/** Enrichment intent for save: leave as-is, set meta, or clear stored meta. */
type EnrichmentIntent =
  | { readonly kind: "unchanged" }
  | { readonly kind: "set"; readonly meta: EnrichmentMeta }
  | { readonly kind: "clear" };

function emptyState(): FormState {
  return {
    title: "",
    category: "",
    venueName: "",
    bookingUrl: "",
    bookingReference: "",
    confirmationCode: "",
    notes: "",
    startAtLocal: "",
    endAtLocal: "",
    startLocation: undefined,
  };
}

function stateFromItem(
  item: Extract<ItineraryItem, { readonly type: "activity" }>,
  tripTimezone: string,
): FormState {
  return {
    title: item.title,
    category: item.details.category ?? "",
    venueName: item.details.venueName ?? "",
    bookingUrl: item.details.bookingUrl ?? "",
    bookingReference: item.details.bookingReference ?? "",
    confirmationCode: item.confirmationCode ?? "",
    notes: item.notes ?? "",
    startAtLocal: instantToWallClockLocal(item.startAt, tripTimezone),
    endAtLocal: instantToWallClockLocal(item.endAt, tripTimezone),
    startLocation: item.startLocation,
  };
}

/**
 * Activity create / edit form with optional place typeahead (PR 12).
 * Parent remounts via `key` on new sessions. Enrichment never auto-saves.
 */
export function ActivityForm(props: ActivityFormProps) {
  const {
    mode,
    tripTimezone,
    submitting,
    error,
    onCancel,
    onCreate,
    onUpdate,
    onEnrichPlace,
    placeProximity,
  } = props;
  const [form, setForm] = useState<FormState>(() =>
    mode.kind === "edit"
      ? stateFromItem(mode.item, tripTimezone)
      : emptyState(),
  );
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [enrichmentIntent, setEnrichmentIntent] = useState<EnrichmentIntent>(
    () =>
      mode.kind === "edit" && mode.item.enrichment !== undefined
        ? { kind: "set", meta: mode.item.enrichment }
        : { kind: "unchanged" },
  );

  function onLocationChange(
    location: GeoPoint | undefined,
    meta: EnrichmentMeta | undefined,
  ): void {
    setForm((prev) => {
      if (location === undefined) {
        return { ...prev, startLocation: undefined };
      }
      const venueName =
        prev.venueName.trim().length > 0
          ? prev.venueName
          : (location.label ?? prev.venueName);
      const title =
        prev.title.trim().length > 0
          ? prev.title
          : venueName.length > 0
            ? venueName
            : prev.title;
      return {
        ...prev,
        startLocation: location,
        venueName,
        title,
      };
    });
    if (location === undefined) {
      setEnrichmentIntent(
        mode.kind === "edit" ? { kind: "clear" } : { kind: "unchanged" },
      );
      return;
    }
    if (meta !== undefined) {
      setEnrichmentIntent({ kind: "set", meta });
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLocalError(undefined);

    const title = form.title.trim();
    if (title.length === 0) {
      setLocalError("Title is required");
      return;
    }

    const clearOnEmpty = mode.kind === "edit";
    const startParsed = parseOptionalInstant(
      form.startAtLocal,
      tripTimezone,
      "Start time",
      clearOnEmpty,
    );
    if (!startParsed.ok) {
      setLocalError(startParsed.error);
      return;
    }
    const endParsed = parseOptionalInstant(
      form.endAtLocal,
      tripTimezone,
      "End time",
      clearOnEmpty,
    );
    if (!endParsed.ok) {
      setLocalError(endParsed.error);
      return;
    }

    const details: Record<string, string> = {};
    assignOptionalDetails(details, [
      ["category", form.category],
      ["venueName", form.venueName],
      ["bookingUrl", form.bookingUrl],
      ["bookingReference", form.bookingReference],
    ]);

    const confirmationCode = optionalTrim(form.confirmationCode);
    const notes = optionalTrim(form.notes);

    if (mode.kind === "create") {
      const body: Record<string, unknown> = {
        type: "activity",
        title,
        details,
      };
      if (typeof startParsed.value === "string") {
        body["startAt"] = startParsed.value;
      }
      if (typeof endParsed.value === "string") {
        body["endAt"] = endParsed.value;
      }
      if (confirmationCode !== undefined) {
        body["confirmationCode"] = confirmationCode;
      }
      if (notes !== undefined) {
        body["notes"] = notes;
      }
      if (form.startLocation !== undefined) {
        body["startLocation"] = form.startLocation;
      }
      if (enrichmentIntent.kind === "set") {
        body["enrichment"] = enrichmentIntent.meta;
      }
      const decoded = decodeCreateItem(body);
      if (Either.isLeft(decoded)) {
        setLocalError(decoded.left);
        return;
      }
      await onCreate(decoded.right);
      return;
    }

    const patch: Record<string, unknown> = {
      title,
      details,
      notes: notes ?? "",
      startAt: startParsed.value,
      endAt: endParsed.value,
      confirmationCode: confirmationCode ?? "",
    };
    if (form.startLocation !== undefined) {
      patch["startLocation"] = form.startLocation;
    } else if (mode.kind === "edit") {
      // Clear pin when the user used Clear in the location picker.
      patch["startLocation"] = null;
    }
    if (enrichmentIntent.kind === "set") {
      patch["enrichment"] = enrichmentIntent.meta;
    } else if (enrichmentIntent.kind === "clear") {
      patch["enrichment"] = null;
    }
    const decoded = decodeUpdateItem(patch);
    if (Either.isLeft(decoded)) {
      setLocalError(decoded.left);
      return;
    }
    await onUpdate(mode.item.itemId, mode.item.version, decoded.right);
  }

  const displayError = localError ?? error;

  return (
    <form className="form item-form" onSubmit={(e) => void onSubmit(e)}>
      <h3 className="item-form__title">
        {mode.kind === "create" ? "Add activity" : "Edit activity"}
      </h3>
      {displayError !== undefined ? (
        <p className="banner banner--error" role="alert">
          {displayError}
        </p>
      ) : null}

      <LocationPicker
        value={form.startLocation}
        disabled={submitting}
        label="Activity location"
        hint="Search to prefill venue and map pin. You always review and save — nothing is written automatically."
        proximity={placeProximity}
        onSearch={onEnrichPlace}
        onChange={onLocationChange}
      />

      <label className="field">
        <span className="field__label">Title</span>
        <input
          className="field__input"
          type="text"
          name="title"
          maxLength={200}
          required
          value={form.title}
          onChange={(e) => {
            setForm((f) => ({ ...f, title: e.target.value }));
          }}
          placeholder="Louvre visit"
        />
      </label>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Category</span>
          <input
            className="field__input"
            type="text"
            name="category"
            value={form.category}
            onChange={(e) => {
              setForm((f) => ({ ...f, category: e.target.value }));
            }}
            placeholder="Museum"
          />
        </label>
        <label className="field">
          <span className="field__label">Venue</span>
          <input
            className="field__input"
            type="text"
            name="venueName"
            value={form.venueName}
            onChange={(e) => {
              setForm((f) => ({ ...f, venueName: e.target.value }));
            }}
          />
        </label>
      </div>

      <label className="field">
        <span className="field__label">Booking URL</span>
        <input
          className="field__input"
          type="url"
          name="bookingUrl"
          value={form.bookingUrl}
          onChange={(e) => {
            setForm((f) => ({ ...f, bookingUrl: e.target.value }));
          }}
          placeholder="https://"
        />
      </label>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Start ({tripTimezone})</span>
          <input
            className="field__input"
            type="datetime-local"
            name="startAt"
            value={form.startAtLocal}
            onChange={(e) => {
              setForm((f) => ({ ...f, startAtLocal: e.target.value }));
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">End ({tripTimezone})</span>
          <input
            className="field__input"
            type="datetime-local"
            name="endAt"
            value={form.endAtLocal}
            onChange={(e) => {
              setForm((f) => ({ ...f, endAtLocal: e.target.value }));
            }}
          />
        </label>
      </div>
      <p className="field__hint">
        Times are in {tripTimezone}. Clear a field to remove that time.
      </p>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Confirmation</span>
          <input
            className="field__input"
            type="text"
            name="confirmationCode"
            maxLength={64}
            value={form.confirmationCode}
            onChange={(e) => {
              setForm((f) => ({ ...f, confirmationCode: e.target.value }));
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">Booking reference</span>
          <input
            className="field__input"
            type="text"
            name="bookingReference"
            value={form.bookingReference}
            onChange={(e) => {
              setForm((f) => ({ ...f, bookingReference: e.target.value }));
            }}
          />
        </label>
      </div>

      <label className="field">
        <span className="field__label">Notes</span>
        <textarea
          className="field__input field__textarea"
          name="notes"
          maxLength={5000}
          rows={2}
          value={form.notes}
          onChange={(e) => {
            setForm((f) => ({ ...f, notes: e.target.value }));
          }}
        />
      </label>

      <div className="form__actions">
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode.kind === "create"
              ? "Add activity"
              : "Save activity"}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
