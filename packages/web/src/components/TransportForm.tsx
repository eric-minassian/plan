import type {
  CreateItineraryItem,
  ItineraryItem,
  TransportDetails,
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

const TRANSPORT_MODES = [
  "car",
  "taxi",
  "rideshare",
  "bus",
  "ferry",
  "other",
] as const satisfies ReadonlyArray<TransportDetails["mode"]>;

export type TransportFormMode =
  | { readonly kind: "create" }
  | {
      readonly kind: "edit";
      readonly item: Extract<ItineraryItem, { readonly type: "transport" }>;
    };

export interface TransportFormProps {
  readonly mode: TransportFormMode;
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
  mode: TransportDetails["mode"];
  provider: string;
  pickupInstructions: string;
  confirmationCode: string;
  notes: string;
  startAtLocal: string;
  endAtLocal: string;
}

function emptyState(): FormState {
  return {
    title: "",
    mode: "taxi",
    provider: "",
    pickupInstructions: "",
    confirmationCode: "",
    notes: "",
    startAtLocal: "",
    endAtLocal: "",
  };
}

function stateFromItem(
  item: Extract<ItineraryItem, { readonly type: "transport" }>,
  tripTimezone: string,
): FormState {
  return {
    title: item.title,
    mode: item.details.mode,
    provider: item.details.provider ?? "",
    pickupInstructions: item.details.pickupInstructions ?? "",
    confirmationCode: item.confirmationCode ?? "",
    notes: item.notes ?? "",
    startAtLocal: instantToWallClockLocal(item.startAt, tripTimezone),
    endAtLocal: instantToWallClockLocal(item.endAt, tripTimezone),
  };
}

function isTransportMode(value: string): value is TransportDetails["mode"] {
  return (TRANSPORT_MODES as readonly string[]).includes(value);
}

/** Transport create / edit form. Parent remounts via `key` on new sessions. */
export function TransportForm(props: TransportFormProps) {
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
      "Pickup time",
      clearOnEmpty,
    );
    if (!startParsed.ok) {
      setLocalError(startParsed.error);
      return;
    }
    const endParsed = parseOptionalInstant(
      form.endAtLocal,
      tripTimezone,
      "Drop-off time",
      clearOnEmpty,
    );
    if (!endParsed.ok) {
      setLocalError(endParsed.error);
      return;
    }

    const details: Record<string, string> = { mode: form.mode };
    assignOptionalDetails(details, [
      ["provider", form.provider],
      ["pickupInstructions", form.pickupInstructions],
    ]);

    const confirmationCode = optionalTrim(form.confirmationCode);
    const notes = optionalTrim(form.notes);

    if (mode.kind === "create") {
      const body: Record<string, unknown> = {
        type: "transport",
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
        {mode.kind === "create" ? "Add transport" : "Edit transport"}
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
          placeholder="Airport transfer"
        />
      </label>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Mode</span>
          <select
            className="field__input"
            name="mode"
            value={form.mode}
            onChange={(e) => {
              const next = e.target.value;
              if (isTransportMode(next)) {
                setForm((f) => ({ ...f, mode: next }));
              }
            }}
          >
            {TRANSPORT_MODES.map((m) => (
              <option key={m} value={m}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Provider</span>
          <input
            className="field__input"
            type="text"
            name="provider"
            value={form.provider}
            onChange={(e) => {
              setForm((f) => ({ ...f, provider: e.target.value }));
            }}
            placeholder="Uber"
          />
        </label>
      </div>

      <label className="field">
        <span className="field__label">Pickup instructions</span>
        <textarea
          className="field__input field__textarea"
          name="pickupInstructions"
          rows={2}
          value={form.pickupInstructions}
          onChange={(e) => {
            setForm((f) => ({ ...f, pickupInstructions: e.target.value }));
          }}
          placeholder="Meet at Terminal 2 arrivals"
        />
      </label>

      <div className="form__row">
        <label className="field">
          <span className="field__label">Pickup ({tripTimezone})</span>
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
          <span className="field__label">Drop-off ({tripTimezone})</span>
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
              ? "Add transport"
              : "Save transport"}
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
