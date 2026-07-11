import { expect, test } from "@playwright/test";
import {
  cleanupTrip,
  createFlightItemFromEnrichment,
  createNoteItem,
  createShareGrant,
  createTrip,
  enrichFlight,
  exportTripJson,
  listAttachments,
  uploadAttachment,
  type FlightEnrichmentDto,
} from "../src/api.js";
import {
  criticalPathSkipReason,
  loadE2EEnv,
} from "../src/env.js";
import { assertShareSessionFlow } from "../src/share-browser.js";

/**
 * Full critical path (owner API + share browser):
 * 1. Create trip
 * 2. Mock enrich flight (UA100) + create flight from suggestion
 * 3. Create note + attachment presign (PUT/confirm when possible)
 * 4. Export JSON
 * 5. Share session → read-only viewer (items visible) → leave
 *
 * Requires `E2E_OWNER_ACCESS_TOKEN`. Skips cleanly when absent.
 */
const env = loadE2EEnv();
const skipReason = criticalPathSkipReason(env);

const NOTE_TITLE = "E2E boarding pass note";
const NOTE_BODY = "Attachment target for critical path.";

function assertMockUa100Found(enrichment: FlightEnrichmentDto): void {
  expect(enrichment.status, "mock UA100 must be found").toBe("found");
  expect(enrichment.provider).toBe("mock");
  expect(enrichment.flightNumber).toBeTruthy();
  expect(enrichment.departure?.airportIata).toBe("SFO");
  expect(enrichment.arrival?.airportIata).toBe("JFK");
  expect(enrichment.departure?.scheduledAt.length).toBeGreaterThan(0);
  expect(enrichment.arrival?.scheduledAt.length).toBeGreaterThan(0);
  expect(enrichment.fetchedAt.length).toBeGreaterThan(0);
}

function assertLiveEnrichment(enrichment: FlightEnrichmentDto): void {
  expect(["found", "cancelled", "not_found"]).toContain(enrichment.status);
  expect(enrichment.provider.length).toBeGreaterThan(0);
  expect(enrichment.fetchedAt.length).toBeGreaterThan(0);
  if (enrichment.status === "found" || enrichment.status === "cancelled") {
    expect(enrichment.flightNumber).toBeTruthy();
    expect(enrichment.departure?.airportIata).toBeTruthy();
    expect(enrichment.arrival?.airportIata).toBeTruthy();
    expect(enrichment.departure?.scheduledAt.length).toBeGreaterThan(0);
    expect(enrichment.arrival?.scheduledAt.length).toBeGreaterThan(0);
  }
}

