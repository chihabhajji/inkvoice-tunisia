// What the app offers follows the `access` map the server sends with the user.

import { describe, expect, test } from "bun:test";
import { canUser } from "@/hooks/use-can";

const viewer = {
  is_admin: false,
  access: {
    invoices: ["read", "export"],
    customers: ["read", "export"],
    templates: ["read"],
    users: [],
  },
};

describe("canUser", () => {
  test("follows the access map", () => {
    expect(canUser(viewer, "invoices", "read")).toBe(true);
    expect(canUser(viewer, "invoices", "export")).toBe(true);
    expect(canUser(viewer, "invoices", "create")).toBe(false);
    expect(canUser(viewer, "customers", "delete")).toBe(false);
    expect(canUser(viewer, "users", "read")).toBe(false);
  });

  test("a resource the map leaves out is not allowed", () => {
    expect(canUser(viewer, "expenses", "read")).toBe(false);
  });

  test("admins may do everything, signed-out users nothing", () => {
    expect(canUser({ is_admin: true, access: {} }, "invoices", "delete")).toBe(true);
    expect(canUser(null, "invoices", "read")).toBe(false);
  });

  test("a server that sends no map keeps every control", () => {
    expect(canUser({ is_admin: false }, "invoices", "delete")).toBe(true);
  });
});
