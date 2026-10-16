// Time Tracker page: live timer, projects manager, manual entries, entries
// table, and "create invoice from unbilled time". Wrapped in PluginGuard by the
// route registration, so it only renders when the plugin is enabled.

import { Clock, Pencil, Play, Plus, RotateCcw, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canUser } from "@/hooks/use-can";
import { useTranslation } from "@/i18n";
import { formatCurrency } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth.store";
import { useSettingsStore } from "@/stores/settings.store";
import { type TtProject, type TtSummaryRow, type TtTimeEntry, ttApi } from "./api";

interface Customer {
  id: string;
  name: string;
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds < 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

// Mirrors the backend summary formula: running entries are excluded, unbilled
// amount is hours times the entry rate (falling back to the project default).
function computeTotals(entries: TtTimeEntry[], projects: TtProject[]) {
  const rateOf = new Map(projects.map((p) => [p.id, p.default_rate]));
  let total = 0;
  let billable = 0;
  let unbilled = 0;
  let amount = 0;
  for (const e of entries) {
    if (e.duration_seconds == null) continue;
    const secs = e.duration_seconds;
    total += secs;
    if (e.billable) {
      billable += secs;
      if (!e.is_billed) {
        unbilled += secs;
        amount += (secs / 3600) * (e.rate ?? rateOf.get(e.project_id) ?? 0);
      }
    }
  }
  return { total, billable, unbilled, amount };
}

// Remembers the last project + description used for the timer so starting again
// after stopping (or reloading the page) is one click.
const LAST_USED_KEY = "inkvoice-tt-last-used";

function readLastUsed(): { project_id: string; description: string } | null {
  try {
    const raw = localStorage.getItem(LAST_USED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { project_id?: string; description?: string };
    if (typeof v.project_id === "string")
      return { project_id: v.project_id, description: v.description ?? "" };
  } catch {
    // ignore corrupt storage
  }
  return null;
}

function saveLastUsed(v: { project_id: string; description: string }) {
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(v));
  } catch {
    // ignore storage errors (e.g. private mode)
  }
}

// Projects carry an optional hex color; fall back to a stable hash of the name
// so projects stay distinguishable even when no color is configured.
const COLOR_PALETTE = [
  "#f59e0b",
  "#10b981",
  "#6366f1",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#8b5cf6",
  "#ef4444",
];

function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
}

function ProjectDot({ color, name }: { color: string | null; name: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color ?? hashColor(name) }}
    />
  );
}

export default function TimeTrackingPage() {
  const { t } = useTranslation();
  const currency =
    useSettingsStore((s) => s.settings.base_currency || s.settings.currency) || "USD";
  const { user } = useAuthStore();
  const isAdmin = !!user?.is_admin;
  // Billing time writes an invoice (POST /invoice needs invoices:create).
  const canBill = canUser(user, "invoices", "create");

  const [projects, setProjects] = useState<TtProject[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [entries, setEntries] = useState<TtTimeEntry[]>([]);
  const [summary, setSummary] = useState<TtSummaryRow[]>([]);
  const [active, setActive] = useState<TtTimeEntry | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [filterProject, setFilterProject] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [userIdFilter, setUserIdFilter] = useState("all");
  const [users, setUsers] = useState<
    { id: string; username: string; display_name: string | null }[]
  >([]);

  // Live clock tick for the running timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const activeProjects = useMemo(() => projects.filter((p) => !p.is_archived), [projects]);
  const totals = useMemo(() => computeTotals(entries, projects), [entries, projects]);

  const loadProjects = useCallback(async () => {
    setProjects(await ttApi.listProjects(true));
  }, []);

  const loadEntries = useCallback(async () => {
    setEntries(
      await ttApi.listEntries({
        project_id: filterProject === "all" ? undefined : filterProject,
        user_id: isAdmin && userIdFilter !== "all" ? userIdFilter : undefined,
        from: from || undefined,
        to: to ? `${to}T23:59:59` : undefined,
      }),
    );
  }, [filterProject, userIdFilter, isAdmin, from, to]);

  const loadSummary = useCallback(async () => {
    setSummary(await ttApi.summary());
  }, []);

  const loadActive = useCallback(async () => {
    setActive(await ttApi.activeTimer());
  }, []);

  useEffect(() => {
    loadProjects();
    loadActive();
    loadSummary();
    api
      .listCustomers({ limit: "1000" })
      .then((r) => setCustomers(r.data.items ?? []))
      .catch(() => setCustomers([]));
  }, [loadProjects, loadActive, loadSummary]);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .listUsers()
      .then((res) =>
        setUsers(
          ((res.data as any) ?? []) as {
            id: string;
            username: string;
            display_name: string | null;
          }[],
        ),
      )
      .catch(() => undefined);
  }, [isAdmin]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Clock className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">{t("time_tracker.title")}</h1>
      </div>

      <SummaryStats totals={totals} currency={currency} />

      <TimerWidget
        projects={activeProjects}
        active={active}
        elapsed={active ? (now - new Date(active.started_at).getTime()) / 1000 : 0}
        onChanged={() => {
          loadActive();
          loadEntries();
          loadSummary();
        }}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <ProjectsManager
          projects={projects}
          customers={customers}
          summary={summary}
          showArchived={showArchived}
          isAdmin={isAdmin}
          onToggleArchived={() => setShowArchived((v) => !v)}
          onChanged={() => {
            loadProjects();
            loadSummary();
          }}
        />
        {canBill && (
          <InvoiceFromUnbilled
            customers={customers}
            summary={summary}
            currency={currency}
            onCreated={() => {
              loadEntries();
              loadSummary();
            }}
          />
        )}
      </div>

      <EntriesTable
        entries={entries}
        projects={activeProjects}
        filterProject={filterProject}
        from={from}
        to={to}
        now={now}
        hasActive={!!active}
        isAdmin={isAdmin}
        users={users}
        userIdFilter={userIdFilter}
        onFilterProject={setFilterProject}
        onUserFilter={setUserIdFilter}
        onFrom={setFrom}
        onTo={setTo}
        onResume={() => {
          loadActive();
          loadEntries();
          loadSummary();
        }}
        onChanged={() => {
          loadEntries();
          loadSummary();
        }}
      />
    </div>
  );
}

