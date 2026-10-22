import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { MwlStudyMaster, mwlService } from "@/lib/dicomService";
import { Edit2, Loader2, Plus, Trash2 } from "lucide-react";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";

const ManagementStudyPage = () => {
  const { toast } = useToast();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [studies, setStudies] = useState<MwlStudyMaster[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MwlStudyMaster | null>(null);
  const [form, setForm] = useState({
    procedureCode: "",
    modalityCode: "",
    studyDescription: "",
  });

  const loadStudies = useCallback(async (query?: string) => {
    setLoading(true);
    try {
      const rows = await mwlService.fetchStudyMasters(query);
      setStudies(rows);
    } catch (error) {
      toast({
        title: "Failed to load study master",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadStudies();
  }, [loadStudies]);

  const resetForm = () => {
    setForm({
      procedureCode: "",
      modalityCode: "",
      studyDescription: "",
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        procedureCode: form.procedureCode.trim(),
        modalityCode: form.modalityCode.trim(),
        studyDescription: form.studyDescription.trim(),
      };
      if (editing) {
        await mwlService.updateStudyMaster(editing.id, payload);
        toast({ title: "Study master updated" });
      } else {
        await mwlService.createStudyMaster(payload);
        toast({ title: "Study master added" });
      }
      setOpen(false);
      setEditing(null);
      resetForm();
      await loadStudies(search);
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

  const handleEdit = (study: MwlStudyMaster) => {
    setEditing(study);
    setForm({
      procedureCode: study.procedure_code,
      modalityCode: study.modality_code,
      studyDescription: study.study_description,
    });
    setOpen(true);
  };

  const handleDelete = async (id: number) => {
    const study = studies.find(item => item.id === id);
    const reason = await confirmDelete({
      title: "Delete study master?",
      description: "This will remove the MWL study master.",
      target: study ? `${study.procedure_code} - ${study.study_description}` : `Study master ID ${id}`,
    });
    if (!reason) return;
    setDeletingId(id);
    try {
      await mwlService.deleteStudyMaster(id, { reason });
      toast({ title: "Study master deleted" });
      await loadStudies(search);
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

  const title = useMemo(() => (editing ? "Edit Study Master" : "Add Study Master"), [editing]);

  return (
    <div className="admin-command-page space-y-6 pb-10">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title">Study Management</h1>
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
          Study
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="section-title">Study List</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex gap-2">
            <Input
              placeholder="Search study description / modality / procedure code"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="max-w-md"
            />
            <Button variant="outline" onClick={() => loadStudies(search)}>Search</Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Procedure Code</TableHead>
                <TableHead>Modality Code</TableHead>
                <TableHead>Study Description</TableHead>
                <TableHead className="w-[120px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4}>Loading data...</TableCell>
                </TableRow>
              ) : studies.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>No study master data yet.</TableCell>
                </TableRow>
              ) : (
                studies.map(study => (
                  <TableRow key={study.id}>
                    <TableCell>{study.procedure_code}</TableCell>
                    <TableCell>{study.modality_code}</TableCell>
                    <TableCell>{study.study_description}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => handleEdit(study)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-8 w-8 text-destructive"
                          disabled={deletingId === study.id}
                          onClick={() => handleDelete(study.id)}
                        >
                          {deletingId === study.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
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
              <Label>Procedure Code</Label>
              <Input
                value={form.procedureCode}
                onChange={e => setForm(prev => ({ ...prev, procedureCode: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Modality Code</Label>
              <Input
                value={form.modalityCode}
                onChange={e => setForm(prev => ({ ...prev, modalityCode: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Study Description</Label>
              <Input
                value={form.studyDescription}
                onChange={e => setForm(prev => ({ ...prev, studyDescription: e.target.value }))}
                required
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

export default ManagementStudyPage;
