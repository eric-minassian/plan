import type {
  CreateItineraryItem,
  ItineraryItem,
  UpdateItineraryItem,
} from "@tripplan/domain";
import { Either } from "effect";
import { useState, type FormEvent } from "react";
import { decodeCreateItem, decodeUpdateItem } from "../api/decode.ts";
import { instantToWallClockLocal } from "../timeline/datetime.ts";
import { optionalTrim, parseOptionalInstant } from "./form-utils.ts";

export type NoteFormMode =
  | { readonly kind: "create" }
  | {
      readonly kind: "edit";
      readonly item: Extract<ItineraryItem, { readonly type: "note" }>;
    };

export interface NoteFormProps {
  readonly mode: NoteFormMode;
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
  notes: string;
  startAtLocal: string;
}

function emptyState(): FormState {
  return { title: "", notes: "", startAtLocal: "" };
}

function stateFromItem(
  item: Extract<ItineraryItem, { readonly type: "note" }>,
  tripTimezone: string,
): FormState {
  return {
    title: item.title,
    notes: item.notes ?? "",
    startAtLocal: instantToWallClockLocal(item.startAt, tripTimezone),
  };
}

/**
 * Manual note create / edit form (PR 8b).
 *
 * Parent must remount via a stable `key` when opening a new create session or
 * a different item — no reset `useEffect` on `mode` identity (that wiped edits
 * when parent re-rendered for submitting / formError).
 */
export function NoteForm(props: NoteFormProps) {
  const { mode, tripTimezone, submitting, error, onCancel, onCreate, onUpdate } =
    props;
  const [form, setForm] = useState<FormState>(() =>
    mode.kind === "edit" ? stateFromItem(mode.item, tripTimezone) : emptyState(),
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

    const notes = optionalTrim(form.notes);

    if (mode.kind === "create") {
      const body: Record<string, unknown> = {
        type: "note",
        title,
        details: {},
      };
      if (typeof startParsed.value === "string") {
        body["startAt"] = startParsed.value;
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
      startAt: startParsed.value,
      notes: notes ?? "",
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
        {mode.kind === "create" ? "Add note" : "Edit note"}
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
          placeholder="Packing list"
        />
      </label>

      <label className="field">
        <span className="field__label">Body</span>
        <textarea
          className="field__input field__textarea"
          name="notes"
          maxLength={5000}
          rows={4}
          value={form.notes}
          onChange={(e) => {
            setForm((f) => ({ ...f, notes: e.target.value }));
          }}
          placeholder="Free-form note…"
        />
      </label>

      <label className="field">
        <span className="field__label">
          Start ({tripTimezone}) — optional
        </span>
        <input
          className="field__input"
          type="datetime-local"
          name="startAt"
          value={form.startAtLocal}
          onChange={(e) => {
            setForm((f) => ({ ...f, startAtLocal: e.target.value }));
          }}
        />
        <span className="field__hint">
          Clear to keep unscheduled. Times are in {tripTimezone}.
        </span>
      </label>

      <div className="form__actions">
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode.kind === "create"
              ? "Add note"
              : "Save note"}
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
