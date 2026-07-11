/**
 * MapLibre canvas — loaded lazily so the GL bundle stays out of the initial chunk.
 */
import type { FeatureCollection, LineString, Point } from "geojson";
import maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { MapArc, MapPin } from "./geo-features.ts";
import { greatCircleCoordinates } from "./geo-features.ts";
import { mapTilerStyleUrl } from "./style-url.ts";
import "maplibre-gl/dist/maplibre-gl.css";

const PINS_SOURCE = "trip-pins";
const PINS_LAYER = "trip-pins-circle";
const PINS_SELECTED_LAYER = "trip-pins-selected";
const ARCS_SOURCE = "trip-arcs";
const ARCS_LAYER = "trip-arcs-line";

export type MapCanvasProps = {
  readonly mapTilerApiKey: string;
  readonly pins: readonly MapPin[];
  readonly arcs: readonly MapArc[];
  /**
   * Stable key for the trip's unfiltered geo bbox. When this changes,
   * fitBounds runs once. Day-filter changes should keep the same key.
   */
  readonly fitBoundsKey: string;
  readonly selectedItemId: string | undefined;
  /** Pass `undefined` to clear selection (map background click). */
  readonly onSelectItem: (itemId: string | undefined) => void;
  /** Style / tile failures (invalid key, network). */
  readonly onMapError?: (message: string) => void;
};

type PendingState = {
  pins: readonly MapPin[];
  arcs: readonly MapArc[];
  fitBoundsKey: string;
  selectedItemId: string | undefined;
};

