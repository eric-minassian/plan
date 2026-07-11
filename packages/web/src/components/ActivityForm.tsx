import type {
  CreateItineraryItem,
  ItineraryItem,
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
}

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
  };
}

/** Activity create / edit form. Parent remounts via `key` on new sessions. */
export function ActivityForm(props: ActivityFormProps) {
  const { mode, tripTimezone, submitting, error, onCancel, onCreate, onUpdate } =
    props;
  const [form, setForm] = useState<FormState>(() =>
    mode.kind === "edit"
      ? stateFromItem(mode.item, tripTimezone)
      : emptyState(),
  );
  const [localError, setLocalError] = useState<string | undefined>(undefined);

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
