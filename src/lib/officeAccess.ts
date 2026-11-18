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
  public_view: number;
}

/**
 * One place decides who may read an office, used by both the snapshot and the stream.
 *
 * Prefer durable member/share access so disabling public viewing affects only anonymous streams.
 */
export function resolveReadAccess(
  c: Context,
  db: Db,
  options: { slug?: string },
): ReadAccess {
  const shareToken = c.req.query("share") ?? bearerToken(c.req.header("authorization"));

  if (!options.slug) {
    // Legacy path: no slug, so a share link is the only way in.
    if (!shareToken) return { orgId: null, reason: "unauthorized" };
    const share = verifyShareToken(db, shareToken);
    return share ? { orgId: share.orgId, via: "share" } : { orgId: null, reason: "unauthorized" };
  }

  const office = db
    .prepare("SELECT id, slug, EXISTS(SELECT 1 FROM public_offices WHERE org_id=organizations.id) AS public_view FROM organizations WHERE slug = ? AND archived_at IS NULL")
    .get<OfficeRow>(options.slug);

  if (!office) return { orgId: null, reason: "not_found" };

  const session = sessionFromRequest(c, db);
  if (session?.orgId === office.id) return { orgId: office.id, via: "member" };

  if (shareToken) {
    const share = verifyShareToken(db, shareToken);
    if (share?.orgId === office.id) return { orgId: office.id, via: "share" };
  }

  return office.public_view ? { orgId: office.id, via: 'public' } : { orgId: null, reason: 'unauthorized' };
}
