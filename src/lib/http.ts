import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { uuidv7 } from "./uuid";

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "payload_too_large"
  | "unsupported_type"
  | "unknown_room"
  | "invalid_seq"
  | "content_rejected"
  | "lease_held"
  | "lease_expired"
  | "inbox_full"
  | "validation_failed"
  | "internal";

export function fail(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
): Response {
  return c.json({ error: { code, message, request_id: uuidv7() } }, status);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) : null;
}
