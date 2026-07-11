import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createDocsS3Client,
  makeS3DocsStore,
  PENDING_OBJECT_TAG,
} from "./docs-store.js";

describe("makeS3DocsStore presignPut contract", () => {
  it("does not embed empty-body flexible checksums; keeps tagging as signed header", async () => {
    const client = createDocsS3Client({
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
    const store = makeS3DocsStore({
      bucketName: "tripplan-docs-test",
      region: "us-east-1",
      client,
      putExpiresSeconds: 900,
    });

    const result = await Effect.runPromise(
      store.presignPut({
        key: "trips/t1/items/i1/a1",
        contentType: "application/pdf",
        contentLength: 42,
      }),
    );

    const url = new URL(result.uploadUrl);
    // Issue 1: no empty-body CRC32 / flexible checksum algorithm in query.
    expect(url.searchParams.get("x-amz-checksum-crc32")).toBeNull();
    expect(url.searchParams.get("x-amz-sdk-checksum-algorithm")).toBeNull();
    expect(result.uploadUrl.toLowerCase()).not.toContain("checksum");

    // Issue 3: tagging stays a signed header (not hoisted to query).
    expect(url.searchParams.get("x-amz-tagging")).toBeNull();
    const signed = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed.split(";").sort()).toEqual(
      ["content-length", "content-type", "host", "x-amz-tagging"].sort(),
    );

    expect(result.requiredHeaders["Content-Type"]).toBe("application/pdf");
    expect(result.requiredHeaders["Content-Length"]).toBe("42");
    expect(result.requiredHeaders["x-amz-tagging"]).toBe(PENDING_OBJECT_TAG);
  });
});