function SummaryStats({
  totals,
  currency,
}: {
  totals: { total: number; billable: number; unbilled: number; amount: number };
  currency: string;
}) {
  const { t } = useTranslation();
  const cells = [
    { label: t("time_tracker.stat_total"), value: formatDuration(totals.total) },
    { label: t("time_tracker.stat_billable"), value: formatDuration(totals.billable) },
    { label: t("time_tracker.stat_unbilled"), value: formatDuration(totals.unbilled) },
    {
      label: t("time_tracker.stat_unbilled_value"),
      value: formatCurrency(totals.amount, currency),
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cells.map((c) => (
        <Card key={c.label}>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className="text-lg font-semibold tabular-nums">{c.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TimerWidget({
  projects,
  active,
  elapsed,
  onChanged,
}: {
  projects: TtProject[];
  active: TtTimeEntry | null;
  elapsed: number;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState(() => readLastUsed()?.project_id ?? "");
  const [description, setDescription] = useState(() => readLastUsed()?.description ?? "");
  const [todaySeconds, setTodaySeconds] = useState(0);

  // While running, show how much tracked time has accumulated today.
  useEffect(() => {
    if (!active) {
      setTodaySeconds(0);
      return;
    }
    const today = todayISO();
    ttApi
      .summary({ from: today, to: `${today}T23:59:59` })
      .then((rows) => setTodaySeconds(rows.reduce((s, r) => s + r.total_seconds, 0)))
      .catch(() => setTodaySeconds(0));
  }, [active]);

  const start = async () => {
    if (!projectId) return;
    try {
      await ttApi.startTimer({ project_id: projectId, description: description || null });
      saveLastUsed({ project_id: projectId, description });
      setDescription("");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const stop = async () => {
    try {
      const stopped = await ttApi.stopTimer();
      if (stopped) {
        // Prefill the start form with the just-stopped entry so resuming is one click.
        setProjectId(stopped.project_id);
        setDescription(stopped.description ?? "");
        saveLastUsed({ project_id: stopped.project_id, description: stopped.description ?? "" });
      }
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("time_tracker.timer")}</CardTitle>
      </CardHeader>
      <CardContent>
        {active ? (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-sm font-medium">{active.project_name}</div>
              {active.description && (
                <div className="text-xs text-muted-foreground">{active.description}</div>
              )}
              <div className="text-xs text-muted-foreground mt-1">
                {t("time_tracker.today_total")}:{" "}
                <span className="font-medium tabular-nums">
                  {formatDuration(todaySeconds + elapsed)}
                </span>
              </div>
            </div>
            <div className="font-mono text-2xl tabular-nums">{formatClock(elapsed)}</div>
            <Button onClick={stop} variant="destructive">
              <Square className="h-4 w-4 mr-2" />
              {t("time_tracker.stop")}
            </Button>
          </div>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("time_tracker.no_project_hint")}</p>
        ) : (
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1">
              <Label>{t("time_tracker.project")}</Label>
              <Select value={projectId} onValueChange={(v) => setProjectId(v ?? "")}>
                <SelectTrigger className="w-52">
                  <SelectValue placeholder={t("time_tracker.project")}>
                    {projects.find((p) => p.id === projectId)?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 flex-1 min-w-48">
              <Label>{t("time_tracker.description_label")}</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("time_tracker.description_label")}
              />
            </div>
            <Button onClick={start} disabled={!projectId}>
              <Play className="h-4 w-4 mr-2" />
              {t("time_tracker.start")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectsManager({
  projects,
  customers,
  summary,
  showArchived,
  isAdmin,
  onToggleArchived,
  onChanged,
}: {
  projects: TtProject[];
  customers: Customer[];
  summary: TtSummaryRow[];
  showArchived: boolean;
  isAdmin: boolean;
  onToggleArchived: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TtProject | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TtProject | null>(null);
  const [busy, setBusy] = useState(false);

  const summaryByProject = useMemo(() => new Map(summary.map((r) => [r.project_id, r])), [summary]);

  const visible = projects.filter((p) => showArchived || !p.is_archived);

  const archive = async (p: TtProject) => {
    await ttApi.updateProject(p.id, { is_archived: !p.is_archived });
    onChanged();
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await ttApi.deleteProject(deleteTarget.id);
      onChanged();
      setDeleteTarget(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{t("time_tracker.projects")}</CardTitle>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onToggleArchived}>
            {t("time_tracker.show_archived")}
          </Button>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditTarget(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              {t("time_tracker.add_project")}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("time_tracker.no_project_hint")}</p>
        ) : (
          <div className="space-y-1">
            {visible.map((p) => {
              const row = summaryByProject.get(p.id);
              return (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 text-sm border-b py-1.5 last:border-0"
                >
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-2">
                      <ProjectDot color={p.color} name={p.name} />
                      <span className={p.is_archived ? "text-muted-foreground line-through" : ""}>
                        {p.name}
                      </span>
                    </span>
                    {p.default_rate != null && (
                      <span className="text-xs text-muted-foreground ml-2">{p.default_rate}/h</span>
                    )}
                    {row && row.unbilled_seconds > 0 && (
                      <span className="text-xs text-muted-foreground ml-2">
                        {t("time_tracker.unbilled_hint", {
                          hours: formatDuration(row.unbilled_seconds),
                        })}
                      </span>
                    )}
                  </div>
                  {isAdmin && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditTarget(p);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => archive(p)}>
                        {p.is_archived ? t("time_tracker.unarchive") : t("time_tracker.archive")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(p)}
                        title={t("time_tracker.delete")}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <ProjectDialog
        open={dialogOpen}
        project={editTarget}
        customers={customers}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setEditTarget(null);
        }}
        onSaved={onChanged}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("time_tracker.confirm_delete_project_title")}
        description={t("time_tracker.confirm_delete_project_desc")}
        variant="destructive"
        onConfirm={remove}
        loading={busy}
      />
    </Card>
  );
}

function ProjectDialog({
  open,
  project,
  customers,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  project: TtProject | null;
  customers: Customer[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const isEdit = !!project;
  const [name, setName] = useState("");
  const [customerId, setCustomerId] = useState("none");
  const [rate, setRate] = useState("");
  const [billable, setBillable] = useState(true);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setCustomerId(project?.customer_id ?? "none");
    setRate(project?.default_rate != null ? String(project.default_rate) : "");
    setBillable(project ? project.billable === 1 : true);
  }, [open, project]);

  const save = async () => {
    if (!name.trim()) return;
    const input = {
      name: name.trim(),
      customer_id: customerId === "none" ? null : customerId,
      default_rate: rate ? Number(rate) : null,
      billable,
    };
    try {
      if (isEdit) {
        await ttApi.updateProject(project!.id, input);
      } else {
        await ttApi.createProject(input);
      }
      toast.success(isEdit ? t("time_tracker.project_saved") : t("time_tracker.saved"));
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("time_tracker.edit_project") : t("time_tracker.add_project")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{t("time_tracker.project_name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>{t("time_tracker.customer")}</Label>
            <Select value={customerId} onValueChange={(v) => setCustomerId(v ?? "none")}>
              <SelectTrigger>
                <SelectValue>
                  {customerId === "none"
                    ? t("time_tracker.no_customer")
                    : customers.find((c) => c.id === customerId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("time_tracker.no_customer")}</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t("time_tracker.rate")}</Label>
            <Input type="number" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm" htmlFor="tt-billable">
            <Checkbox id="tt-billable" checked={billable} onCheckedChange={setBillable} />
            {t("time_tracker.billable")}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={!name.trim()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EntryDialog({
  open,
  entry,
  projects,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  entry: TtTimeEntry | null;
  projects: TtProject[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const isEdit = !!entry;
  const [projectId, setProjectId] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(todayISO());
  const [hours, setHours] = useState("");

  useEffect(() => {
    if (!open) return;
    if (entry) {
      setProjectId(entry.project_id);
      setDescription(entry.description ?? "");
      setDate(entry.started_at.slice(0, 10));
      setHours(((entry.duration_seconds ?? 0) / 3600).toFixed(2));
    } else {
      setProjectId(projects[0]?.id ?? "");
      setDescription("");
      setDate(todayISO());
      setHours("");
    }
  }, [open, entry, projects]);

  const save = async () => {
    if (!projectId || !hours) return;
    const duration = Math.round(Number(hours) * 3600);
    try {
      if (isEdit) {
        // Keep the original clock time, only move the date.
        const orig = new Date(entry!.started_at);
        const [y, m, d] = date.split("-").map(Number);
        const started = new Date(y, m - 1, d, orig.getHours(), orig.getMinutes()).toISOString();
        await ttApi.updateEntry(entry!.id, {
          project_id: projectId,
          description: description || null,
          started_at: started,
          duration_seconds: duration,
        });
      } else {
        await ttApi.createEntry({
          project_id: projectId,
          description: description || null,
          started_at: new Date(`${date}T09:00:00`).toISOString(),
          duration_seconds: duration,
        });
      }
      toast.success(isEdit ? t("time_tracker.entry_saved") : t("time_tracker.saved"));
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("time_tracker.edit_entry") : t("time_tracker.add_entry")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{t("time_tracker.project")}</Label>
            <Select value={projectId} onValueChange={(v) => setProjectId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder={t("time_tracker.project")}>
                  {projects.find((p) => p.id === projectId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t("time_tracker.description_label")}</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex gap-3">
            <div className="space-y-1 flex-1">
              <Label>{t("time_tracker.started")}</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1 w-32">
              <Label>{t("time_tracker.duration")} (h)</Label>
              <Input
                type="number"
                step="0.25"
                min="0"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={!projectId || !hours}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EntriesTable({
  entries,
  projects,
  filterProject,
  from,
  to,
  now,
  hasActive,
  isAdmin,
  users,
  userIdFilter,
  onFilterProject,
  onUserFilter,
  onFrom,
  onTo,
  onResume,
  onChanged,
}: {
  entries: TtTimeEntry[];
  projects: TtProject[];
  filterProject: string;
  from: string;
  to: string;
  now: number;
  hasActive: boolean;
  isAdmin: boolean;
  users: { id: string; username: string; display_name: string | null }[];
  userIdFilter: string;
  onFilterProject: (v: string) => void;
  onUserFilter: (v: string) => void;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  onResume: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TtTimeEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TtTimeEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const totalSeconds = useMemo(
    () => entries.reduce((s, e) => s + (e.duration_seconds ?? 0), 0),
    [entries],
  );

  const resume = async (e: TtTimeEntry) => {
    try {
      await ttApi.startTimer({ project_id: e.project_id, description: e.description });
      onResume();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await ttApi.deleteEntry(deleteTarget.id);
      onChanged();
      toast.success(t("time_tracker.deleted"));
      setDeleteTarget(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">{t("time_tracker.entries")}</CardTitle>
            <Button
              size="sm"
              onClick={() => {
                setEditTarget(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              {t("time_tracker.add_entry")}
            </Button>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="space-y-1">
              <Select value={filterProject} onValueChange={(v) => onFilterProject(v ?? "all")}>
                <SelectTrigger className="w-44">
                  <SelectValue>
                    {filterProject === "all"
                      ? t("time_tracker.all_projects")
                      : projects.find((p) => p.id === filterProject)?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("time_tracker.all_projects")}</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isAdmin && (
              <div className="min-w-[160px] space-y-1">
                <Label>{t("time_tracker.user")}</Label>
                <Select value={userIdFilter} onValueChange={(v) => onUserFilter(v ?? "all")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("time_tracker.all_users")}</SelectItem>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.display_name || u.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>{t("time_tracker.from")}</Label>
              <Input type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>{t("time_tracker.to")}</Label>
              <Input type="date" value={to} onChange={(e) => onTo(e.target.value)} />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("time_tracker.no_entries")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("time_tracker.project")}</TableHead>
                <TableHead>{t("time_tracker.description_label")}</TableHead>
                <TableHead>{t("time_tracker.started")}</TableHead>
                <TableHead className="text-right">{t("time_tracker.duration")}</TableHead>
                <TableHead>{t("time_tracker.status")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-2">
                      <ProjectDot
                        color={projects.find((p) => p.id === e.project_id)?.color ?? null}
                        name={e.project_name}
                      />
                      {e.project_name}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{e.description || "-"}</TableCell>
                  <TableCell>{e.started_at.slice(0, 10)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {e.ended_at ? (
                      formatDuration(e.duration_seconds)
                    ) : (
                      <span className="font-mono">
                        {formatClock((now - new Date(e.started_at).getTime()) / 1000)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {!e.ended_at ? (
                      <Badge variant="secondary">{t("time_tracker.running")}</Badge>
                    ) : e.is_billed ? (
                      t("time_tracker.billed")
                    ) : e.billable ? (
                      t("time_tracker.unbilled")
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {!e.is_billed && e.ended_at && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => resume(e)}
                          disabled={hasActive}
                          title={t("time_tracker.resume")}
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                      )}
                      {!e.is_billed && e.ended_at && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditTarget(e);
                            setDialogOpen(true);
                          }}
                          title={t("time_tracker.edit")}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {!e.is_billed && e.ended_at && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(e)}
                          title={t("time_tracker.delete")}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3} className="text-right font-medium">
                  {t("time_tracker.entries_total")}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatDuration(totalSeconds)}
                </TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>

      <EntryDialog
        open={dialogOpen}
        entry={editTarget}
        projects={projects}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setEditTarget(null);
        }}
        onSaved={onChanged}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("time_tracker.confirm_delete_entry_title")}
        description={t("time_tracker.confirm_delete_entry_desc")}
        variant="destructive"
        onConfirm={remove}
        loading={busy}
      />
    </Card>
  );
}

function InvoiceFromUnbilled({
  customers,
  summary,
  currency,
  onCreated,
}: {
  customers: Customer[];
  summary: TtSummaryRow[];
  currency: string;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [customerId, setCustomerId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => {
    const rows = summary.filter((r) => r.customer_id === customerId);
    return {
      unbilled: rows.reduce((s, r) => s + r.unbilled_seconds, 0),
      amount: rows.reduce((s, r) => s + r.unbilled_amount, 0),
    };
  }, [summary, customerId]);

  const create = async () => {
    if (!customerId) return;
    setBusy(true);
    try {
      const res = await ttApi.createInvoice({
        customer_id: customerId,
        from: from || undefined,
        to: to || undefined,
      });
      toast.success(t("time_tracker.invoice_created", { count: res.entry_count }));
      onCreated();
      navigate(`/invoices/${res.invoice.id}`);
    } catch (e) {
      const msg = (e as Error).message;
      toast.error(msg.includes("No unbilled") ? t("time_tracker.no_unbilled") : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("time_tracker.invoice_unbilled")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>{t("time_tracker.customer")}</Label>
          <Select value={customerId} onValueChange={(v) => setCustomerId(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder={t("time_tracker.select_customer")}>
                {customers.find((c) => c.id === customerId)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {customerId && preview.unbilled > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("time_tracker.unbilled_preview", {
              hours: formatDuration(preview.unbilled),
              amount: formatCurrency(preview.amount, currency),
            })}
          </p>
        )}
        <div className="flex gap-3">
          <div className="space-y-1 flex-1">
            <Label>{t("time_tracker.from")}</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1 flex-1">
            <Label>{t("time_tracker.to")}</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <Button onClick={create} disabled={!customerId || busy} className="w-full">
          {t("time_tracker.create_invoice")}
        </Button>
      </CardContent>
    </Card>
  );
}
