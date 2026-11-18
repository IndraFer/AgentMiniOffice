import { bearerToken, verifyShareToken } from "./auth";
import type { Db } from "./db";

/**
 * Read access never comes from an agent token. Only a share link, which is read only, scoped to
 * one organization, expiring, and revocable.
 */
export function authorizeShare(
  db: Db,
  header: string | undefined,
  query: string | undefined,
): string | null {
  const token = query ?? bearerToken(header);
  if (!token) return null;
  return verifyShareToken(db, token)?.orgId ?? null;
}
