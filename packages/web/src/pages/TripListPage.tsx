import { Button } from "@eric-minassian/design/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@eric-minassian/design/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@eric-minassian/design/components/empty";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@eric-minassian/design/components/field";
import { Input } from "@eric-minassian/design/components/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@eric-minassian/design/components/item";
import { Spinner } from "@eric-minassian/design/components/spinner";
import { useAuth } from "@ericminassian/auth/react";
import type { Trip } from "@tripplan/domain";
import { Either } from "effect";
import { RefreshCwIcon } from "lucide-react";
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
import { ErrorAlert } from "../components/ErrorAlert.tsx";

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
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Your trips</CardTitle>
          <CardDescription>
            Open a trip to manage the day-by-day timeline.
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void loadTrips();
              }}
              disabled={loading}
            >
              <RefreshCwIcon
                data-icon="inline-start"
                className={loading ? "animate-spin" : undefined}
              />
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {listError !== undefined ? <ErrorAlert>{listError}</ErrorAlert> : null}

          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Spinner />
              Loading trips…
            </div>
          ) : trips.length === 0 ? (
            <Empty className="border border-dashed py-8">
              <EmptyHeader>
                <EmptyTitle>No trips yet</EmptyTitle>
                <EmptyDescription>
                  Create one below to start planning.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="gap-2">
              {trips.map((trip) => (
                <Item key={trip.tripId} variant="outline" asChild>
                  <Link
                    to={`/trips/${encodeURIComponent(trip.tripId)}`}
                    className="no-underline"
                  >
                    <ItemContent>
                      <ItemTitle className="text-sm">{trip.title}</ItemTitle>
                      <ItemDescription className="line-clamp-none flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>
                          {trip.startDate} → {trip.endDate}
                        </span>
                        <span className="font-mono text-[0.7rem]">
                          {trip.timezone}
                        </span>
                      </ItemDescription>
                    </ItemContent>
                  </Link>
                </Item>
              ))}
            </ItemGroup>
          )}

          {nextCursor !== undefined ? (
            <Button
              type="button"
              variant="outline"
              disabled={loadingMore || loading}
              onClick={() => {
                void loadMore();
              }}
            >
              {loadingMore ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create trip</CardTitle>
          <CardDescription>
            Dates and timezone drive day buckets on the timeline.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {formError !== undefined ? (
            <div className="mb-3">
              <ErrorAlert>{formError}</ErrorAlert>
            </div>
          ) : null}
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => void onSubmit(e)}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="trip-title">Title</FieldLabel>
                <Input
                  id="trip-title"
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
              </Field>

              <Field>
                <FieldLabel htmlFor="trip-timezone">Timezone</FieldLabel>
                <Input
                  id="trip-timezone"
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
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="trip-start">Start date</FieldLabel>
                  <Input
                    id="trip-start"
                    type="date"
                    name="startDate"
                    required
                    value={form.startDate}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, startDate: e.target.value }));
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="trip-end">End date</FieldLabel>
                  <Input
                    id="trip-end"
                    type="date"
                    name="endDate"
                    required
                    value={form.endDate}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, endDate: e.target.value }));
                    }}
                  />
                </Field>
              </div>
            </FieldGroup>

            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Creating…
                </>
              ) : (
                "Create trip"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
