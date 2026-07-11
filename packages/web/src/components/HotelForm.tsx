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

export type HotelFormMode =
  | { readonly kind: "create" }
  | {
      readonly kind: "edit";
      readonly item: Extract<ItineraryItem, { readonly type: "hotel" }>;
    };

export interface HotelFormProps {
  readonly mode: HotelFormMode;
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
  propertyName: string;
  address: string;
  phone: string;
  roomType: string;
  bookingReference: string;
  confirmationCode: string;
  checkInTime: string;
  checkOutTime: string;
  notes: string;
  startAtLocal: string;
  endAtLocal: string;
}

function emptyState(): FormState {
  return {
    title: "",
    propertyName: "",
    address: "",
    phone: "",
    roomType: "",
    bookingReference: "",
    confirmationCode: "",
    checkInTime: "",
    checkOutTime: "",
    notes: "",
    startAtLocal: "",
    endAtLocal: "",
  };
}

function stateFromItem(
  item: Extract<ItineraryItem, { readonly type: "hotel" }>,
  tripTimezone: string,
): FormState {
  return {
    title: item.title,
    propertyName: item.details.propertyName,
    address: item.details.address ?? "",
    phone: item.details.phone ?? "",
    roomType: item.details.roomType ?? "",
    bookingReference: item.details.bookingReference ?? "",
    confirmationCode: item.confirmationCode ?? "",
    checkInTime: item.details.checkInTime ?? "",
    checkOutTime: item.details.checkOutTime ?? "",
    notes: item.notes ?? "",
    startAtLocal: instantToWallClockLocal(item.startAt, tripTimezone),
    endAtLocal: instantToWallClockLocal(item.endAt, tripTimezone),
  };
}

/** Hotel create / edit form. Parent remounts via `key` on new sessions. */
export function HotelForm(props: HotelFormProps) {
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
    const propertyName = form.propertyName.trim();
    if (title.length === 0) {
      setLocalError("Title is required");
      return;
    }
    if (propertyName.length === 0) {
      setLocalError("Property name is required");
      return;
    }

    const clearOnEmpty = mode.kind === "edit";
    const startParsed = parseOptionalInstant(
      form.startAtLocal,
      tripTimezone,
      "Check-in time",
      clearOnEmpty,
    );
    if (!startParsed.ok) {
      setLocalError(startParsed.error);
      return;
    }
    const endParsed = parseOptionalInstant(
      form.endAtLocal,
      tripTimezone,
      "Check-out time",
      clearOnEmpty,
    );
    if (!endParsed.ok) {
      setLocalError(endParsed.error);
      return;
    }

    const details: Record<string, string> = { propertyName };
    assignOptionalDetails(details, [
      ["address", form.address],
      ["phone", form.phone],
      ["roomType", form.roomType],
      ["bookingReference", form.bookingReference],
      ["checkInTime", form.checkInTime],
      ["checkOutTime", form.checkOutTime],
    ]);
    // Preserve server/seed fields not exposed in the form (full details replace).
    if (mode.kind === "edit" && mode.item.details.timePrecision !== undefined) {
      details["timePrecision"] = mode.item.details.timePrecision;
    }

    const confirmationCode = optionalTrim(form.confirmationCode);
    const notes = optionalTrim(form.notes);

    if (mode.kind === "create") {
      const body: Record<string, unknown> = {
        type: "hotel",
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
        {mode.kind === "create" ? "Add hotel" : "Edit hotel"}
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
          placeholder="Hotel night 1"
        />
      </label>

      <label className="field">
        <span className="field__label">Property name</span>
        <input
          className="field__input"
          type="text"
          name="propertyName"
          required
          value={form.propertyName}
          onChange={(e) => {
            setForm((f) => ({ ...f, propertyName: e.target.value }));
          }}
          placeholder="The Lumière"
        />
      </label>

      <label className="field">
        <span className="field__label">Address</span>
        <input
          className="field__input"
          type="text"
          name="address"
          value={form.address}
          onChange={(e) => {
            setForm((f) => ({ ...f, address: e.target.value }));
          }}
        />
      </label>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Phone</span>
          <input
            className="field__input"
            type="text"
            name="phone"
            value={form.phone}
            onChange={(e) => {
              setForm((f) => ({ ...f, phone: e.target.value }));
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">Room type</span>
          <input
            className="field__input"
            type="text"
            name="roomType"
            value={form.roomType}
            onChange={(e) => {
              setForm((f) => ({ ...f, roomType: e.target.value }));
            }}
          />
        </label>
      </div>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Check-in ({tripTimezone})</span>
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
          <span className="field__label">Check-out ({tripTimezone})</span>
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
        Stay window times are in {tripTimezone}. Optional wall times below are
        free-text (e.g. “15:00”) for property desk hours.
      </p>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Desk check-in time</span>
          <input
            className="field__input"
            type="text"
            name="checkInTime"
            value={form.checkInTime}
            onChange={(e) => {
              setForm((f) => ({ ...f, checkInTime: e.target.value }));
            }}
            placeholder="15:00"
          />
        </label>
        <label className="field">
          <span className="field__label">Desk check-out time</span>
          <input
            className="field__input"
            type="text"
            name="checkOutTime"
            value={form.checkOutTime}
            onChange={(e) => {
              setForm((f) => ({ ...f, checkOutTime: e.target.value }));
            }}
            placeholder="11:00"
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
              ? "Add hotel"
              : "Save hotel"}
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
