import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  DicomNode,
  DicomRoutingJob,
  DicomRoutingSchedule,
  dicomRoutingService,
} from "@/lib/dicomService";

type Props = { nodes: DicomNode[]; canEdit: boolean };

const fieldClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary";
const statusClass: Record<string, string> = {
  success: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  failed: "bg-red-50 text-red-700 ring-red-600/20",
  sending: "bg-blue-50 text-blue-700 ring-blue-600/20",
  retrying: "bg-amber-50 text-amber-700 ring-amber-600/20",
  queued: "bg-slate-100 text-slate-700 ring-slate-500/20",
};

export default function DicomRoutingSettings({ nodes, canEdit }: Props) {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<DicomRoutingSchedule[]>([]);
  const [jobs, setJobs] = useState<DicomRoutingJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ date: string; count: number; instances: number } | null>(null);
  const [form, setForm] = useState({
    name: "Send previous-day studies",
    nodeId: "",
    recurrence: "daily",
    runTime: "01:00",
    scheduledAt: "",
    sourceDateMode: "previous_day",
    sourceDate: "",
    modality: "",
    maxRetries: "3",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSchedules, nextJobs] = await Promise.all([
        dicomRoutingService.fetchSchedules(),
        dicomRoutingService.fetchJobs(),
      ]);
      setSchedules(nextSchedules);
      setJobs(nextJobs);
      if (!form.nodeId && nodes.length) setForm(current => ({ ...current, nodeId: String(nodes[0].id) }));
    } catch (error) {
      toast({ title: "Unable to load DICOM routing", description: error instanceof Error ? error.message : "Unexpected error", variant: "destructive" });
    } finally { setLoading(false); }
  }, [form.nodeId, nodes, toast]);

  useEffect(() => { load(); }, [load]);

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const result = await dicomRoutingService.preview({ sourceDateMode: form.sourceDateMode, sourceDate: form.sourceDate || undefined, modality: form.modality || undefined });
      setPreview(result);
    } catch (error) {
      toast({ title: "Preview failed", description: error instanceof Error ? error.message : "Unexpected error", variant: "destructive" });
    } finally { setPreviewing(false); }
  };

  const createSchedule = async () => {
    if (!form.nodeId) return toast({ title: "Destination required", description: "Select a DICOM destination.", variant: "destructive" });
    if (form.recurrence === "once" && !form.scheduledAt) return toast({ title: "Schedule time required", description: "Choose the date and time for this one-time schedule.", variant: "destructive" });
    setSaving(true);
    try {
      await dicomRoutingService.create({
        ...form,
        nodeId: Number(form.nodeId),
        maxRetries: Number(form.maxRetries),
        sourceDate: form.sourceDate || null,
        scheduledAt: form.scheduledAt || null,
      });
      toast({ title: "Schedule created", description: "The routing service will run this schedule automatically." });
      setPreview(null);
      await load();
    } catch (error) {
      toast({ title: "Unable to create schedule", description: error instanceof Error ? error.message : "Unexpected error", variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">Create routing schedule</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Define when studies are sent and select the receiving DICOM node.</p>
        </div>
        <div className="grid gap-x-5 gap-y-4 p-5 md:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-2"><Label>Schedule Name</Label><Input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></div>
          <div className="space-y-2"><Label>DICOM Destination</Label><select className={fieldClass} value={form.nodeId} onChange={event => setForm({ ...form, nodeId: event.target.value })}><option value="">Select destination</option>{nodes.filter(node => node.enabled).map(node => <option key={node.id} value={node.id}>{node.name} ({node.aet})</option>)}</select></div>
          <div className="space-y-2"><Label>Frequency</Label><select className={fieldClass} value={form.recurrence} onChange={event => setForm({ ...form, recurrence: event.target.value })}><option value="daily">Daily</option><option value="once">One time</option></select></div>
          {form.recurrence === "daily" ? <div className="space-y-2"><Label>Run Time</Label><Input type="time" value={form.runTime} onChange={event => setForm({ ...form, runTime: event.target.value })} /></div> : <div className="space-y-2"><Label>Scheduled Date & Time</Label><Input type="datetime-local" value={form.scheduledAt} onChange={event => setForm({ ...form, scheduledAt: event.target.value })} /></div>}
          <div className="space-y-2"><Label>Study Date</Label><select className={fieldClass} value={form.sourceDateMode} onChange={event => setForm({ ...form, sourceDateMode: event.target.value })}><option value="previous_day">Previous day</option><option value="specific_date">Specific date</option></select></div>
          {form.sourceDateMode === "specific_date" ? <div className="space-y-2"><Label>Source Study Date</Label><Input type="date" value={form.sourceDate} onChange={event => setForm({ ...form, sourceDate: event.target.value })} /></div> : null}
          <div className="space-y-2"><Label>Modality</Label><Input placeholder="All modalities" value={form.modality} onChange={event => setForm({ ...form, modality: event.target.value.toUpperCase() })} /></div>
          <div className="space-y-2"><Label>Maximum Retries</Label><Input type="number" min="1" max="10" value={form.maxRetries} onChange={event => setForm({ ...form, maxRetries: event.target.value })} /></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-3">
          <div className="text-sm text-muted-foreground">{preview ? <><span className="font-medium text-foreground">{preview.count} studies</span> · {preview.instances} instances · {preview.date}</> : "Preview the selection before saving."}</div>
          <div className="flex gap-2"><Button size="sm" variant="outline" onClick={runPreview} disabled={previewing}>{previewing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Preview</Button><Button size="sm" onClick={createSchedule} disabled={!canEdit || saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save schedule</Button></div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="text-base font-semibold">Schedules</h2><p className="mt-0.5 text-sm text-muted-foreground">Active and paused routing rules.</p></div><Button variant="ghost" size="sm" onClick={load}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></div>
        <div className="divide-y divide-border">
          {loading ? <div className="p-8 text-center text-muted-foreground">Loading schedules...</div> : schedules.length === 0 ? <div className="p-8 text-center text-muted-foreground">No routing schedules configured.</div> : schedules.map(schedule => (
            <div key={schedule.id} className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div><div className="flex items-center gap-2"><p className="font-medium">{schedule.name}</p><span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${schedule.enabled ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "bg-slate-100 text-slate-600 ring-slate-500/20"}`}>{schedule.enabled ? "Active" : "Paused"}</span></div><p className="mt-1 text-sm text-muted-foreground">{schedule.node_name} · {schedule.aet} · {schedule.recurrence === "daily" ? `Daily, ${schedule.run_time}` : "One time"} · {schedule.source_date_mode === "previous_day" ? "Previous day" : schedule.source_date || "-"}{schedule.modality ? ` · ${schedule.modality}` : " · All modalities"}</p><p className="mt-1 text-xs text-muted-foreground">Next run {schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "not scheduled"}</p></div>
              <div className="flex items-center gap-2"><Switch checked={schedule.enabled} disabled={!canEdit} onCheckedChange={async enabled => { await dicomRoutingService.setEnabled(schedule.id, enabled); await load(); }} /><Button size="sm" variant="outline" disabled={!canEdit} onClick={async () => { const result = await dicomRoutingService.runNow(schedule.id); toast({ title: "Routing queued", description: `${result.queued} studies queued for ${result.date}.` }); await load(); }}><Play className="mr-2 h-4 w-4" />Run Now</Button><Button size="icon" variant="ghost" disabled={!canEdit} onClick={async () => { if (!window.confirm(`Delete schedule “${schedule.name}”?`)) return; await dicomRoutingService.remove(schedule.id); await load(); }}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4"><h2 className="text-base font-semibold">Transfer history</h2><p className="mt-0.5 text-sm text-muted-foreground">Recent scheduled transfers and delivery status.</p></div>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Schedule</th><th className="px-4 py-3 font-medium">Destination</th><th className="px-4 py-3 font-medium">Study Instance UID</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Attempts</th><th className="px-5 py-3 font-medium">Created</th></tr></thead><tbody>{jobs.slice(0, 50).map(job => <tr key={job.id} className="border-t border-border hover:bg-muted/20"><td className="px-5 py-3">{job.schedule_name}</td><td className="px-4 py-3">{job.node_name}</td><td className="max-w-[280px] truncate px-4 py-3 font-mono text-xs">{job.study_instance_uid}</td><td className="px-4 py-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${statusClass[job.status] || statusClass.queued}`}>{job.status}</span></td><td className="px-4 py-3">{job.attempts}</td><td className="whitespace-nowrap px-5 py-3 text-muted-foreground">{new Date(job.created_at).toLocaleString()}</td></tr>)}</tbody></table>{jobs.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">No transfer history.</div> : null}</div>
      </section>
    </div>
  );
}
