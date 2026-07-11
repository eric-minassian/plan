import type { ItineraryItem } from "@tripplan/domain";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useAppConfig } from "../config/ConfigContext.tsx";
import type { AirportsLoadState } from "./airports.ts";
import { colorForUnscheduled } from "./day-colors.ts";
import {
  buildTripMapModel,
  filterMapModel,
  mapFitBoundsKey,
  UNSCHEDULED_DAY_KEY,
  type MapDayFilter,
} from "./geo-features.ts";
import { hasMapTilerKey } from "./style-url.ts";

const MapCanvas = lazy(async () => {
  const mod = await import("./MapCanvas.tsx");
  return { default: mod.default };
});

export type TripMapPanelProps = {
  readonly items: readonly ItineraryItem[];
  readonly tripTimezone: string;
  readonly tripStartDate: string;
  readonly selectedItemId: string | undefined;
  readonly onSelectItem: (itemId: string | undefined) => void;
  /** Shared airports load state from parent (avoids double hook). */
  readonly airports: AirportsLoadState;
  readonly onRetryAirports?: () => void;
  /** When true, hide edit-oriented copy (future share viewer). */
  readonly readOnly?: boolean;
};

/**
 * Trip map panel: day filter chips, empty geo state, MapLibre canvas (lazy).
 */
