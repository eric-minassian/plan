import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMockOwnerAuth, mockPrincipal } from "../auth/mock-owner-auth.js";
import { SHARE_COOKIE_NAME } from "../auth/share-auth.js";
import type { HttpRequest } from "../http/types.js";
import { silentLogger } from "../logging/logger.js";
import {
  makeInMemoryAttachmentRepo,
  MAX_ATTACHMENTS_PER_ITEM,
} from "../repos/attachment-repo.js";
import { makeInMemoryShareRepo } from "../repos/share-repo.js";
import { makeInMemoryTripRepo } from "../repos/trip-repo.js";
import { makeInMemoryUserRepo } from "../repos/user-repo.js";
import {
  makeMockDocsStore,
  PENDING_OBJECT_TAG,
  type MockDocsStore,
} from "../s3/docs-store.js";
import { handleRequest } from "../router.js";

function baseRequest(
  partial: Partial<HttpRequest> & Pick<HttpRequest, "method" | "path">,
): HttpRequest {
  return {
    method: partial.method,
    path: partial.path,
    url: partial.url ?? `https://plan.ericminassian.com${partial.path}`,
    headers: partial.headers ?? {},
    query: partial.query ?? {},
    cookies: partial.cookies ?? {},
    body: partial.body,
    requestId: partial.requestId ?? "test-request-id",
    clientIp: partial.clientIp ?? "127.0.0.1",
  };
}

const owner = mockPrincipal({ sub: "owner-1", nickname: "Ada" });
const other = mockPrincipal({ sub: "owner-2" });

function deps(options: {
  tripRepo: ReturnType<typeof makeInMemoryTripRepo>;
  attachmentRepo?: ReturnType<typeof makeInMemoryAttachmentRepo>;
  docsStore?: MockDocsStore;
  shareRepo?: ReturnType<typeof makeInMemoryShareRepo>;
  userRepo?: ReturnType<typeof makeInMemoryUserRepo>;
  principal?: ReturnType<typeof mockPrincipal> | null;
}) {
  return {
    ownerAuth: makeMockOwnerAuth(
      options.principal === undefined ? owner : options.principal,
    ),
    userRepo: options.userRepo ?? makeInMemoryUserRepo(),
    tripRepo: options.tripRepo,
    attachmentRepo:
      options.attachmentRepo ?? makeInMemoryAttachmentRepo(),
    docsStore: options.docsStore ?? makeMockDocsStore(),
    shareRepo: options.shareRepo ?? makeInMemoryShareRepo(),
    logger: silentLogger,
  };
}

const tripBody = JSON.stringify({
  title: "Japan 2026",
  timezone: "Asia/Tokyo",
  startDate: "2026-06-01",
  endDate: "2026-06-10",
});

async function createTripAndItem(): Promise<{
  tripRepo: ReturnType<typeof makeInMemoryTripRepo>;
  attachmentRepo: ReturnType<typeof makeInMemoryAttachmentRepo>;
  docsStore: MockDocsStore;
  tripId: string;
  itemId: string;
}> {
  const tripRepo = makeInMemoryTripRepo();
  const attachmentRepo = makeInMemoryAttachmentRepo();
  const docsStore = makeMockDocsStore();
  const d = deps({ tripRepo, attachmentRepo, docsStore });

  const tripRes = await Effect.runPromise(
    handleRequest(
      baseRequest({ method: "POST", path: "/api/v1/trips", body: tripBody }),
      d,
    ),
  );
  expect(tripRes.status).toBe(201);
  const tripId = (JSON.parse(tripRes.body ?? "{}") as { tripId: string })
    .tripId;

  const itemRes = await Effect.runPromise(
    handleRequest(
      baseRequest({
        method: "POST",
        path: `/api/v1/trips/${tripId}/items`,
        body: JSON.stringify({
          type: "note",
          title: "Boarding pass",
          notes: "keep handy",
          details: {},
        }),
      }),
      d,
    ),
  );
  expect(itemRes.status).toBe(201);
  const itemId = (JSON.parse(itemRes.body ?? "{}") as { itemId: string })
    .itemId;

  return { tripRepo, attachmentRepo, docsStore, tripId, itemId };
}

