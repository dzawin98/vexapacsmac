import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ClipboardList,
  Edit2,
  FileText,
  History,
  Plus,
  Search,
  Trash2,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

type AssetStatus = "active" | "due_soon" | "overdue" | "maintenance";
type AssetCategory = "XRAY" | "CT" | "USG" | "CR" | "DR";

type TrackRecord = {
  date: string;
  type: string;
  title: string;
  officer: string;
  notes: string;
};

type AssetRecord = {
  id: string;
  name: string;
  category: AssetCategory;
  brand: string;
  model: string;
  serialNumber: string;
  room: string;
  purchaseDate: string;
  warrantyExpiredDate: string;
  lastCalibrationDate: string;
  nextCalibrationDate: string;
  status: AssetStatus;
  responsiblePerson: string;
  vendor: string;
  notes: string;
  history: TrackRecord[];
};

const assets: AssetRecord[] = [
  {
    id: "AST-XR-001",
    name: "XRAY General Radiography 1",
    category: "XRAY",
    brand: "Siemens",
    model: "Multix Select DR",
    serialNumber: "XR-2021-00931",
    room: "Radiology Room 1",
    purchaseDate: "2021-08-12",
    warrantyExpiredDate: "2024-08-12",
    lastCalibrationDate: "2025-12-15",
    nextCalibrationDate: "2026-06-15",
    status: "due_soon",
    responsiblePerson: "Radiografer Koordinator",
    vendor: "PT Medika Imaging",
    notes: "Tube masih stabil. Perlu follow up minor noise pada detector kiri bawah.",
    history: [
      {
        date: "2025-12-15",
        type: "Calibration",
        title: "Kalibrasi semester rutin",
        officer: "BPFK Jakarta",
        notes: "Output exposure dan alignment masih dalam toleransi.",
      },
      {
        date: "2025-10-04",
        type: "Maintenance",
        title: "Preventive maintenance",
        officer: "PT Medika Imaging",
        notes: "Pembersihan detector, cek kabel, dan update service log.",
      },
      {
        date: "2024-12-16",
        type: "Calibration",
        title: "Kalibrasi tahunan",
        officer: "BPFK Jakarta",
        notes: "Lulus uji kesesuaian.",
      },
    ],
  },
  {
    id: "AST-CT-001",
    name: "CT Scan 128 Slice",
    category: "CT",
    brand: "GE",
    model: "Revolution EVO",
    serialNumber: "CT-128-77820",
    room: "CT Room",
    purchaseDate: "2020-03-20",
    warrantyExpiredDate: "2027-03-20",
    lastCalibrationDate: "2026-02-02",
    nextCalibrationDate: "2027-02-02",
    status: "active",
    responsiblePerson: "Kepala Instalasi Radiologi",
    vendor: "PT Global Healthtech",
    notes: "Kontrak service aktif sampai Maret 2027. Tube usage dipantau bulanan.",
    history: [
      {
        date: "2026-02-02",
        type: "Calibration",
        title: "Kalibrasi dan uji performa CT",
        officer: "Vendor + Fisikawan Medis",
        notes: "CTDI phantom sesuai baseline.",
      },
      {
        date: "2025-11-18",
        type: "Service",
        title: "Tube warmup issue",
        officer: "PT Global Healthtech",
        notes: "Parameter warmup dikembalikan ke rekomendasi vendor.",
      },
    ],
  },
  {
    id: "AST-US-002",
    name: "USG Abdomen Portable",
    category: "USG",
    brand: "Mindray",
    model: "M9",
    serialNumber: "US-M9-44110",
    room: "USG Room 2",
    purchaseDate: "2022-11-05",
    warrantyExpiredDate: "2025-11-05",
    lastCalibrationDate: "2025-05-10",
    nextCalibrationDate: "2026-05-10",
    status: "overdue",
    responsiblePerson: "Supervisor USG",
    vendor: "PT Diagnostik Prima",
    notes: "Kalibrasi sudah melewati jadwal. Prioritaskan booking vendor minggu ini.",
    history: [
      {
        date: "2025-05-10",
        type: "Calibration",
        title: "Kalibrasi probe dan display",
        officer: "PT Diagnostik Prima",
        notes: "Probe convex baik, probe linear direkomendasikan inspeksi ulang.",
      },
      {
        date: "2025-01-22",
        type: "Repair",
        title: "Penggantian kabel probe",
        officer: "PT Diagnostik Prima",
        notes: "Kabel probe linear diganti.",
      },
    ],
  },
  {
    id: "AST-DR-003",
    name: "Mobile DR Ward",
    category: "DR",
    brand: "Canon",
    model: "MobileDaRt Evolution",
    serialNumber: "MDR-552190",
    room: "Mobile Unit",
    purchaseDate: "2023-04-17",
    warrantyExpiredDate: "2026-04-17",
    lastCalibrationDate: "2026-01-08",
    nextCalibrationDate: "2026-07-08",
    status: "maintenance",
    responsiblePerson: "Radiografer Shift Mobile",
    vendor: "PT Radmed Nusantara",
    notes: "Sedang menunggu sparepart brake handle. Unit masih bisa standby terbatas.",
    history: [
      {
        date: "2026-05-26",
        type: "Maintenance",
        title: "Brake handle loose",
        officer: "PT Radmed Nusantara",
        notes: "Sparepart dipesan. Estimasi tiba 7 hari kerja.",
      },
      {
        date: "2026-01-08",
        type: "Calibration",
        title: "Kalibrasi mobile DR",
        officer: "BPFK Jakarta",
        notes: "Exposure repeatability baik.",
      },
    ],
  },
];

