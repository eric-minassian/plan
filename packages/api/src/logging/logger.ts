import type { AuthClass } from "../http/types.js";

/**
 * Structured JSON logger — request id, route, auth class only.
 * Never log tokens, Authorization headers, or PII (email, nickname, etc.).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RequestLogFields {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly authClass: AuthClass;
  readonly status?: number;
  readonly durationMs?: number;
}

export interface Logger {
  readonly log: (
    level: LogLevel,
    message: string,
    fields?: Readonly<Record<string, string | number | boolean | undefined>>,
  ) => void;
  readonly request: (fields: RequestLogFields, message?: string) => void;
}

function write(
  level: LogLevel,
  message: string,
  fields: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  const line = JSON.stringify({
    level,
    message,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const consoleLogger: Logger = {
  log(level, message, fields = {}) {
    write(level, message, fields);
  },
  request(fields, message = "request") {
    write("info", message, {
      requestId: fields.requestId,
      method: fields.method,
      path: fields.path,
      authClass: fields.authClass,
      status: fields.status,
      durationMs: fields.durationMs,
    });
  },
};

/** Silent logger for unit tests. */
export const silentLogger: Logger = {
  log() {},
  request() {},
};
