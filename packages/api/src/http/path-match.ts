/**
 * Simple route path matching with `:param` segments.
 * Exact segment match except `:name` captures one path segment.
 */

export interface PathMatch {
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Match a request path against a route pattern.
 * Returns params on success, undefined when no match.
 *
 * Patterns are absolute paths (e.g. `/api/v1/trips/:tripId/export`).
 */
export function matchPath(
  pattern: string,
  path: string,
): PathMatch | undefined {
  const patternParts = splitPath(pattern);
  const pathParts = splitPath(path);
  if (patternParts.length !== pathParts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const pp = patternParts[i];
    const vp = pathParts[i];
    if (pp === undefined || vp === undefined) {
      return undefined;
    }
    if (pp.startsWith(":")) {
      const name = pp.slice(1);
      if (name.length === 0 || vp.length === 0) {
        return undefined;
      }
      params[name] = decodeURIComponent(vp);
      continue;
    }
    if (pp !== vp) {
      return undefined;
    }
  }
  return { params };
}

function splitPath(path: string): string[] {
  const normalized =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (normalized === "/" || normalized.length === 0) {
    return [""];
  }
  return normalized.split("/");
}
