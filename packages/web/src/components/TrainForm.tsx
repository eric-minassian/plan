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

export type TrainFormMode =
  | { readonly kind: "create" }
  | {
      readonly kind: "edit";
      readonly item: Extract<ItineraryItem, { readonly type: "train" }>;
    };

export interface TrainFormProps {
  readonly mode: TrainFormMode;
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
  operator: string;
  trainNumber: string;
  departureStation: string;
  arrivalStation: string;
  coach: string;
  seat: string;
  bookingReference: string;
  confirmationCode: string;
  notes: string;
  startAtLocal: string;
  endAtLocal: string;
}

function emptyState(): FormState {
  return {
    title: "",
    operator: "",
    trainNumber: "",
    departureStation: "",
    arrivalStation: "",
    coach: "",
    seat: "",
    bookingReference: "",
    confirmationCode: "",
    notes: "",
    startAtLocal: "",
    endAtLocal: "",
  };
}

function stateFromItem(
  item: Extract<ItineraryItem, { readonly type: "train" }>,
  tripTimezone: string,
): FormState {
  return {
    title: item.title,
    operator: item.details.operator ?? "",
    trainNumber: item.details.trainNumber ?? "",
    departureStation: item.details.departureStation ?? "",
    arrivalStation: item.details.arrivalStation ?? "",
    coach: item.details.coach ?? "",
    seat: item.details.seat ?? "",
    bookingReference: item.details.bookingReference ?? "",
    confirmationCode: item.confirmationCode ?? "",
    notes: item.notes ?? "",
    startAtLocal: instantToWallClockLocal(item.startAt, tripTimezone),
    endAtLocal: instantToWallClockLocal(item.endAt, tripTimezone),
  };
}

/** Train create / edit form. Parent remounts via `key` on new sessions. */
export function TrainForm(props: TrainFormProps) {
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
      "Departure time",
      clearOnEmpty,
    );
    if (!startParsed.ok) {
      setLocalError(startParsed.error);
      return;
    }
    const endParsed = parseOptionalInstant(
      form.endAtLocal,
      tripTimezone,
      "Arrival time",
      clearOnEmpty,
    );
    if (!endParsed.ok) {
      setLocalError(endParsed.error);
      return;
    }

    const details: Record<string, string> = {};
    assignOptionalDetails(details, [
      ["operator", form.operator],
      ["trainNumber", form.trainNumber],
      ["departureStation", form.departureStation],
      ["arrivalStation", form.arrivalStation],
      ["coach", form.coach],
      ["seat", form.seat],
      ["bookingReference", form.bookingReference],
    ]);

    const confirmationCode = optionalTrim(form.confirmationCode);
    const notes = optionalTrim(form.notes);

    if (mode.kind === "create") {
      const body: Record<string, unknown> = {
        type: "train",
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
        {mode.kind === "create" ? "Add train" : "Edit train"}
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
          placeholder="TGV to Lyon"
        />
      </label>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Operator</span>
          <input
            className="field__input"
            type="text"
            name="operator"
            value={form.operator}
            onChange={(e) => {
              setForm((f) => ({ ...f, operator: e.target.value }));
            }}
            placeholder="SNCF"
          />
        </label>
        <label className="field">
          <span className="field__label">Train number</span>
          <input
            className="field__input"
            type="text"
            name="trainNumber"
            value={form.trainNumber}
            onChange={(e) => {
              setForm((f) => ({ ...f, trainNumber: e.target.value }));
            }}
            placeholder="6612"
          />
        </label>
      </div>

      <div className="form__row">
        <label className="field">
          <span className="field__label">From station</span>
          <input
            className="field__input"
            type="text"
            name="departureStation"
            value={form.departureStation}
            onChange={(e) => {
              setForm((f) => ({ ...f, departureStation: e.target.value }));
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">To station</span>
          <input
            className="field__input"
            type="text"
            name="arrivalStation"
            value={form.arrivalStation}
            onChange={(e) => {
              setForm((f) => ({ ...f, arrivalStation: e.target.value }));
            }}
          />
        </label>
      </div>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Departure ({tripTimezone})</span>
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
          <span className="field__label">Arrival ({tripTimezone})</span>
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
          <span className="field__label">Coach</span>
          <input
            className="field__input"
            type="text"
            name="coach"
            value={form.coach}
            onChange={(e) => {
              setForm((f) => ({ ...f, coach: e.target.value }));
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">Seat</span>
          <input
            className="field__input"
            type="text"
            name="seat"
            value={form.seat}
            onChange={(e) => {
              setForm((f) => ({ ...f, seat: e.target.value }));
            }}
          />
        </label>
      </div>

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
              ? "Add train"
              : "Save train"}
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
