import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { MwlModalityStation, mwlService } from "@/lib/dicomService";
import { Edit2, Loader2, Plus, Trash2 } from "lucide-react";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";

const ModalityManagementPage = () => {
  const { toast } = useToast();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [modalities, setModalities] = useState<MwlModalityStation[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MwlModalityStation | null>(null);
  const [form, setForm] = useState({
    namaRuangan: "",
    aeTitleStation: "",
  });

  const loadModalities = useCallback(async (query?: string) => {
    setLoading(true);
    try {
      const rows = await mwlService.fetchModalityStations(query);
      setModalities(rows);
    } catch (error) {
      toast({
        title: "Failed to load modality master",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadModalities();
  }, [loadModalities]);

  const resetForm = () => {
    setForm({
      namaRuangan: "",
      aeTitleStation: "",
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        namaRuangan: form.namaRuangan.trim(),
        aeTitleStation: form.aeTitleStation.trim(),
      };
      if (editing) {
        await mwlService.updateModalityStation(editing.id, payload);
        toast({ title: "Modality master updated" });
      } else {
        await mwlService.createModalityStation(payload);
        toast({ title: "Modality master added" });
      }
      setOpen(false);
      setEditing(null);
      resetForm();
      await loadModalities(search);
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

  const handleEdit = (item: MwlModalityStation) => {
    setEditing(item);
    setForm({
      namaRuangan: item.nama_ruangan,
      aeTitleStation: item.ae_title_station ?? "",
    });
    setOpen(true);
  };

  const handleDelete = async (id: number) => {
    const modality = modalities.find(item => item.id === id);
    const reason = await confirmDelete({
      title: "Delete modality station?",
      description: "This will remove the modality station master data.",
      target: modality ? `${modality.nama_ruangan} - ${modality.ae_title_station || "-"}` : `Modality ID ${id}`,
    });
    if (!reason) return;
    setDeletingId(id);
    try {
      await mwlService.deleteModalityStation(id, { reason });
      toast({ title: "Modality master deleted" });
      await loadModalities(search);
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

  const title = useMemo(() => (editing ? "Edit Modality Master" : "Add Modality Master"), [editing]);

  return (
    <div className="admin-command-page space-y-6 pb-10">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title">Modality Management</h1>
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
          Add Modality
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="section-title">Modality List</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex gap-2">
            <Input
              placeholder="Search room name / AE Title"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="max-w-md"
            />
            <Button variant="outline" onClick={() => loadModalities(search)}>Search</Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Room Name</TableHead>
                <TableHead>AE Title Station</TableHead>
                <TableHead className="w-[120px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={3}>Loading data...</TableCell>
                </TableRow>
              ) : modalities.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3}>No modality master data yet.</TableCell>
                </TableRow>
              ) : (
                modalities.map(item => (
                  <TableRow key={item.id}>
                    <TableCell>{item.nama_ruangan}</TableCell>
                    <TableCell>{item.ae_title_station || "-"}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => handleEdit(item)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-8 w-8 text-destructive"
                          disabled={deletingId === item.id}
                          onClick={() => handleDelete(item.id)}
                        >
                          {deletingId === item.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
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
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Room Name</Label>
              <Input
                value={form.namaRuangan}
                onChange={e => setForm(prev => ({ ...prev, namaRuangan: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>AE Title Station</Label>
              <Input
                value={form.aeTitleStation}
                onChange={e => setForm(prev => ({ ...prev, aeTitleStation: e.target.value }))}
                placeholder="Optional. Leave empty if station AE filtering is not needed."
              />
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

export default ModalityManagementPage;
