import { Archive, ArchiveRestore, Download, Loader2, Upload, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCan } from "@/hooks/use-can";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";
import { formatCurrency, formatDate } from "@/lib/utils";

type Status = "inbox" | "processed" | "archived";

interface InboxItem {
  id: string;
  document_number: string | null;
  issue_date: string | null;
  supplier_name: string | null;
  supplier_vat_id: string | null;
  total: number | null;
  currency: string | null;
  file_name: string;
  status: Status;
  customer_id: string | null;
  parse_status: "pending" | "ok" | "error";
  parse_error: string | null;
  source?: string;
  transport_id?: string | null;
  provider_message_id?: string | null;
  sender_scheme?: string | null;
  sender_id?: string | null;
  created_at: string;
}

export default function Einvoices() {
  const { t } = useTranslation();
  // The inbox is covered by the invoices permission.
  const can = useCan();
  const canEdit = can("invoices", "update");
  const [tab, setTab] = useState<Status | "all">("all");
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listEinvoiceInbox(tab === "all" ? undefined : tab)
      .then((r) => {
        setItems(r.data || []);
        setLoading(false);
      })
      .catch((err) => {
        toast.error(formatApiError(err, t));
        setLoading(false);
      });
  }, [tab, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function upload(file: File) {
    setUploading(true);
    try {
      const r = await api.importEinvoiceFile(file);
      if (r.success) {
        toast.success(
          r.data?.duplicate ? t("einvoice.inbox_duplicate") : t("einvoice.inbox_imported"),
        );
        load();
      }
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function setStatus(item: InboxItem, status: Status) {
    try {
      await api.setEinvoiceInboxStatus(item.id, status);
      load();
    } catch (err) {
      toast.error(formatApiError(err, t));
    }
  }

  async function link(item: InboxItem) {
    const customerId = window.prompt(t("einvoice.link_prompt"));
    if (customerId === null) return;
    setLinkingId(item.id);
    try {
      await api.linkEinvoiceInbox(item.id, customerId.trim() || null);
      toast.success(t("einvoice.link_success"));
      load();
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setLinkingId(null);
    }
  }

  const counts = {
    all: items.length,
    inbox: items.filter((i) => i.status === "inbox").length,
    processed: items.filter((i) => i.status === "processed").length,
    archived: items.filter((i) => i.status === "archived").length,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("einvoice.title")}</h1>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xml,.pdf,application/xml,application/pdf"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          {can("invoices", "create") && (
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {t("einvoice.import")}
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-base">{t("einvoice.inbox_title")}</CardTitle>
          <Tabs value={tab} onValueChange={(v) => setTab(v as Status | "all")}>
            <TabsList>
              <TabsTrigger value="all">
                {t("einvoice.tab_all")} ({counts.all})
              </TabsTrigger>
              <TabsTrigger value="inbox">
                {t("einvoice.tab_inbox")} ({counts.inbox})
              </TabsTrigger>
              <TabsTrigger value="processed">
                {t("einvoice.tab_processed")} ({counts.processed})
              </TabsTrigger>
              <TabsTrigger value="archived">
                {t("einvoice.tab_archived")} ({counts.archived})
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="pt-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t("einvoice.loading")}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("einvoice.inbox_empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("einvoice.document_number")}</TableHead>
                  <TableHead>{t("einvoice.supplier")}</TableHead>
                  <TableHead>{t("einvoice.issue_date")}</TableHead>
                  <TableHead className="text-right">{t("einvoice.total")}</TableHead>
                  <TableHead>{t("einvoice.source")}</TableHead>
                  <TableHead>{t("einvoice.parse_status")}</TableHead>
                  <TableHead>{t("einvoice.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      {item.document_number || "—"}
                      <span className="block text-xs text-muted-foreground">{item.file_name}</span>
                    </TableCell>
                    <TableCell>
                      {item.supplier_name || "—"}
                      {item.supplier_vat_id && (
                        <span className="block text-xs text-muted-foreground">
                          {item.supplier_vat_id}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{item.issue_date ? formatDate(item.issue_date) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.total != null
                        ? formatCurrency(item.total, item.currency || "EUR")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {item.source === "peppol" ? (
                        <Badge
                          variant="outline"
                          className="text-blue-600 dark:text-blue-400"
                          title={
                            item.sender_id ? `${item.sender_scheme}:${item.sender_id}` : undefined
                          }
                        >
                          {t("einvoice.source_peppol")}
                        </Badge>
                      ) : item.source === "qonto" ? (
                        <Badge
                          variant="outline"
                          className="text-blue-600 dark:text-blue-400"
                          title={
                            item.sender_id ? `${item.sender_scheme}:${item.sender_id}` : undefined
                          }
                        >
                          {t("einvoice.source_qonto")}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">{t("einvoice.source_upload")}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.parse_status === "ok" ? (
                        <Badge variant="outline" className="text-green-600 dark:text-green-400">
                          {t("einvoice.parsed_ok")}
                        </Badge>
                      ) : item.parse_status === "error" ? (
                        <Badge variant="destructive">{t("einvoice.parsed_error")}</Badge>
                      ) : (
                        <Badge variant="secondary">{t("einvoice.parsed_pending")}</Badge>
                      )}
                      {item.parse_error && (
                        <span
                          className="block max-w-48 truncate text-xs text-muted-foreground"
                          title={item.parse_error}
                        >
                          {item.parse_error}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <a
                          href={api.downloadEinvoiceInboxRaw(item.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-input"
                          title={t("einvoice.download_raw")}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={t("einvoice.link_customer")}
                            onClick={() => link(item)}
                            disabled={linkingId === item.id}
                          >
                            <UserRound className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {!canEdit ? null : item.status === "archived" ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={t("einvoice.restore")}
                            onClick={() => setStatus(item, "inbox")}
                          >
                            <ArchiveRestore className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={t("einvoice.archive")}
                            onClick={() => setStatus(item, "archived")}
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {item.status === "inbox" && canEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setStatus(item, "processed")}
                          >
                            {t("einvoice.mark_processed")}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
