import type { DatabaseDateTime } from "@araucaria/database";

/** Formats application-clock instants for MySQL DATETIME(6) UTC columns. */
export function formatUtcDateTime(value: Date): DatabaseDateTime {
  const part = (number: number, width = 2) =>
    String(number).padStart(width, "0");
  return `${part(value.getUTCFullYear(), 4)}-${part(value.getUTCMonth() + 1)}-${part(value.getUTCDate())} ${part(value.getUTCHours())}:${part(value.getUTCMinutes())}:${part(value.getUTCSeconds())}.${part(value.getUTCMilliseconds(), 3)}000`;
}

export function systemUtcDateTime(): DatabaseDateTime {
  return formatUtcDateTime(new Date());
}

export function addUtcMilliseconds(
  value: DatabaseDateTime,
  milliseconds: number,
): DatabaseDateTime {
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(
      "UTC duration must be a safe integer number of milliseconds.",
    );
  }
  const timestamp = parseUtcDateTime(value);
  timestamp.setTime(timestamp.getTime() + milliseconds);
  return formatUtcDateTime(timestamp);
}

export function addUtcSeconds(
  value: DatabaseDateTime,
  seconds: number,
): DatabaseDateTime {
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("UTC duration must be a safe integer number of seconds.");
  }
  return addUtcMilliseconds(value, seconds * 1_000);
}

function parseUtcDateTime(value: DatabaseDateTime): Date {
  const timestamp = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(
      "Application clock must return a UTC MySQL datetime string.",
    );
  }
  return timestamp;
}
