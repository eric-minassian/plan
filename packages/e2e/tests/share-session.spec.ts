import { expect, test } from "@playwright/test";
import {
  loadE2EEnv,
  shareSmokeSkipReason,
} from "../src/env.js";
import { resolveShareFixture } from "../src/seed.js";
import { assertShareSessionFlow } from "../src/share-browser.js";

/**
 * Share session smoke: hash fragment → POST /share/session → HttpOnly cookie →
 * read-only ShareViewerPage timeline.
 *
 * Avoids owner passkeys by seeding via API (Bearer) or a pre-provisioned token.
 */
const env = loadE2EEnv();
const skipReason = shareSmokeSkipReason(env);

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
      const itemTitles =
        fixture.noteTitle !== undefined ? [fixture.noteTitle] : undefined;

      const { tripJson } = await assertShareSessionFlow(page, fixture.token, {
        tripTitle: fixture.title,
        itemTitles,
        leaveShare: true,
      });

      // When we seeded a note, response items must include it (not meta-only).
      if (fixture.noteTitle !== undefined) {
        const body = tripJson as {
          items?: readonly { title?: string }[];
        };
        expect(Array.isArray(body.items), "share trip items array").toBe(true);
        expect(
          body.items?.some((item) => item.title === fixture.noteTitle),
          `share trip items include note "${fixture.noteTitle}"`,
        ).toBe(true);
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