export default function MapCanvas(props: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | undefined>(undefined);
  const readyRef = useRef(false);
  const pendingRef = useRef<PendingState>({
    pins: props.pins,
    arcs: props.arcs,
    fitBoundsKey: props.fitBoundsKey,
    selectedItemId: props.selectedItemId,
  });
  const lastFitKeyRef = useRef<string | undefined>(undefined);
  const lastFlyRef = useRef<{
    itemId: string;
    lat: number;
    lng: number;
  } | null>(null);
  const onSelectRef = useRef(props.onSelectItem);
  const onErrorRef = useRef(props.onMapError);
  onSelectRef.current = props.onSelectItem;
  onErrorRef.current = props.onMapError;

  // Keep pending snapshot current for the ready callback.
  pendingRef.current = {
    pins: props.pins,
    arcs: props.arcs,
    fitBoundsKey: props.fitBoundsKey,
    selectedItemId: props.selectedItemId,
  };

  // Create map once per API key.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    readyRef.current = false;
    lastFitKeyRef.current = undefined;
    lastFlyRef.current = null;

    const map = new maplibregl.Map({
      container,
      style: mapTilerStyleUrl(props.mapTilerApiKey),
      center: [0, 20],
      zoom: 1.2,
      attributionControl: { compact: true },
    });
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    mapRef.current = map;

    const onError = (event: { error?: Error | string }): void => {
      const err = event.error;
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Map failed to load tiles";
      onErrorRef.current?.(message);
    };
    map.on("error", onError);

    const markReady = (): void => {
      if (readyRef.current) {
        return;
      }
      if (map.getSource(PINS_SOURCE) === undefined) {
        map.addSource(ARCS_SOURCE, {
          type: "geojson",
          data: emptyLineCollection(),
        });
        map.addLayer({
          id: ARCS_LAYER,
          type: "line",
          source: ARCS_SOURCE,
          paint: {
            "line-color": ["get", "color"],
            "line-width": 2.5,
            "line-opacity": 0.75,
          },
          layout: {
            "line-cap": "round",
            "line-join": "round",
          },
        });

        map.addSource(PINS_SOURCE, {
          type: "geojson",
          data: emptyPointCollection(),
        });
        map.addLayer({
          id: PINS_LAYER,
          type: "circle",
          source: PINS_SOURCE,
          paint: {
            "circle-radius": 7,
            "circle-color": ["get", "color"],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#0f1419",
            "circle-opacity": 0.95,
          },
        });
        map.addLayer({
          id: PINS_SELECTED_LAYER,
          type: "circle",
          source: PINS_SOURCE,
          filter: ["==", ["get", "itemId"], ""],
          paint: {
            "circle-radius": 12,
            "circle-color": "transparent",
            "circle-stroke-width": 3,
            "circle-stroke-color": "#e7ecf1",
          },
        });

        map.on("click", (event) => {
          const features = map.queryRenderedFeatures(event.point, {
            layers: [PINS_LAYER],
          });
          const itemId = features[0]?.properties?.["itemId"];
          if (typeof itemId === "string" && itemId.length > 0) {
            onSelectRef.current(itemId);
          } else {
            onSelectRef.current(undefined);
          }
        });
        map.on("mouseenter", PINS_LAYER, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", PINS_LAYER, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      readyRef.current = true;
      const pending = pendingRef.current;
      applyMapData(map, pending, lastFitKeyRef, lastFlyRef);
    };

    map.on("load", markReady);

    const ro = new ResizeObserver(() => {
      map.resize();
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      readyRef.current = false;
      map.off("error", onError);
      map.remove();
      mapRef.current = undefined;
    };
  }, [props.mapTilerApiKey]);

  // Push pin/arc/selection updates only when sources exist.
  useEffect(() => {
    const map = mapRef.current;
    if (map === undefined || !readyRef.current) {
      return;
    }
    applyMapData(
      map,
      {
        pins: props.pins,
        arcs: props.arcs,
        fitBoundsKey: props.fitBoundsKey,
        selectedItemId: props.selectedItemId,
      },
      lastFitKeyRef,
      lastFlyRef,
    );
  }, [
    props.pins,
    props.arcs,
    props.fitBoundsKey,
    props.selectedItemId,
  ]);

  return <div ref={containerRef} className="map-canvas" role="presentation" />;
}

function applyMapData(
  map: maplibregl.Map,
  state: PendingState,
  lastFitKeyRef: { current: string | undefined },
  lastFlyRef: {
    current: { itemId: string; lat: number; lng: number } | null;
  },
): void {
  const pinsSource = map.getSource(PINS_SOURCE);
  const arcsSource = map.getSource(ARCS_SOURCE);
  if (!(pinsSource instanceof maplibregl.GeoJSONSource)) {
    return;
  }
  if (!(arcsSource instanceof maplibregl.GeoJSONSource)) {
    return;
  }

  pinsSource.setData(pinsToGeoJson(state.pins));
  arcsSource.setData(arcsToGeoJson(state.arcs));

  if (map.getLayer(PINS_SELECTED_LAYER) !== undefined) {
    map.setFilter(PINS_SELECTED_LAYER, [
      "==",
      ["get", "itemId"],
      state.selectedItemId ?? "",
    ]);
  }

  if (
    state.fitBoundsKey.length > 0 &&
    state.fitBoundsKey !== lastFitKeyRef.current &&
    state.pins.length > 0
  ) {
    lastFitKeyRef.current = state.fitBoundsKey;
    const bounds = new maplibregl.LngLatBounds();
    for (const pin of state.pins) {
      bounds.extend([pin.lng, pin.lat]);
    }
    map.fitBounds(bounds, {
      padding: 48,
      maxZoom: 10,
      duration: 500,
    });
  }

  if (state.selectedItemId === undefined) {
    lastFlyRef.current = null;
    return;
  }
  const pin = state.pins.find((p) => p.itemId === state.selectedItemId);
  if (pin === undefined) {
    return;
  }
  const prev = lastFlyRef.current;
  if (
    prev !== null &&
    prev.itemId === pin.itemId &&
    prev.lat === pin.lat &&
    prev.lng === pin.lng
  ) {
    return;
  }
  lastFlyRef.current = { itemId: pin.itemId, lat: pin.lat, lng: pin.lng };
  map.easeTo({
    center: [pin.lng, pin.lat],
    zoom: Math.max(map.getZoom(), 5),
    duration: 450,
  });
}

function emptyPointCollection(): FeatureCollection<Point> {
  return { type: "FeatureCollection", features: [] };
}

function emptyLineCollection(): FeatureCollection<LineString> {
  return { type: "FeatureCollection", features: [] };
}

function pinsToGeoJson(pins: readonly MapPin[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [pin.lng, pin.lat],
      },
      properties: {
        id: pin.id,
        itemId: pin.itemId,
        role: pin.role,
        color: pin.color,
        title: pin.title,
        label: pin.label,
      },
    })),
  };
}

function arcsToGeoJson(arcs: readonly MapArc[]): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: arcs.map((arc) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: greatCircleCoordinates(arc.from, arc.to),
      },
      properties: {
        id: arc.id,
        itemId: arc.itemId,
        color: arc.color,
        title: arc.title,
      },
    })),
  };
}