const formatDate = (value: string) =>
  new Date(`${value}T00:00:00`).toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

const daysUntil = (value: string) => {
  const target = new Date(`${value}T00:00:00`).getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((target - today.getTime()) / 86400000);
};

const isExpired = (value: string) => daysUntil(value) < 0;

const statusConfig: Record<AssetStatus, { label: string; className: string }> = {
  active: {
    label: "Active",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300",
  },
  due_soon: {
    label: "Due Soon",
    className: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300",
  },
  overdue: {
    label: "Overdue",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  maintenance: {
    label: "Maintenance",
    className: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300",
  },
};

const StatusBadge = ({ status }: { status: AssetStatus }) => (
  <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusConfig[status].className}`}>
    {statusConfig[status].label}
  </span>
);

const emptyTrackRecord: TrackRecord = {
  date: "2026-06-01",
  type: "Maintenance",
  title: "",
  officer: "",
  notes: "",
};

const MetricCard = ({
  title,
  value,
  icon,
}: {
  title: string;
  value: string | number;
  icon: React.ReactNode;
}) => (
  <Card className="rounded-lg border-border shadow-sm">
    <CardContent className="flex items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      </div>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
    </CardContent>
  </Card>
);

const AssetManagementPage = () => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [selectedAsset, setSelectedAsset] = useState<AssetRecord | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editAssetOpen, setEditAssetOpen] = useState(false);
  const [deleteAssetOpen, setDeleteAssetOpen] = useState(false);
  const [trackDialogMode, setTrackDialogMode] = useState<"add" | "edit" | null>(null);
  const [trackRecordDraft, setTrackRecordDraft] = useState<TrackRecord>(emptyTrackRecord);
  const [deleteTrackRecord, setDeleteTrackRecord] = useState<TrackRecord | null>(null);

  const filteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return assets.filter(asset => {
      const matchCategory = category === "all" || asset.category === category;
      const matchQuery =
        !normalizedQuery ||
        [asset.name, asset.id, asset.brand, asset.model, asset.serialNumber, asset.room]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      return matchCategory && matchQuery;
    });
  }, [category, query]);

  const dueSoonCount = assets.filter(asset => asset.status === "due_soon").length;
  const overdueCount = assets.filter(asset => asset.status === "overdue").length;
  const maintenanceCount = assets.filter(asset => asset.status === "maintenance").length;
  const warrantyExpiredCount = assets.filter(asset => isExpired(asset.warrantyExpiredDate)).length;

  const openAddTrackRecord = () => {
    setTrackRecordDraft({
      date: "2026-06-01",
      type: "Maintenance",
      title: "Kunjungan teknisi rutin",
      officer: selectedAsset?.vendor || "",
      notes: "Teknisi melakukan pengecekan fungsi alat dan membersihkan komponen utama.",
    });
    setTrackDialogMode("add");
  };

  const openEditTrackRecord = (record: TrackRecord) => {
    setTrackRecordDraft(record);
    setTrackDialogMode("edit");
  };

  return (
    <div className="admin-command-page min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Wrench className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Asset Management</h1>
              </div>
            </div>
            <Button className="h-10 rounded-lg" onClick={() => setAddDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Asset
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <MetricCard title="Total Assets" value={assets.length} icon={<ClipboardList className="h-5 w-5" />} />
          <MetricCard title="Due Soon" value={dueSoonCount} icon={<CalendarClock className="h-5 w-5" />} />
          <MetricCard title="Overdue" value={overdueCount} icon={<AlertTriangle className="h-5 w-5" />} />
          <MetricCard title="Warranty Expired" value={warrantyExpiredCount} icon={<AlertTriangle className="h-5 w-5" />} />
          <MetricCard title="Maintenance" value={maintenanceCount} icon={<Wrench className="h-5 w-5" />} />
        </div>

        <div className="grid gap-5">
          <Card className="rounded-lg border-border shadow-sm">
            <CardHeader className="border-b border-border p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <CardTitle className="text-base">Asset List</CardTitle>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={event => setQuery(event.target.value)}
                      placeholder="Search asset, serial, room"
                      className="h-10 w-full rounded-lg pl-9 sm:w-[260px]"
                    />
                  </div>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger className="h-10 rounded-lg sm:w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All equipment</SelectItem>
                      <SelectItem value="XRAY">XRAY</SelectItem>
                      <SelectItem value="CT">CT</SelectItem>
                      <SelectItem value="USG">USG</SelectItem>
                      <SelectItem value="CR">CR</SelectItem>
                      <SelectItem value="DR">DR</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-5">
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Asset</TableHead>
                      <TableHead>Brand / Model</TableHead>
                      <TableHead>Serial Number</TableHead>
                      <TableHead>Room</TableHead>
                      <TableHead>Purchase Date</TableHead>
                      <TableHead>Warranty Expired</TableHead>
                      <TableHead>Last Calibration</TableHead>
                      <TableHead>Next Due</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAssets.map(asset => {
                      const dueDays = daysUntil(asset.nextCalibrationDate);
                      return (
                        <TableRow
                          key={asset.id}
                          className="cursor-pointer transition-colors hover:bg-muted/35"
                          onDoubleClick={() => setSelectedAsset(asset)}
                          title="Double click to open asset details"
                        >
                          <TableCell>
                            <div className="font-medium">{asset.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {asset.id}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div>{asset.brand}</div>
                            <div className="text-xs text-muted-foreground">{asset.model}</div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{asset.serialNumber}</TableCell>
                          <TableCell>{asset.room}</TableCell>
                          <TableCell>{formatDate(asset.purchaseDate)}</TableCell>
                          <TableCell>
                            <div>{formatDate(asset.warrantyExpiredDate)}</div>
                            <div className={isExpired(asset.warrantyExpiredDate) ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                              {isExpired(asset.warrantyExpiredDate) ? "Expired" : "Active"}
                            </div>
                          </TableCell>
                          <TableCell>{formatDate(asset.lastCalibrationDate)}</TableCell>
                          <TableCell>
                            <div>{formatDate(asset.nextCalibrationDate)}</div>
                            <div className="text-xs text-muted-foreground">
                              {dueDays < 0 ? `${Math.abs(dueDays)} days overdue` : `${dueDays} days left`}
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={asset.status} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>

        <Dialog open={Boolean(selectedAsset)} onOpenChange={open => !open && setSelectedAsset(null)}>
          <DialogContent className="max-h-[88vh] max-w-5xl overflow-hidden rounded-lg p-0 [&>button.absolute]:hidden">
            <DialogHeader className="border-b border-border px-6 py-4">
              <DialogTitle className="flex flex-wrap items-start justify-between gap-3 text-lg">
                <span>
                  {selectedAsset?.name}
                  <span className="mt-1 block text-sm font-normal text-muted-foreground">
                    {selectedAsset ? `${selectedAsset.brand} ${selectedAsset.model}` : ""}
                  </span>
                </span>
                {selectedAsset && (
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={selectedAsset.status} />
                    <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg" onClick={() => setEditAssetOpen(true)}>
                      <Edit2 className="mr-1.5 h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-lg text-destructive hover:text-destructive"
                      onClick={() => setDeleteAssetOpen(true)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </span>
                )}
              </DialogTitle>
            </DialogHeader>

            {selectedAsset && (
              <div className="max-h-[calc(88vh-88px)] overflow-y-auto px-6 pb-6 pt-5">
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                  <div className="space-y-5">
                    <Card className="rounded-lg border-border shadow-sm">
                      <CardHeader className="border-b border-border p-5">
                        <CardTitle className="text-base">Asset Detail</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4 p-5">
                        <div className="grid gap-3 sm:grid-cols-2">
                          {[
                            ["Asset ID", selectedAsset.id],
                            ["Serial Number", selectedAsset.serialNumber],
                            ["Category", selectedAsset.category],
                            ["Room", selectedAsset.room],
                            ["Purchase Date", formatDate(selectedAsset.purchaseDate)],
                            ["Warranty Expired", formatDate(selectedAsset.warrantyExpiredDate)],
                            ["Vendor", selectedAsset.vendor],
                            ["PIC", selectedAsset.responsiblePerson],
                            ["Last Calibration", formatDate(selectedAsset.lastCalibrationDate)],
                            ["Next Calibration", formatDate(selectedAsset.nextCalibrationDate)],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded-lg border border-border bg-background px-3 py-2">
                              <div className="text-xs text-muted-foreground">{label}</div>
                              <div className="mt-1 text-sm font-medium">{value}</div>
                            </div>
                          ))}
                        </div>

                        <div className="rounded-lg border border-border bg-muted/20 p-3">
                          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                            <FileText className="h-4 w-4 text-primary" />
                            Notes
                          </div>
                          <p className="text-sm leading-6 text-muted-foreground">{selectedAsset.notes}</p>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <Card className="rounded-lg border-border shadow-sm">
                    <CardHeader className="border-b border-border p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <History className="h-4 w-4 text-primary" />
                          <CardTitle className="text-base">Track Record</CardTitle>
                        </div>
                        <Button type="button" size="sm" className="h-8 rounded-lg" onClick={openAddTrackRecord}>
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="p-5">
                      <div className="space-y-3">
                        {selectedAsset.history.map((item, index) => (
                          <div key={`${item.date}-${index}`} className="rounded-lg border border-border bg-background p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="font-medium">{item.title}</div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {formatDate(item.date)} | {item.officer}
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Badge variant="outline">{item.type}</Badge>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-lg"
                                  onClick={() => openEditTrackRecord(item)}
                                  title="Edit track record"
                                >
                                  <Edit2 className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-lg text-destructive hover:text-destructive"
                                  onClick={() => setDeleteTrackRecord(item)}
                                  title="Delete track record"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.notes}</p>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden rounded-lg p-0">
            <DialogHeader className="border-b border-border px-6 py-4">
              <DialogTitle className="text-lg">Add Asset</DialogTitle>
            </DialogHeader>
            <div className="max-h-[calc(88vh-84px)] overflow-y-auto px-6 pb-6 pt-5">
              <div className="grid gap-5">
                <Card className="rounded-lg border-border shadow-sm">
                  <CardHeader className="border-b border-border p-5">
                    <CardTitle className="text-base">Asset Identity</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-4 p-5 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Asset ID</label>
                      <Input defaultValue="AST-XR-004" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Asset Name</label>
                      <Input defaultValue="XRAY Mobile IGD" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Category</label>
                      <Select defaultValue="XRAY">
                        <SelectTrigger className="rounded-lg">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="XRAY">XRAY</SelectItem>
                          <SelectItem value="CT">CT</SelectItem>
                          <SelectItem value="USG">USG</SelectItem>
                          <SelectItem value="CR">CR</SelectItem>
                          <SelectItem value="DR">DR</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Room / Location</label>
                      <Input defaultValue="IGD Radiology Corner" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Brand</label>
                      <Input defaultValue="Shimadzu" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Model</label>
                      <Input defaultValue="MobileArt Evolution MX8" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Serial Number</label>
                      <Input defaultValue="MX8-IDG-2026-014" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Responsible Person</label>
                      <Input defaultValue="Radiografer IGD" className="rounded-lg" />
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-lg border-border shadow-sm">
                  <CardHeader className="border-b border-border p-5">
                    <CardTitle className="text-base">Purchase, Warranty, and Calibration</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-4 p-5 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Purchase Date</label>
                      <Input type="date" defaultValue="2026-03-15" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Warranty Expired</label>
                      <Input type="date" defaultValue="2029-03-15" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Last Calibration</label>
                      <Input type="date" defaultValue="2026-03-20" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Next Calibration</label>
                      <Input type="date" defaultValue="2026-09-20" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Vendor</label>
                      <Input defaultValue="PT Radiologi Sehat Indonesia" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Status</label>
                      <Select defaultValue="active">
                        <SelectTrigger className="rounded-lg">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="due_soon">Due Soon</SelectItem>
                          <SelectItem value="overdue">Overdue</SelectItem>
                          <SelectItem value="maintenance">Maintenance</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-lg border-border shadow-sm">
                  <CardHeader className="border-b border-border p-5">
                    <CardTitle className="text-base">Initial Track Record and Notes</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-4 p-5">
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Record Date</label>
                        <Input type="date" defaultValue="2026-03-20" className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Record Type</label>
                        <Input defaultValue="Installation" className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Officer / Vendor</label>
                        <Input defaultValue="PT Radiologi Sehat Indonesia" className="rounded-lg" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Record Title</label>
                      <Input defaultValue="Instalasi awal dan acceptance test" className="rounded-lg" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Notes</label>
                      <Textarea
                        defaultValue="Unit diterima dalam kondisi baik. Training operator sudah dilakukan untuk shift pagi dan sore."
                        className="min-h-[110px] rounded-lg"
                      />
                    </div>
                    <div className="flex justify-end gap-2 border-t border-border pt-4">
                      <Button type="button" variant="outline" className="rounded-lg" onClick={() => setAddDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button type="button" className="rounded-lg" disabled>
                        Save Draft
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={editAssetOpen} onOpenChange={setEditAssetOpen}>
          <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden rounded-lg p-0">
            <DialogHeader className="border-b border-border px-6 py-4">
              <DialogTitle className="text-lg">Edit Asset</DialogTitle>
            </DialogHeader>
            {selectedAsset && (
              <div className="max-h-[calc(88vh-84px)] overflow-y-auto px-6 pb-6 pt-5">
                <div className="grid gap-5">
                  <Card className="rounded-lg border-border shadow-sm">
                    <CardHeader className="border-b border-border p-5">
                      <CardTitle className="text-base">Asset Identity</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 p-5 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Asset ID</label>
                        <Input defaultValue={selectedAsset.id} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Asset Name</label>
                        <Input defaultValue={selectedAsset.name} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Category</label>
                        <Select defaultValue={selectedAsset.category}>
                          <SelectTrigger className="rounded-lg">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="XRAY">XRAY</SelectItem>
                            <SelectItem value="CT">CT</SelectItem>
                            <SelectItem value="USG">USG</SelectItem>
                            <SelectItem value="CR">CR</SelectItem>
                            <SelectItem value="DR">DR</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Room / Location</label>
                        <Input defaultValue={selectedAsset.room} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Brand</label>
                        <Input defaultValue={selectedAsset.brand} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Model</label>
                        <Input defaultValue={selectedAsset.model} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Serial Number</label>
                        <Input defaultValue={selectedAsset.serialNumber} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Responsible Person</label>
                        <Input defaultValue={selectedAsset.responsiblePerson} className="rounded-lg" />
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="rounded-lg border-border shadow-sm">
                    <CardHeader className="border-b border-border p-5">
                      <CardTitle className="text-base">Purchase, Warranty, and Calibration</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 p-5 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Purchase Date</label>
                        <Input type="date" defaultValue={selectedAsset.purchaseDate} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Warranty Expired</label>
                        <Input type="date" defaultValue={selectedAsset.warrantyExpiredDate} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Last Calibration</label>
                        <Input type="date" defaultValue={selectedAsset.lastCalibrationDate} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Next Calibration</label>
                        <Input type="date" defaultValue={selectedAsset.nextCalibrationDate} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Vendor</label>
                        <Input defaultValue={selectedAsset.vendor} className="rounded-lg" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Status</label>
                        <Select defaultValue={selectedAsset.status}>
                          <SelectTrigger className="rounded-lg">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="active">Active</SelectItem>
                            <SelectItem value="due_soon">Due Soon</SelectItem>
                            <SelectItem value="overdue">Overdue</SelectItem>
                            <SelectItem value="maintenance">Maintenance</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="rounded-lg border-border shadow-sm">
                    <CardHeader className="border-b border-border p-5">
                      <CardTitle className="text-base">Notes</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 p-5">
                      <Textarea defaultValue={selectedAsset.notes} className="min-h-[120px] rounded-lg" />
                      <div className="flex justify-end gap-2 border-t border-border pt-4">
                        <Button type="button" variant="outline" className="rounded-lg" onClick={() => setEditAssetOpen(false)}>
                          Cancel
                        </Button>
                        <Button type="button" className="rounded-lg" disabled>
                          Update Asset
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={deleteAssetOpen} onOpenChange={setDeleteAssetOpen}>
          <DialogContent className="max-w-md rounded-lg">
            <DialogHeader>
              <DialogTitle>Delete Asset</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm leading-6 text-muted-foreground">
                This action will remove the selected asset and its track record from Asset Management.
              </p>
              {selectedAsset && (
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="font-medium">{selectedAsset.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {selectedAsset.id} | {selectedAsset.serialNumber}
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium">Delete Reason</label>
                <Textarea
                  defaultValue="Aset dipindahkan ke luar instalasi / data sudah tidak aktif."
                  className="min-h-[90px] rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" className="rounded-lg" onClick={() => setDeleteAssetOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" className="rounded-lg" disabled>
                  Delete Asset
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(trackDialogMode)} onOpenChange={open => !open && setTrackDialogMode(null)}>
          <DialogContent className="max-w-2xl rounded-lg p-0">
            <DialogHeader className="border-b border-border px-6 py-4">
              <DialogTitle className="text-lg">
                {trackDialogMode === "edit" ? "Edit Track Record" : "Add Track Record"}
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 px-6 py-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Record Date</label>
                  <Input
                    type="date"
                    value={trackRecordDraft.date}
                    onChange={event => setTrackRecordDraft(current => ({ ...current, date: event.target.value }))}
                    className="rounded-lg"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Record Type</label>
                  <Select
                    value={trackRecordDraft.type}
                    onValueChange={value => setTrackRecordDraft(current => ({ ...current, type: value }))}
                  >
                    <SelectTrigger className="rounded-lg">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Maintenance">Maintenance</SelectItem>
                      <SelectItem value="Calibration">Calibration</SelectItem>
                      <SelectItem value="Repair">Repair</SelectItem>
                      <SelectItem value="Service">Service</SelectItem>
                      <SelectItem value="Inspection">Inspection</SelectItem>
                      <SelectItem value="Installation">Installation</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Record Title</label>
                <Input
                  value={trackRecordDraft.title}
                  onChange={event => setTrackRecordDraft(current => ({ ...current, title: event.target.value }))}
                  placeholder="Example: Kunjungan teknisi rutin"
                  className="rounded-lg"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Officer / Vendor</label>
                <Input
                  value={trackRecordDraft.officer}
                  onChange={event => setTrackRecordDraft(current => ({ ...current, officer: event.target.value }))}
                  placeholder="Example: PT Medika Imaging"
                  className="rounded-lg"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Notes</label>
                <Textarea
                  value={trackRecordDraft.notes}
                  onChange={event => setTrackRecordDraft(current => ({ ...current, notes: event.target.value }))}
                  placeholder="Write technician activity, findings, follow-up, and recommendations."
                  className="min-h-[130px] rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-border pt-4">
                <Button type="button" variant="outline" className="rounded-lg" onClick={() => setTrackDialogMode(null)}>
                  Cancel
                </Button>
                <Button type="button" className="rounded-lg" disabled>
                  {trackDialogMode === "edit" ? "Update Record" : "Save Record"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(deleteTrackRecord)} onOpenChange={open => !open && setDeleteTrackRecord(null)}>
          <DialogContent className="max-w-md rounded-lg">
            <DialogHeader>
              <DialogTitle>Delete Track Record</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm leading-6 text-muted-foreground">
                This will remove the selected technician activity from this asset track record.
              </p>
              {deleteTrackRecord && (
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="font-medium">{deleteTrackRecord.title}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDate(deleteTrackRecord.date)} | {deleteTrackRecord.officer}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" className="rounded-lg" onClick={() => setDeleteTrackRecord(null)}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" className="rounded-lg" disabled>
                  Delete
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default AssetManagementPage;
