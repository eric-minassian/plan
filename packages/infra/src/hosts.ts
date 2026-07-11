import type { Stage } from "./stage.js";

/** Production SPA / public API host (CloudFront). */
export const PROD_SPA_DOMAIN = "plan.ericminassian.com";

/** Staging SPA / public API host (CloudFront). */
export const STAGING_SPA_DOMAIN = "plan-staging.ericminassian.com";

/** Local Vite dev server origin. */
export const LOCAL_VITE_ORIGIN = "http://localhost:5173";

/**
 * Stage-aware default SPA hostname (no scheme).
 * Override at WebStack via CDK context `webDomain` (empty string disables).
 */
export function defaultSpaDomain(stage: Stage): string | undefined {
  switch (stage) {
    case "prod":
      return PROD_SPA_DOMAIN;
    case "staging":
      return STAGING_SPA_DOMAIN;
    case "dev":
      return undefined;
  }
}

/**
 * HTTPS origin for the stage SPA host when a default domain exists.
 * Used for `PUBLIC_API_BASE_URL` (DPoP htu) and credentialed CORS.
 */
export function spaOriginForStage(stage: Stage): string | undefined {
  const domain = defaultSpaDomain(stage);
  return domain === undefined ? undefined : `https://${domain}`;
}

/**
 * API Gateway CORS allow-list for the SPA.
 * Prod/staging: stage SPA only (no localhost against non-dev APIs).
 * Dev: prod SPA + Vite for dogfood against a shared bucket/API shape.
 */
export function apiCorsOrigins(stage: Stage): string[] {
  const productionSpa = `https://${PROD_SPA_DOMAIN}`;
  switch (stage) {
    case "prod":
      return [productionSpa];
    case "staging": {
      const staging = spaOriginForStage("staging");
      return staging !== undefined ? [staging] : [productionSpa];
    }
    case "dev":
      return [productionSpa, LOCAL_VITE_ORIGIN];
  }
}

/**
 * S3 docs bucket CORS origins (presigned GET/PUT from browser).
 * Includes Vite on all stages for dogfood; staging adds the staging SPA host.
 */
export function docsCorsOrigins(stage: Stage): string[] {
  const productionSpa = `https://${PROD_SPA_DOMAIN}`;
  const stagingSpa = `https://${STAGING_SPA_DOMAIN}`;
  switch (stage) {
    case "prod":
      return [productionSpa, LOCAL_VITE_ORIGIN];
    case "staging":
      return [stagingSpa, productionSpa, LOCAL_VITE_ORIGIN];
    case "dev":
      return [productionSpa, LOCAL_VITE_ORIGIN];
  }
}
