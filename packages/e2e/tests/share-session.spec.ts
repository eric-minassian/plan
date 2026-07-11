import { expect, test, type Page } from "@playwright/test";
import {
  loadE2EEnv,
  shareSmokeSkipReason,
} from "../src/env.js";
import { resolveShareFixture } from "../src/seed.js";

/**
 * Share session smoke: hash fragment → POST /share/session → HttpOnly cookie →
 * read-only ShareViewerPage timeline.
 *
 * Avoids owner passkeys by seeding via API (Bearer) or a pre-provisioned token.
 */
const env = loadE2EEnv();
const skipReason = shareSmokeSkipReason(env);

/**
 * Inject the capability secret into the hash before page scripts run so
 * `page.goto("/s")` never records the token in the navigation URL / action log.
 */
async function openShareViewerWithToken(
  page: Page,
  token: string,
): Promise<void> {
  await page.addInitScript((rawToken: string) => {
    const path = window.location.pathname;
    if (path !== "/s" && path !== "/s/") {
      return;
    }
    // history.replaceState keeps the secret out of a second navigation event.
    const encoded = encodeURIComponent(rawToken);
    history.replaceState(
      null,
      "",
      `${path}#${encoded}`,
    );
  }, token);

  await page.goto("/s");
}

function shareCookieFrom(
  cookies: ReadonlyArray<{
    name: string;
    value: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
    path: string;
  }>,
) {
  return cookies.find((c) => c.name === "tripplan_share");
}

test.describe("share session smoke", () => {
  // Skip at suite level so Playwright does not launch a browser without secrets.
  test.skip(skipReason !== undefined, skipReason ?? "");

  test("exchanges share link and shows read-only trip", async ({ page }) => {
    const fixture = await resolveShareFixture(env);
    if (fixture === undefined) {
      test.skip(true, shareSmokeSkipReason(env) ?? "No share fixture");
      return;
    }

    try {
      const exchangeResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/v1/share/session") &&
          response.request().method() === "POST",
      );
      const tripResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/v1/share/trip") &&
          response.request().method() === "GET",
      );

      await openShareViewerWithToken(page, fixture.token);

      const exchangeResponse = await exchangeResponsePromise;
      expect(
        exchangeResponse.status(),
        "POST /share/session should establish cookie session",
      ).toBe(204);

      const tripResponse = await tripResponsePromise;
      expect(
        tripResponse.status(),
        "GET /share/trip should succeed with session cookie",
      ).toBe(200);

      // Hash cleared for hygiene after capture (success or failure paths).
      await expect(page).toHaveURL(/\/s\/?$/);

      const shareCookie = shareCookieFrom(await page.context().cookies());
      expect(shareCookie, "tripplan_share cookie").toBeDefined();
      expect(shareCookie?.httpOnly).toBe(true);
      expect(shareCookie?.secure).toBe(true);
      expect(shareCookie?.sameSite).toBe("Lax");
      expect(shareCookie?.path).toBe("/");
      expect(shareCookie?.value.length ?? 0).toBeGreaterThan(0);

      await expect(
        page.getByText("Shared trip · read-only"),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Opening another shared trip switches your view",
          { exact: false },
        ),
      ).toBeVisible();

      if (fixture.title !== undefined) {
        await expect(
          page.getByRole("heading", { name: fixture.title, exact: true }),
        ).toBeVisible();
      }

      await expect(
        page.getByRole("heading", { name: "Timeline", exact: true }),
      ).toBeVisible();

      // Owner edit chrome must not appear on the public share route.
      await expect(page.getByRole("button", { name: "+ Flight" })).toHaveCount(
        0,
      );
      await expect(page.getByRole("button", { name: "+ Note" })).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Share", exact: true }),
      ).toHaveCount(0);

      // Leave share: DELETE /share/session 204 + cookie cleared + UI banner.
      const clearResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/v1/share/session") &&
          response.request().method() === "DELETE",
      );
      await page.getByRole("button", { name: "Leave share" }).click();
      const clearResponse = await clearResponsePromise;
      expect(
        clearResponse.status(),
        "DELETE /share/session should clear server session",
      ).toBe(204);

      await expect(
        page.getByText("Share session cleared on this device."),
      ).toBeVisible();

      const afterLeave = shareCookieFrom(await page.context().cookies());
      expect(
        afterLeave === undefined || afterLeave.value.length === 0,
        "tripplan_share cookie should be cleared after leave",
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
