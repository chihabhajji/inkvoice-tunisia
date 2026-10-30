import type { PaginatedResponse } from "../../../backend/src/types/common";

export async function allBankingOptions<T>(
  fetchPage: (page: number) => Promise<{ data: PaginatedResponse<T> }>,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { data } = await fetchPage(page);
    items.push(...data.items);
    totalPages = data.totalPages;
    page++;
  } while (page <= totalPages);
  return items;
}
