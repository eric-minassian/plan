import type {
  CreateItineraryItem,
  EnrichFlightRequest,
  EnrichmentMeta,
  FlightEnrichmentFound,
  FlightEnrichmentResponse,
  GeoPoint,
  ItineraryItem,
  UpdateItineraryItem,
} from "@tripplan/domain";
import { parseFlightDesignator } from "@tripplan/domain";
import { Either } from "effect";
import { useState, type FormEvent } from "react";
import { decodeCreateItem, decodeUpdateItem } from "../api/decode.ts";
import { formatApiError } from "../api/errors.ts";
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
  /**
   * Optional enrichment lookup (suggest-then-confirm). When omitted, lookup UI
   * is hidden (tests / offline).
   */
  readonly onEnrichFlight?: (
    query: EnrichFlightRequest,
  ) => Promise<FlightEnrichmentResponse>;
}

interface FormState {
  title: string;
  flightNumber: string;
  airlineCode: string;
  airlineName: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTerminal: string;
  arrivalTerminal: string;
  confirmationCode: string;
  seat: string;
  notes: string;
  startAtLocal: string;
  endAtLocal: string;
  startTimeZone: string;
  endTimeZone: string;
  startLocation: GeoPoint | undefined;
  endLocation: GeoPoint | undefined;
}

/** Enrichment intent for save: leave as-is, set meta, or clear stored meta. */
type EnrichmentIntent =
  | { readonly kind: "unchanged" }
  | { readonly kind: "set"; readonly meta: EnrichmentMeta }
  | { readonly kind: "clear" };

function emptyState(): FormState {
  return {
    title: "",
    flightNumber: "",
    airlineCode: "",
    airlineName: "",
    departureAirport: "",
    arrivalAirport: "",
    departureTerminal: "",
    arrivalTerminal: "",
    confirmationCode: "",
    seat: "",
    notes: "",
    startAtLocal: "",
    endAtLocal: "",
    startTimeZone: "",
    endTimeZone: "",
    startLocation: undefined,
    endLocation: undefined,
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
    departureTerminal: item.details.departureTerminal ?? "",
    arrivalTerminal: item.details.arrivalTerminal ?? "",
    confirmationCode: item.confirmationCode ?? "",
    seat: item.details.seat ?? "",
    notes: item.notes ?? "",
    startAtLocal: instantToWallClockLocal(item.startAt, tripTimezone),
    endAtLocal: instantToWallClockLocal(item.endAt, tripTimezone),
    startTimeZone: item.startTimeZone ?? "",
    endTimeZone: item.endTimeZone ?? "",
    startLocation: item.startLocation,
    endLocation: item.endLocation,
  };
}

