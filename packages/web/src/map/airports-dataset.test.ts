import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Keep monorepo source of truth and SPA public copy in sync.
 * PR 11 may expand the dataset — both paths must stay identical until a
 * build-time copy step replaces this check.
 */
describe("airports dataset copies", () => {
  it("matches data/airports/v1.json and public/data/airports/v1.json", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "../../../../");
    const source = readFileSync(
      resolve(root, "data/airports/v1.json"),
      "utf8",
    );
    const publicCopy = readFileSync(
      resolve(root, "packages/web/public/data/airports/v1.json"),
      "utf8",
    );
    expect(publicCopy).toBe(source);
  });
});
