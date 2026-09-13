import type { JsonValue } from "./types.js";

/** Serializes a domain JSON value for a MySQL JSON bind parameter. */
export function serializeJson(value: JsonValue | null): string | null {
  return value === null ? null : JSON.stringify(value);
}
