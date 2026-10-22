import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { MwlPatient, mwlService } from "@/lib/dicomService";
import { Loader2, Pencil, Plus, Trash2, Eye, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { MwlDataTable, MwlTableColumn } from "@/components/mwl/MwlDataTable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DetailGrid, DetailHero, DetailItem, DetailSection } from "@/components/mwl/DetailDialogSections";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";

const formatPatientSource = (value?: string | null) =>
  String(value || "").trim().toUpperCase() === "Y" ? "RIS" : "SIMRS";

const emptyForm = {
  noRm: "",
  namaPasien: "",
  tanggalLahir: "",
  kelamin: "M" as "M" | "F" | "O",
  alamat: "",
  kecamatan: "",
  kabupaten: "",
  provinsi: "",
  kodePos: "",
  noHp: "",
};

const PatientRegister = () => {
  const { toast } = useToast();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState<MwlPatient | null>(null);
  const [editingPatient, setEditingPatient] = useState<MwlPatient | null>(null);
  const [patients, setPatients] = useState<MwlPatient[]>([]);
  const [form, setForm] = useState({ ...emptyForm });

  const loadPatients = useCallback(async (query?: string) => {
    setLoading(true);
    try {
      const rows = await mwlService.fetchPatients(query);
      setPatients(rows);
    } catch (error) {
      toast({
        title: "Failed to load patients",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadPatients();
  }, [loadPatients]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        noRm: form.noRm.trim(),
        namaPasien: form.namaPasien.trim(),
        tanggalLahir: form.tanggalLahir,
        kelamin: form.kelamin,
        alamat: form.alamat.trim() || undefined,
        kecamatan: form.kecamatan.trim() || undefined,
        kabupaten: form.kabupaten.trim() || undefined,
        provinsi: form.provinsi.trim() || undefined,
        kodePos: form.kodePos.trim() || undefined,
        noHp: form.noHp.trim() || undefined,
        updateSimrs: "Y" as const,
      };
      if (editingPatient) {
        await mwlService.updatePatient(editingPatient.id, payload);
      } else {
        await mwlService.registerPatient(payload);
      }
      toast({
        title: editingPatient ? "Patient updated" : "Patient saved",
        description: editingPatient ? "Patient data has been updated." : "MWL patient registration completed.",
      });
      setForm({ ...emptyForm });
      setEditingPatient(null);
      setDialogOpen(false);
      await loadPatients(search);
    } catch (error) {
      toast({
        title: "Registration failed",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const openCreateDialog = () => {
    setEditingPatient(null);
    setForm({ ...emptyForm });
    setDialogOpen(true);
  };

  const openEditDialog = (patient: MwlPatient) => {
    setEditingPatient(patient);
    setForm({
      noRm: patient.no_rm || "",
      namaPasien: patient.nama_pasien || "",
      tanggalLahir: patient.tanggal_lahir ? String(patient.tanggal_lahir).slice(0, 10) : "",
      kelamin: patient.kelamin || "M",
      alamat: patient.alamat || "",
      kecamatan: patient.kecamatan || "",
      kabupaten: patient.kabupaten || "",
      provinsi: patient.provinsi || "",
      kodePos: patient.kode_pos || "",
      noHp: patient.no_hp || "",
    });
    setDialogOpen(true);
  };

  const openDetailDialog = (patient: MwlPatient) => {
    setSelectedPatient(patient);
    setDetailOpen(true);
  };

  const handleDelete = async (patient: MwlPatient) => {
    const reason = await confirmDelete({
      title: "Delete patient?",
      description: "This will remove the selected patient registration data.",
      target: `${patient.nama_pasien} (${patient.no_rm})`,
    });
    if (!reason) return;
    try {
      await mwlService.deletePatient(patient.id, { reason });
      toast({ title: "Patient deleted", description: "Patient data has been deleted." });
      await loadPatients(search);
    } catch (error) {
      toast({
        title: "Failed to delete patient",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    }
  };

  const columns = useMemo<MwlTableColumn<MwlPatient>[]>(() => [
    { key: "no_rm", label: "No RM", render: row => row.no_rm, value: row => row.no_rm },
    { key: "nama_pasien", label: "Patient Name", render: row => row.nama_pasien, value: row => row.nama_pasien },
    {
      key: "tanggal_lahir",
      label: "Birth Date",
      render: row => (row.tanggal_lahir ? String(row.tanggal_lahir).slice(0, 10) : "-"),
      value: row => row.tanggal_lahir,
    },
    { key: "kelamin", label: "Sex", render: row => row.kelamin, value: row => row.kelamin },
    { key: "no_hp", label: "Phone Number", render: row => row.no_hp || "-", value: row => row.no_hp },
    { key: "alamat", label: "Address", render: row => row.alamat || "-", value: row => row.alamat },
    { key: "kecamatan", label: "District", render: row => row.kecamatan || "-", value: row => row.kecamatan },
    { key: "kabupaten", label: "Regency", render: row => row.kabupaten || "-", value: row => row.kabupaten },
    { key: "provinsi", label: "Province", render: row => row.provinsi || "-", value: row => row.provinsi },
    { key: "kode_pos", label: "Postal Code", render: row => row.kode_pos || "-", value: row => row.kode_pos },
    {
      key: "update_simrs",
      label: "Source",
      render: row => <Badge variant="outline">{row.update_simrs === "Y" ? "Updated by RIS" : "Source data"}</Badge>,
      value: row => row.update_simrs,
    },
    {
      key: "actions",
      label: "Action",
      render: row => (
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-lg" onClick={() => openDetailDialog(row)}>
            <Eye className="h-4 w-4" />
          </Button>
          <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-lg" onClick={() => openEditDialog(row)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button type="button" variant="destructive" size="icon" className="h-8 w-8 rounded-lg" onClick={() => handleDelete(row)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
      value: row => `${row.no_rm} ${row.nama_pasien}`,
    },
  ], [toast]);

  const refreshButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" onClick={() => loadPatients(search)} aria-label="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Refresh</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="mwl-command-page space-y-6 pb-10">
      <div className="mwl-command-header flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title mwl-command-title">Patient Register</h1>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="mwl-command-action rounded-xl" onClick={openCreateDialog}>
              <Plus className="w-4 h-4 mr-2" />
              Add Patient
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{editingPatient ? "Edit MWL Patient" : "Patient Registration Form"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Patient ID (MRN)</Label>
                <Input value={form.noRm} onChange={e => setForm(prev => ({ ...prev, noRm: e.target.value }))} required />
              </div>
              <div className="space-y-2">
                <Label>Full Name</Label>
                <Input value={form.namaPasien} onChange={e => setForm(prev => ({ ...prev, namaPasien: e.target.value }))} required />
              </div>
              <div className="space-y-2">
                <Label>Birth Date</Label>
                <Input type="date" value={form.tanggalLahir} onChange={e => setForm(prev => ({ ...prev, tanggalLahir: e.target.value }))} required />
              </div>
              <div className="space-y-2">
                <Label>Sex</Label>
                <Select value={form.kelamin} onValueChange={value => setForm(prev => ({ ...prev, kelamin: value as "M" | "F" | "O" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="M">M</SelectItem>
                    <SelectItem value="F">F</SelectItem>
                    <SelectItem value="O">O</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Address</Label>
                <Input value={form.alamat} onChange={e => setForm(prev => ({ ...prev, alamat: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>District</Label>
                <Input value={form.kecamatan} onChange={e => setForm(prev => ({ ...prev, kecamatan: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Regency</Label>
                <Input value={form.kabupaten} onChange={e => setForm(prev => ({ ...prev, kabupaten: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Province</Label>
                <Input value={form.provinsi} onChange={e => setForm(prev => ({ ...prev, provinsi: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Postal Code</Label>
                <Input value={form.kodePos} onChange={e => setForm(prev => ({ ...prev, kodePos: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Phone Number</Label>
                <Input value={form.noHp} onChange={e => setForm(prev => ({ ...prev, noHp: e.target.value }))} />
              </div>
              <div className="md:col-span-2 flex justify-end">
                <Button type="submit" disabled={saving} className="rounded-xl">
                  {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {editingPatient ? "Save Changes" : "Save/Register"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="technologist-command-surface overflow-hidden border-0 bg-transparent shadow-none">
        <CardContent className="p-0">
          <MwlDataTable
            storageKey="mwl-register-table"
            columns={columns}
            rows={patients}
            loading={loading}
            emptyMessage="No patient data yet."
            searchValue={search}
            searchPlaceholder="Search Patient ID or Patient name"
            onSearchChange={setSearch}
            toolbar={refreshButton}
            getRowKey={row => row.id}
            onRowDoubleClick={openDetailDialog}
          />
        </CardContent>
      </Card>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[86vh] max-w-3xl overflow-hidden border-0 bg-transparent p-0 shadow-none">
          <DialogHeader>
            <DialogTitle className="sr-only">Patient Detail</DialogTitle>
          </DialogHeader>
          {selectedPatient && (
            <div className="max-h-[86vh] overflow-y-auto rounded-2xl border bg-background p-4 shadow-2xl">
              <div className="space-y-3">
                <DetailHero
                  title={selectedPatient.nama_pasien || "-"}
                  subtitle={`No RM ${selectedPatient.no_rm || "-"}`}
                />

                <DetailSection title="Patient Identity">
                  <DetailGrid>
                    <DetailItem label="No RM" value={selectedPatient.no_rm} />
                    <DetailItem label="Patient Name" value={selectedPatient.nama_pasien} />
                    <DetailItem label="Birth Date" value={String(selectedPatient.tanggal_lahir || "-").slice(0, 10)} />
                    <DetailItem label="Sex" value={selectedPatient.kelamin} />
                    <DetailItem label="Phone Number" value={selectedPatient.no_hp || "-"} />
                    <DetailItem label="Postal Code" value={selectedPatient.kode_pos || "-"} />
                  </DetailGrid>
                </DetailSection>

                <DetailSection title="Patient Address">
                  <DetailGrid>
                    <DetailItem label="Address" value={selectedPatient.alamat || "-"} className="md:col-span-2" />
                    <DetailItem label="District" value={selectedPatient.kecamatan || "-"} />
                    <DetailItem label="Regency" value={selectedPatient.kabupaten || "-"} />
                    <DetailItem label="Province" value={selectedPatient.provinsi || "-"} />
                    <DetailItem label="Data Source" value={formatPatientSource(selectedPatient.update_simrs)} />
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

export default PatientRegister;
