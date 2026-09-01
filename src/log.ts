export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFieldValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogFieldValue>;

/**
 * Emit a structured JSON log line. Only correlated, non-sensitive fields may be
 * passed: request id, user id, grant id, organization id, route, outcome.
 * Never log tokens, codes, client secrets, or authorization headers.
 */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
