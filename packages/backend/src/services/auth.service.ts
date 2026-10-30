import { getDb } from "../database/connection";
import type { Action, Resource, User } from "../types/user";
import { signToken } from "../utils/jwt";
import { verifyPassword } from "../utils/password";
import { ALL_ACTIONS, RESOURCES, roleAllows } from "../utils/permissions";

/**
 * The shared password check behind every sign-in path (web login and mobile
 * device sessions). Returns null for an unknown user and a wrong password
 * alike, so callers can't tell the two apart.
 */
export async function verifyCredentials(username: string, password: string): Promise<User | null> {
  const db = getDb();
  const user = db
    .query("SELECT * FROM users WHERE username = ? AND is_active = 1")
    .get(username) as User | null;

  if (!user) {
    return null;
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return null;
  }
  return user;
}

export async function login(username: string, password: string, tenantId?: string) {
  const user = await verifyCredentials(username, password);
  if (!user) {
    return null;
  }

  const token = await signToken({
    sub: user.id,
    username: user.username,
    is_admin: !!user.is_admin,
    tenant_id: tenantId,
  });

  // The same shape as GET /auth/me, so the app knows what to offer from the
  // first screen on.
  const current = getCurrentUser(user.id);
  if (!current) return null;
  return { token, user: current };
}

export function getCurrentUser(userId: string) {
  const db = getDb();
  const user = db
    .query(
      "SELECT id, username, email, display_name, is_admin, role FROM users WHERE id = ? AND is_active = 1",
    )
    .get(userId) as Omit<User, "password_hash" | "is_active" | "created_at" | "updated_at"> | null;

  if (!user) return null;

  const permissions = db
    .query("SELECT resource, action FROM user_permissions WHERE user_id = ?")
    .all(userId) as { resource: string; action: string }[];

  return {
    ...user,
    is_admin: !!user.is_admin,
    permissions,
    access: accessFor(!!user.is_admin, user.role, permissions),
  };
}

/**
 * What the user may do on each resource, by the rule requirePermission applies
 * (admins anything, others their role plus any legacy grant), so a client can
 * hide what the server would refuse. The server still checks every request.
 */
function accessFor(
  isAdmin: boolean,
  role: string | null,
  grants: { resource: string; action: string }[],
): Record<Resource, Action[]> {
  const allowed = (resource: Resource, action: Action) =>
    isAdmin ||
    roleAllows(role, resource, action) ||
    grants.some((g) => g.resource === resource && g.action === action);
  return Object.fromEntries(
    RESOURCES.map((resource) => [resource, ALL_ACTIONS.filter((a) => allowed(resource, a))]),
  ) as Record<Resource, Action[]>;
}
