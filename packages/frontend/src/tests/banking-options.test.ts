import { expect, test } from "bun:test";
import { allBankingOptions } from "../lib/banking-options";

test("account and contact selectors include every page", async () => {
  const requested: number[] = [];
  const items = await allBankingOptions(async (page) => {
    requested.push(page);
    return { data: { items: [page], page, limit: 1, total: 3, totalPages: 3 } };
  });
  expect(requested).toEqual([1, 2, 3]);
  expect(items).toEqual([1, 2, 3]);
});

test("failed page loading is surfaced instead of showing an incomplete directory", async () => {
  await expect(
    allBankingOptions(async () => {
      throw new Error("Unavailable");
    }),
  ).rejects.toThrow("Unavailable");
});
