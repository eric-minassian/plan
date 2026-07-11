import type {
  CreateItineraryItem,
  ItineraryItem,
  UpdateItineraryItem,
} from "@tripplan/domain";
import {
  MAX_CUSTOM_FIELD_KEY_LENGTH,
  MAX_CUSTOM_FIELD_VALUE_LENGTH,
  MAX_CUSTOM_FIELDS,
} from "@tripplan/domain";
import { Either } from "effect";
import { useState, type FormEvent } from "react";
import { decodeCreateItem, decodeUpdateItem } from "../api/decode.ts";
import { instantToWallClockLocal } from "../timeline/datetime.ts";
import { optionalTrim, parseOptionalInstant } from "./form-utils.ts";

export type CustomFormMode =
  | { readonly kind: "create" }
  | {
      readonly kind: "edit";
      readonly item: Extract<ItineraryItem, { readonly type: "custom" }>;
    };

export interface CustomFormProps {
  readonly mode: CustomFormMode;
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

interface FieldRow {
  readonly id: string;
  key: string;
  value: string;
}

interface FormState {
  title: string;
  confirmationCode: string;
  notes: string;
  startAtLocal: string;
  endAtLocal: string;
  fields: FieldRow[];
}

function newFieldId(): string {
  return crypto.randomUUID();
}

function emptyState(): FormState {
  return {
    title: "",
    confirmationCode: "",
    notes: "",
    startAtLocal: "",
    endAtLocal: "",
    fields: [],
  };
}

function stateFromItem(
  item: Extract<ItineraryItem, { readonly type: "custom" }>,
  tripTimezone: string,
): FormState {
  const fieldsRecord = item.details.fields ?? {};
  const fields: FieldRow[] = Object.entries(fieldsRecord).map(
    ([key, value]) => ({
      id: newFieldId(),
      key,
      value,
    }),
  );
  return {
    title: item.title,
    confirmationCode: item.confirmationCode ?? "",
    notes: item.notes ?? "",
    startAtLocal: instantToWallClockLocal(item.startAt, tripTimezone),
    endAtLocal: instantToWallClockLocal(item.endAt, tripTimezone),
    fields,
  };
}

function buildFieldsMap(
  rows: readonly FieldRow[],
):
  | { readonly ok: true; readonly fields: Record<string, string> | undefined }
  | { readonly ok: false; readonly error: string } {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0 && row.value.trim().length === 0) {
      continue;
    }
    if (key.length === 0) {
      return { ok: false, error: "Custom field key is required when value is set" };
    }
    if (key.length > MAX_CUSTOM_FIELD_KEY_LENGTH) {
      return {
        ok: false,
        error: `Custom field key must be ≤${String(MAX_CUSTOM_FIELD_KEY_LENGTH)} characters`,
      };
    }
    const value = row.value.trim();
    if (value.length > MAX_CUSTOM_FIELD_VALUE_LENGTH) {
      return {
        ok: false,
        error: `Custom field value must be ≤${String(MAX_CUSTOM_FIELD_VALUE_LENGTH)} characters`,
      };
    }
    if (Object.hasOwn(map, key)) {
      return { ok: false, error: `Duplicate custom field key: ${key}` };
    }
    map[key] = value;
  }
  const keys = Object.keys(map);
  if (keys.length > MAX_CUSTOM_FIELDS) {
    return {
      ok: false,
      error: `At most ${String(MAX_CUSTOM_FIELDS)} custom fields allowed`,
    };
  }
  if (keys.length === 0) {
    return { ok: true, fields: undefined };
  }
  return { ok: true, fields: map };
}

/** Custom item create / edit form. Parent remounts via `key` on new sessions. */
export function CustomForm(props: CustomFormProps) {
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

    const fieldsBuilt = buildFieldsMap(form.fields);
    if (!fieldsBuilt.ok) {
      setLocalError(fieldsBuilt.error);
      return;
    }

    const details: Record<string, unknown> = {};
    if (fieldsBuilt.fields !== undefined) {
      details["fields"] = fieldsBuilt.fields;
    }

    const confirmationCode = optionalTrim(form.confirmationCode);
    const notes = optionalTrim(form.notes);

    if (mode.kind === "create") {
      const body: Record<string, unknown> = {
        type: "custom",
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
  const filledFieldCount = form.fields.filter(
    (row) => row.key.trim().length > 0 || row.value.trim().length > 0,
  ).length;
  const canAddField = filledFieldCount < MAX_CUSTOM_FIELDS;

  return (
    <form className="form item-form" onSubmit={(e) => void onSubmit(e)}>
      <h3 className="item-form__title">
        {mode.kind === "create" ? "Add custom item" : "Edit custom item"}
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
          placeholder="Something else"
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

      <fieldset className="custom-fields">
        <legend className="field__label">Custom fields</legend>
        {form.fields.length === 0 ? (
          <p className="field__hint">No custom fields yet.</p>
        ) : null}
        {form.fields.map((row, index) => (
          <div key={row.id} className="form__row custom-fields__row">
            <label className="field">
              <span className="field__label">Key</span>
              <input
                className="field__input"
                type="text"
                maxLength={MAX_CUSTOM_FIELD_KEY_LENGTH}
                value={row.key}
                onChange={(e) => {
                  const value = e.target.value;
                  setForm((f) => ({
                    ...f,
                    fields: f.fields.map((r, i) =>
                      i === index ? { ...r, key: value } : r,
                    ),
                  }));
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">Value</span>
              <input
                className="field__input"
                type="text"
                maxLength={MAX_CUSTOM_FIELD_VALUE_LENGTH}
                value={row.value}
                onChange={(e) => {
                  const value = e.target.value;
                  setForm((f) => ({
                    ...f,
                    fields: f.fields.map((r, i) =>
                      i === index ? { ...r, value } : r,
                    ),
                  }));
                }}
              />
            </label>
            <button
              type="button"
              className="btn btn--ghost btn--sm custom-fields__remove"
              disabled={submitting}
              onClick={() => {
                setForm((f) => ({
                  ...f,
                  fields: f.fields.filter((_, i) => i !== index),
                }));
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={submitting || !canAddField}
          onClick={() => {
            setForm((f) => ({
              ...f,
              fields: [...f.fields, { id: newFieldId(), key: "", value: "" }],
            }));
          }}
        >
          + Field
        </button>
        <p className="field__hint">
          Up to {MAX_CUSTOM_FIELDS} fields; keys ≤{MAX_CUSTOM_FIELD_KEY_LENGTH},
          values ≤{MAX_CUSTOM_FIELD_VALUE_LENGTH}.
        </p>
      </fieldset>

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
              ? "Add custom item"
              : "Save custom item"}
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
