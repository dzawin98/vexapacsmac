import { useEffect, useMemo, useState } from "react";
import { ArchiveRestore, DatabaseBackup, RefreshCw, Save, Trash2 } from "lucide-react";
import { backupService, BackupConfig, BackupJobLog, BackupJobStatus, BackupManifestSummary, BackupScheduleStatus } from "@/lib/dicomService";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

const formatDateTime = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "medium" }).format(date);
};

const defaultConfig: BackupConfig = {
  backupRoot: "D:\\VEXAPACS-Backup",
  dataPath: "C:\\ProgramData\\VEXAPACS\\DATA",
  programDataPath: "C:\\ProgramData\\VEXAPACS",
  includeDicomData: true,
  includeProgramData: true,
  postgres: {
    host: "localhost",
    port: 5432,
    user: "postgres",
    password: "",
    risDb: "veloris_db",
    pacsDb: "velopacs_db",
    binPath: "",
  },
  retention: { keepLast: 7 },
  schedule: {
    enabled: false,
    frequency: "daily",
    time: "23:00",
    interval: 1,
    daysOfWeek: ["MON"],
    dayOfMonth: 1,
  },
};

const defaultSchedule = defaultConfig.schedule!;
const weekDays = [
  { value: "MON", label: "Mon" },
  { value: "TUE", label: "Tue" },
  { value: "WED", label: "Wed" },
  { value: "THU", label: "Thu" },
  { value: "FRI", label: "Fri" },
  { value: "SAT", label: "Sat" },
  { value: "SUN", label: "Sun" },
];

