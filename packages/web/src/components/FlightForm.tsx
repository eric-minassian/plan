import type {
  CreateItineraryItem,
  ItineraryItem,
  UpdateItineraryItem,
} from "@tripplan/domain";
import { Either } from "effect";
import { useState, type FormEvent } from "react";
import { decodeCreateItem, decodeUpdateItem } from "../api/decode.ts";
import {
  instantToWallClockLocal,
  wallClockInZoneToInstant,
} from "../timeline/datetime.ts";

export type FlightFormMode =
  | { readonly kind: "create" }
  | {
      readonly kind: "edit";
      readonly item: Extract<ItineraryItem, { readonly type: "flight" }>;
    };

export interface FlightFormProps {
  readonly mode: FlightFormMode;
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
  flightNumber: string;
  airlineCode: string;
  airlineName: string;
  departureAirport: string;
  arrivalAirport: string;
  confirmationCode: string;
  seat: string;
  notes: string;
  startAtLocal: string;
  endAtLocal: string;
}

function emptyState(): FormState {
  return {
    title: "",
    flightNumber: "",
    airlineCode: "",
    airlineName: "",
    departureAirport: "",
    arrivalAirport: "",
    confirmationCode: "",
    seat: "",
    notes: "",
    startAtLocal: "",
    endAtLocal: "",
  };
}

function stateFromItem(
  item: Extract<ItineraryItem, { readonly type: "flight" }>,
  tripTimezone: string,
): FormState {
  return {
    title: item.title,
    flightNumber: item.details.flightNumber,
    airlineCode: item.details.airlineCode ?? "",
    airlineName: item.details.airlineName ?? "",
    departureAirport: item.details.departureAirport ?? "",
    arrivalAirport: item.details.arrivalAirport ?? "",
    confirmationCode: item.confirmationCode ?? "",
    seat: item.details.seat ?? "",
    notes: item.notes ?? "",
    startAtLocal: instantToWallClockLocal(item.startAt, tripTimezone),
    endAtLocal: instantToWallClockLocal(item.endAt, tripTimezone),
  };
}

function optionalTrim(value: string): string | undefined {
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Parse wall clock for create (omit empty) vs edit (null clears).
 */
function parseOptionalInstant(
  wall: string,
  tripTimezone: string,
  label: string,
  clearOnEmpty: boolean,
):
  | { readonly ok: true; readonly value: string | null | undefined }
  | { readonly ok: false; readonly error: string } {
  if (wall.trim().length === 0) {
    return { ok: true, value: clearOnEmpty ? null : undefined };
  }
  const instant = wallClockInZoneToInstant(wall.trim(), tripTimezone);
  if (instant === undefined) {
    return {
      ok: false,
      error: `${label} is invalid for this trip timezone (check date/time)`,
    };
  }
  return { ok: true, value: instant };
}

/**
 * Manual flight create / edit form (PR 8b).
 *
 * Parent remounts via `key` when opening a new session — no `useEffect`
 * reset on `mode` object identity.
 */
export function FlightForm(props: FlightFormProps) {
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
    const flightNumber = form.flightNumber.trim();
    if (title.length === 0) {
      setLocalError("Title is required");
      return;
    }
    if (flightNumber.length === 0) {
      setLocalError("Flight number is required");
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

    const details: Record<string, string> = { flightNumber };
    const airlineCode = optionalTrim(form.airlineCode);
    const airlineName = optionalTrim(form.airlineName);
    const departureAirport = optionalTrim(form.departureAirport);
    const arrivalAirport = optionalTrim(form.arrivalAirport);
    const seat = optionalTrim(form.seat);
    if (airlineCode !== undefined) details["airlineCode"] = airlineCode;
    if (airlineName !== undefined) details["airlineName"] = airlineName;
    if (departureAirport !== undefined) {
      details["departureAirport"] = departureAirport;
    }
    if (arrivalAirport !== undefined) {
      details["arrivalAirport"] = arrivalAirport;
    }
    if (seat !== undefined) details["seat"] = seat;

    const confirmationCode = optionalTrim(form.confirmationCode);
    const notes = optionalTrim(form.notes);

    if (mode.kind === "create") {
      const body: Record<string, unknown> = {
        type: "flight",
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
        {mode.kind === "create" ? "Add flight" : "Edit flight"}
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
          placeholder="UA 100 SFO → JFK"
        />
      </label>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Flight number</span>
          <input
            className="field__input"
            type="text"
            name="flightNumber"
            required
            value={form.flightNumber}
            onChange={(e) => {
              setForm((f) => ({ ...f, flightNumber: e.target.value }));
            }}
            placeholder="100"
          />
        </label>
        <label className="field">
          <span className="field__label">Airline code</span>
          <input
            className="field__input"
            type="text"
            name="airlineCode"
            value={form.airlineCode}
            onChange={(e) => {
              setForm((f) => ({ ...f, airlineCode: e.target.value }));
            }}
            placeholder="UA"
          />
        </label>
      </div>

      <label className="field">
        <span className="field__label">Airline name</span>
        <input
          className="field__input"
          type="text"
          name="airlineName"
          value={form.airlineName}
          onChange={(e) => {
            setForm((f) => ({ ...f, airlineName: e.target.value }));
          }}
          placeholder="United Airlines"
        />
      </label>

      <div className="form__row">
        <label className="field">
          <span className="field__label">From (IATA)</span>
          <input
            className="field__input"
            type="text"
            name="departureAirport"
            value={form.departureAirport}
            onChange={(e) => {
              setForm((f) => ({ ...f, departureAirport: e.target.value }));
            }}
            placeholder="SFO"
          />
        </label>
        <label className="field">
          <span className="field__label">To (IATA)</span>
          <input
            className="field__input"
            type="text"
            name="arrivalAirport"
            value={form.arrivalAirport}
            onChange={(e) => {
              setForm((f) => ({ ...f, arrivalAirport: e.target.value }));
            }}
            placeholder="JFK"
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
        Times are in {tripTimezone} (airport-local entry not supported yet).
        Clear a field to remove that time.
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
          <span className="field__label">Seat</span>
          <input
            className="field__input"
            type="text"
            name="seat"
            value={form.seat}
            onChange={(e) => {
              setForm((f) => ({ ...f, seat: e.target.value }));
            }}
            placeholder="12A"
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
              ? "Add flight"
              : "Save flight"}
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
