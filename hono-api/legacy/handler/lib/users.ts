import {
  sql,
} from "./db.ts";

export const BOOL_FIELDS = [
  "verified",
  "can_manage_questions",
  "can_edit_surveys",
  "can_review_data",
  "can_verify_surveyors",
  "can_assign_surveyors",
  "can_crud_questionnaire",
  "can_validate_proof",
  "can_web_survey",
  "can_record_voice",
  "can_translate_telugu",
  "can_converse",
  "can_excel_charts",
] as const;

export const NUM_FIELDS = [
  "max_questions_per_survey",
  "max_surveys",
  "max_surveyors",
  "max_records",
  "max_categories",
  "converse_max_records",
  "converse_max_minutes",
  "max_sub_admins",
] as const;

export const USER_COLUMNS = [
  "u.id", "u.username", "u.display_name", "u.role", "u.active", "u.created_at",
  "u.company_id", "u.company_name", "u.key_id", "u.phone", "u.created_by", "u.pin_hash",
  ...BOOL_FIELDS.map((f) => `u.${f}`),
  ...NUM_FIELDS.map((f) => `u.${f}`),
].join(", ");

export type PortalUser = {
  id: unknown;
  username: string;
  name: string;
  role: string;
  active: unknown;
  created_at: unknown;
  company_id: number | null;
  company_name: string | null;
  key_id: string | null;
  phone: string | null;
  created_by: number | null;
} & Record<(typeof BOOL_FIELDS)[number], boolean> &
  Record<(typeof NUM_FIELDS)[number], number>;

// ── Session cache: token → user, 30s TTL ─────────────────
// Every authenticated request calls getUser(). On the VPS with local
// PostgreSQL this is <1ms, but on Deno Deploy / Neon HTTP each lookup
// is a network round-trip. Caching eliminates that.
const SESSION_CACHE_TTL_MS = 30_000;
const sessionCache = new Map<string, { user: PortalUser; expires: number }>();

/** Clear a cached session (call on logout, password change, user disable). */
export function invalidateSessionCache(token?: string): void {
  if (token) {
    sessionCache.delete(token);
  } else {
    sessionCache.clear();
  }
}

/** Periodically sweep expired entries so the Map doesn't grow unbounded. */
let lastSweep = 0;
function sweepCache(): void {
  const now = Date.now();
  if (now - lastSweep < 60_000) return; // sweep at most once per minute
  lastSweep = now;
  for (const [k, v] of sessionCache) {
    if (v.expires < now) sessionCache.delete(k);
  }
}

export async function getUser(token: string | null): Promise<PortalUser | null> {
  if (!token || !sql) return null;

  // Fast path: cached and still fresh
  const cached = sessionCache.get(token);
  if (cached && cached.expires > Date.now()) {
    return cached.user;
  }

  sweepCache();

  const rows = (await sql(
    `SELECT ${USER_COLUMNS}
     FROM app_sessions s
     JOIN app_users u ON u.id = s.user_id
     WHERE s.token = $1
       AND s.expires_at > NOW()
       AND u.active = TRUE
       AND u.role IN ('super_admin', 'admin', 'surveyor', 'sub_client_admin')
     LIMIT 1`,
    [token],
  ).catch((e: unknown) => {
    console.error("getUser session lookup failed:", (e as Error)?.message || e);
    return [];
  })) as Record<string, unknown>[];

  const u = rows[0];
  if (!u) return null;

  const me: Record<string, unknown> = {
    id: u.id,
    username: u.username,
    name: u.display_name || u.username,
    role: u.role,
    active: u.active,
    created_at: u.created_at,
    company_id: u.company_id != null ? Number(u.company_id) : null,
    company_name: u.company_name ? String(u.company_name) : null,
    key_id: u.key_id || null,
    phone: u.phone || null,
    created_by: u.created_by != null ? Number(u.created_by) : null,
  };
  for (const f of BOOL_FIELDS) me[f] = sqlBool(u[f]);
  me.has_pin = !!u.pin_hash;
  if (u.role === "admin" || u.role === "super_admin") {
    me.can_web_survey = true;
  }
  for (const f of NUM_FIELDS) me[f] = Number(u[f]) || 0;
  const user = me as PortalUser;

  // Cache the result
  sessionCache.set(token, { user, expires: Date.now() + SESSION_CACHE_TTL_MS });
  return user;
}

/** Portal roles: Client Admin + platform Super Admin (01-PRD.md §2). Super Admin has all admin powers.
 *  Sub Client Admins also use the admin portal, scoped to their parent's company. */
export function isPortalAdmin(role: unknown): boolean {
  return role === "admin" || role === "super_admin" || role === "sub_client_admin";
}

/**
 * Ownership anchor for tenant scoping. A Sub Client Admin operates inside the
 * Client Admin that created it: everything they touch belongs to the parent
 * (users they create get created_by = parent), so ownership predicates resolve
 * to the parent id. Sub admins also own nothing directly except their own row.
 */
export function effectiveAdminId(me: PortalUser | null | undefined): number | null {
  if (!me) return null;
  if (me.role === "sub_client_admin") return me.created_by ?? null;
  return typeof me.id === "number" ? me.id : Number(me.id) || null;
}

/** True for Client Admin + Sub Client Admin (delegated admin side). */
export function isClientSideAdmin(role: unknown): boolean {
  return role === "admin" || role === "sub_client_admin";
}

/** Coerce Postgres/JSON boolean-ish values (true | 't' | 'true' | 1). */
export function sqlBool(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "t" || s === "true" || s === "1" || s === "yes";
  }
  return false;
}

/**
 * Read COUNT(*) row from `const [row] = await sql\`SELECT COUNT(*)::int AS n …\``.
 * Must use row.n — treating the row as an array always yields 0 and breaks limits/UI.
 */
export function sqlCountN(row: unknown): number {
  if (row == null) return 0;
  if (typeof row === "object" && "n" in (row as object)) {
    const n = Number((row as { n?: unknown }).n);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

