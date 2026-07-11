import type { Airport } from "@tripplan/domain";
import { AIRPORTS_V1 } from "./airports-dataset.js";

/** Case-insensitive IATA lookup against the static dataset. */
export function lookupAirport(
  iata: string,
  dataset: readonly Airport[] = AIRPORTS_V1,
): Airport | undefined {
  const code = iata.trim().toUpperCase();
  if (code.length !== 3) {
    return undefined;
  }
  return dataset.find((a) => a.iata === code);
}

export function airportGeo(
  iata: string,
  dataset: readonly Airport[] = AIRPORTS_V1,
): { lat: number; lng: number; timezone: string | undefined; name: string } | undefined {
  const row = lookupAirport(iata, dataset);
  if (row === undefined) {
    return undefined;
  }
  return {
    lat: row.lat,
    lng: row.lng,
    timezone: row.timezone,
    name: row.name,
  };
}
