import { useEffect, useMemo, useState } from "react";
import { Edit2, Link2, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { doseService, MwlStudyMaster, mwlService } from "@/lib/dicomService";
import { useToast } from "@/hooks/use-toast";
import { defaultIdrlRecords, getIdrlStudyGroupKey, type DoseModality, type IdrlRecord, type IdrlStudyLink } from "./doseMock";

const emptyRecord: IdrlRecord = { id: "", modalityCode: "CT", exam: "", metric: "", limit: "", unit: "", bodyRegion: "", reference: "BAPETEN IDRL", effectiveDate: "" };
const modalityOptions: DoseModality[] = ["CT", "DX", "CR", "PX", "XR", "MG", "XA", "RF", "NM", "DENTAL"];

const IdrlPage = () => {
  const { toast } = useToast();
  const [records, setRecords] = useState<IdrlRecord[]>([]);
  const [studyLinks, setStudyLinks] = useState<IdrlStudyLink[]>([]);
  const [open, setOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [form, setForm] = useState<IdrlRecord>(emptyRecord);
  const [linkTarget, setLinkTarget] = useState<{ modalityCode: DoseModality; exam: string } | null>(null);
  const [studyOptions, setStudyOptions] = useState<MwlStudyMaster[]>([]);
  const [studyLoading, setStudyLoading] = useState(false);
  const [studyQuery, setStudyQuery] = useState("");
  const [selectedStudyIds, setSelectedStudyIds] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [modalityFilter, setModalityFilter] = useState<DoseModality | "ALL">("ALL");

  const filteredStudyOptions = useMemo(() => {
    if (!linkTarget) return studyOptions;
    return studyOptions.filter(study => String(study.modality_code || "").trim().toUpperCase() === linkTarget.modalityCode);
  }, [linkTarget, studyOptions]);

  const filteredRecords = useMemo(() => {
    const term = query.trim().toLowerCase();
    return records.filter(record => {
      if (modalityFilter !== "ALL" && record.modalityCode !== modalityFilter) return false;
      if (!term) return true;
      return `${record.exam} ${record.metric} ${record.bodyRegion} ${record.reference} ${record.modalityCode}`.toLowerCase().includes(term);
    });
  }, [modalityFilter, query, records]);

  const loadDoseReferences = async () => {
    try {
      const [idrlRows, linkRows] = await Promise.all([
        doseService.fetchIdrlRecords(),
        doseService.fetchIdrlStudyLinks(),
      ]);
      const storedIds = new Set(idrlRows.map(item => item.id));
      const mergedRows = [...idrlRows, ...defaultIdrlRecords.filter(item => !storedIds.has(item.id))] as IdrlRecord[];
      setRecords(mergedRows);
      setStudyLinks(linkRows as IdrlStudyLink[]);
      if (mergedRows.length !== idrlRows.length) {
        doseService.saveIdrlRecords(mergedRows).catch(() => undefined);
      }
    } catch (error) {
      setRecords(defaultIdrlRecords);
      toast({ title: "Failed to load dose references", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    }
  };

  useEffect(() => {
    loadDoseReferences();
  }, []);

  const save = async () => {
    const nextRecord = { ...form, id: form.id || `idrl-${Date.now()}` };
    const next = [nextRecord, ...records.filter(item => item.id !== nextRecord.id)];
    try {
      const saved = await doseService.saveIdrlRecords(next);
      setRecords(saved as IdrlRecord[]);
      setOpen(false);
      setForm(emptyRecord);
    } catch (error) {
      toast({ title: "Failed to save IDRL", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    }
  };

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    studyLinks.forEach(link => {
      const key = getIdrlStudyGroupKey(link.modalityCode, link.idrlExam);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }, [studyLinks]);

  const loadStudyOptions = async (search?: string) => {
    setStudyLoading(true);
    try {
      const rows = await mwlService.fetchStudyMasters(search);
      setStudyOptions(rows);
    } catch (error) {
      toast({ title: "Failed to load study master", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    } finally {
      setStudyLoading(false);
    }
  };

  const openLinkDialog = (record: IdrlRecord) => {
    const target = { modalityCode: record.modalityCode, exam: record.exam };
    const key = getIdrlStudyGroupKey(target.modalityCode, target.exam);
    setLinkTarget(target);
    setSelectedStudyIds(studyLinks.filter(link => getIdrlStudyGroupKey(link.modalityCode, link.idrlExam) === key).map(link => link.studyMasterId));
    setStudyQuery("");
    setLinkOpen(true);
  };

  useEffect(() => {
    if (linkOpen) loadStudyOptions(studyQuery);
  }, [linkOpen]);

  const toggleStudy = (studyId: number, checked: boolean) => {
    setSelectedStudyIds(prev => checked ? Array.from(new Set([...prev, studyId])) : prev.filter(id => id !== studyId));
  };

  const saveStudyLinks = async () => {
    if (!linkTarget) return;
    const key = getIdrlStudyGroupKey(linkTarget.modalityCode, linkTarget.exam);
    const selectedStudies = studyOptions.filter(study => selectedStudyIds.includes(study.id));
    const selectedLinks: IdrlStudyLink[] = selectedStudies.map(study => ({
        id: `${key}::${study.id}`,
        modalityCode: linkTarget.modalityCode,
        idrlExam: linkTarget.exam,
        studyMasterId: study.id,
        procedureCode: study.procedure_code,
        studyDescription: study.study_description,
      }));
    try {
      const saved = await doseService.saveIdrlStudyLinks({ modalityCode: linkTarget.modalityCode, idrlExam: linkTarget.exam }, selectedLinks);
      setStudyLinks(saved as IdrlStudyLink[]);
      setLinkOpen(false);
    } catch (error) {
      toast({ title: "Failed to save study links", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    }
  };

  return (
    <div className="admin-command-page min-h-full animate-fade-in space-y-5 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="page-title">TPDI / IDRL</h1></div>
        <Button className="rounded-xl" onClick={() => { setForm(emptyRecord); setOpen(true); }}><Plus className="mr-2 h-4 w-4" />Add IDRL</Button>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_220px]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search exam, metric, body region, reference" className="h-11 rounded-xl pl-9" />
        </div>
        <Select value={modalityFilter} onValueChange={value => setModalityFilter(value as DoseModality | "ALL")}>
          <SelectTrigger className="h-11 rounded-xl"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="ALL">All Modalities</SelectItem>{modalityOptions.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <section className="overflow-hidden rounded-2xl border bg-card/70">
        <div className="overflow-x-auto">
          <table className="min-w-[1050px] w-full text-sm">
            <thead><tr>{["Modality", "Exam/Protocol", "Linked Study", "Metric", "Limit", "Unit", "Body Region", "Reference", "Effective", "Action"].map(header => <th key={header} className="px-4 py-3 text-left">{header}</th>)}</tr></thead>
            <tbody>{filteredRecords.map(record => <tr key={record.id}>
              <td className="px-4 py-3"><Badge variant="outline">{record.modalityCode}</Badge></td><td className="px-4 py-3 font-semibold">{record.exam}</td><td className="px-4 py-3"><Button variant="outline" className="h-8 rounded-lg" onClick={() => openLinkDialog(record)}><Link2 className="mr-2 h-3.5 w-3.5" />{groupCounts.get(getIdrlStudyGroupKey(record.modalityCode, record.exam)) || 0} Study</Button></td><td className="px-4 py-3">{record.metric}</td><td className="px-4 py-3">{record.limit}</td><td className="px-4 py-3">{record.unit}</td><td className="px-4 py-3">{record.bodyRegion}</td><td className="px-4 py-3">{record.reference}</td><td className="px-4 py-3">{record.effectiveDate}</td>
              <td className="px-4 py-3"><div className="flex gap-2"><Button variant="outline" size="icon" className="h-8 w-8" onClick={() => { setForm(record); setOpen(true); }}><Edit2 className="h-4 w-4" /></Button><Button variant="outline" size="icon" className="h-8 w-8 text-destructive" onClick={async () => { try { await doseService.deleteIdrlRecord(record.id); setRecords(prev => prev.filter(item => item.id !== record.id)); } catch (error) { toast({ title: "Failed to delete IDRL", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" }); } }}><Trash2 className="h-4 w-4" /></Button></div></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl rounded-3xl">
          <DialogHeader><DialogTitle>{form.id ? "Edit IDRL" : "Add IDRL"}</DialogTitle></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label>Modality</Label><Select value={form.modalityCode} onValueChange={value => setForm(prev => ({ ...prev, modalityCode: value as DoseModality }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{modalityOptions.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></div>
            {["exam", "metric", "limit", "unit", "bodyRegion", "reference", "effectiveDate"].map(key => <div key={key} className="space-y-2"><Label>{key}</Label><Input type={key === "effectiveDate" ? "date" : "text"} value={(form as unknown as Record<string, string>)[key] || ""} onChange={event => setForm(prev => ({ ...prev, [key]: event.target.value }))} /></div>)}
          </div>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save}>Save</Button></div>
        </DialogContent>
      </Dialog>

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="max-w-3xl rounded-3xl">
          <DialogHeader><DialogTitle>Link Study Procedure</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="rounded-2xl border bg-muted/30 p-4 text-sm">
              <div className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">IDRL Study</div>
              <div className="mt-1 font-bold">{linkTarget?.modalityCode} - {linkTarget?.exam}</div>
            </div>
            <div className="flex gap-2">
              <Input value={studyQuery} onChange={event => setStudyQuery(event.target.value)} placeholder="Search procedure code / study description" className="h-10 rounded-xl" />
              <Button variant="outline" className="rounded-xl" onClick={() => loadStudyOptions(studyQuery)} disabled={studyLoading}>{studyLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}</Button>
            </div>
            <div className="max-h-80 overflow-y-auto rounded-2xl border">
              {studyLoading ? <div className="p-4 text-sm text-muted-foreground">Loading study master...</div> : filteredStudyOptions.length === 0 ? <div className="p-4 text-sm text-muted-foreground">No {linkTarget?.modalityCode} study master data.</div> : filteredStudyOptions.map(study => {
                const checked = selectedStudyIds.includes(study.id);
                return (
                  <label key={study.id} className="flex cursor-pointer items-start gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/40">
                    <Checkbox checked={checked} onCheckedChange={value => toggleStudy(study.id, Boolean(value))} />
                    <span className="grid gap-1 text-sm">
                      <span className="font-semibold">{study.study_description}</span>
                      <span className="text-xs text-muted-foreground">{study.procedure_code} - {study.modality_code}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setLinkOpen(false)}>Cancel</Button><Button onClick={saveStudyLinks}>Save Link</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default IdrlPage;
