import type { ItineraryItem } from "@tripplan/domain";
import { formatInstantInZone } from "./datetime.ts";

export function itemTypeLabel(type: ItineraryItem["type"]): string {
  switch (type) {
    case "flight":
      return "Flight";
    case "note":
      return "Note";
    case "hotel":
      return "Hotel";
    case "train":
      return "Train";
    case "transport":
      return "Transport";
    case "activity":
      return "Activity";
    case "ticket":
      return "Ticket";
    case "custom":
      return "Custom";
  }
}

export function itemSubtitle(
  item: ItineraryItem,
  timezone: string,
): string | undefined {
  const start = formatInstantInZone(item.startAt, timezone);
  const end = formatInstantInZone(item.endAt, timezone);
  if (item.type === "flight") {
    const route = [
      item.details.departureAirport,
      item.details.arrivalAirport,
    ]
      .filter((x): x is string => x !== undefined && x.length > 0)
      .join(" → ");
    const bits = [
      item.details.airlineCode !== undefined
        ? `${item.details.airlineCode}${item.details.flightNumber}`
        : item.details.flightNumber,
      route.length > 0 ? route : undefined,
      start,
      end !== undefined ? `→ ${end}` : undefined,
    ].filter((x): x is string => x !== undefined);
    return bits.join(" · ");
  }
  if (item.type === "note") {
    const body = item.notes?.trim();
    if (body !== undefined && body.length > 0) {
      return body.length > 120 ? `${body.slice(0, 117)}…` : body;
    }
    return start;
  }
  return start;
}

export function itemTypeBadgeVariant(
  type: ItineraryItem["type"],
): "default" | "secondary" | "outline" {
  switch (type) {
    case "flight":
      return "default";
    case "note":
      return "secondary";
    default:
      return "outline";
  }
}
