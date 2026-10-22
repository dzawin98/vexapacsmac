import { FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { MwlDoctor, mwlService } from "@/lib/dicomService";
import { Edit2, Loader2, Plus, Trash2 } from "lucide-react";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";

type DoctorRole = "ADMINISTRATOR" | "CLINICIAN" | "RADIOLOGIST" | "TECHNOLOGIST" | "FISMED";

const doctorRoleOptions: Array<{ value: DoctorRole; label: string }> = [
  { value: "ADMINISTRATOR", label: "ADMINISTRATOR" },
  { value: "TECHNOLOGIST", label: "TECHNOLOGIST" },
  { value: "FISMED", label: "MEDICAL PHYSICS" },
  { value: "RADIOLOGIST", label: "RADIOLOGIST" },
  { value: "CLINICIAN", label: "CLINICIAN" },
];

const formatDoctorRole = (role: string) => role === "FISMED" ? "MEDICAL PHYSICS" : role;

const DoctorManagementPage = () => {
  const { toast } = useToast();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [doctors, setDoctors] = useState<MwlDoctor[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MwlDoctor | null>(null);
  const [form, setForm] = useState({
    kodeDokter: "",
    namaDokter: "",
    role: "CLINICIAN" as DoctorRole,
  });

  const loadDoctors = useCallback(async (query?: string) => {
    setLoading(true);
    try {
      const rows = await mwlService.fetchDoctors({ q: query });
      setDoctors(rows);
    } catch (error) {
      toast({
        title: "Failed to load doctor data",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadDoctors();
  }, [loadDoctors]);

  const resetForm = () => {
    setForm({
      kodeDokter: "",
      namaDokter: "",
      role: "CLINICIAN",
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        kodeDokter: form.kodeDokter.trim(),
        namaDokter: form.namaDokter.trim(),
        role: form.role,
      };
      if (editing) {
        await mwlService.updateDoctor(editing.id, payload);
        toast({ title: "Doctor data updated" });
      } else {
        await mwlService.createDoctor(payload);
        toast({ title: "Doctor data added" });
      }
      setOpen(false);
      setEditing(null);
      resetForm();
      await loadDoctors(search);
    } catch (error) {
      toast({
        title: editing ? "Update failed" : "Create failed",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (doctor: MwlDoctor) => {
    setEditing(doctor);
    setForm({
      kodeDokter: doctor.kode_dokter,
      namaDokter: doctor.nama_dokter,
      role: doctor.role,
    });
    setOpen(true);
  };

  const handleDelete = async (id: number) => {
    const doctor = doctors.find(item => item.id === id);
    const reason = await confirmDelete({
      title: "Delete doctor?",
      description: "This will remove the doctor master data.",
      target: doctor ? `${doctor.kode_dokter} - ${doctor.nama_dokter}` : `Doctor ID ${id}`,
    });
    if (!reason) return;
    setDeletingId(id);
    try {
      await mwlService.deleteDoctor(id, { reason });
      toast({ title: "Doctor data deleted" });
      await loadDoctors(search);
    } catch (error) {
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="admin-command-page space-y-6 pb-10">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title">Doctor Management</h1>
        </div>
        <Button
          className="rounded-xl"
          onClick={() => {
            setEditing(null);
            resetForm();
            setOpen(true);
          }}
        >
          <Plus className="w-4 h-4 mr-2" />
          Add
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="section-title">Staff List</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex gap-2">
            <Input
              placeholder="Search doctor code / name"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="max-w-md"
            />
            <Button variant="outline" onClick={() => loadDoctors(search)}>Search</Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Doctor Code</TableHead>
                <TableHead>Doctor Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="w-[120px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4}>Loading data...</TableCell>
                </TableRow>
              ) : doctors.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>No doctor data yet.</TableCell>
                </TableRow>
              ) : (
                doctors.map(doctor => (
                  <TableRow key={doctor.id}>
                    <TableCell>{doctor.kode_dokter}</TableCell>
                    <TableCell>{doctor.nama_dokter}</TableCell>
                    <TableCell>{formatDoctorRole(doctor.role)}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => handleEdit(doctor)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-8 w-8 text-destructive"
                          disabled={deletingId === doctor.id}
                          onClick={() => handleDelete(doctor.id)}
                        >
                          {deletingId === doctor.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Staff" : "Add Staff"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Staff Code</Label>
              <Input
                value={form.kodeDokter}
                onChange={e => setForm(prev => ({ ...prev, kodeDokter: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Staff Name</Label>
              <Input
                value={form.namaDokter}
                onChange={e => setForm(prev => ({ ...prev, namaDokter: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={value => setForm(prev => ({ ...prev, role: value as DoctorRole }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {doctorRoleOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {DeleteReasonDialog}
    </div>
  );
};

export default DoctorManagementPage;
