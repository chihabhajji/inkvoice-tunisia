import { Landmark, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { CurrencyCombobox } from "@/components/shared/CurrencyCombobox";
import { EmptyState } from "@/components/shared/EmptyState";
import { FormField } from "@/components/shared/FormField";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/i18n";
import { allBankingOptions } from "@/lib/banking-options";
import { formatApiError } from "@/lib/format-api-error";
import type { Bank, BankAccount } from "../../../backend/src/contracts/banking";

type Section = "accounts" | "banks";
const emptyForm = {
  name: "",
  branch: "",
  bank_id: "",
  label: "",
  holder: "",
  currency: "TND",
  account_number: "",
  iban: "",
  bic: "",
  instructions: "",
  is_default: false,
};
export default function Banking() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("accounts");
  const [rows, setRows] = useState<(Bank | BankAccount)[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = { page: String(page), archived: String(archived), search };
      const response =
        section === "accounts" ? await api.listBankAccounts(query) : await api.listBanks(query);
      setRows(response.data.items);
      setTotalPages(response.data.totalPages);
      setError("");
    } catch (err) {
      setError(formatApiError(err, t));
    } finally {
      setLoading(false);
    }
  }, [section, page, archived, search, t]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (editing === undefined) return;
    allBankingOptions((p) => api.listBanks({ page: String(p), limit: "100", archived: "false" }))
      .then(setBanks)
      .catch((err) => setError(formatApiError(err, t)));
  }, [editing, t]);
  const field = (key: keyof typeof emptyForm, value: string | boolean) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const id = editing || undefined;
      if (section === "banks") await api.saveBank({ name: form.name, branch: form.branch }, id);
      if (section === "accounts")
        await api.saveBankAccount(
          {
            bank_id: form.bank_id,
            label: form.label,
            holder: form.holder,
            currency: form.currency,
            account_number: form.account_number,
            iban: form.iban,
            bic: form.bic,
            instructions: form.instructions,
            is_default: form.is_default,
          },
          id,
        );
      setEditing(undefined);
      toast.success(t("banking.saved"));
      await load();
    } catch (err) {
      setError(formatApiError(err, t));
    } finally {
      setBusy(false);
    }
  };
  const archive = async (row: Bank | BankAccount) => {
    setBusy(true);
    try {
      if (section === "accounts") await api.saveBankAccount({ archived: !row.archived }, row.id);
      else await api.saveBank({ archived: !row.archived }, row.id);
      await load();
    } catch (err) {
      setError(formatApiError(err, t));
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    setForm(emptyForm);
    setEditing(null);
    setError("");
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("banking.title")}</h1>
        </div>
        <Button onClick={add}>
          <Plus className="h-4 w-4 mr-2" /> {t("banking.add")}
        </Button>
      </div>
      <Tabs
        value={section}
        onValueChange={(value) => {
          setSection(value as Section);
          setPage(1);
        }}
        className="gap-4"
      >
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-4">
          <TabsList>
            {(["accounts", "banks"] as const).map((value) => (
              <TabsTrigger key={value} value={value}>
                {t(`banking.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              aria-label={t("common.search")}
              placeholder={t(`banking.search_${section}`)}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <label htmlFor="banking-archived" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="banking-archived"
              checked={archived}
              onCheckedChange={(checked) => {
                setArchived(checked);
                setPage(1);
              }}
            />
            {t("banking.archived")}
          </label>
        </div>
        <TabsContent value={section} className="flex flex-col gap-4">
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="glass-table-wrapper">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t(section === "accounts" ? "banking.label" : "banking.name")}
                  </TableHead>
                  <TableHead>
                    {t(section === "accounts" ? "banking.bank" : "banking.branch")}
                  </TableHead>
                  {section !== "banks" && <TableHead>{t("banking.account_number")}</TableHead>}
                  <TableHead className="text-right">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading || !rows.length ? (
                  <TableRow>
                    <TableCell colSpan={section === "banks" ? 3 : 4} className="p-0">
                      {loading ? (
                        <p role="status" className="py-12 text-center text-muted-foreground">
                          {t("common.loading")}
                        </p>
                      ) : (
                        <EmptyState
                          icon={Landmark}
                          title={t(
                            search || archived ? "banking.no_results" : `banking.empty_${section}`,
                          )}
                          description={!search && !archived ? t("banking.empty") : undefined}
                          actionLabel={!search && !archived ? t("banking.add") : undefined}
                          onAction={add}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <p className="font-medium">{"label" in row ? row.label : row.name}</p>
                        {"holder" in row && (
                          <p className="text-xs text-muted-foreground">{row.holder}</p>
                        )}
                      </TableCell>
                      <TableCell>
                        {"currency" in row ? (
                          <>
                            {row.bank_name} · {row.currency}
                            {row.is_default ? ` · ${t("banking.default")}` : ""}
                          </>
                        ) : (
                          row.branch
                        )}
                      </TableCell>
                      {"currency" in row ? (
                        <TableCell className="font-mono">
                          {row.account_number || row.iban}
                        </TableCell>
                      ) : null}
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setForm({
                                ...emptyForm,
                                ...row,
                                bank_id: "bank_id" in row ? row.bank_id || "" : "",
                              });
                              setEditing(row.id);
                              setError("");
                            }}
                          >
                            {t("common.edit")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void archive(row)}
                          >
                            {t(row.archived ? "banking.restore" : "banking.archive")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {totalPages > 1 && (
            <div className="flex justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => p - 1)}
              >
                {t("common.previous")}
              </Button>
              <span className="text-sm py-2 text-muted-foreground tabular-nums">
                {t("common.page_of", { page: String(page), total: String(totalPages) })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("common.next")}
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(undefined);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(`banking.${section}`)}</DialogTitle>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            {section !== "accounts" && (
              <FormField label={t("banking.name")} required>
                <Input required value={form.name} onChange={(e) => field("name", e.target.value)} />
              </FormField>
            )}
            {section === "banks" && (
              <FormField label={t("banking.branch")}>
                <Input value={form.branch} onChange={(e) => field("branch", e.target.value)} />
              </FormField>
            )}
            {section === "accounts" && (
              <FormField
                label={t("banking.bank")}
                hint={t("banking.bank_first")}
                required={section === "accounts"}
              >
                <select
                  className="form-select"
                  required={section === "accounts"}
                  value={form.bank_id}
                  onChange={(e) => field("bank_id", e.target.value)}
                >
                  <option value="">{t("common.none")}</option>
                  {banks.map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.name}
                    </option>
                  ))}
                </select>
              </FormField>
            )}
            {section === "accounts" && (
              <>
                <FormField label={t("banking.label")} required>
                  <Input
                    required
                    value={form.label}
                    onChange={(e) => field("label", e.target.value)}
                  />
                </FormField>
                <FormField label={t("banking.holder")} required>
                  <Input
                    required
                    value={form.holder}
                    onChange={(e) => field("holder", e.target.value)}
                  />
                </FormField>
                <FormField label={t("banking.currency")}>
                  <CurrencyCombobox
                    value={form.currency}
                    onChange={(code) => field("currency", code)}
                  />
                </FormField>
                <FormField label={t("banking.account_number")}>
                  <Input
                    value={form.account_number}
                    onChange={(e) => field("account_number", e.target.value)}
                  />
                </FormField>
                <FormField label="IBAN">
                  <Input value={form.iban} onChange={(e) => field("iban", e.target.value)} />
                </FormField>
                <FormField label="BIC / SWIFT">
                  <Input value={form.bic} onChange={(e) => field("bic", e.target.value)} />
                </FormField>
                <FormField label={t("banking.instructions")}>
                  <Textarea
                    value={form.instructions}
                    onChange={(e) => field("instructions", e.target.value)}
                  />
                </FormField>
                <label htmlFor="banking-default" className="flex gap-2 items-center text-sm">
                  <Checkbox
                    id="banking-default"
                    checked={form.is_default}
                    onCheckedChange={(checked) => field("is_default", checked)}
                  />
                  {t("banking.default_hint")}
                </label>
              </>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {t("common.save")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
