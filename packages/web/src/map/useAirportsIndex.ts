import { useCallback, useEffect, useState } from "react";
import {
  emptyAirportsIndex,
  loadAirportsIndex,
  type AirportsLoadState,
} from "./airports.ts";

/**
 * Shared SPA airports index with loading/error status.
 * Failures are not permanently cached — call `retry` or remount to try again.
 */
export function useAirportsIndex(): AirportsLoadState & {
  readonly retry: () => void;
} {
  const [state, setState] = useState<AirportsLoadState>({
    index: emptyAirportsIndex(),
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({
      index: prev.status === "ready" ? prev.index : emptyAirportsIndex(),
      status: "loading",
    }));

    void loadAirportsIndex()
      .then((index) => {
        if (!cancelled) {
          setState({ index, status: "ready" });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ index: emptyAirportsIndex(), status: "error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, retry };
}