export function TripMapPanel(props: TripMapPanelProps) {
  const config = useAppConfig();
  const { airports } = props;
  const [selectedDays, setSelectedDays] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [tileError, setTileError] = useState<string | undefined>(undefined);

  const model = useMemo(
    () =>
      buildTripMapModel({
        items: props.items,
        tripTimezone: props.tripTimezone,
        tripStartDate: props.tripStartDate,
        airports: airports.index,
      }),
    [props.items, props.tripTimezone, props.tripStartDate, airports.index],
  );

  const fitBoundsKey = useMemo(
    () => mapFitBoundsKey(model.pins),
    [model.pins],
  );

  // Drop day filters that no longer exist after item edits.
  useEffect(() => {
    const valid = new Set(model.days.map((d) => d.dayKey));
    if (model.unscheduledPinCount > 0) {
      valid.add(UNSCHEDULED_DAY_KEY);
    }
    setSelectedDays((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const next = new Set<string>();
      for (const key of prev) {
        if (valid.has(key)) {
          next.add(key);
        }
      }
      if (setsEqual(next, prev)) {
        return prev;
      }
      return next;
    });
  }, [model.days, model.unscheduledPinCount]);

  // When timeline selects an item filtered out by day chips, reveal its day.
  useEffect(() => {
    const itemId = props.selectedItemId;
    if (itemId === undefined) {
      return;
    }
    const pin = model.pins.find((p) => p.itemId === itemId);
    if (pin === undefined) {
      return;
    }
    setSelectedDays((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const key = pin.dayKey ?? UNSCHEDULED_DAY_KEY;
      if (prev.has(key)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [props.selectedItemId, model.pins]);

  // Reset tile error when key changes.
  useEffect(() => {
    setTileError(undefined);
  }, [config.mapTilerApiKey]);

  const filtered = useMemo(
    () => filterMapModel(model, selectedDays.size > 0 ? selectedDays : null),
    [model, selectedDays],
  );

  const keyOk = hasMapTilerKey(config.mapTilerApiKey);
  const showMap = keyOk && tileError === undefined;

  function toggleDay(dayKey: string): void {
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayKey)) {
        next.delete(dayKey);
      } else {
        next.add(dayKey);
      }
      return next;
    });
  }

  function clearDays(): void {
    setSelectedDays(new Set());
  }

  const airportsLoading = airports.status === "loading";
  const airportsError = airports.status === "error";

  return (
    <section className="panel trip-map-panel" aria-label="Trip map">
      <div className="panel__header">
        <h2>Map</h2>
        {model.hasGeo ? (
          <span className="muted trip-map-panel__count">
            {filtered.pins.length} location
            {filtered.pins.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {model.days.length > 0 || model.unscheduledPinCount > 0 ? (
        <DayFilterChips
          days={model.days}
          unscheduledPinCount={model.unscheduledPinCount}
          selected={selectedDays}
          onToggle={toggleDay}
          onClear={clearDays}
        />
      ) : null}

      {airportsLoading && !model.hasGeo ? (
        <div className="map-empty" role="status">
          <p className="muted map-empty__body">Loading locations…</p>
        </div>
      ) : !model.hasGeo ? (
        <MapEmptyState
          readOnly={props.readOnly === true}
          airportsError={airportsError}
          onRetryAirports={props.onRetryAirports}
        />
      ) : !showMap ? (
        <div className="map-empty" role="status">
          <p className="map-empty__title">Map tiles unavailable</p>
          <p className="muted map-empty__body">
            {tileError !== undefined
              ? "The map style failed to load. Check the MapTiler key or network."
              : "Set "}
            {tileError === undefined ? (
              <>
                <code>mapTilerApiKey</code> in runtime{" "}
                <code>config.json</code> to load the map.
              </>
            ) : null}
          </p>
          {tileError !== undefined ? (
            <p className="muted map-empty__hint">{tileError}</p>
          ) : null}
          <PinList
            pins={filtered.pins}
            selectedItemId={props.selectedItemId}
            onSelectItem={props.onSelectItem}
          />
        </div>
      ) : (
        <div className="map-frame">
          <Suspense
            fallback={
              <div className="map-fallback muted" role="status">
                Loading map…
              </div>
            }
          >
            <MapCanvas
              mapTilerApiKey={config.mapTilerApiKey}
              pins={filtered.pins}
              arcs={filtered.arcs}
              fitBoundsKey={fitBoundsKey}
              selectedItemId={props.selectedItemId}
              onSelectItem={props.onSelectItem}
              onMapError={(message) => {
                setTileError(message);
              }}
            />
          </Suspense>
        </div>
      )}
    </section>
  );
}

function MapEmptyState(props: {
  readonly readOnly: boolean;
  readonly airportsError: boolean;
  readonly onRetryAirports?: () => void;
}): ReactNode {
  return (
    <div className="map-empty" role="status">
      <p className="map-empty__title">No locations yet</p>
      <p className="muted map-empty__body">
        Locations will appear when items have places or airports.
      </p>
      {props.airportsError ? (
        <p className="muted map-empty__hint">
          Airport lookup failed — flights with only IATA codes cannot be
          pinned yet.
          {props.onRetryAirports !== undefined ? (
            <>
              {" "}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={props.onRetryAirports}
              >
                Retry
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {props.readOnly ? null : (
        <p className="muted map-empty__hint">
          Add airport codes on flights, or place coordinates on items, to pin
          them here.
        </p>
      )}
    </div>
  );
}

function DayFilterChips(props: {
  readonly days: readonly MapDayFilter[];
  readonly unscheduledPinCount: number;
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (dayKey: string) => void;
  readonly onClear: () => void;
}) {
  const allActive = props.selected.size === 0;
  return (
    <div className="day-chips" role="group" aria-label="Filter map by day">
      <button
        type="button"
        className={`day-chip${allActive ? " day-chip--active" : ""}`}
        aria-pressed={allActive}
        onClick={props.onClear}
      >
        All days
      </button>
      {props.days.map((day) => {
        const active = props.selected.has(day.dayKey);
        return (
          <button
            key={day.dayKey}
            type="button"
            className={`day-chip${active ? " day-chip--active" : ""}`}
            aria-pressed={active}
            style={
              {
                "--day-chip-color": day.color,
              } as CSSProperties
            }
            onClick={() => {
              props.onToggle(day.dayKey);
            }}
          >
            {day.label}
            <span className="day-chip__count">{day.pinCount}</span>
          </button>
        );
      })}
      {props.unscheduledPinCount > 0 ? (
        <button
          type="button"
          className={`day-chip${
            props.selected.has(UNSCHEDULED_DAY_KEY) ? " day-chip--active" : ""
          }`}
          aria-pressed={props.selected.has(UNSCHEDULED_DAY_KEY)}
          style={
            {
              "--day-chip-color": colorForUnscheduled(),
            } as CSSProperties
          }
          onClick={() => {
            props.onToggle(UNSCHEDULED_DAY_KEY);
          }}
        >
          Unscheduled
          <span className="day-chip__count">{props.unscheduledPinCount}</span>
        </button>
      ) : null}
    </div>
  );
}

function PinList(props: {
  readonly pins: ReturnType<typeof filterMapModel>["pins"];
  readonly selectedItemId: string | undefined;
  readonly onSelectItem: (itemId: string | undefined) => void;
}) {
  if (props.pins.length === 0) {
    return null;
  }
  return (
    <ul className="map-pin-list">
      {props.pins.map((pin) => (
        <li key={pin.id}>
          <button
            type="button"
            className={`map-pin-list__btn${
              props.selectedItemId === pin.itemId
                ? " map-pin-list__btn--selected"
                : ""
            }`}
            onClick={() => {
              props.onSelectItem(pin.itemId);
            }}
          >
            <span
              className="map-pin-list__dot"
              style={{ background: pin.color }}
              aria-hidden
            />
            <span className="map-pin-list__title">{pin.title}</span>
            <span className="map-pin-list__label muted">{pin.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const key of a) {
    if (!b.has(key)) {
      return false;
    }
  }
  return true;
}