function optionalTrim(value: string): string | undefined {
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Compose airline code + number for enrich request so re-lookup works after
 * apply sets flightNumber to the numeric portion only.
 */
export function designatorForLookup(form: {
  readonly flightNumber: string;
  readonly airlineCode: string;
}): string {
  const fn = form.flightNumber.trim();
  const code = form.airlineCode.trim().toUpperCase();
  if (fn.length === 0) {
    return "";
  }
  const parsed = parseFlightDesignator(fn);
  if (parsed.airlineCode !== undefined) {
    return parsed.normalized;
  }
  if (code.length > 0) {
    return `${code}${fn.replace(/\s+/g, "")}`.toUpperCase();
  }
  return fn;
}

function geoFromEndpoint(endpoint: {
  readonly airportIata: string;
  readonly airportName?: string;
  readonly lat?: number;
  readonly lng?: number;
  readonly timezone?: string;
}): GeoPoint | undefined {
  if (endpoint.lat === undefined || endpoint.lng === undefined) {
    return undefined;
  }
  return {
    lat: endpoint.lat,
    lng: endpoint.lng,
    label: endpoint.airportName ?? endpoint.airportIata,
    ...(endpoint.timezone !== undefined
      ? { timezone: endpoint.timezone }
      : {}),
  };
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

function applySuggestion(
  form: FormState,
  suggestion: FlightEnrichmentFound,
  tripTimezone: string,
): FormState {
  const airlineCode = suggestion.airlineCode ?? form.airlineCode;
  const flightNumber = suggestion.flightNumber || form.flightNumber;
  const dep = suggestion.departure.airportIata;
  const arr = suggestion.arrival.airportIata;
  const titleBits = [
    airlineCode.length > 0 ? `${airlineCode}${flightNumber}` : flightNumber,
    dep.length > 0 && arr.length > 0 ? `${dep} → ${arr}` : undefined,
  ].filter((x): x is string => x !== undefined && x.length > 0);

  return {
    ...form,
    title: form.title.trim().length > 0 ? form.title : titleBits.join(" "),
    flightNumber,
    airlineCode,
    airlineName: suggestion.airlineName ?? form.airlineName,
    departureAirport: dep,
    arrivalAirport: arr,
    departureTerminal: suggestion.departure.terminal ?? form.departureTerminal,
    arrivalTerminal: suggestion.arrival.terminal ?? form.arrivalTerminal,
    startAtLocal: instantToWallClockLocal(
      suggestion.departure.scheduledAt,
      tripTimezone,
    ),
    endAtLocal: instantToWallClockLocal(
      suggestion.arrival.scheduledAt,
      tripTimezone,
    ),
    startTimeZone:
      suggestion.departure.timezone ?? form.startTimeZone,
    endTimeZone: suggestion.arrival.timezone ?? form.endTimeZone,
    startLocation:
      geoFromEndpoint(suggestion.departure) ?? form.startLocation,
    endLocation: geoFromEndpoint(suggestion.arrival) ?? form.endLocation,
  };
}

/**
 * Manual flight create / edit form with optional enrichment lookup (PR 11).
 *
 * Parent remounts via `key` when opening a new session — no `useEffect`
 * reset on `mode` object identity.
 * Enrichment never auto-saves; user reviews prefilled fields and clicks Save.
 */
export function FlightForm(props: FlightFormProps) {
  const {
    mode,
    tripTimezone,
    submitting,
    error,
    onCancel,
    onCreate,
    onUpdate,
    onEnrichFlight,
  } = props;
  const [form, setForm] = useState<FormState>(() =>
    mode.kind === "edit"
      ? stateFromItem(mode.item, tripTimezone)
      : emptyState(),
  );
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [lookupDate, setLookupDate] = useState("");
  const [lookupHint, setLookupHint] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupMessage, setLookupMessage] = useState<string | undefined>(
    undefined,
  );
  const [enrichmentIntent, setEnrichmentIntent] = useState<EnrichmentIntent>(
    () =>
      mode.kind === "edit" && mode.item.enrichment !== undefined
        ? { kind: "set", meta: mode.item.enrichment }
        : { kind: "unchanged" },
  );

  async function onLookup(): Promise<void> {
    if (onEnrichFlight === undefined) {
      return;
    }
    setLocalError(undefined);
    setLookupMessage(undefined);

    const designator = designatorForLookup(form);
    if (designator.length === 0) {
      setLocalError("Enter a flight number before lookup");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lookupDate.trim())) {
      setLocalError("Lookup date is required (YYYY-MM-DD)");
      return;
    }

    const query: EnrichFlightRequest = {
      flightNumber: designator,
      date: lookupDate.trim(),
      ...(optionalTrim(lookupHint) !== undefined
        ? { departureAirportHint: optionalTrim(lookupHint) }
        : {}),
    };

    setLookupBusy(true);
    try {
      const result = await onEnrichFlight(query);
      if (result.status === "not_found") {
        // Clear stale enrichment on save (edit) so provenance is not a lie.
        setEnrichmentIntent(
          mode.kind === "edit" ? { kind: "clear" } : { kind: "unchanged" },
        );
        setLookupMessage(
          "No schedule found for that flight and date. Enter details manually.",
        );
        return;
      }

      setForm((prev) => applySuggestion(prev, result, tripTimezone));
      setEnrichmentIntent({
        kind: "set",
        meta: {
          provider: result.provider,
          fetchedAt: result.fetchedAt,
          ...(result.confidence !== undefined
            ? { confidence: result.confidence }
            : {}),
        },
      });
      const cancelled =
        result.status === "cancelled"
          ? " Flight is marked cancelled — review before saving."
          : "";
      setLookupMessage(
        `Suggestion applied from ${result.provider}. Review fields and save when ready.${cancelled}`,
      );
    } catch (cause) {
      setLocalError(formatApiError(cause));
    } finally {
      setLookupBusy(false);
    }
  }

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
    const departureTerminal = optionalTrim(form.departureTerminal);
    const arrivalTerminal = optionalTrim(form.arrivalTerminal);
    const seat = optionalTrim(form.seat);
    if (airlineCode !== undefined) details["airlineCode"] = airlineCode;
    if (airlineName !== undefined) details["airlineName"] = airlineName;
    if (departureAirport !== undefined) {
      details["departureAirport"] = departureAirport;
    }
    if (arrivalAirport !== undefined) {
      details["arrivalAirport"] = arrivalAirport;
    }
    if (departureTerminal !== undefined) {
      details["departureTerminal"] = departureTerminal;
    }
    if (arrivalTerminal !== undefined) {
      details["arrivalTerminal"] = arrivalTerminal;
    }
    if (seat !== undefined) details["seat"] = seat;

    const confirmationCode = optionalTrim(form.confirmationCode);
    const notes = optionalTrim(form.notes);
    const startTimeZone = optionalTrim(form.startTimeZone);
    const endTimeZone = optionalTrim(form.endTimeZone);

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
      if (startTimeZone !== undefined) {
        body["startTimeZone"] = startTimeZone;
      }
      if (endTimeZone !== undefined) {
        body["endTimeZone"] = endTimeZone;
      }
      if (form.startLocation !== undefined) {
        body["startLocation"] = form.startLocation;
      }
      if (form.endLocation !== undefined) {
        body["endLocation"] = form.endLocation;
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
    if (startTimeZone !== undefined) {
      patch["startTimeZone"] = startTimeZone;
    }
    if (endTimeZone !== undefined) {
      patch["endTimeZone"] = endTimeZone;
    }
    if (form.startLocation !== undefined) {
      patch["startLocation"] = form.startLocation;
    }
    if (form.endLocation !== undefined) {
      patch["endLocation"] = form.endLocation;
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
  const busy = submitting || lookupBusy;
  const lookupDesignatorPreview = designatorForLookup(form);

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
      {lookupMessage !== undefined ? (
        <p className="banner banner--info" role="status">
          {lookupMessage}
        </p>
      ) : null}

      {onEnrichFlight !== undefined ? (
        <fieldset className="item-form__lookup" disabled={busy}>
          <legend className="item-form__lookup-legend">
            Lookup schedule (optional)
          </legend>
          <p className="field__hint">
            Suggests times and airports from the flight number and date. You
            always review and save — nothing is written automatically.
            {lookupDesignatorPreview.length > 0
              ? ` Lookup uses “${lookupDesignatorPreview}”.`
              : ""}
          </p>
          <div className="form__row">
            <label className="field">
              <span className="field__label">Flight number</span>
              <input
                className="field__input"
                type="text"
                name="lookupFlightNumber"
                value={form.flightNumber}
                onChange={(e) => {
                  setForm((f) => ({ ...f, flightNumber: e.target.value }));
                }}
                placeholder="UA100"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span className="field__label">Date</span>
              <input
                className="field__input"
                type="date"
                name="lookupDate"
                value={lookupDate}
                onChange={(e) => {
                  setLookupDate(e.target.value);
                }}
                required={false}
              />
            </label>
          </div>
          <div className="form__row">
            <label className="field">
              <span className="field__label">From hint (IATA)</span>
              <input
                className="field__input"
                type="text"
                name="lookupHint"
                maxLength={3}
                value={lookupHint}
                onChange={(e) => {
                  setLookupHint(e.target.value);
                }}
                placeholder="SFO"
              />
            </label>
            <div className="field field--actions">
              <span className="field__label">&nbsp;</span>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => {
                  void onLookup();
                }}
              >
                {lookupBusy ? "Looking up…" : "Lookup"}
              </button>
            </div>
          </div>
        </fieldset>
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
          <span className="field__label">Dep terminal</span>
          <input
            className="field__input"
            type="text"
            name="departureTerminal"
            value={form.departureTerminal}
            onChange={(e) => {
              setForm((f) => ({ ...f, departureTerminal: e.target.value }));
            }}
            placeholder="3"
          />
        </label>
        <label className="field">
          <span className="field__label">Arr terminal</span>
          <input
            className="field__input"
            type="text"
            name="arrivalTerminal"
            value={form.arrivalTerminal}
            onChange={(e) => {
              setForm((f) => ({ ...f, arrivalTerminal: e.target.value }));
            }}
            placeholder="7"
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
        Times are entered in {tripTimezone}
        {form.startTimeZone.length > 0 || form.endTimeZone.length > 0
          ? ` (airport zones: ${form.startTimeZone || "—"} → ${form.endTimeZone || "—"})`
          : ""}
        . Clear a field to remove that time.
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
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {submitting
            ? "Saving…"
            : mode.kind === "create"
              ? "Add flight"
              : "Save flight"}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
