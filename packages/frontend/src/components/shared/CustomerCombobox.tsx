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

interface CustomerOption {
  id: string;
  name: string;
  email?: string | null;
}

interface CustomerComboboxProps {
  customers: CustomerOption[];
  value: string;
  onChange: (id: string) => void;
  /** Called when the user chooses to create a new customer; receives the
   *  current search text so the customer-create page can pre-fill the name. */
  /** Omit when the user may not create a customer: the add entries are hidden. */
  onAddNew?: (search: string) => void;
  error?: boolean;
}

export function CustomerCombobox({
  customers,
  value,
  onChange,
  onAddNew,
  error,
}: CustomerComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = customers.find((c) => c.id === value);

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
          <Button
            type="button"
            variant="outline"
            aria-invalid={error}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected ? selected.name : t("invoices.select_customer")}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) min-w-72 p-0">
        <Command>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t("invoices.search_customer")}
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
                    ? t("invoices.add_customer_named", { name: search.trim() })
                    : t("invoices.add_new_customer")}
                </button>
              ) : (
                <span className="block px-2 py-1.5 text-sm text-muted-foreground">
                  {t("command.no_results")}
                </span>
              )}
            </CommandEmpty>
            <CommandGroup>
              {customers.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.id}
                  keywords={[c.name, c.email ?? ""].filter(Boolean) as string[]}
                  data-checked={value === c.id}
                  onSelect={() => {
                    onChange(c.id);
                    setOpen(false);
                  }}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{c.name}</span>
                    {c.email && (
                      <span className="truncate text-xs text-muted-foreground">{c.email}</span>
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
                {t("invoices.add_new_customer")}
              </button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
