import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createPlaceProvider } from "./create-place-provider.js";

describe("createPlaceProvider", () => {
  it("defaults to mock when enrichmentPlacesLive is false", () => {
    const provider = createPlaceProvider(
      loadConfig({ ENRICHMENT_PLACES_LIVE: "false" }),
    );
    expect(provider.name).toBe("mock");
    expect(provider.isLive).toBe(false);
  });

  it("selects MapTiler when enrichmentPlacesLive is true", () => {
    const provider = createPlaceProvider(
      loadConfig({ ENRICHMENT_PLACES_LIVE: "true" }),
    );
    expect(provider.name).toBe("maptiler");
    expect(provider.isLive).toBe(true);
  });

  it("defaults to mock when flag unset", () => {
    const provider = createPlaceProvider(loadConfig({}));
    expect(provider.name).toBe("mock");
    expect(provider.isLive).toBe(false);
  });
});
