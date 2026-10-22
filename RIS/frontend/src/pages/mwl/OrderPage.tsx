import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, ChevronsUpDown, Eye, Filter, Loader2, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  MwlAssignedStaff,
  MwlDoctor,
  MwlOrder,
  MwlPatient,
  MwlStudyMaster,
  dicomWebService,
  mwlService,
} from "@/lib/dicomService";
import { MwlDataTable, MwlTableColumn } from "@/components/mwl/MwlDataTable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DetailGrid, DetailHero, DetailItem, DetailSection } from "@/components/mwl/DetailDialogSections";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";

const toLocalDate = (value = new Date()) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate()
  ).padStart(2, "0")}`;

const toLocalDateTime = (value = new Date()) =>
  `${toLocalDate(value)}T${String(value.getHours()).padStart(2, "0")}:${String(
    value.getMinutes()
  ).padStart(2, "0")}`;

const emptyForm = {
  patientRecordId: "",
  studyMasterId: "",
  accessionNumber: "",
  noRegister: "",
  tanggalOrder: toLocalDateTime(),
  tanggalAktivasi: "",
  studyDate: toLocalDate(),
  studyTime: "",
  modality: "",
  cito: "0",
  polirawat: "O",
  kodeRuangan: "",
  namaRuangan: "",
  procedureCode: "",
  procedureDesc: "",
  klinis: "",
  diagnosa: "",
  kodePemeriksaan: "",
  namaPemeriksaan: "",
  caraBayar: "",
  kodeAsuransi: "",
  namaAsuransi: "",
  kodeInstalasiRadiologi: "",
  namaInstalasiRadiologi: "",
  updateRis: "N",
  referringPhysician: "",
  referringDoctorId: "",
  radiologistDoctorId: "",
  technologistDoctorId: "",
};

const statusLabel: Record<string, string> = {
  PENDING: "Pending",
  SENT_TO_MWL: "Scheduled",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const parseAssignedStaff = (value?: string | null): MwlAssignedStaff[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const formatAssignedStaff = (value?: string | null) => {
  const assigned = parseAssignedStaff(value);
  if (!assigned.length) return "-";
  return assigned.map(item => `${item.nama_dokter} (${item.role})`).join(", ");
};

const getOrderDateTimeValue = (order?: MwlOrder | null) =>
  order?.tanggal_order || order?.order_in_tanggal_order || null;

const getOrderActivationDateTimeValue = (order?: MwlOrder | null) =>
  order?.tanggal_aktivasi || order?.order_in_tanggal_aktivasi || null;

const formatOrderDateTime = (value?: string | null) =>
  value ? String(value).slice(0, 16).replace("T", " ") : "-";

const normalizeCitoValue = (value?: string | boolean | null) => {
  if (typeof value === "boolean") return value ? "1" : "0";
  const normalized = String(value || "").trim().toUpperCase();
  if (["1", "Y", "YES", "TRUE", "S", "E", "CITO", "EMERGENCY"].includes(normalized)) return "1";
  return "0";
};

type DatePreset = "today" | "7days" | "1month" | "2months" | "range";

const toDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const matchesOrderDatePreset = (order: MwlOrder, preset: DatePreset, fromDate: string, toDateValue: string): boolean => {
  const date = toDate(getOrderDateTimeValue(order) || order.study_date);
  if (!date) return false;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const today = new Date();
  const todayStart = startOf(today);
  const dateOnly = startOf(date);

  if (preset === "today") return dateOnly.getTime() === todayStart.getTime();
  if (preset === "7days") {
    const diff = todayStart.getTime() - dateOnly.getTime();
    const deltaDays = diff / (1000 * 60 * 60 * 24);
    return deltaDays >= 0 && deltaDays <= 7;
  }
  if (preset === "1month" || preset === "2months") {
    const from = new Date(todayStart);
    from.setMonth(from.getMonth() - (preset === "1month" ? 1 : 2));
    return date >= from && date <= endOf(today);
  }
  if (!fromDate || !toDateValue) return false;
  const from = toDate(fromDate);
  const to = toDate(toDateValue);
  if (from && date < startOf(from)) return false;
  if (to && date > endOf(to)) return false;
  return true;
};

const formatActiveDateFilterLabel = (preset: DatePreset, fromDate: string, toDateValue: string) => {
  if (preset === "today") return "Today";
  if (preset === "7days") return "Last 7 Days";
  if (preset === "1month") return "Last 1 Month";
  if (preset === "2months") return "Last 2 Months";
  if (preset === "range") {
    if (fromDate && toDateValue) return `Custom Range: ${fromDate} to ${toDateValue}`;
    if (fromDate) return `Custom Range: from ${fromDate}`;
    if (toDateValue) return `Custom Range: until ${toDateValue}`;
    return "Custom Range";
  }
  return "Today";
};

const OrderPage = () => {
  const { toast } = useToast();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const [patients, setPatients] = useState<MwlPatient[]>([]);
  const [studyMasters, setStudyMasters] = useState<MwlStudyMaster[]>([]);
  const [doctors, setDoctors] = useState<MwlDoctor[]>([]);
  const [orders, setOrders] = useState<MwlOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [studySearchOpen, setStudySearchOpen] = useState(false);
  const [patientSearchOpen, setPatientSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [fromDate, setFromDate] = useState("");
  const [toDateValue, setToDateValue] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<MwlOrder | null>(null);
  const [editingOrder, setEditingOrder] = useState<MwlOrder | null>(null);
  const [form, setForm] = useState({ ...emptyForm });

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    const searchTerm = search.trim();
    if (!silent) setLoading(true);
    try {
      const [patientRows, orderRows, studyRows, doctorRows] = await Promise.all([
        mwlService.fetchPatients(),
        mwlService.fetchOrders({ status: "ALL", q: searchTerm || undefined, includeDeleted: Boolean(searchTerm) }),
        mwlService.fetchStudyMasters(),
        mwlService.fetchDoctors({ role: "ALL" }),
      ]);
      setPatients(patientRows);
      setOrders(orderRows);
      setStudyMasters(studyRows);
      setDoctors(doctorRows);
    } catch (error) {
      toast({
        title: "Failed to load order data",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [search, toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    let active = true;
    dicomWebService.fetchUiSettings()
      .then(settings => {
        if (active) setAutoRefreshEnabled(typeof settings.autoRefresh === "boolean" ? settings.autoRefresh : true);
      })
      .catch(() => {
        if (active) setAutoRefreshEnabled(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!autoRefreshEnabled || dialogOpen || detailOpen) return;
    const id = window.setInterval(() => {
      loadData({ silent: true });
    }, 30000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, dialogOpen, detailOpen, loadData]);

  const selectedStudyMaster = studyMasters.find(item => String(item.id) === form.studyMasterId);
  const selectedPatient = patients.find(item => String(item.id) === form.patientRecordId);
  const clinicians = useMemo(() => doctors.filter(item => item.role === "CLINICIAN"), [doctors]);
  const radiologists = useMemo(() => doctors.filter(item => item.role === "RADIOLOGIST"), [doctors]);
  const technologists = useMemo(() => doctors.filter(item => item.role === "TECHNOLOGIST"), [doctors]);

  const resetForm = () => {
    setForm({ ...emptyForm, tanggalOrder: toLocalDateTime(), studyDate: toLocalDate() });
    setEditingOrder(null);
  };

  const applyStudyMaster = (item: MwlStudyMaster) =>
    setForm(prev => ({
      ...prev,
      studyMasterId: String(item.id),
      modality: item.modality_code,
      procedureCode: item.procedure_code,
      procedureDesc: item.study_description,
    }));

  const openCreateDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openDetailDialog = (order: MwlOrder) => {
    setSelectedOrder(order);
    setDetailOpen(true);
  };

  const openEditDialog = (order: MwlOrder) => {
    setEditingOrder(order);
    setForm({
      patientRecordId: String(order.patient_record_id),
      studyMasterId: order.study_master_id ? String(order.study_master_id) : "",
      accessionNumber: order.accession_number || "",
      noRegister: order.no_register || "",
      tanggalOrder: getOrderDateTimeValue(order) ? String(getOrderDateTimeValue(order)).slice(0, 16) : "",
      tanggalAktivasi: getOrderActivationDateTimeValue(order) ? String(getOrderActivationDateTimeValue(order)).slice(0, 16) : "",
      studyDate: order.study_date ? String(order.study_date).slice(0, 10) : toLocalDate(),
      studyTime: order.study_time ? String(order.study_time).slice(0, 5) : "",
      modality: order.modality || "",
      cito: normalizeCitoValue(order.cito),
      polirawat: order.polirawat || "O",
      kodeRuangan: order.kode_ruangan || "",
      namaRuangan: order.nama_ruangan || "",
      procedureCode: order.procedure_code || order.study_master_procedure_code || "",
      procedureDesc: order.procedure_desc || "",
      klinis: order.klinis || "",
      diagnosa: order.diagnosa || "",
      kodePemeriksaan: order.kode_pemeriksaan || "",
      namaPemeriksaan: order.nama_pemeriksaan || "",
      caraBayar: order.cara_bayar || "",
      kodeAsuransi: order.kode_asuransi || "",
      namaAsuransi: order.nama_asuransi || "",
      kodeInstalasiRadiologi: order.kode_instalasi_radiologi || "",
      namaInstalasiRadiologi: order.nama_instalasi_radiologi || "",
      updateRis: order.update_ris || "N",
      referringPhysician: order.referring_physician || "",
      referringDoctorId: order.referring_doctor_id ? String(order.referring_doctor_id) : "",
      radiologistDoctorId: order.radiologist_doctor_id ? String(order.radiologist_doctor_id) : "",
      technologistDoctorId: order.technologist_id || order.technologist_doctor_id ? String(order.technologist_id || order.technologist_doctor_id) : "",
    });
    setDialogOpen(true);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.patientRecordId || !form.studyMasterId || !form.klinis.trim()) {
      toast({
        title: "Incomplete data",
        description: "Patient, study description, and clinical notes are required.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        patientRecordId: Number(form.patientRecordId),
        studyMasterId: Number(form.studyMasterId),
        referringDoctorId: form.referringDoctorId ? Number(form.referringDoctorId) : undefined,
        radiologistDoctorId: form.radiologistDoctorId ? Number(form.radiologistDoctorId) : undefined,
        technologistDoctorId: form.technologistDoctorId ? Number(form.technologistDoctorId) : undefined,
        accessionNumber: form.accessionNumber.trim() || undefined,
        noRontgen: form.accessionNumber.trim() || undefined,
        noRegister: form.noRegister.trim() || undefined,
        tanggalOrder: form.tanggalOrder || undefined,
        tanggalAktivasi: form.tanggalAktivasi || undefined,
        studyDate: form.studyDate,
        studyTime: form.studyTime || undefined,
        modality: form.modality,
        cito: normalizeCitoValue(form.cito),
        polirawat: form.polirawat || undefined,
        kodeRuangan: form.kodeRuangan.trim() || undefined,
        namaRuangan: form.namaRuangan.trim() || undefined,
        procedureCode: form.procedureCode.trim() || undefined,
        procedureDesc: form.procedureDesc.trim(),
        klinis: form.klinis.trim(),
        diagnosa: form.diagnosa.trim() || undefined,
        kodePemeriksaan: form.kodePemeriksaan.trim() || undefined,
        namaPemeriksaan: form.namaPemeriksaan.trim() || undefined,
        caraBayar: form.caraBayar.trim() || undefined,
        kodeAsuransi: form.kodeAsuransi.trim() || undefined,
        namaAsuransi: form.namaAsuransi.trim() || undefined,
        kodeInstalasiRadiologi: form.kodeInstalasiRadiologi.trim() || undefined,
        namaInstalasiRadiologi: form.namaInstalasiRadiologi.trim() || undefined,
        updateRis: form.updateRis || undefined,
        referringPhysician: form.referringPhysician.trim() || undefined,
      };
      if (editingOrder) await mwlService.updateOrder(editingOrder.id, payload);
      else await mwlService.createOrder(payload);
      toast({
        title: editingOrder ? "Order updated" : "Order created",
        description: editingOrder ? "Order data has been updated." : "Order data has been saved.",
      });
      resetForm();
      setDialogOpen(false);
      await loadData();
    } catch (error) {
      toast({
        title: editingOrder ? "Failed to update order" : "Failed to create order",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (order: MwlOrder) => {
    const reason = await confirmDelete({
      title: "Delete MWL order?",
      description: "This will hide the selected worklist order. The data can still be restored from manual search.",
      target: `${order.accession_number} - ${order.nama_pasien} - ${order.procedure_desc}`,
    });
    if (!reason) return;
    try {
      await mwlService.deleteOrder(order.id, { reason });
      toast({ title: "Order hidden", description: "Order data has been hidden and can be restored from search." });
      await loadData();
    } catch (error) {
      toast({
        title: "Failed to delete order",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    }
  };

  const handleRestore = async (order: MwlOrder) => {
    try {
      await mwlService.restoreOrder(order.id);
      toast({ title: "Order restored", description: "Order is visible again in the MWL order list." });
      await loadData();
    } catch (error) {
      toast({
        title: "Failed to restore order",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    }
  };

  const tableColumns = useMemo<MwlTableColumn<MwlOrder>[]>(
    () => [
      {
        key: "tanggal_order",
        label: "Order Date",
        render: row => formatOrderDateTime(getOrderDateTimeValue(row)),
        value: row => getOrderDateTimeValue(row),
      },
      { key: "no_rm", label: "No RM", render: row => row.no_rm, value: row => row.no_rm },
      { key: "nama_pasien", label: "Patient Name", render: row => row.nama_pasien, value: row => row.nama_pasien },
      {
        key: "accession_number",
        label: "Accession Number",
        render: row => row.accession_number,
        value: row => row.accession_number,
      },
      {
        key: "status",
        label: "Status",
        render: row => row.deleted_at ? (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="destructive">Deleted</Badge>
            <Badge variant="secondary">{statusLabel[row.status] || row.status}</Badge>
          </div>
        ) : <Badge variant="secondary">{statusLabel[row.status] || row.status}</Badge>,
        value: row => statusLabel[row.status] || row.status,
      },
      {
        key: "no_register",
        label: "No Register",
        render: row => row.no_register || "-",
        value: row => row.no_register,
      },
      { key: "study_date", label: "Study Date", render: row => row.study_date || "-", value: row => row.study_date },
      { key: "modality", label: "Modality", render: row => row.modality, value: row => row.modality },
      {
        key: "procedure_desc",
        label: "Study Description",
        render: row => row.procedure_desc,
        value: row => row.procedure_desc,
      },
      { key: "klinis", label: "Clinical Notes", render: row => row.klinis || "-", value: row => row.klinis },
      { key: "diagnosa", label: "Diagnosis", render: row => row.diagnosa || "-", value: row => row.diagnosa },
      {
        key: "dokter",
        label: "Referring Doctor",
        render: row => row.nama_dokter || row.referring_doctor_name || "-",
        value: row => row.nama_dokter || row.referring_doctor_name,
      },
      {
        key: "radiolog",
        label: "Radiologist",
        render: row => row.nama_radiolog || row.radiologist_doctor_name || "-",
        value: row => row.nama_radiolog || row.radiologist_doctor_name,
      },
      {
        key: "petugasMwl",
        label: "MWL Staff",
        render: row => formatAssignedStaff(row.assigned_staff_json),
        value: row => formatAssignedStaff(row.assigned_staff_json),
      },
      {
        key: "actions",
        label: "Action",
        render: row => (
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-lg" onClick={() => openDetailDialog(row)}>
              <Eye className="h-4 w-4" />
            </Button>
            {row.deleted_at ? (
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-lg" onClick={() => handleRestore(row)} title="Restore order">
                <RotateCcw className="h-4 w-4" />
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-lg" onClick={() => openEditDialog(row)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button type="button" variant="destructive" size="icon" className="h-8 w-8 rounded-lg" onClick={() => handleDelete(row)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        ),
        value: row => `${row.accession_number} ${row.nama_pasien}`,
      },
    ],
    []
  );

  const refreshButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" onClick={loadData} aria-label="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Refresh</TooltipContent>
    </Tooltip>
  );

  const filteredOrders = useMemo(
    () => {
      if (search.trim()) return orders;
      return orders.filter(order => matchesOrderDatePreset(order, datePreset, fromDate, toDateValue));
    },
    [orders, datePreset, fromDate, toDateValue, search]
  );
  const activeDateFilterLabel = useMemo(
    () => formatActiveDateFilterLabel(datePreset, fromDate, toDateValue),
    [datePreset, fromDate, toDateValue]
  );

  const filterControls = (
    <div className="flex items-center gap-2">
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button variant="outline" className="rounded-xl h-9 gap-2 px-3" aria-label="Order date filter">
                <CalendarDays className="w-4 h-4" />
                <span className="max-w-[180px] truncate text-xs">{activeDateFilterLabel}</span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Order date filter</TooltipContent>
        </Tooltip>
        <PopoverContent className="w-72 p-3" align="end">
          <div className="space-y-3">
            <RadioGroup value={datePreset} onValueChange={value => setDatePreset(value as DatePreset)} className="grid gap-2">
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="today" id="order-date-today" /><span>Today</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="7days" id="order-date-7days" /><span>7 days ago</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="1month" id="order-date-1month" /><span>1 Month</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="2months" id="order-date-2months" /><span>2 Month</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="range" id="order-date-range" /><span>Custom range</span></label>
            </RadioGroup>
            {datePreset === "range" && (
              <div className="space-y-2">
                <div className="grid grid-cols-[auto,1fr] items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">From</span>
                  <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-8 rounded-md text-[11px]" />
                </div>
                <div className="grid grid-cols-[auto,1fr] items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">To</span>
                  <Input type="date" value={toDateValue} onChange={e => setToDateValue(e.target.value)} className="h-8 rounded-md text-[11px]" />
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {refreshButton}
    </div>
  );

  return (
    <div className="mwl-command-page space-y-6 pb-10">
      <div className="page-header mwl-command-header">
        <div className="page-header-main">
          <h1 className="page-title mwl-command-title">Order</h1>
        </div>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="mwl-command-action rounded-xl" onClick={openCreateDialog}>
              <Plus className="w-4 h-4 mr-2" />
              Order
            </Button>
          </DialogTrigger>
          <DialogContent className="w-[96vw] max-w-5xl p-0 overflow-hidden">
            <DialogHeader className="px-6 py-4 border-b">
              <DialogTitle>{editingOrder ? "Edit Order" : "Create Order Form"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="flex flex-col">
              <div className="px-6 pt-4">
                <Tabs defaultValue="pemeriksaan" className="w-full">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="pemeriksaan">Study</TabsTrigger>
                    <TabsTrigger value="administrasi">Administration</TabsTrigger>
                    <TabsTrigger value="dokter">Doctors</TabsTrigger>
                  </TabsList>

                  <TabsContent value="pemeriksaan" className="mt-4">
                    <ScrollArea className="h-[58vh] pr-2">
                      <div className="rounded-xl border p-4 space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-2 md:col-span-2">
                            <Label>Patient</Label>
                            <Popover open={patientSearchOpen} onOpenChange={setPatientSearchOpen}>
                              <PopoverTrigger asChild>
                                <Button type="button" variant="outline" className="w-full justify-between font-normal">
                                  {selectedPatient
                                    ? `${selectedPatient.no_rm} - ${selectedPatient.nama_pasien}`
                                    : "Select patient"}
                                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                                <Command>
                                  <CommandInput placeholder="Search patient..." />
                                  <CommandList>
                                    <CommandEmpty>Patient not found</CommandEmpty>
                                    <CommandGroup>
                                      {patients.map(patient => (
                                        <CommandItem
                                          key={patient.id}
                                          value={`${patient.no_rm} ${patient.nama_pasien}`}
                                          onSelect={() => {
                                            setForm(prev => ({ ...prev, patientRecordId: String(patient.id) }));
                                            setPatientSearchOpen(false);
                                          }}
                                        >
                                          <Check
                                            className={cn(
                                              "mr-2 h-4 w-4",
                                              String(patient.id) === form.patientRecordId ? "opacity-100" : "opacity-0"
                                            )}
                                          />
                                          {patient.no_rm} - {patient.nama_pasien}
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </CommandList>
                                </Command>
                              </PopoverContent>
                            </Popover>
                          </div>

                          <div className="space-y-2">
                            <Label>Order Date</Label>
                            <Input type="datetime-local" value={form.tanggalOrder} onChange={e => setForm(prev => ({ ...prev, tanggalOrder: e.target.value }))} />
                            <p className="text-xs text-muted-foreground">Order date is when the order was created. It does not have to match the Study Date.</p>
                          </div>

                          <div className="space-y-2">
                            <Label>Activation Date</Label>
                            <Input type="datetime-local" value={form.tanggalAktivasi} onChange={e => setForm(prev => ({ ...prev, tanggalAktivasi: e.target.value }))} />
                          </div>

                          <div className="space-y-2">
                            <Label>Study Date</Label>
                            <Input type="date" value={form.studyDate} onChange={e => setForm(prev => ({ ...prev, studyDate: e.target.value }))} required />
                            <p className="text-xs text-muted-foreground">Study Date is sent to the modality/MWL as the examination date.</p>
                          </div>

                          <div className="space-y-2">
                            <Label>Study Time</Label>
                            <Input type="time" value={form.studyTime} onChange={e => setForm(prev => ({ ...prev, studyTime: e.target.value }))} />
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <Label>Study Description</Label>
                            <Popover open={studySearchOpen} onOpenChange={setStudySearchOpen}>
                              <PopoverTrigger asChild>
                                <Button type="button" variant="outline" role="combobox" className="w-full justify-between font-normal">
                                  {selectedStudyMaster ? selectedStudyMaster.study_description : "Select study description..."}
                                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                                <Command>
                                  <CommandInput placeholder="Search study description..." />
                                  <CommandList>
                                    <CommandEmpty>No study description found</CommandEmpty>
                                    <CommandGroup>
                                      {studyMasters.map(item => (
                                        <CommandItem
                                          key={item.id}
                                          value={`${item.study_description} ${item.modality_code} ${item.procedure_code}`}
                                          onSelect={() => {
                                            applyStudyMaster(item);
                                            setStudySearchOpen(false);
                                          }}
                                        >
                                          <Check className={cn("mr-2 h-4 w-4", String(item.id) === form.studyMasterId ? "opacity-100" : "opacity-0")} />
                                          <span>{item.study_description}</span>
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </CommandList>
                                </Command>
                              </PopoverContent>
                            </Popover>
                          </div>

                          <div className="space-y-2">
                            <Label>Modality</Label>
                            <Input value={form.modality} readOnly className="bg-muted/50" />
                          </div>

                          <div className="space-y-2">
                            <Label>Procedure Code</Label>
                            <Input value={form.procedureCode} readOnly className="bg-muted/50" />
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <Label>Procedure Description</Label>
                            <Input value={form.procedureDesc} readOnly className="bg-muted/50" />
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <Label>Clinical Notes</Label>
                            <Input value={form.klinis} onChange={e => setForm(prev => ({ ...prev, klinis: e.target.value }))} required />
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <Label>Diagnosis</Label>
                            <Input value={form.diagnosa} onChange={e => setForm(prev => ({ ...prev, diagnosa: e.target.value }))} />
                          </div>
                        </div>
                      </div>
                    </ScrollArea>
                  </TabsContent>

                  <TabsContent value="administrasi" className="mt-4">
                    <ScrollArea className="h-[58vh] pr-2">
                      <div className="rounded-xl border p-4 space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Accession Number</Label>
                            <Input value={form.accessionNumber} onChange={e => setForm(prev => ({ ...prev, accessionNumber: e.target.value }))} placeholder="Internal RIS / DICOM order number" />
                          </div>

                          <div className="space-y-2">
                            <Label>No Register</Label>
                            <Input value={form.noRegister} onChange={e => setForm(prev => ({ ...prev, noRegister: e.target.value }))} placeholder="Visit registration number" />
                          </div>

                          <div className="space-y-2">
                            <Label>Cito</Label>
                            <Select value={form.cito} onValueChange={value => setForm(prev => ({ ...prev, cito: value }))}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="0">Non Cito</SelectItem>
                                <SelectItem value="1">Cito</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-2">
                            <Label>Care Type</Label>
                            <Select value={form.polirawat} onValueChange={value => setForm(prev => ({ ...prev, polirawat: value }))}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="O">O / Outpatient</SelectItem>
                                <SelectItem value="I">I / Inpatient</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-2">
                            <Label>Origin Room Code</Label>
                            <Input value={form.kodeRuangan} onChange={e => setForm(prev => ({ ...prev, kodeRuangan: e.target.value }))} placeholder="Example: UGD12, CPK1, POLI01" />
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <Label>Origin Room Name</Label>
                            <Input value={form.namaRuangan} onChange={e => setForm(prev => ({ ...prev, namaRuangan: e.target.value }))} placeholder="Example: ER, Cempaka 1, Surgery Clinic" />
                          </div>

                          <div className="space-y-2">
                            <Label>Payment Method</Label>
                            <Input value={form.caraBayar} onChange={e => setForm(prev => ({ ...prev, caraBayar: e.target.value }))} />
                          </div>

                          <div className="space-y-2">
                            <Label>Insurance Code</Label>
                            <Input value={form.kodeAsuransi} onChange={e => setForm(prev => ({ ...prev, kodeAsuransi: e.target.value }))} />
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <Label>Insurance Name</Label>
                            <Input value={form.namaAsuransi} onChange={e => setForm(prev => ({ ...prev, namaAsuransi: e.target.value }))} />
                          </div>

                          <div className="space-y-2">
                            <Label>Radiology Installation Code</Label>
                            <Input value={form.kodeInstalasiRadiologi} onChange={e => setForm(prev => ({ ...prev, kodeInstalasiRadiologi: e.target.value }))} />
                          </div>

                          <div className="space-y-2">
                            <Label>Radiology Installation Name</Label>
                            <Input value={form.namaInstalasiRadiologi} onChange={e => setForm(prev => ({ ...prev, namaInstalasiRadiologi: e.target.value }))} />
                          </div>
                        </div>
                      </div>
                    </ScrollArea>
                  </TabsContent>

                  <TabsContent value="dokter" className="mt-4">
                    <ScrollArea className="h-[58vh] pr-2">
                      <div className="rounded-xl border p-4 space-y-4">
                        <div className="space-y-2">
                          <Label>Referring Doctor</Label>
                          <Select
                            value={form.referringDoctorId}
                            onValueChange={value =>
                              setForm(prev => ({
                                ...prev,
                                referringDoctorId: value,
                                referringPhysician: clinicians.find(item => String(item.id) === value)?.nama_dokter || prev.referringPhysician,
                              }))
                            }
                          >
                            <SelectTrigger><SelectValue placeholder="Select CLINICIAN" /></SelectTrigger>
                            <SelectContent>
                              {clinicians.map(item => (
                                <SelectItem key={item.id} value={String(item.id)}>
                                  {item.nama_dokter} ({item.kode_dokter})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>Radiologist</Label>
                          <Select value={form.radiologistDoctorId} onValueChange={value => setForm(prev => ({ ...prev, radiologistDoctorId: value }))}>
                            <SelectTrigger><SelectValue placeholder="Select RADIOLOGIST" /></SelectTrigger>
                            <SelectContent>
                              {radiologists.map(item => (
                                <SelectItem key={item.id} value={String(item.id)}>
                                  {item.nama_dokter} ({item.kode_dokter})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>Technologist / Radiographer</Label>
                          <Select value={form.technologistDoctorId} onValueChange={value => setForm(prev => ({ ...prev, technologistDoctorId: value }))}>
                            <SelectTrigger><SelectValue placeholder="Select TECHNOLOGIST" /></SelectTrigger>
                            <SelectContent>
                              {technologists.map(item => (
                                <SelectItem key={item.id} value={String(item.id)}>
                                  {item.nama_dokter} ({item.kode_dokter})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                          Use these master-data selections to remap responsibility without free typing. If the order is already scheduled and still has no images, the scheduled placeholder will follow this mapping.
                        </div>
                      </div>
                    </ScrollArea>
                  </TabsContent>
                </Tabs>
              </div>

              <div className="px-6 py-4 border-t flex justify-end bg-background">
                <Button type="submit" disabled={saving} className="rounded-xl w-full sm:w-auto px-8">
                  {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {editingOrder ? "Save Changes" : "Create Order"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="technologist-command-surface overflow-hidden border-0 bg-transparent shadow-none">
        <CardContent className="p-0">
          <MwlDataTable
            storageKey="mwl-order-table"
            columns={tableColumns}
            rows={filteredOrders}
            loading={loading}
            emptyMessage="No order data yet."
            searchValue={search}
            searchPlaceholder="Accession, patient, or study"
            onSearchChange={setSearch}
            toolbar={filterControls}
            enablePagination
            initialPageSize={25}
            pageSizeOptions={[25, 50, 100]}
            getRowKey={row => row.id}
            onRowDoubleClick={openDetailDialog}
          />
        </CardContent>
      </Card>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden border-0 bg-transparent p-0 shadow-none">
          <DialogHeader>
            <DialogTitle className="sr-only">MWL Order Detail</DialogTitle>
          </DialogHeader>
          {selectedOrder && (
            <div className="max-h-[88vh] overflow-y-auto rounded-2xl border bg-background p-4 shadow-2xl">
              <div className="space-y-3">
                <DetailHero
                  title={selectedOrder.nama_pasien || "-"}
                  subtitle={`${selectedOrder.no_rm || "-"} â€¢ Accession ${selectedOrder.accession_number || "-"}`}
                  badges={[
                    { label: statusLabel[selectedOrder.status] || selectedOrder.status, variant: selectedOrder.status === "COMPLETED" ? "default" : "secondary" },
                    { label: `Modality ${selectedOrder.modality || "-"}`, variant: "outline" },
                  ]}
                />

                <DetailSection title="Order Summary">
                  <DetailGrid>
                    <DetailItem label="Accession Number" value={selectedOrder.accession_number} />
                    <DetailItem label="No Register" value={selectedOrder.no_register || "-"} />
                    <DetailItem label="Order Date" value={formatOrderDateTime(getOrderDateTimeValue(selectedOrder))} />
                    <DetailItem label="Activation Date" value={formatOrderDateTime(getOrderActivationDateTimeValue(selectedOrder))} />
                    <DetailItem label="Study Date" value={selectedOrder.study_date || "-"} />
                    <DetailItem label="Study Time" value={selectedOrder.study_time || "-"} />
                    <DetailItem label="Study Description" value={selectedOrder.procedure_desc || "-"} className="md:col-span-2" />
                    <DetailItem label="Clinical Notes" value={selectedOrder.klinis || "-"} className="md:col-span-2" />
                    <DetailItem label="Diagnosis" value={selectedOrder.diagnosa || "-"} className="md:col-span-2" />
                  </DetailGrid>
                </DetailSection>

                <DetailSection title="Staff and Room">
                  <DetailGrid>
                    <DetailItem label="Referring Doctor" value={selectedOrder.nama_dokter || selectedOrder.referring_doctor_name || "-"} />
                    <DetailItem label="Radiology Doctor" value={selectedOrder.nama_radiolog || selectedOrder.radiologist_doctor_name || "-"} />
                    <DetailItem label="Radiology Admin" value={selectedOrder.nama_admin || "-"} />
                    <DetailItem label="Radiographer" value={selectedOrder.nama_radiografer || "-"} />
                    <DetailItem label="MWL Staff List" value={formatAssignedStaff(selectedOrder.assigned_staff_json)} className="md:col-span-2" />
                    <DetailItem label="Patient Origin Room" value={selectedOrder.nama_ruangan || "-"} />
                    <DetailItem label="Radiology Installation" value={selectedOrder.nama_instalasi_radiologi || "-"} />
                  </DetailGrid>
                </DetailSection>

                <DetailSection title="Payment Administration">
                  <DetailGrid>
                    <DetailItem label="Payment Method" value={selectedOrder.cara_bayar || "-"} />
                    <DetailItem label="Insurance" value={selectedOrder.nama_asuransi || "-"} />
                  </DetailGrid>
                </DetailSection>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {DeleteReasonDialog}
    </div>
  );
};

export default OrderPage;
