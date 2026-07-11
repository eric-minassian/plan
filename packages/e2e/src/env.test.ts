import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  criticalPathSkipReason,
  DEFAULT_E2E_BASE_URL,
  hasCriticalPathCredentials,
  hasShareSmokeCredentials,
  loadE2EEnv,
  loadLocalEnvFile,
  shareSmokeSkipReason,
} from "./env.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeTempEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tripplan-e2e-env-"));
  tempDirs.push(dir);
  const path = join(dir, ".env");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("loadLocalEnvFile", () => {
  it("is a no-op when file is missing", () => {
    const env: NodeJS.ProcessEnv = {};
    loadLocalEnvFile(join(tmpdir(), "missing-e2e-env-file"), env);
    expect(env).toEqual({});
  });

  it("loads KEY=VALUE and ignores comments / blanks", () => {
    const path = writeTempEnv(
      [
        "# comment",
        "",
        "E2E_BASE_URL=https://example.test",
        "E2E_SHARE_TOKEN=tok",
        "  E2E_SHARE_TRIP_TITLE=My Trip  ",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {};
    loadLocalEnvFile(path, env);
    expect(env.E2E_BASE_URL).toBe("https://example.test");
    expect(env.E2E_SHARE_TOKEN).toBe("tok");
    expect(env.E2E_SHARE_TRIP_TITLE).toBe("My Trip");
  });

  it("does not override already-set non-empty vars", () => {
    const path = writeTempEnv("E2E_SHARE_TOKEN=from-file\n");
    const env: NodeJS.ProcessEnv = { E2E_SHARE_TOKEN: "from-process" };
    loadLocalEnvFile(path, env);
    expect(env.E2E_SHARE_TOKEN).toBe("from-process");
  });

  it("strips matching single/double quotes around values", () => {
    const path = writeTempEnv(
      [
        `E2E_SHARE_TOKEN="quoted"`,
        `E2E_SHARE_TRIP_TITLE='also'`,
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {};
    loadLocalEnvFile(path, env);
    expect(env.E2E_SHARE_TOKEN).toBe("quoted");
    expect(env.E2E_SHARE_TRIP_TITLE).toBe("also");
  });
});

describe("loadE2EEnv", () => {
  it("defaults base URL and treats whitespace-only secrets as unset", () => {
    const env = loadE2EEnv({
      E2E_BASE_URL: undefined,
      E2E_SHARE_TOKEN: "   ",
      E2E_OWNER_ACCESS_TOKEN: "\t",
      E2E_SHARE_TRIP_TITLE: "  titled  ",
    });
    expect(env.baseUrl).toBe(DEFAULT_E2E_BASE_URL);
    expect(env.shareToken).toBeUndefined();
    expect(env.ownerAccessToken).toBeUndefined();
    expect(env.shareTripTitle).toBe("titled");
    expect(env.requireAttachmentUpload).toBe(false);
  });

  it("normalizes trailing slash on base URL", () => {
    const env = loadE2EEnv({
      E2E_BASE_URL: "https://plan-staging.example.com/",
    });
    expect(env.baseUrl).toBe("https://plan-staging.example.com");
  });

  it("parses E2E_REQUIRE_ATTACHMENT_UPLOAD", () => {
    expect(
      loadE2EEnv({ E2E_REQUIRE_ATTACHMENT_UPLOAD: "true" })
        .requireAttachmentUpload,
    ).toBe(true);
    expect(
      loadE2EEnv({ E2E_REQUIRE_ATTACHMENT_UPLOAD: "0" })
        .requireAttachmentUpload,
    ).toBe(false);
    expect(
      loadE2EEnv({ E2E_REQUIRE_ATTACHMENT_UPLOAD: "yes" })
        .requireAttachmentUpload,
    ).toBe(true);
  });
});

describe("credential skip helpers", () => {
  it("share smoke accepts share token or owner token", () => {
    expect(
      hasShareSmokeCredentials(
        loadE2EEnv({ E2E_SHARE_TOKEN: "tok" }),
      ),
    ).toBe(true);
    expect(
      hasShareSmokeCredentials(
        loadE2EEnv({ E2E_OWNER_ACCESS_TOKEN: "own" }),
      ),
    ).toBe(true);
    expect(hasShareSmokeCredentials(loadE2EEnv({}))).toBe(false);
    expect(shareSmokeSkipReason(loadE2EEnv({}))).toMatch(/E2E_SHARE_TOKEN/);
  });

  it("critical path requires owner token only", () => {
    expect(
      hasCriticalPathCredentials(
        loadE2EEnv({ E2E_SHARE_TOKEN: "tok" }),
      ),
    ).toBe(false);
    expect(
      hasCriticalPathCredentials(
        loadE2EEnv({ E2E_OWNER_ACCESS_TOKEN: "own" }),
      ),
    ).toBe(true);
    expect(criticalPathSkipReason(loadE2EEnv({}))).toMatch(
      /E2E_OWNER_ACCESS_TOKEN/,
    );
    expect(
      criticalPathSkipReason(
        loadE2EEnv({ E2E_OWNER_ACCESS_TOKEN: "own" }),
      ),
    ).toBeUndefined();
  });
});
