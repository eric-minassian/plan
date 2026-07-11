import { Button } from "@eric-minassian/design/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@eric-minassian/design/components/field";
import { Input } from "@eric-minassian/design/components/input";
import { BusyIcon } from "./BusyIcon.tsx";
import { Textarea } from "@eric-minassian/design/components/textarea";
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
import { ErrorAlert } from "./ErrorAlert.tsx";

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

    let startAt: string | null | undefined;
    if (form.startAtLocal.trim().length > 0) {
      const instant = wallClockInZoneToInstant(
        form.startAtLocal.trim(),
        tripTimezone,
      );
      if (instant === undefined) {
        setLocalError(
          "Start time is invalid for this trip timezone (check date/time)",
        );
        return;
      }
      startAt = instant;
    } else if (mode.kind === "edit") {
      // Empty control on edit ⇒ clear (move to Unscheduled).
      startAt = null;
    }

    const notes =
      form.notes.trim().length > 0 ? form.notes.trim() : undefined;

    if (mode.kind === "create") {
      const body: Record<string, unknown> = {
        type: "note",
        title,
        details: {},
      };
      if (typeof startAt === "string") {
        body["startAt"] = startAt;
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
      startAt,
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
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => void onSubmit(e)}
    >
      <h3 className="font-heading text-sm font-medium">
        {mode.kind === "create" ? "Add note" : "Edit note"}
      </h3>
      {displayError !== undefined ? (
        <ErrorAlert>{displayError}</ErrorAlert>
      ) : null}

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="note-title">Title</FieldLabel>
          <Input
            id="note-title"
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
        </Field>

        <Field>
          <FieldLabel htmlFor="note-body">Body</FieldLabel>
          <Textarea
            id="note-body"
            name="notes"
            maxLength={5000}
            rows={4}
            value={form.notes}
            onChange={(e) => {
              setForm((f) => ({ ...f, notes: e.target.value }));
            }}
            placeholder="Free-form note…"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="note-start">
            Start ({tripTimezone}) — optional
          </FieldLabel>
          <Input
            id="note-start"
            type="datetime-local"
            name="startAt"
            value={form.startAtLocal}
            onChange={(e) => {
              setForm((f) => ({ ...f, startAtLocal: e.target.value }));
            }}
          />
          <FieldDescription>
            Clear to keep unscheduled. Times are in {tripTimezone}.
          </FieldDescription>
        </Field>
      </FieldGroup>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <>
              <BusyIcon data-icon="inline-start" />
              Saving…
            </>
          ) : mode.kind === "create" ? (
            "Add note"
          ) : (
            "Save note"
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
