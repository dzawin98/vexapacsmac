import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, ClipboardList, Edit2, History, Plus, Search, Trash2, Wrench } from "lucide-react";
import { assetService, type AssetHistoryRecord, type AssetRecord, type AssetStatus } from "@/lib/dicomService";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

type AssetDraft = Omit<AssetRecord, "status" | "history">;

const categories = ["XRAY", "CT", "MRI", "USG", "CR", "DR", "MG", "FL", "OTHER"];
const today = () => new Date().toISOString().slice(0, 10);
const emptyAsset = (): AssetDraft => ({
  id: "",
  name: "",
  category: "XRAY",
  brand: "",
  model: "",
  serialNumber: "",
  room: "",
  purchaseDate: "",
  warrantyExpiredDate: "",
  lastCalibrationDate: "",
  nextCalibrationDate: "",
  operationalStatus: "active",
  responsiblePerson: "",
  vendor: "",
  notes: "",
});
const emptyHistory = (): AssetHistoryRecord => ({ date: today(), type: "Maintenance", title: "", officer: "", notes: "" });

const formatDate = (value?: string | null) => {
  if (!value) return "-";
  return new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString("id-ID", {
    day: "2-digit", month: "short", year: "numeric",
  });
};
const daysUntil = (value?: string | null) => {
  if (!value) return null;
  const target = new Date(`${String(value).slice(0, 10)}T00:00:00`).getTime();
  const current = new Date();
  current.setHours(0, 0, 0, 0);
  return Math.ceil((target - current.getTime()) / 86400000);
};
const isExpired = (value?: string | null) => {
  const days = daysUntil(value);
  return days !== null && days < 0;
};
const statusConfig: Record<AssetStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  due_soon: { label: "Due Soon", className: "border-amber-200 bg-amber-50 text-amber-700" },
  overdue: { label: "Overdue", className: "border-destructive/30 bg-destructive/10 text-destructive" },
  maintenance: { label: "Maintenance", className: "border-sky-200 bg-sky-50 text-sky-700" },
};
const StatusBadge = ({ status }: { status: AssetStatus }) => (
  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusConfig[status].className}`}>
    {statusConfig[status].label}
  </span>
);

const AssetFields = ({ draft, setDraft, idLocked = false }: {
  draft: AssetDraft;
  setDraft: React.Dispatch<React.SetStateAction<AssetDraft>>;
  idLocked?: boolean;
}) => {
  const field = (key: keyof AssetDraft, value: string) => setDraft(current => ({ ...current, [key]: value }));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="space-y-2 text-sm font-medium">Asset ID<Input value={draft.id} disabled={idLocked} onChange={e => field("id", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Asset Name<Input value={draft.name} onChange={e => field("name", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Category
        <Select value={draft.category} onValueChange={value => field("category", value)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{categories.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
        </Select>
      </label>
      <label className="space-y-2 text-sm font-medium">Room / Location<Input value={draft.room} onChange={e => field("room", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Brand<Input value={draft.brand} onChange={e => field("brand", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Model<Input value={draft.model} onChange={e => field("model", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Serial Number<Input value={draft.serialNumber} onChange={e => field("serialNumber", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Responsible Person<Input value={draft.responsiblePerson} onChange={e => field("responsiblePerson", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Purchase Date<Input type="date" value={draft.purchaseDate || ""} onChange={e => field("purchaseDate", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Warranty Expired<Input type="date" value={draft.warrantyExpiredDate || ""} onChange={e => field("warrantyExpiredDate", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Last Calibration<Input type="date" value={draft.lastCalibrationDate || ""} onChange={e => field("lastCalibrationDate", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Next Calibration<Input type="date" value={draft.nextCalibrationDate || ""} onChange={e => field("nextCalibrationDate", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Vendor<Input value={draft.vendor} onChange={e => field("vendor", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Operational Status
        <Select value={draft.operationalStatus} onValueChange={value => field("operationalStatus", value)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="maintenance">Maintenance</SelectItem></SelectContent>
        </Select>
      </label>
      <label className="space-y-2 text-sm font-medium md:col-span-2">Notes<Textarea value={draft.notes} onChange={e => field("notes", e.target.value)} className="min-h-24" /></label>
    </div>
  );
};

const HistoryFields = ({ draft, setDraft }: {
  draft: AssetHistoryRecord;
  setDraft: React.Dispatch<React.SetStateAction<AssetHistoryRecord>>;
}) => {
  const field = (key: keyof AssetHistoryRecord, value: string) => setDraft(current => ({ ...current, [key]: value }));
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm font-medium">Record Date<Input type="date" value={draft.date} onChange={e => field("date", e.target.value)} /></label>
        <label className="space-y-2 text-sm font-medium">Record Type
          <Select value={draft.type} onValueChange={value => field("type", value)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{["Maintenance", "Calibration", "Repair", "Service", "Inspection", "Installation"].map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
          </Select>
        </label>
      </div>
      <label className="space-y-2 text-sm font-medium">Title<Input value={draft.title} onChange={e => field("title", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Officer / Vendor<Input value={draft.officer} onChange={e => field("officer", e.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">Notes<Textarea value={draft.notes} onChange={e => field("notes", e.target.value)} className="min-h-28" /></label>
    </div>
  );
};

const AssetManagementPage = () => {
  const { toast } = useToast();
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [selectedAsset, setSelectedAsset] = useState<AssetRecord | null>(null);
  const [assetDialog, setAssetDialog] = useState<"add" | "edit" | null>(null);
  const [assetDraft, setAssetDraft] = useState<AssetDraft>(emptyAsset());
  const [historyDialog, setHistoryDialog] = useState<"add" | "edit" | null>(null);
  const [historyDraft, setHistoryDraft] = useState<AssetHistoryRecord>(emptyHistory());
  const [deleteTarget, setDeleteTarget] = useState<"asset" | "history" | null>(null);

  const loadAssets = useCallback(async () => {
    try {
      setLoading(true);
      const rows = await assetService.fetchAssets();
      setAssets(rows);
      setSelectedAsset(current => current ? rows.find(row => row.id === current.id) || null : null);
    } catch (error) {
      toast({ title: "Failed to load assets", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void loadAssets(); }, [loadAssets]);

  const filteredAssets = useMemo(() => assets.filter(asset => {
    const text = [asset.id, asset.name, asset.brand, asset.model, asset.serialNumber, asset.room].join(" ").toLowerCase();
    return (category === "all" || asset.category === category) && text.includes(query.trim().toLowerCase());
  }), [assets, category, query]);

  const saveAsset = async () => {
    if (!assetDraft.id || !assetDraft.name || !assetDraft.serialNumber) {
      toast({ title: "Required fields missing", description: "Asset ID, name, and serial number are required.", variant: "destructive" });
      return;
    }
    try {
      setSaving(true);
      if (assetDialog === "add") await assetService.createAsset({ ...assetDraft, initialHistory: null });
      else if (selectedAsset) await assetService.updateAsset(selectedAsset.id, assetDraft);
      setAssetDialog(null);
      await loadAssets();
      toast({ title: assetDialog === "add" ? "Asset created" : "Asset updated" });
    } catch (error) {
      toast({ title: "Failed to save asset", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const saveHistory = async () => {
    if (!selectedAsset || !historyDraft.date || !historyDraft.title) return;
    try {
      setSaving(true);
      if (historyDialog === "edit" && historyDraft.id) await assetService.updateHistory(selectedAsset.id, historyDraft.id, historyDraft);
      else await assetService.addHistory(selectedAsset.id, historyDraft);
      setHistoryDialog(null);
      await loadAssets();
      toast({ title: "Track record saved" });
    } catch (error) {
      toast({ title: "Failed to save track record", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const confirmDelete = async () => {
    if (!selectedAsset) return;
    try {
      setSaving(true);
      if (deleteTarget === "asset") {
        await assetService.deleteAsset(selectedAsset.id);
        setSelectedAsset(null);
      } else if (historyDraft.id) await assetService.deleteHistory(selectedAsset.id, historyDraft.id);
      setDeleteTarget(null);
      await loadAssets();
      toast({ title: "Data deleted" });
    } catch (error) {
      toast({ title: "Failed to delete data", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const metrics = {
    dueSoon: assets.filter(item => item.status === "due_soon").length,
    overdue: assets.filter(item => item.status === "overdue").length,
    maintenance: assets.filter(item => item.status === "maintenance").length,
    warrantyExpired: assets.filter(item => isExpired(item.warrantyExpiredDate)).length,
  };

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        <div className="flex flex-col justify-between gap-4 rounded-lg border bg-card p-5 shadow-sm lg:flex-row lg:items-center">
          <div className="flex items-center gap-3"><div className="rounded-lg bg-primary/10 p-3 text-primary"><Wrench className="h-5 w-5" /></div><div><h1 className="text-2xl font-semibold">Asset Management</h1><p className="text-sm text-muted-foreground">Real radiology equipment, calibration, and service records.</p></div></div>
          <Button onClick={() => { setAssetDraft(emptyAsset()); setAssetDialog("add"); }}><Plus className="mr-2 h-4 w-4" />Add Asset</Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {[
            ["Total Assets", assets.length, <ClipboardList className="h-5 w-5" />],
            ["Due Soon", metrics.dueSoon, <CalendarClock className="h-5 w-5" />],
            ["Overdue", metrics.overdue, <AlertTriangle className="h-5 w-5" />],
            ["Warranty Expired", metrics.warrantyExpired, <AlertTriangle className="h-5 w-5" />],
            ["Maintenance", metrics.maintenance, <Wrench className="h-5 w-5" />],
          ].map(([label, value, icon]) => <Card key={String(label)}><CardContent className="flex items-center justify-between p-4"><div><p className="text-xs uppercase text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div><div className="rounded-lg bg-primary/10 p-2 text-primary">{icon}</div></CardContent></Card>)}
        </div>
        <Card>
          <CardHeader className="border-b"><div className="flex flex-col justify-between gap-3 sm:flex-row"><CardTitle className="text-base">Asset List</CardTitle><div className="flex gap-2"><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search assets" className="pl-9" /></div><Select value={category} onValueChange={setCategory}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All</SelectItem>{categories.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></div></div></CardHeader>
          <CardContent className="p-5"><div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>Asset</TableHead><TableHead>Brand / Model</TableHead><TableHead>Serial</TableHead><TableHead>Room</TableHead><TableHead>Next Calibration</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>
            {loading ? <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Loading assets...</TableCell></TableRow> : filteredAssets.length === 0 ? <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No assets found. Add the first asset to start.</TableCell></TableRow> : filteredAssets.map(asset => {
              const due = daysUntil(asset.nextCalibrationDate);
              return <TableRow key={asset.id} className="cursor-pointer" onDoubleClick={() => setSelectedAsset(asset)}><TableCell><div className="font-medium">{asset.name}</div><div className="text-xs text-muted-foreground">{asset.id}</div></TableCell><TableCell>{asset.brand}<div className="text-xs text-muted-foreground">{asset.model}</div></TableCell><TableCell className="font-mono text-xs">{asset.serialNumber}</TableCell><TableCell>{asset.room || "-"}</TableCell><TableCell>{formatDate(asset.nextCalibrationDate)}<div className="text-xs text-muted-foreground">{due === null ? "Not scheduled" : due < 0 ? `${Math.abs(due)} days overdue` : `${due} days left`}</div></TableCell><TableCell><StatusBadge status={asset.status} /></TableCell></TableRow>;
            })}
          </TableBody></Table></div></CardContent>
        </Card>
      </div>

      <Dialog open={Boolean(selectedAsset)} onOpenChange={open => !open && setSelectedAsset(null)}><DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto"><DialogHeader><DialogTitle className="flex items-center justify-between pr-8"><span>{selectedAsset?.name}</span>{selectedAsset && <StatusBadge status={selectedAsset.status} />}</DialogTitle></DialogHeader>{selectedAsset && <div className="grid gap-5 lg:grid-cols-[1fr_380px]"><Card><CardHeader><div className="flex justify-between"><CardTitle className="text-base">Asset Detail</CardTitle><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => { const { status, history, ...draft } = selectedAsset; setAssetDraft(draft); setAssetDialog("edit"); }}><Edit2 className="mr-1 h-4 w-4" />Edit</Button><Button size="sm" variant="destructive" onClick={() => setDeleteTarget("asset")}><Trash2 className="mr-1 h-4 w-4" />Delete</Button></div></div></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">{[["Asset ID", selectedAsset.id], ["Serial", selectedAsset.serialNumber], ["Category", selectedAsset.category], ["Room", selectedAsset.room], ["Brand", selectedAsset.brand], ["Model", selectedAsset.model], ["Purchase", formatDate(selectedAsset.purchaseDate)], ["Warranty", formatDate(selectedAsset.warrantyExpiredDate)], ["Last Calibration", formatDate(selectedAsset.lastCalibrationDate)], ["Next Calibration", formatDate(selectedAsset.nextCalibrationDate)], ["PIC", selectedAsset.responsiblePerson], ["Vendor", selectedAsset.vendor]].map(([label, value]) => <div key={label} className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium">{value || "-"}</div></div>)}<div className="rounded-lg border p-3 sm:col-span-2"><div className="text-xs text-muted-foreground">Notes</div><p className="mt-1 text-sm">{selectedAsset.notes || "-"}</p></div></CardContent></Card>
        <Card><CardHeader><div className="flex justify-between"><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" />Track Record</CardTitle><Button size="sm" onClick={() => { setHistoryDraft(emptyHistory()); setHistoryDialog("add"); }}><Plus className="mr-1 h-4 w-4" />Add</Button></div></CardHeader><CardContent className="space-y-3">{selectedAsset.history.length === 0 ? <p className="text-sm text-muted-foreground">No track records.</p> : selectedAsset.history.map(record => <div key={record.id} className="rounded-lg border p-3"><div className="flex justify-between gap-2"><div><div className="font-medium">{record.title}</div><div className="text-xs text-muted-foreground">{formatDate(record.date)} | {record.officer || "-"}</div></div><Badge variant="outline">{record.type}</Badge></div><p className="mt-2 text-sm text-muted-foreground">{record.notes || "-"}</p><div className="mt-2 flex justify-end gap-1"><Button size="icon" variant="ghost" onClick={() => { setHistoryDraft(record); setHistoryDialog("edit"); }}><Edit2 className="h-4 w-4" /></Button><Button size="icon" variant="ghost" className="text-destructive" onClick={() => { setHistoryDraft(record); setDeleteTarget("history"); }}><Trash2 className="h-4 w-4" /></Button></div></div>)}</CardContent></Card></div>}</DialogContent></Dialog>

      <Dialog open={Boolean(assetDialog)} onOpenChange={open => !open && setAssetDialog(null)}><DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>{assetDialog === "add" ? "Add Asset" : "Edit Asset"}</DialogTitle></DialogHeader><AssetFields draft={assetDraft} setDraft={setAssetDraft} idLocked={assetDialog === "edit"} /><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setAssetDialog(null)}>Cancel</Button><Button disabled={saving} onClick={saveAsset}>{saving ? "Saving..." : "Save Asset"}</Button></div></DialogContent></Dialog>
      <Dialog open={Boolean(historyDialog)} onOpenChange={open => !open && setHistoryDialog(null)}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>{historyDialog === "add" ? "Add Track Record" : "Edit Track Record"}</DialogTitle></DialogHeader><HistoryFields draft={historyDraft} setDraft={setHistoryDraft} /><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setHistoryDialog(null)}>Cancel</Button><Button disabled={saving} onClick={saveHistory}>{saving ? "Saving..." : "Save Record"}</Button></div></DialogContent></Dialog>
      <Dialog open={Boolean(deleteTarget)} onOpenChange={open => !open && setDeleteTarget(null)}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Delete {deleteTarget === "asset" ? "Asset" : "Track Record"}</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">This action permanently removes the selected data from the database.</p><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={saving} onClick={confirmDelete}>{saving ? "Deleting..." : "Delete"}</Button></div></DialogContent></Dialog>
    </div>
  );
};

export default AssetManagementPage;