test.describe("critical path", () => {
  test.skip(skipReason !== undefined, skipReason ?? "");

  test("trip → mock enrich → flight → upload → export → share", async ({
    page,
  }) => {
    const ownerToken = env.ownerAccessToken;
    if (ownerToken === undefined) {
      test.skip(true, criticalPathSkipReason(env) ?? "No owner token");
      return;
    }

    const baseUrl = env.baseUrl;
    let tripId: string | undefined;
    let shareId: string | undefined;

    try {
      // --- 1. Create trip ---
      const trip = await createTrip(baseUrl, ownerToken, {
        title: `E2E critical ${new Date().toISOString().replace(/[:.]/g, "-")}`,
      });
      tripId = trip.tripId;
      expect(trip.tripId.length).toBeGreaterThan(0);
      expect(trip.title.length).toBeGreaterThan(0);
      expect(trip.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // --- 2. Enrich flight (UA100) + suggest-then-confirm create ---
      const enrichment = await enrichFlight(baseUrl, ownerToken, {
        flightNumber: "UA100",
        date: trip.startDate,
        departureAirportHint: "SFO",
      });

      if (enrichment.provider === "mock") {
        assertMockUa100Found(enrichment);
      } else {
        assertLiveEnrichment(enrichment);
      }

      let flightTitle: string | undefined;
      let flightItemId: string | undefined;
      if (
        (enrichment.status === "found" || enrichment.status === "cancelled") &&
        enrichment.flightNumber !== undefined &&
        enrichment.departure !== undefined &&
        enrichment.arrival !== undefined
      ) {
        const flight = await createFlightItemFromEnrichment(
          baseUrl,
          ownerToken,
          trip.tripId,
          {
            status: enrichment.status,
            flightNumber: enrichment.flightNumber,
            airlineCode: enrichment.airlineCode,
            airlineName: enrichment.airlineName,
            provider: enrichment.provider,
            fetchedAt: enrichment.fetchedAt,
            confidence: enrichment.confidence,
            departure: enrichment.departure,
            arrival: enrichment.arrival,
          },
        );
        flightItemId = flight.itemId;
        flightTitle = flight.title;
        expect(flight.itemId.length).toBeGreaterThan(0);
      } else if (enrichment.provider === "mock") {
        throw new Error(
          "Mock enrich returned found for UA100 but missing flight fields",
        );
      }

      // --- 3. Note item + attachment presign (PUT/confirm when possible) ---
      const note = await createNoteItem(baseUrl, ownerToken, trip.tripId, {
        title: NOTE_TITLE,
        notes: NOTE_BODY,
      });
      expect(note.itemId.length).toBeGreaterThan(0);
      expect(note.title).toBe(NOTE_TITLE);

      const upload = await uploadAttachment(
        baseUrl,
        ownerToken,
        trip.tripId,
        note.itemId,
      );
      expect(upload.presign.attachmentId.length).toBeGreaterThan(0);
      expect(upload.presign.uploadUrl.length).toBeGreaterThan(0);
      expect(upload.presign.s3Key.length).toBeGreaterThan(0);

      // Always prove DDB pending (or ready) row without requiring S3 PUT.
      const attachments = await listAttachments(
        baseUrl,
        ownerToken,
        trip.tripId,
        note.itemId,
      );
      const listed = attachments.find(
        (a) => a.attachmentId === upload.presign.attachmentId,
      );
      expect(listed, "presigned attachment listed for item").toBeDefined();

      if (upload.completed) {
        expect(upload.meta?.status).toBe("ready");
        expect(upload.meta?.attachmentId).toBe(upload.presign.attachmentId);
        expect(listed?.status).toBe("ready");
      } else {
        expect(listed?.status).toBe("pending");
        if (env.requireAttachmentUpload) {
          throw new Error(
            `Attachment PUT/confirm required but failed ` +
              `(putStatus=${String(upload.putStatus)}, error=${upload.putError ?? "unknown"})`,
          );
        }
        // Soft-skip: presign + pending row prove attachment API without S3 PUT.
        // Node fetch (not browser CORS): failures are network / signature / policy.
        console.warn(
          "[e2e] attachment PUT/confirm soft-skipped after presign (pending row ok):",
          upload.putError ?? `HTTP ${String(upload.putStatus)}`,
        );
      }

      // --- 4. Export JSON ---
      const exported = await exportTripJson(baseUrl, ownerToken, trip.tripId);
      expect(exported.body.tripId).toBe(trip.tripId);
      expect(exported.body.title).toBe(trip.title);
      expect(Array.isArray(exported.body.items)).toBe(true);
      expect(
        exported.body.items.some((item) => item.itemId === note.itemId),
      ).toBe(true);
      if (flightItemId !== undefined) {
        expect(
          exported.body.items.some((item) => item.itemId === flightItemId),
        ).toBe(true);
      }

      // Content-Disposition is part of the export download contract.
      expect(
        exported.contentDisposition,
        "export must set Content-Disposition",
      ).not.toBeNull();
      const disposition = exported.contentDisposition ?? "";
      expect(disposition.toLowerCase()).toContain("attachment");
      expect(disposition).toContain(`trip-${trip.tripId}.json`);

      // --- 5. Share session (browser) — items visible, full cookie + leave ---
      const share = await createShareGrant(
        baseUrl,
        ownerToken,
        trip.tripId,
        "e2e-critical",
      );
      shareId = share.shareId;

      const itemTitles = [NOTE_TITLE];
      if (flightTitle !== undefined) {
        itemTitles.push(flightTitle);
      }

      const { tripJson } = await assertShareSessionFlow(page, share.token, {
        tripTitle: trip.title,
        itemTitles,
        leaveShare: true,
      });

      // Response body also includes items (not only UI).
      const shareBody = tripJson as {
        items?: readonly { itemId?: string; title?: string }[];
      };
      expect(Array.isArray(shareBody.items)).toBe(true);
      expect(
        shareBody.items?.some((item) => item.title === NOTE_TITLE),
      ).toBe(true);
      if (flightItemId !== undefined) {
        expect(
          shareBody.items?.some((item) => item.itemId === flightItemId),
        ).toBe(true);
      }
    } finally {
      if (tripId !== undefined) {
        await cleanupTrip(baseUrl, ownerToken, tripId, shareId);
      }
    }
  });
});