async function presign(
  ctx: Awaited<ReturnType<typeof createTripAndItem>>,
  body: {
    contentType: string;
    fileName: string;
    sizeBytes: number;
  },
) {
  return Effect.runPromise(
    handleRequest(
      baseRequest({
        method: "POST",
        path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/presign`,
        body: JSON.stringify(body),
      }),
      deps(ctx),
    ),
  );
}

describe("document attachments", () => {
  it("presign → PUT → confirm → list → owner url → delete", async () => {
    const ctx = await createTripAndItem();
    const sizeBytes = 12;

    const signed = await presign(ctx, {
      contentType: "application/pdf",
      fileName: "pass.pdf",
      sizeBytes,
    });
    expect(signed.status).toBe(201);
    const presignBody = JSON.parse(signed.body ?? "{}") as {
      attachmentId: string;
      s3Key: string;
      uploadUrl: string;
      requiredHeaders: Record<string, string>;
      expiresIn: number;
    };
    expect(presignBody.attachmentId.length).toBeGreaterThan(0);
    expect(presignBody.s3Key).toBe(
      `trips/${ctx.tripId}/items/${ctx.itemId}/${presignBody.attachmentId}`,
    );
    expect(presignBody.uploadUrl).toContain(presignBody.s3Key);
    expect(presignBody.requiredHeaders["Content-Type"]).toBe("application/pdf");
    expect(presignBody.requiredHeaders["Content-Length"]).toBe(
      String(sizeBytes),
    );
    expect(presignBody.requiredHeaders["x-amz-tagging"]).toBe(
      PENDING_OBJECT_TAG,
    );
    expect(presignBody.expiresIn).toBeGreaterThan(0);

    // Simulate client PUT with signed headers.
    ctx.docsStore.simulatePut(presignBody.s3Key, presignBody.requiredHeaders);
    const stored = ctx.docsStore.getObject(presignBody.s3Key);
    expect(stored?.tags.pending).toBe("true");

    const confirm = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${presignBody.attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );
    expect(confirm.status).toBe(200);
    const ready = JSON.parse(confirm.body ?? "{}") as {
      status: string;
      fileName: string;
      s3Key?: string;
    };
    expect(ready.status).toBe("ready");
    expect(ready.fileName).toBe("pass.pdf");
    expect(ready.s3Key).toBeUndefined();
    expect(ctx.docsStore.getObject(presignBody.s3Key)?.tags.pending).toBe(
      undefined,
    );

    // Idempotent confirm
    const confirm2 = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${presignBody.attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );
    expect(confirm2.status).toBe(200);

    const list = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments`,
        }),
        deps(ctx),
      ),
    );
    expect(list.status).toBe(200);
    const listBody = JSON.parse(list.body ?? "{}") as {
      attachments: Array<{ attachmentId: string; status: string }>;
    };
    expect(listBody.attachments).toHaveLength(1);
    expect(listBody.attachments[0]?.status).toBe("ready");

    const urlRes = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${presignBody.attachmentId}/url`,
        }),
        deps(ctx),
      ),
    );
    expect(urlRes.status).toBe(200);
    const urlBody = JSON.parse(urlRes.body ?? "{}") as {
      url: string;
      expiresIn: number;
    };
    expect(urlBody.url).toContain(presignBody.s3Key);
    expect(urlBody.url).toContain("response-content-disposition");
    expect(urlBody.expiresIn).toBeGreaterThan(0);

    const del = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${presignBody.attachmentId}`,
        }),
        deps(ctx),
      ),
    );
    expect(del.status).toBe(204);
    expect(ctx.docsStore.getObject(presignBody.s3Key)).toBeUndefined();

    const listEmpty = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments`,
        }),
        deps(ctx),
      ),
    );
    const emptyBody = JSON.parse(listEmpty.body ?? "{}") as {
      attachments: unknown[];
    };
    expect(emptyBody.attachments).toHaveLength(0);
  });

  it("rejects disallowed content type, oversized files, and non-integer sizeBytes", async () => {
    const ctx = await createTripAndItem();

    const badType = await presign(ctx, {
      contentType: "application/zip",
      fileName: "x.zip",
      sizeBytes: 100,
    });
    expect(badType.status).toBe(400);

    const tooBig = await presign(ctx, {
      contentType: "image/png",
      fileName: "big.png",
      sizeBytes: 15 * 1024 * 1024 + 1,
    });
    expect(tooBig.status).toBe(400);

    const fractional = await presign(ctx, {
      contentType: "application/pdf",
      fileName: "frac.pdf",
      sizeBytes: 10.5,
    });
    expect(fractional.status).toBe(400);
  });

  it("confirm fails when object missing or size mismatches", async () => {
    const ctx = await createTripAndItem();
    const signed = await presign(ctx, {
      contentType: "image/png",
      fileName: "a.png",
      sizeBytes: 8,
    });
    const { attachmentId, s3Key, requiredHeaders } = JSON.parse(
      signed.body ?? "{}",
    ) as {
      attachmentId: string;
      s3Key: string;
      requiredHeaders: Record<string, string>;
    };

    const missing = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );
    expect(missing.status).toBe(400);

    // Wrong size simulation: put with mismatched Content-Length is rejected by mock;
    // put correctly then overwrite length to force HeadObject mismatch.
    ctx.docsStore.simulatePut(s3Key, requiredHeaders);
    const obj = ctx.docsStore.objects.get(s3Key);
    if (obj !== undefined) {
      ctx.docsStore.objects.set(s3Key, { ...obj, contentLength: 1 });
    }

    const mismatch = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );
    expect(mismatch.status).toBe(400);
  });

  it("owner download rejects pending attachment with 409", async () => {
    const ctx = await createTripAndItem();
    const signed = await presign(ctx, {
      contentType: "application/pdf",
      fileName: "pending.pdf",
      sizeBytes: 4,
    });
    const { attachmentId } = JSON.parse(signed.body ?? "{}") as {
      attachmentId: string;
    };

    const urlRes = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/url`,
        }),
        deps(ctx),
      ),
    );
    expect(urlRes.status).toBe(409);
  });

  it("enforces max attachments per item (confirm to free pending slots)", async () => {
    const ctx = await createTripAndItem();
    for (let i = 0; i < MAX_ATTACHMENTS_PER_ITEM; i++) {
      const res = await presign(ctx, {
        contentType: "image/jpeg",
        fileName: `f${i}.jpg`,
        sizeBytes: 10 + i,
      });
      expect(res.status).toBe(201);
      const body = JSON.parse(res.body ?? "{}") as {
        attachmentId: string;
        s3Key: string;
        requiredHeaders: Record<string, string>;
      };
      // Confirm so concurrent pending quota does not block reaching the hard max.
      ctx.docsStore.simulatePut(body.s3Key, body.requiredHeaders);
      const confirm = await Effect.runPromise(
        handleRequest(
          baseRequest({
            method: "POST",
            path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${body.attachmentId}/confirm`,
          }),
          deps(ctx),
        ),
      );
      expect(confirm.status).toBe(200);
    }
    const over = await presign(ctx, {
      contentType: "image/jpeg",
      fileName: "overflow.jpg",
      sizeBytes: 99,
    });
    expect(over.status).toBe(400);
  });

  it("enforces concurrent pending upload limit", async () => {
    const ctx = await createTripAndItem();
    for (let i = 0; i < 5; i++) {
      const res = await presign(ctx, {
        contentType: "image/png",
        fileName: `p${i}.png`,
        sizeBytes: 20 + i,
      });
      expect(res.status).toBe(201);
    }
    const over = await presign(ctx, {
      contentType: "image/png",
      fileName: "too-many-pending.png",
      sizeBytes: 50,
    });
    expect(over.status).toBe(400);
  });

  it("sanitizes path-like file names into key-safe stored names", async () => {
    const ctx = await createTripAndItem();
    const signed = await presign(ctx, {
      contentType: "application/pdf",
      fileName: "../../etc/passwd.pdf",
      sizeBytes: 3,
    });
    expect(signed.status).toBe(201);
    const { attachmentId, s3Key } = JSON.parse(signed.body ?? "{}") as {
      attachmentId: string;
      s3Key: string;
    };
    // Key never contains the original fileName path.
    expect(s3Key).not.toContain("etc");
    expect(s3Key).toContain(attachmentId);

    ctx.docsStore.simulatePut(
      s3Key,
      JSON.parse(signed.body ?? "{}").requiredHeaders as Record<
        string,
        string
      >,
    );
    const confirm = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );
    const meta = JSON.parse(confirm.body ?? "{}") as { fileName: string };
    expect(meta.fileName).toBe("passwd.pdf");
  });

  it("returns 404 for other owners", async () => {
    const ctx = await createTripAndItem();
    const signed = await presign(ctx, {
      contentType: "image/gif",
      fileName: "x.gif",
      sizeBytes: 2,
    });
    const { attachmentId } = JSON.parse(signed.body ?? "{}") as {
      attachmentId: string;
    };

    const list = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments`,
        }),
        deps({ ...ctx, principal: other }),
      ),
    );
    expect(list.status).toBe(404);

    const del = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}`,
        }),
        deps({ ...ctx, principal: other }),
      ),
    );
    expect(del.status).toBe(404);
  });

  it("cascades attachments when deleting an item", async () => {
    const ctx = await createTripAndItem();
    const signed = await presign(ctx, {
      contentType: "application/pdf",
      fileName: "gone.pdf",
      sizeBytes: 5,
    });
    const { attachmentId, s3Key, requiredHeaders } = JSON.parse(
      signed.body ?? "{}",
    ) as {
      attachmentId: string;
      s3Key: string;
      requiredHeaders: Record<string, string>;
    };
    ctx.docsStore.simulatePut(s3Key, requiredHeaders);
    await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );

    const delItem = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}`,
        }),
        deps(ctx),
      ),
    );
    expect(delItem.status).toBe(204);
    expect(ctx.docsStore.getObject(s3Key)).toBeUndefined();

    const att = await Effect.runPromise(
      ctx.attachmentRepo.get(ctx.tripId, ctx.itemId, attachmentId),
    );
    expect(att).toBeUndefined();
  });

  it("does not cascade attachments for another owner's trip (IDOR)", async () => {
    const ctx = await createTripAndItem();
    const signed = await presign(ctx, {
      contentType: "application/pdf",
      fileName: "victim.pdf",
      sizeBytes: 6,
    });
    const { attachmentId, s3Key, requiredHeaders } = JSON.parse(
      signed.body ?? "{}",
    ) as {
      attachmentId: string;
      s3Key: string;
      requiredHeaders: Record<string, string>;
    };
    ctx.docsStore.simulatePut(s3Key, requiredHeaders);
    await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );

    const attack = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}`,
        }),
        deps({ ...ctx, principal: other }),
      ),
    );
    expect(attack.status).toBe(404);
    // Attachments and S3 object must remain.
    const att = await Effect.runPromise(
      ctx.attachmentRepo.get(ctx.tripId, ctx.itemId, attachmentId),
    );
    expect(att?.status).toBe("ready");
    expect(ctx.docsStore.getObject(s3Key)).toBeDefined();
  });

  it("confirm is idempotent when already ready (concurrent race path)", async () => {
    const ctx = await createTripAndItem();
    const signed = await presign(ctx, {
      contentType: "image/webp",
      fileName: "race.webp",
      sizeBytes: 9,
    });
    const { attachmentId, s3Key, requiredHeaders } = JSON.parse(
      signed.body ?? "{}",
    ) as {
      attachmentId: string;
      s3Key: string;
      requiredHeaders: Record<string, string>;
    };
    ctx.docsStore.simulatePut(s3Key, requiredHeaders);

    // First confirm succeeds.
    const first = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );
    expect(first.status).toBe(200);

    // Second confirm (already ready) remains 200.
    const second = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );
    expect(second.status).toBe(200);

    // Force race path: mark pending in store while object is ready on S3, then
    // confirmReady conflicts after a parallel flip — simulate by confirming
    // when status is already ready via pre-check (covered above). Also exercise
    // conflict recovery by calling confirmReady twice after pending→ready.
    const conflictOk = await Effect.runPromise(
      ctx.attachmentRepo.confirmReady(ctx.tripId, ctx.itemId, attachmentId).pipe(
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            expect(err.type).toBe("Conflict");
            const live = yield* ctx.attachmentRepo.get(
              ctx.tripId,
              ctx.itemId,
              attachmentId,
            );
            expect(live?.status).toBe("ready");
            return live;
          }),
        ),
      ),
    );
    expect(conflictOk?.status).toBe("ready");
  });

  it("confirm rejects missing HeadObject Content-Type", async () => {
    const ctx = await createTripAndItem();
    const signed = await presign(ctx, {
      contentType: "application/pdf",
      fileName: "notype.pdf",
      sizeBytes: 4,
    });
    const { attachmentId, s3Key, requiredHeaders } = JSON.parse(
      signed.body ?? "{}",
    ) as {
      attachmentId: string;
      s3Key: string;
      requiredHeaders: Record<string, string>;
    };
    ctx.docsStore.simulatePut(s3Key, requiredHeaders);
    const obj = ctx.docsStore.objects.get(s3Key);
    if (obj !== undefined) {
      ctx.docsStore.objects.set(s3Key, { ...obj, contentType: "" });
    }

    const confirm = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/confirm`,
        }),
        deps(ctx),
      ),
    );
    expect(confirm.status).toBe(400);
  });

  it("share trip includes ready attachment meta; share download URL works", async () => {
    const ctx = await createTripAndItem();
    const shareRepo = makeInMemoryShareRepo();
    const userRepo = makeInMemoryUserRepo();
    await Effect.runPromise(userRepo.upsertFromPrincipal(owner));

    const signed = await presign(ctx, {
      contentType: "application/pdf",
      fileName: "shared.pdf",
      sizeBytes: 7,
    });
    const { attachmentId, s3Key, requiredHeaders } = JSON.parse(
      signed.body ?? "{}",
    ) as {
      attachmentId: string;
      s3Key: string;
      requiredHeaders: Record<string, string>;
    };
    ctx.docsStore.simulatePut(s3Key, requiredHeaders);
    await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/items/${ctx.itemId}/attachments/${attachmentId}/confirm`,
        }),
        deps({ ...ctx, shareRepo, userRepo }),
      ),
    );

    // Pending attachment should not appear on share trip.
    const pendingSign = await presign(ctx, {
      contentType: "image/png",
      fileName: "still-pending.png",
      sizeBytes: 3,
    });
    expect(pendingSign.status).toBe(201);

    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${ctx.tripId}/shares`,
          body: JSON.stringify({ label: "Family" }),
        }),
        deps({ ...ctx, shareRepo, userRepo }),
      ),
    );
    const token = (JSON.parse(created.body ?? "{}") as { token: string })
      .token;

    const exchange = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token }),
          headers: { origin: "https://plan.ericminassian.com" },
        }),
        deps({ ...ctx, shareRepo, userRepo }),
      ),
    );
    expect(exchange.status).toBe(204);
    const sessionCookie = exchange.cookies?.[0] ?? "";
    const sessionId = sessionCookie
      .split(";")[0]
      ?.split("=")
      .slice(1)
      .join("=") ?? "";

    const shareTrip = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: "/api/v1/share/trip",
          cookies: { [SHARE_COOKIE_NAME]: sessionId },
        }),
        deps({ ...ctx, shareRepo, userRepo }),
      ),
    );
    expect(shareTrip.status).toBe(200);
    const dto = JSON.parse(shareTrip.body ?? "{}") as {
      attachments: Array<{
        attachmentId: string;
        itemId: string;
        status: string;
        fileName: string;
        s3Key?: string;
      }>;
      ownerId?: string;
    };
    expect(dto.ownerId).toBeUndefined();
    expect(dto.attachments).toHaveLength(1);
    expect(dto.attachments[0]?.attachmentId).toBe(attachmentId);
    expect(dto.attachments[0]?.itemId).toBe(ctx.itemId);
    expect(dto.attachments[0]?.status).toBe("ready");
    expect(dto.attachments[0]?.fileName).toBe("shared.pdf");
    expect(dto.attachments[0]?.s3Key).toBeUndefined();

    const shareUrl = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/share/items/${ctx.itemId}/attachments/${attachmentId}/url`,
          cookies: { [SHARE_COOKIE_NAME]: sessionId },
        }),
        deps({ ...ctx, shareRepo, userRepo }),
      ),
    );
    expect(shareUrl.status).toBe(200);
    const shareUrlBody = JSON.parse(shareUrl.body ?? "{}") as {
      url: string;
    };
    expect(shareUrlBody.url).toContain(s3Key);

    // Pending attachment download rejected
    const pendingId = (
      JSON.parse(pendingSign.body ?? "{}") as { attachmentId: string }
    ).attachmentId;
    const pendingUrl = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/share/items/${ctx.itemId}/attachments/${pendingId}/url`,
          cookies: { [SHARE_COOKIE_NAME]: sessionId },
        }),
        deps({ ...ctx, shareRepo, userRepo }),
      ),
    );
    expect(pendingUrl.status).toBe(409);
  });
});
