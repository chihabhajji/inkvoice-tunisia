import { useCallback } from "react";
import { useAuthStore } from "@/stores/auth.store";

export type Resource =
  | "invoices"
  | "customers"
  | "products"
  | "expenses"
  | "templates"
  | "settings"
  | "tax_definitions"
  | "users";
export type Action = "read" | "create" | "update" | "delete" | "publish" | "void" | "export";

interface AccessUser {
  is_admin: boolean;
  access?: Partial<Record<string, string[]>>;
}

/**
 * Whether the user may do `action` on `resource`, as the server reported it in
 * the `access` map on sign-in and GET /auth/me. This only decides which
 * controls the app shows: the server checks every request itself. Quotes and
 * recurring invoices count as "invoices", reminder rules as "settings".
 */
export function canUser(user: AccessUser | null, resource: Resource, action: Action): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  // A server too old to send `access` still enforces roles. Offer everything
  // rather than nothing, as before.
  if (!user.access) return true;
  return user.access[resource]?.includes(action) ?? false;
}

/** `canUser` for the signed-in user. */
export function useCan(): (resource: Resource, action: Action) => boolean {
  const user = useAuthStore((s) => s.user);
  return useCallback(
    (resource: Resource, action: Action) => canUser(user, resource, action),
    [user],
  );
}
