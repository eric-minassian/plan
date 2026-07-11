import { useAuth } from "@ericminassian/auth/react";
import type { Trip } from "@tripplan/domain";
import { Either } from "effect";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import { createTripPlanApi } from "../api/client.ts";
import { decodeCreateTrip } from "../api/decode.ts";
import { formatApiError } from "../api/errors.ts";
import { useAuthClient } from "../auth/AuthClientContext.tsx";

interface CreateTripFormState {
  title: string;
  timezone: string;
  startDate: string;
  endDate: string;
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function emptyForm(): CreateTripFormState {
  return {
    title: "",
    timezone: defaultTimezone(),
    startDate: "",
    endDate: "",
  };
}

/** Owner trip list + create form; links into trip timeline (PR 8b). */
export function TripListPage() {
  const authClient = useAuthClient();
  const { signOut } = useAuth();

  const onUnauthorized = useCallback(async () => {
    // Session dead: clear local auth and return to origin (login CTA).
    await signOut({ postLogoutRedirectUri: window.location.origin });
  }, [signOut]);

  const api = useMemo(
    () => createTripPlanApi(authClient, { onUnauthorized }),
    [authClient, onUnauthorized],
  );

  const [trips, setTrips] = useState<readonly Trip[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [form, setForm] = useState<CreateTripFormState>(emptyForm);

  /** Bumped on full reload so in-flight loadMore/loadTrips ignore stale responses. */
  const listGeneration = useRef(0);

  const loadTrips = useCallback(async () => {
    const generation = ++listGeneration.current;
    setLoading(true);
    setLoadingMore(false);
    setListError(undefined);
    try {
      const page = await api.listTrips();
      if (generation !== listGeneration.current) {
        return;
      }
      setTrips(page.trips);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (generation !== listGeneration.current) {
        return;
      }
      setListError(formatApiError(cause));
      setTrips([]);
      setNextCursor(undefined);
    } finally {
      if (generation === listGeneration.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void loadTrips();
  }, [loadTrips]);

  async function loadMore(): Promise<void> {
    if (nextCursor === undefined || loadingMore || loading) {
      return;
    }
    const generation = listGeneration.current;
    setLoadingMore(true);
    setListError(undefined);
    try {
      const page = await api.listTrips({ cursor: nextCursor });
      if (generation !== listGeneration.current) {
        return;
      }
      setTrips((prev) => [...prev, ...page.trips]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (generation !== listGeneration.current) {
        return;
      }
      setListError(formatApiError(cause));
    } finally {
      if (generation === listGeneration.current) {
        setLoadingMore(false);
      }
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(undefined);

    if (form.endDate.length > 0 && form.startDate.length > 0) {
      if (form.endDate < form.startDate) {
        setFormError("End date must be on or after start date");
        return;
      }
    }

    const decoded = decodeCreateTrip({
      title: form.title.trim(),
      timezone: form.timezone.trim(),
      startDate: form.startDate,
      endDate: form.endDate,
    });
    if (Either.isLeft(decoded)) {
      setFormError(decoded.left);
      return;
    }

    setSubmitting(true);
    try {
      const created = await api.createTrip(decoded.right);
      setTrips((prev) => [created, ...prev]);
      setForm(emptyForm());
    } catch (cause) {
      setFormError(formatApiError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="trip-list">
      <section className="panel">
        <div className="panel__header">
          <h2>Your trips</h2>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              void loadTrips();
            }}
            disabled={loading}
          >
            Refresh
          </button>
        </div>

        {listError !== undefined ? (
          <p className="banner banner--error" role="alert">
            {listError}
          </p>
        ) : null}

        {loading ? (
          <p className="muted">Loading trips…</p>
        ) : trips.length === 0 ? (
          <p className="muted">No trips yet. Create one below.</p>
        ) : (
          <ul className="trip-cards">
            {trips.map((trip) => (
              <li key={trip.tripId} className="trip-card">
                <Link
                  to={`/trips/${encodeURIComponent(trip.tripId)}`}
                  className="trip-card__link"
                >
                  <div className="trip-card__title">{trip.title}</div>
                  <div className="trip-card__meta">
                    <span>
                      {trip.startDate} → {trip.endDate}
                    </span>
                    <span className="trip-card__tz">{trip.timezone}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {nextCursor !== undefined ? (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={loadingMore || loading}
            onClick={() => {
              void loadMore();
            }}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </section>

      <section className="panel">
        <h2>Create trip</h2>
        {formError !== undefined ? (
          <p className="banner banner--error" role="alert">
            {formError}
          </p>
        ) : null}
        <form className="form" onSubmit={(e) => void onSubmit(e)}>
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
              placeholder="Summer in Lisbon"
            />
          </label>

          <label className="field">
            <span className="field__label">Timezone</span>
            <input
              className="field__input"
              type="text"
              name="timezone"
              required
              value={form.timezone}
              onChange={(e) => {
                setForm((f) => ({ ...f, timezone: e.target.value }));
              }}
              placeholder="Europe/Lisbon"
              list="iana-common"
            />
            <datalist id="iana-common">
              <option value="UTC" />
              <option value="America/New_York" />
              <option value="America/Los_Angeles" />
              <option value="Europe/London" />
              <option value="Europe/Paris" />
              <option value="Asia/Tokyo" />
            </datalist>
          </label>

          <div className="form__row">
            <label className="field">
              <span className="field__label">Start date</span>
              <input
                className="field__input"
                type="date"
                name="startDate"
                required
                value={form.startDate}
                onChange={(e) => {
                  setForm((f) => ({ ...f, startDate: e.target.value }));
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">End date</span>
              <input
                className="field__input"
                type="date"
                name="endDate"
                required
                value={form.endDate}
                onChange={(e) => {
                  setForm((f) => ({ ...f, endDate: e.target.value }));
                }}
              />
            </label>
          </div>

          <button
            type="submit"
            className="btn btn--primary"
            disabled={submitting}
          >
            {submitting ? "Creating…" : "Create trip"}
          </button>
        </form>
      </section>
    </div>
  );
}