const BackupRestorePage = () => {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const [config, setConfig] = useState<BackupConfig>(defaultConfig);
  const [backups, setBackups] = useState<BackupManifestSummary[]>([]);
  const [jobLogs, setJobLogs] = useState<BackupJobLog[]>([]);
  const [job, setJob] = useState<BackupJobStatus>({ running: false });
  const [schedule, setSchedule] = useState<BackupScheduleStatus>({ enabled: false, taskName: "VEXAPACS Daily Backup" });
  const [scheduleForm, setScheduleForm] = useState(defaultSchedule);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupManifestSummary | null>(null);
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoreOptions, setRestoreOptions] = useState({
    skipDatabase: false,
    skipDicomData: false,
    skipProgramData: false,
    noStopServices: true,
  });

  const jobRunning = Boolean(job?.running);
  const jobProgress = job?.progress;
  const canManageBackupRestore = hasPermission("manage_backup_restore");
  const canRestore = restoreConfirmation === "RESTORE" && Boolean(restoreTarget?.path) && !jobRunning && canManageBackupRestore;

  const loadAll = async () => {
    setLoading(true);
    try {
      const [loadedConfig, loadedBackups, loadedJobLogs, status] = await Promise.all([
        backupService.fetchConfig(),
        backupService.listBackups(),
        backupService.listJobs(),
        backupService.fetchStatus(),
      ]);
      setConfig({ ...defaultConfig, ...loadedConfig, postgres: { ...defaultConfig.postgres, ...loadedConfig.postgres } });
      setBackups(loadedBackups);
      setJobLogs(loadedJobLogs);
      setJob(status.job || { running: false });
      setSchedule(status.schedule || { enabled: false, taskName: "VEXAPACS Daily Backup" });
      setScheduleForm({
        ...defaultSchedule,
        ...(loadedConfig.schedule || {}),
        ...(status.schedule || {}),
      });
    } catch (error) {
      toast({
        title: "Failed to load backup manager",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!jobRunning) return;
    const timer = window.setInterval(() => {
      backupService.fetchStatus()
        .then(status => {
          setJob(status.job || { running: false });
          setSchedule(status.schedule || schedule);
          if (!status.job?.running) {
            void backupService.listBackups().then(setBackups).catch(() => undefined);
            void backupService.listJobs().then(setJobLogs).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [jobRunning, schedule]);

  const maskedPassword = useMemo(() => config.postgres.password === "********", [config.postgres.password]);

  const updatePostgres = (key: keyof BackupConfig["postgres"], value: string | number) => {
    setConfig(prev => ({
      ...prev,
      postgres: {
        ...prev.postgres,
        [key]: value,
      },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        ...config,
        postgres: {
          ...config.postgres,
          password: maskedPassword ? undefined : config.postgres.password,
        },
      };
      const saved = await backupService.saveConfig(payload);
      setConfig({ ...defaultConfig, ...saved, postgres: { ...defaultConfig.postgres, ...saved.postgres } });
      toast({ title: "Backup config saved", description: "Configuration updated successfully." });
    } catch (error) {
      toast({
        title: "Failed to save config",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRunBackup = async () => {
    try {
      const result = await backupService.runBackup({ noStopServices: true });
      setJob(result.job);
      toast({ title: "Backup started", description: "Backup is running in the background." });
    } catch (error) {
      toast({
        title: "Failed to start backup",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const handleSaveSchedule = async () => {
    try {
      const next = await backupService.saveSchedule({ ...scheduleForm, enabled: true });
      setSchedule(next);
      setScheduleForm({ ...scheduleForm, ...next, enabled: true });
      toast({ title: "Schedule saved", description: `Backup scheduled at ${scheduleForm.time}.` });
    } catch (error) {
      toast({
        title: "Failed to save schedule",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const handleDeleteSchedule = async () => {
    try {
      const next = await backupService.deleteSchedule();
      setSchedule(next);
      setScheduleForm(prev => ({ ...prev, enabled: false }));
      toast({ title: "Schedule removed", description: "Daily backup task deleted." });
    } catch (error) {
      toast({
        title: "Failed to delete schedule",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget?.path) return;
    try {
      const result = await backupService.runRestore({
        backupPath: restoreTarget.path,
        confirmation: restoreConfirmation,
        ...restoreOptions,
      });
      setJob(result.job);
      setRestoreTarget(null);
      setRestoreConfirmation("");
      toast({ title: "Restore started", description: "Restore is running in the background." });
    } catch (error) {
      toast({
        title: "Failed to start restore",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Backup & Restore</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="icon" onClick={loadAll} disabled={loading || jobRunning}>
            <RefreshCw className="h-4 w-4" />
            <span className="sr-only">Refresh</span>
          </Button>
          <Button onClick={handleRunBackup} disabled={loading || jobRunning || !canManageBackupRestore}>
            <DatabaseBackup className="mr-2 h-4 w-4" />
            Run Backup Now
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle>Backup Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Backup Root</Label>
                <Input value={config.backupRoot} onChange={event => setConfig(prev => ({ ...prev, backupRoot: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>DICOM DATA Path</Label>
                <Input value={config.dataPath} onChange={event => setConfig(prev => ({ ...prev, dataPath: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>ProgramData Path</Label>
                <Input value={config.programDataPath} onChange={event => setConfig(prev => ({ ...prev, programDataPath: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>PostgreSQL Bin Path</Label>
                <Input value={config.postgres.binPath || ""} onChange={event => updatePostgres("binPath", event.target.value)} placeholder="C:\\Program Files\\PostgreSQL\\16\\bin" />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>DB Host</Label>
                <Input value={config.postgres.host} onChange={event => updatePostgres("host", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>DB Port</Label>
                <Input type="number" value={config.postgres.port} onChange={event => updatePostgres("port", Number(event.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>DB User</Label>
                <Input value={config.postgres.user} onChange={event => updatePostgres("user", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>DB Password</Label>
                <Input type="password" value={config.postgres.password || ""} onChange={event => updatePostgres("password", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>RIS DB</Label>
                <Input value={config.postgres.risDb} onChange={event => updatePostgres("risDb", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>PACS DB</Label>
                <Input value={config.postgres.pacsDb} onChange={event => updatePostgres("pacsDb", event.target.value)} />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex items-center justify-between rounded-xl border p-3">
                <span className="text-sm font-medium">Include DICOM DATA</span>
                <Switch checked={config.includeDicomData} onCheckedChange={checked => setConfig(prev => ({ ...prev, includeDicomData: checked }))} />
              </label>
              <label className="flex items-center justify-between rounded-xl border p-3">
                <span className="text-sm font-medium">Include ProgramData</span>
                <Switch checked={config.includeProgramData} onCheckedChange={checked => setConfig(prev => ({ ...prev, includeProgramData: checked }))} />
              </label>
              <div className="space-y-2">
                <Label>Keep Last Backups</Label>
                <Input type="number" min={0} value={config.retention.keepLast} onChange={event => setConfig(prev => ({ ...prev, retention: { keepLast: Number(event.target.value) } }))} />
              </div>
            </div>

            <Button onClick={handleSave} disabled={saving || jobRunning || !canManageBackupRestore}>
              <Save className="mr-2 h-4 w-4" />
              Save Configuration
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Scheduler</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant={schedule.enabled ? "default" : "secondary"}>
                  {schedule.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <span className="text-sm text-muted-foreground">{schedule.taskName}</span>
              </div>
              {schedule.enabled && (
                <div className="space-y-1 text-sm">
                  {schedule.runsWithoutUserLoggedOn === false ? (
                    <p className="text-destructive">
                      Backup only runs while a user is signed in to the server. Run the installer as
                      Administrator, or save this schedule again with Administrator rights, so that the backup
                      keeps running without a sign-in.
                    </p>
                  ) : (
                    <p className="text-muted-foreground">
                      The backup runs without any user signed in.
                      {schedule.runLevel ? ` (mode: ${schedule.runLevel})` : ""}
                    </p>
                  )}
                  {schedule.nextRunTime ? (
                    <p className="text-muted-foreground">
                      Next backup: {new Date(schedule.nextRunTime).toLocaleString()}
                    </p>
                  ) : null}
                  {schedule.error ? <p className="text-destructive">{schedule.error}</p> : null}
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Frequency</Label>
                  <Select
                    value={scheduleForm.frequency}
                    onValueChange={value => setScheduleForm(prev => ({ ...prev, frequency: value as "daily" | "weekly" | "monthly" }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Frequency" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Backup Time</Label>
                  <Input type="time" value={scheduleForm.time} onChange={event => setScheduleForm(prev => ({ ...prev, time: event.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label>Every</Label>
                  <Input
                    type="number"
                    min={1}
                    value={scheduleForm.interval}
                    onChange={event => setScheduleForm(prev => ({ ...prev, interval: Math.max(1, Number(event.target.value) || 1) }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    {scheduleForm.frequency === "daily" ? "day(s)" : scheduleForm.frequency === "weekly" ? "week(s)" : "month(s)"}
                  </p>
                </div>
                {scheduleForm.frequency === "monthly" && (
                  <div className="space-y-2">
                    <Label>Day of Month</Label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={scheduleForm.dayOfMonth}
                      onChange={event => setScheduleForm(prev => ({ ...prev, dayOfMonth: Math.max(1, Math.min(31, Number(event.target.value) || 1)) }))}
                    />
                  </div>
                )}
              </div>
              {scheduleForm.frequency === "weekly" && (
                <div className="space-y-2">
                  <Label>Days</Label>
                  <div className="flex flex-wrap gap-2">
                    {weekDays.map(day => {
                      const active = scheduleForm.daysOfWeek?.includes(day.value);
                      return (
                        <Button
                          key={day.value}
                          type="button"
                          variant={active ? "default" : "outline"}
                          size="sm"
                          onClick={() => setScheduleForm(prev => {
                            const current = prev.daysOfWeek || [];
                            const next = current.includes(day.value)
                              ? current.filter(item => item !== day.value)
                              : [...current, day.value];
                            return { ...prev, daysOfWeek: next.length ? next : [day.value] };
                          })}
                        >
                          {day.label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <Button onClick={handleSaveSchedule} disabled={jobRunning || !canManageBackupRestore}>Save</Button>
                <Button variant="outline" onClick={handleDeleteSchedule} disabled={jobRunning || !canManageBackupRestore}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remove
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runtime Job</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant={jobRunning ? "default" : job?.exitCode ? "destructive" : "secondary"}>
                  {jobRunning ? "Running" : job?.finishedAt ? `Exit ${job.exitCode ?? "-"}` : "Idle"}
                </Badge>
                <span className="text-sm text-muted-foreground">{job?.type || "-"}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Started: {formatDateTime(job?.startedAt)}<br />
                Finished: {formatDateTime(job?.finishedAt)}
              </div>
              {jobProgress && (
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{jobProgress.message}</span>
                    <span className="text-muted-foreground">{jobProgress.percent}%</span>
                  </div>
                  <Progress value={jobProgress.percent} />
                </div>
              )}
              {job?.output && (
                <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">{job.output}</pre>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Available Backups</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Content</TableHead>
                <TableHead>Path</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map(backup => (
                <TableRow key={backup.path}>
                  <TableCell className="font-medium">{backup.name}</TableCell>
                  <TableCell>{formatDateTime(backup.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline">DB</Badge>
                      {backup.includeDicomData && <Badge variant="outline">DICOM</Badge>}
                      {backup.includeProgramData && <Badge variant="outline">ProgramData</Badge>}
                      {backup.invalid && <Badge variant="destructive">Invalid</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[360px] truncate text-xs text-muted-foreground">{backup.path}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setRestoreTarget(backup)} disabled={jobRunning || backup.invalid || !canManageBackupRestore}>
                      <ArchiveRestore className="mr-2 h-4 w-4" />
                      Restore
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!backups.length && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No backup found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backup & Restore Job History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Finished</TableHead>
                <TableHead>User</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobLogs.map(log => (
                <TableRow key={log.id}>
                  <TableCell className="font-medium">{log.job_type}</TableCell>
                  <TableCell>
                    <Badge variant={log.status === "success" ? "default" : log.status === "failed" ? "destructive" : "secondary"}>
                      {log.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="min-w-[220px]">
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span>{log.progress_message || "-"}</span>
                        <span className="text-muted-foreground">{log.progress_percent ?? 0}%</span>
                      </div>
                      <Progress value={log.progress_percent ?? 0} className="h-2" />
                    </div>
                  </TableCell>
                  <TableCell>{formatDateTime(log.started_at)}</TableCell>
                  <TableCell>{formatDateTime(log.finished_at)}</TableCell>
                  <TableCell>{log.requested_by || "-"}</TableCell>
                </TableRow>
              ))}
              {!jobLogs.length && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No backup/restore job log found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={Boolean(restoreTarget)} onOpenChange={open => {
        if (!open) {
          setRestoreTarget(null);
          setRestoreConfirmation("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore Backup</DialogTitle>
            <DialogDescription>
              Restore will overwrite the selected database/data. Type RESTORE to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border p-3 text-sm">
              <div className="font-medium">{restoreTarget?.name}</div>
              <div className="text-xs text-muted-foreground">{restoreTarget?.path}</div>
            </div>
            <div className="grid gap-2">
              <Label>Confirmation</Label>
              <Input value={restoreConfirmation} onChange={event => setRestoreConfirmation(event.target.value)} placeholder="RESTORE" />
            </div>
            <div className="grid gap-2">
              <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                Skip Database
                <Switch checked={restoreOptions.skipDatabase} onCheckedChange={checked => setRestoreOptions(prev => ({ ...prev, skipDatabase: checked }))} />
              </label>
              <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                Skip DICOM DATA
                <Switch checked={restoreOptions.skipDicomData} onCheckedChange={checked => setRestoreOptions(prev => ({ ...prev, skipDicomData: checked }))} />
              </label>
              <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                Skip ProgramData
                <Switch checked={restoreOptions.skipProgramData} onCheckedChange={checked => setRestoreOptions(prev => ({ ...prev, skipProgramData: checked }))} />
              </label>
              <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                Keep Services Running
                <Switch checked={restoreOptions.noStopServices} onCheckedChange={checked => setRestoreOptions(prev => ({ ...prev, noStopServices: checked }))} />
              </label>
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-200">
                During a full database restore, PostgreSQL will briefly terminate active database connections.
                This option prevents the script from explicitly stopping Windows services.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleRestore} disabled={!canRestore}>Start Restore</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default BackupRestorePage;
