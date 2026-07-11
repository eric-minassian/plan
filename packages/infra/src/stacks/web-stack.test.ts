import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  resolveWebDomain,
  SPA_ROUTER_FUNCTION_CODE,
} from "./web-stack.js";

describe("buildContentSecurityPolicy", () => {
  it("includes self, auth issuer, MapTiler, and docs bucket in connect-src", () => {
    const docsHost = "tripplan-docs.s3.us-east-1.amazonaws.com";
    const csp = buildContentSecurityPolicy(docsHost);

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob: https://*.maptiler.com");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("frame-src 'none'");

    const connect = csp
      .split("; ")
      .find((part) => part.startsWith("connect-src "));
    expect(connect).toBeDefined();
    expect(connect).toContain("'self'");
    expect(connect).toContain("https://auth.ericminassian.com");
    expect(connect).toContain("https://*.maptiler.com");
    expect(connect).toContain(`https://${docsHost}`);
  });

  it("strips an accidental scheme from the docs host", () => {
    const csp = buildContentSecurityPolicy(
      "https://bucket.s3.us-east-1.amazonaws.com",
    );
    expect(csp).toContain(
      "https://bucket.s3.us-east-1.amazonaws.com",
    );
    expect(csp).not.toContain("https://https://");
  });
});

describe("resolveWebDomain", () => {
  it("returns stage defaults when override is omitted", () => {
    expect(resolveWebDomain("prod", undefined)).toBe(
      "plan.ericminassian.com",
    );
    expect(resolveWebDomain("staging", undefined)).toBe(
      "plan-staging.ericminassian.com",
    );
    expect(resolveWebDomain("dev", undefined)).toBeUndefined();
  });

  it("treats empty override as no custom domain", () => {
    expect(resolveWebDomain("prod", "")).toBeUndefined();
    expect(resolveWebDomain("prod", "   ")).toBeUndefined();
  });

  it("accepts an explicit override hostname", () => {
    expect(resolveWebDomain("dev", "preview.example.com")).toBe(
      "preview.example.com",
    );
    expect(resolveWebDomain("prod", " plan.custom.com ")).toBe(
      "plan.custom.com",
    );
  });
});

describe("SPA_ROUTER_FUNCTION_CODE", () => {
  it("rewrites extension-less paths and leaves static files alone", () => {
    // Lightweight contract: function body must keep the SPA/API co-host rules.
    expect(SPA_ROUTER_FUNCTION_CODE).toContain('request.uri = "/index.html"');
    expect(SPA_ROUTER_FUNCTION_CODE).toContain('uri.indexOf(".")');
    expect(SPA_ROUTER_FUNCTION_CODE).toContain('uri !== "/"');
  });
});
