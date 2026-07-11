import { Schema as S, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  PresignAttachment,
  buildAttachmentS3Key,
  isAllowedAttachmentContentType,
  normalizeContentType,
  sanitizeAttachmentFileName,
} from "./attachment.js";

describe("attachment helpers", () => {
  it("allowlists PDF and common images", () => {
    expect(isAllowedAttachmentContentType("application/pdf")).toBe(true);
    expect(isAllowedAttachmentContentType("image/png")).toBe(true);
    expect(isAllowedAttachmentContentType("image/jpeg; charset=binary")).toBe(
      true,
    );
    expect(isAllowedAttachmentContentType("application/zip")).toBe(false);
    expect(isAllowedAttachmentContentType("text/html")).toBe(false);
  });

  it("normalizes content types", () => {
    expect(normalizeContentType("Image/PNG; charset=utf-8")).toBe("image/png");
  });

  it("sanitizes file names", () => {
    expect(sanitizeAttachmentFileName("../../etc/passwd.pdf")).toBe(
      "passwd.pdf",
    );
    expect(sanitizeAttachmentFileName('quote"name.pdf')).toBe("quotename.pdf");
    expect(sanitizeAttachmentFileName("a".repeat(200)).length).toBe(180);
  });

  it("builds server-only S3 keys without fileName", () => {
    const key = buildAttachmentS3Key("t1", "i1", "a1");
    expect(key).toBe("trips/t1/items/i1/a1");
  });

  it("rejects non-integer sizeBytes on PresignAttachment", () => {
    const decode = S.decodeUnknownEither(PresignAttachment);
    const ok = decode({
      contentType: "application/pdf",
      fileName: "a.pdf",
      sizeBytes: 12,
    });
    expect(Either.isRight(ok)).toBe(true);

    const fractional = decode({
      contentType: "application/pdf",
      fileName: "a.pdf",
      sizeBytes: 10.5,
    });
    expect(Either.isLeft(fractional)).toBe(true);
  });
});
