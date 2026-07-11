/**
 * Shared Playwright helpers for public share session browser checks.
 */

import { expect, type Page, type Response } from "@playwright/test";

export type CookieLike = {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
  path: string;
};

/**
 * Inject the capability secret into the hash before page scripts run so
 * `page.goto("/s")` never records the token in the navigation URL / action log.
 */
export async function openShareViewerWithToken(
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
    history.replaceState(null, "", `${path}#${encoded}`);
  }, token);

  await page.goto("/s");
}

export function shareCookieFrom(
  cookies: ReadonlyArray<CookieLike>,
): CookieLike | undefined {
  return cookies.find((c) => c.name === "tripplan_share");
}

export interface ShareSessionExpectations {
  /** Trip title heading when known. */
  readonly tripTitle?: string;
  /**
   * Item titles that must appear on the read-only timeline
   * (proves share DTO includes items, not only trip meta).
   */
  readonly itemTitles?: readonly string[];
  /** When true (default), assert leave share clears session. */
  readonly leaveShare?: boolean;
}

/**
 * Open share viewer, exchange session, assert cookie + read-only chrome,
 * optional item titles, and leave share.
 */
export async function assertShareSessionFlow(
  page: Page,
  token: string,
  expectations: ShareSessionExpectations = {},
): Promise<{
  readonly exchangeResponse: Response;
  readonly tripResponse: Response;
  readonly tripJson: unknown;
}> {
  const leaveShare = expectations.leaveShare ?? true;

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

  await openShareViewerWithToken(page, token);

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

  const tripJson: unknown = await tripResponse.json();

  // Hash cleared for hygiene after capture.
  await expect(page).toHaveURL(/\/s\/?$/);

  const shareCookie = shareCookieFrom(await page.context().cookies());
  expect(shareCookie, "tripplan_share cookie").toBeDefined();
  expect(shareCookie?.httpOnly).toBe(true);
  expect(shareCookie?.secure).toBe(true);
  expect(shareCookie?.sameSite).toBe("Lax");
  expect(shareCookie?.path).toBe("/");
  expect(shareCookie?.value.length ?? 0).toBeGreaterThan(0);

  await expect(page.getByText("Shared trip · read-only")).toBeVisible();
  await expect(
    page.getByText("Opening another shared trip switches your view", {
      exact: false,
    }),
  ).toBeVisible();

  if (expectations.tripTitle !== undefined) {
    await expect(
      page.getByRole("heading", {
        name: expectations.tripTitle,
        exact: true,
      }),
    ).toBeVisible();
  }

  await expect(
    page.getByRole("heading", { name: "Timeline", exact: true }),
  ).toBeVisible();

  // Owner edit chrome must not appear on the public share route.
  await expect(page.getByRole("button", { name: "+ Flight" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Note" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Share", exact: true }),
  ).toHaveCount(0);

  if (expectations.itemTitles !== undefined) {
    for (const title of expectations.itemTitles) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    }
  }

  if (leaveShare) {
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
  }

  return { exchangeResponse, tripResponse, tripJson };
}
