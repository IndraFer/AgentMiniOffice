import type { Context } from "hono";
import { bearerToken, verifyShareToken } from "./auth";
import type { Db } from "./db";
import { sessionFromRequest } from "./sessions";

export type ReadAccess =
  | { orgId: string; via: "public" | "member" | "share" }
  | { orgId: null; reason: "not_found" | "unauthorized" };

interface OfficeRow {
  id: string;
  slug: string;
}

/**
 * One place decides who may read an office, used by both the snapshot and the stream.
 *
 * Precedence: public slug, then membership by session, then a share link. Any of them is enough.
 */
export function resolveReadAccess(
  c: Context,
  db: Db,
  options: { slug?: string; publicSlugs?: string[] },
): ReadAccess {
  const shareToken = c.req.query("share") ?? bearerToken(c.req.header("authorization"));

  if (!options.slug) {
    // Legacy path: no slug, so a share link is the only way in.
    if (!shareToken) return { orgId: null, reason: "unauthorized" };
    const share = verifyShareToken(db, shareToken);
    return share ? { orgId: share.orgId, via: "share" } : { orgId: null, reason: "unauthorized" };
  }

  const office = db
    .prepare("SELECT id, slug FROM organizations WHERE slug = ? AND archived_at IS NULL")
    .get<OfficeRow>(options.slug);

  if (!office) return { orgId: null, reason: "not_found" };

  if ((options.publicSlugs ?? []).includes(office.slug)) {
    return { orgId: office.id, via: "public" };
  }

  const session = sessionFromRequest(c, db);
  if (session?.orgId === office.id) return { orgId: office.id, via: "member" };

  if (shareToken) {
    const share = verifyShareToken(db, shareToken);
    if (share?.orgId === office.id) return { orgId: office.id, via: "share" };
  }

  return { orgId: null, reason: "unauthorized" };
}
