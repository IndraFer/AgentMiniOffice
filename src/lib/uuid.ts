import { randomBytes } from "node:crypto";

/**
 * UUIDv7, time ordered, generated in the application layer because SQLite has no native
 * generator.
 *
 * Honest caveat: two ids created in the same millisecond are not guaranteed to sort
 * against each other, because the tail is random. Timelines are ordered by received_at
 * then id, never by id alone.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(now);

  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: unknown): value is string {
  return typeof value === "string" && UUIDV7_PATTERN.test(value);
}
