import { Ban, Loader2, RefreshCw, RotateCcw, Send, Share2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCan } from "@/hooks/use-can";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";
import { formatDate } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings.store";

interface Props {
  invoiceId: string;
}

interface Transmission {
  id: string;
  transport_id: string;
  document_type: string;
  status: "queued" | "sending" | "sent" | "delivered" | "rejected" | "failed";
  status_detail: string | null;
  provider_message_id: string | null;
  attempt_count: number;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
}

interface Attempt {
  id: string;
  attempt_number: number;
  status_code: number | null;
  error_message: string | null;
  response_body: string | null;
  created_at: string;
}

const STATUS_STYLES: Record<Transmission["status"], string> = {
  queued: "bg-muted text-muted-foreground",
  sending: "bg-blue-600/10 text-blue-600 dark:text-blue-400",
  sent: "bg-amber-600/10 text-amber-600 dark:text-amber-400",
  delivered: "bg-green-600/10 text-green-600 dark:text-green-400",
  rejected: "bg-red-600/10 text-red-600 dark:text-red-400",
  failed: "bg-red-600/10 text-red-600 dark:text-red-400",
};

function TransmissionPanel({ invoiceId }: Props) {
  const { t } = useTranslation();
  // Sending, retrying and cancelling all hand the invoice to the network.
  const canSend = useCan()("invoices", "publish");
  const settings = useSettingsStore((s) => s.settings);
  const networkLabel = settings.peppol_enabled === "true" ? "PEPPOL" : "France (Qonto)";
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [attempts, setAttempts] = useState<Record<string, Attempt[]>>({});
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listEinvoiceTransmissions(invoiceId)
      .then((r) => {
        setTransmissions(r.data?.transmissions || []);
        setAttempts(r.data?.attempts || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [invoiceId]);

  useEffect(() => {
    load();
  }, [load]);

  async function transmit() {
    setSending(true);
    try {
      const r = await api.transmitEinvoice(invoiceId);
      toast.success(t("peppol.transmit_queued"));
      if (r.data?.transmission_id) load();
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setSending(false);
    }
  }

  async function retry(transmissionId: string) {
    setBusyId(transmissionId);
    try {
      await api.retryEinvoiceTransmission(transmissionId);
      toast.success(t("peppol.retry_scheduled"));
      load();
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(transmissionId: string) {
    setBusyId(transmissionId);
    try {
      await api.cancelEinvoiceTransmission(transmissionId);
      toast.success(t("peppol.cancel_done"));
      load();
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Share2 className="h-4 w-4" /> {t("peppol.transmission_panel", { network: networkLabel })}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          {canSend && (
            <Button size="sm" onClick={transmit} disabled={sending}>
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {t("peppol.send_via_network", { network: networkLabel })}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">{t("einvoice.loading")}</p>
        ) : transmissions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("peppol.no_transmissions", { network: networkLabel })}
          </p>
        ) : (
          <ul className="space-y-4">
            {transmissions.map((tr) => (
              <li key={tr.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={STATUS_STYLES[tr.status]}>
                    {t(`peppol.status_${tr.status}`)}
                  </Badge>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t("peppol.created_at")}: {formatDate(tr.created_at)}
                  </span>
                  {tr.sent_at && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t("peppol.sent_at")}: {formatDate(tr.sent_at)}
                    </span>
                  )}
                  {tr.delivered_at && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t("peppol.delivered_at")}: {formatDate(tr.delivered_at)}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {t("peppol.attempts", { count: String(tr.attempt_count) })}
                  </span>
                  {tr.status === "failed" && canSend && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-xs ml-auto"
                      disabled={busyId === tr.id}
                      onClick={() => retry(tr.id)}
                    >
                      {busyId === tr.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      {t("peppol.retry")}
                    </Button>
                  )}
                  {tr.status === "queued" && canSend && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs ml-auto"
                      disabled={busyId === tr.id}
                      onClick={() => cancel(tr.id)}
                    >
                      {busyId === tr.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Ban className="h-3 w-3" />
                      )}
                      {t("peppol.cancel")}
                    </Button>
                  )}
                </div>
                {tr.status_detail && (
                  <p className="text-xs text-muted-foreground">{tr.status_detail}</p>
                )}
                {tr.provider_message_id && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {t("peppol.provider_message_id")}: {tr.provider_message_id}
                  </p>
                )}
                {(attempts[tr.id] || []).length > 0 && (
                  <div className="space-y-1 border-t pt-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("peppol.attempt_history")}
                    </p>
                    {(attempts[tr.id] || []).map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground tabular-nums">
                          #{a.attempt_number}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatDate(a.created_at)}
                        </span>
                        {a.status_code ? (
                          <Badge variant="outline" className="tabular-nums">
                            HTTP {a.status_code}
                          </Badge>
                        ) : a.error_message ? (
                          <Badge variant="destructive">
                            <XCircle className="h-3 w-3" />
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="tabular-nums">
                            202
                          </Badge>
                        )}
                        {a.error_message && (
                          <span className="truncate text-muted-foreground" title={a.error_message}>
                            {a.error_message}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export { TransmissionPanel };
