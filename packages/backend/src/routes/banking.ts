import { Hono } from "hono";
import { z } from "zod";
import { accountInput, bankInput, contactInput } from "../contracts/banking";
import { requirePermission } from "../middleware/auth";
import {
  getBankingRecord,
  listBanking,
  saveAccount,
  saveBank,
  saveContact,
} from "../services/banking.service";

const pageInput = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  archived: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  currency: z.string().toUpperCase().optional(),
  bank_id: z.string().optional(),
  search: z.string().max(200).optional(),
});
// Reading these directories is required for invoice account/recipient selection; writes remain settings-only.
export const banks = new Hono();
export const bankAccounts = new Hono();
export const contacts = new Hono();
for (const [router, collection] of [
  [banks, "banks"],
  [bankAccounts, "bank_accounts"],
  [contacts, "contacts"],
] as const) {
  router.get("/", requirePermission("invoices", "read"), (c) =>
    c.json({ success: true, data: listBanking(collection, pageInput.parse(c.req.query())) }),
  );
  router.get("/:id", requirePermission("invoices", "read"), (c) =>
    c.json({ success: true, data: getBankingRecord(collection, c.req.param("id")) }),
  );
}
banks.post("/", requirePermission("settings", "update"), async (c) =>
  c.json({ success: true, data: saveBank(bankInput.parse(await c.req.json())) }, 201),
);
banks.patch("/:id", requirePermission("settings", "update"), async (c) => {
  const id = c.req.param("id");
  return c.json({
    success: true,
    data: saveBank(
      bankInput.parse({
        ...getBankingRecord("banks", id),
        ...bankInput.partial().parse(await c.req.json()),
      }),
      id,
    ),
  });
});
bankAccounts.post("/", requirePermission("settings", "update"), async (c) =>
  c.json({ success: true, data: saveAccount(accountInput.parse(await c.req.json())) }, 201),
);
bankAccounts.patch("/:id", requirePermission("settings", "update"), async (c) => {
  const id = c.req.param("id");
  return c.json({
    success: true,
    data: saveAccount(
      accountInput.parse({
        ...getBankingRecord("bank_accounts", id),
        ...accountInput.partial().parse(await c.req.json()),
      }),
      id,
    ),
  });
});
contacts.post("/", requirePermission("settings", "update"), async (c) =>
  c.json({ success: true, data: saveContact(contactInput.parse(await c.req.json())) }, 201),
);
contacts.patch("/:id", requirePermission("settings", "update"), async (c) => {
  const id = c.req.param("id");
  return c.json({
    success: true,
    data: saveContact(
      contactInput.parse({
        ...getBankingRecord("contacts", id),
        ...contactInput.partial().parse(await c.req.json()),
      }),
      id,
    ),
  });
});
