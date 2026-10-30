import { ContactRound, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
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
import { useTranslation } from "@/i18n";
import { allBankingOptions } from "@/lib/banking-options";
import { formatApiError } from "@/lib/format-api-error";
import type { Bank, Contact } from "../../../backend/src/contracts/banking";

const emptyForm = {
  name: "",
  email: "",
  phone: "",
  bank_id: "",
};
export default function Contacts() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Contact[]>([]);
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
      const response = await api.listContacts(query);
      setRows(response.data.items);
      setTotalPages(response.data.totalPages);
      setError("");
    } catch (err) {
      setError(formatApiError(err, t));
    } finally {
      setLoading(false);
    }
  }, [page, archived, search, t]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (editing === undefined) return;
    allBankingOptions((p) => api.listBanks({ page: String(p), limit: "100", archived: "false" }))
      .then(setBanks)
      .catch((err) => setError(formatApiError(err, t)));
  }, [editing, t]);
  const field = (key: keyof typeof emptyForm, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const id = editing || undefined;
      await api.saveContact(
        {
          name: form.name,
          email: form.email,
          phone: form.phone,
          bank_id: form.bank_id || null,
        },
        id,
      );
      setEditing(undefined);
      toast.success(t("contacts.saved"));
      await load();
    } catch (err) {
      setError(formatApiError(err, t));
    } finally {
      setBusy(false);
    }
  };
  const archive = async (row: Contact) => {
    setBusy(true);
    try {
      await api.saveContact({ archived: !row.archived }, row.id);
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
          <h1 className="text-2xl font-bold tracking-tight">{t("contacts.title")}</h1>
        </div>
        <Button onClick={add}>
          <Plus className="h-4 w-4 mr-2" /> {t("contacts.add")}
        </Button>
      </div>
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-4">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label={t("common.search")}
            placeholder={t("contacts.search_placeholder")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <label htmlFor="contacts-archived" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="contacts-archived"
            checked={archived}
            onCheckedChange={(checked) => {
              setArchived(checked);
              setPage(1);
            }}
          />
          {t("contacts.archived")}
        </label>
      </div>
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="glass-table-wrapper">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("contacts.name")}</TableHead>
                <TableHead>{t("contacts.bank")}</TableHead>
                <TableHead>{t("contacts.email")}</TableHead>
                <TableHead>{t("contacts.phone")}</TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading || !rows.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="p-0">
                    {loading ? (
                      <p role="status" className="py-12 text-center text-muted-foreground">
                        {t("common.loading")}
                      </p>
                    ) : (
                      <EmptyState
                        icon={ContactRound}
                        title={t(
                          search || archived ? "contacts.no_results" : "contacts.empty_title",
                        )}
                        description={!search && !archived ? t("contacts.empty") : undefined}
                        actionLabel={!search && !archived ? t("contacts.add") : undefined}
                        onAction={add}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <p className="font-medium">{row.name}</p>
                    </TableCell>
                    <TableCell>{row.bank_name || "—"}</TableCell>
                    <TableCell>{row.email}</TableCell>
                    <TableCell>{row.phone}</TableCell>
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
                          {t(row.archived ? "contacts.restore" : "contacts.archive")}
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
      </div>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(undefined);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(editing ? "contacts.edit" : "contacts.add")}</DialogTitle>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <FormField label={t("contacts.name")} required>
              <Input required value={form.name} onChange={(e) => field("name", e.target.value)} />
            </FormField>
            <FormField label={t("contacts.bank")} hint={t("contacts.bank_hint")}>
              <select
                className="form-select"
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
            <FormField label={t("contacts.email")} required>
              <Input
                type="email"
                required
                value={form.email}
                onChange={(e) => field("email", e.target.value)}
              />
            </FormField>
            <FormField label={t("contacts.phone")}>
              <Input
                type="tel"
                value={form.phone}
                onChange={(e) => field("phone", e.target.value)}
              />
            </FormField>
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
