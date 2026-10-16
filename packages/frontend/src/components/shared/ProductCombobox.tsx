import { ChevronsUpDown, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

interface ProductOption {
  id: string;
  name: string;
  sku?: string | null;
}

interface ProductComboboxProps {
  products: ProductOption[];
  value: string;
  onChange: (id: string) => void;
  /** Called when the user chooses to create a new product or service; receives
   *  the current search text so the product-create page can pre-fill the name. */
  /** Omit when the user may not create a product: the add entries are hidden. */
  onAddNew?: (search: string) => void;
}

export function ProductCombobox({ products, value, onChange, onAddNew }: ProductComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = products.find((p) => p.id === value);

  const handleAddNew = () => {
    setOpen(false);
    onAddNew?.(search.trim());
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch("");
      }}
    >
      <PopoverTrigger
        render={
          <Button type="button" variant="outline" className="w-full justify-between font-normal" />
        }
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected ? selected.name : t("invoices.manual_entry")}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) min-w-72 p-0">
        <Command>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t("invoices.search_product")}
          />
          <CommandList>
            <CommandEmpty>
              {onAddNew ? (
                <button
                  type="button"
                  onClick={handleAddNew}
                  className="flex w-full items-center justify-center gap-1.5 px-2 py-1.5 text-sm text-primary hover:underline"
                >
                  <Plus className="h-4 w-4" />
                  {search.trim()
                    ? t("invoices.add_product_named", { name: search.trim() })
                    : t("invoices.add_new_product")}
                </button>
              ) : (
                <span className="block px-2 py-1.5 text-sm text-muted-foreground">
                  {t("command.no_results")}
                </span>
              )}
            </CommandEmpty>
            <CommandGroup>
              {products.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  keywords={[p.name, p.sku ?? ""].filter(Boolean) as string[]}
                  data-checked={value === p.id}
                  onSelect={() => {
                    onChange(p.id);
                    setOpen(false);
                  }}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{p.name}</span>
                    {p.sku && (
                      <span className="truncate text-xs text-muted-foreground">{p.sku}</span>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {onAddNew && (
            <div className="border-t p-1">
              <button
                type="button"
                onClick={handleAddNew}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-primary hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                {t("invoices.add_new_product")}
              </button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
