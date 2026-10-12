import { Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";
import { formatRelativeTime } from "@/lib/format-relative";

type DeviceSession = Awaited<ReturnType<typeof api.listDeviceSessions>>["data"][number];

/** Mobile app sign-ins for the current user, each revocable. */
export function DeviceSessionsCard() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.listDeviceSessions();
      setSessions(res.data ?? []);
    } catch (err) {
      toast.error(formatApiError(err, t));
    }
  }, [t]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleRevoke = async (id: string) => {
    try {
      await api.revokeDeviceSession(id);
      toast.success(t("device_sessions.revoked"));
      await fetchSessions();
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm">{t("device_sessions.title")}</CardTitle>
          <p className="text-xs text-muted-foreground mt-1 max-w-md">{t("device_sessions.info")}</p>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("device_sessions.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/50 p-3"
                >
                  <div className="flex items-start gap-2 min-w-0">
                    <Smartphone className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.name}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {[
                          s.platform === "ios"
                            ? t("device_sessions.platform_ios")
                            : t("device_sessions.platform_android"),
                          s.model,
                          s.os_version,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {s.last_seen_at
                          ? t("device_sessions.last_seen", {
                              time: formatRelativeTime(new Date(s.last_seen_at).getTime(), t),
                            })
                          : t("device_sessions.never_seen")}
                      </div>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setRevokingId(s.id)}>
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" /> {t("device_sessions.revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={revokingId !== null}
        onOpenChange={(o) => {
          if (!o) setRevokingId(null);
        }}
        title={t("device_sessions.confirm_revoke_title")}
        description={t("device_sessions.confirm_revoke_body")}
        variant="destructive"
        confirmLabel={t("device_sessions.revoke")}
        onConfirm={() => {
          if (revokingId) handleRevoke(revokingId);
        }}
      />
    </>
  );
}
