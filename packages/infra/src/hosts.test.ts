import { describe, expect, it } from "vitest";
import {
  apiCorsOrigins,
  defaultSpaDomain,
  docsCorsOrigins,
  LOCAL_VITE_ORIGIN,
  spaOriginForStage,
} from "./hosts.js";

describe("defaultSpaDomain / spaOriginForStage", () => {
  it("aligns prod and staging public hosts", () => {
    expect(defaultSpaDomain("prod")).toBe("plan.ericminassian.com");
    expect(spaOriginForStage("prod")).toBe("https://plan.ericminassian.com");

    expect(defaultSpaDomain("staging")).toBe(
      "plan-staging.ericminassian.com",
    );
    expect(spaOriginForStage("staging")).toBe(
      "https://plan-staging.ericminassian.com",
    );

    expect(defaultSpaDomain("dev")).toBeUndefined();
    expect(spaOriginForStage("dev")).toBeUndefined();
  });
});

describe("apiCorsOrigins", () => {
  it("uses stage SPA only on prod/staging; Vite only on dev", () => {
    expect(apiCorsOrigins("prod")).toEqual([
      "https://plan.ericminassian.com",
    ]);
    expect(apiCorsOrigins("staging")).toEqual([
      "https://plan-staging.ericminassian.com",
    ]);
    expect(apiCorsOrigins("dev")).toEqual([
      "https://plan.ericminassian.com",
      LOCAL_VITE_ORIGIN,
    ]);
  });
});

describe("docsCorsOrigins", () => {
  it("includes staging SPA on staging stage", () => {
    expect(docsCorsOrigins("staging")).toContain(
      "https://plan-staging.ericminassian.com",
    );
    expect(docsCorsOrigins("staging")).toContain(LOCAL_VITE_ORIGIN);
  });
});
