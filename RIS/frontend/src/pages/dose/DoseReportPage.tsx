import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx-js-style";
import { AlertTriangle, CheckCircle2, Download, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dicomWebService, doseService } from "@/lib/dicomService";
import { useToast } from "@/hooks/use-toast";
import { defaultIdrlRecords, doseFieldMap, type DoseModality, type DoseRecord, type IdrlRecord, type IdrlStudyLink } from "./doseMock";

const modalityOptions: DoseModality[] = ["CT", "DX", "CR", "PX", "XR", "MG", "XA", "RF", "NM", "DENTAL"];
type DatePreset = "today" | "7days" | "1month" | "3months" | "range";

const toDate = (value?: string | null) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isRecordInPreset = (record: DoseRecord, preset: DatePreset, fromDate: string, toDateValue: string) => {
  const date = toDate(record.studyDate || record.savedAt);
  if (!date) return false;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const today = new Date();
  const todayStart = startOf(today);
  const dateOnly = startOf(date);
  if (preset === "today") return dateOnly.getTime() === todayStart.getTime();
  if (preset === "7days") {
    const deltaDays = (todayStart.getTime() - dateOnly.getTime()) / (1000 * 60 * 60 * 24);
    return deltaDays >= 0 && deltaDays <= 7;
  }
  if (preset === "1month" || preset === "3months") {
    const from = new Date(todayStart);
    from.setMonth(from.getMonth() - (preset === "1month" ? 1 : 3));
    return date >= from && date <= endOf(today);
  }
  if (!fromDate || !toDateValue) return false;
  const from = toDate(fromDate);
  const to = toDate(toDateValue);
  if (from && date < startOf(from)) return false;
  if (to && date > endOf(to)) return false;
  return true;
};

const normalizeText = (value?: string | null) => String(value || "").trim().toLowerCase();
const fileDate = () => new Date().toISOString().slice(0, 10);
const getPeriodLabel = (preset: DatePreset, fromDate: string, toDateValue: string) => {
  if (preset === "range") return `${fromDate || "start"} to ${toDateValue || "end"}`;
  if (preset === "today") return "Today";
  if (preset === "7days") return "Last 7 days";
  if (preset === "1month") return "Last 1 month";
  return "Last 3 months";
};

const styleDoseWorksheet = (worksheet: XLSX.WorkSheet, columnCount: number, rowCount: number) => {
  const lastColumn = columnCount - 1;
  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastColumn } },
  ];
  worksheet["!autofilter"] = { ref: `A4:${XLSX.utils.encode_col(lastColumn)}${rowCount + 4}` };
  const titleCell = worksheet.A1;
  const filterCell = worksheet.A2;
  if (titleCell) titleCell.s = { font: { bold: true, sz: 16, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1F4E78" } }, alignment: { horizontal: "left" } };
  if (filterCell) filterCell.s = { font: { italic: true, color: { rgb: "44546A" } }, fill: { fgColor: { rgb: "D9EAF7" } } };
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: 3, c: columnIndex })];
    if (cell) cell.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "2F75B5" } }, alignment: { horizontal: "left" }, border: { top: { style: "thin", color: { rgb: "D9E2F3" } }, bottom: { style: "thin", color: { rgb: "D9E2F3" } } } };
  }
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex + 4, c: columnIndex })];
      if (cell) cell.s = { alignment: { horizontal: "left", vertical: "top", wrapText: true }, fill: { fgColor: { rgb: rowIndex % 2 === 0 ? "F7FBFF" : "FFFFFF" } }, border: { bottom: { style: "thin", color: { rgb: "E7EEF7" } } } };
    }
  }
};

const cleanPatientName = (patientName?: string | null, patientId?: string | null) => {
  const name = String(patientName || "").trim();
  const id = String(patientId || "").trim();
  if (!name || !id) return name;
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return name.replace(new RegExp(`\\s*[-â€“â€”/]?\\s*${escapedId}\\s*$`, "i"), "").trim() || name;
};

const getLinkedIdrlStudy = (record: DoseRecord, links: IdrlStudyLink[]) => {
  const study = normalizeText(record.studyDescription);
  return links.find(link =>
    link.modalityCode === record.modalityCode &&
    (normalizeText(link.studyDescription) === study || normalizeText(link.procedureCode) === study)
  )?.idrlExam || "";
};

const getDoseStatus = (record: DoseRecord, links: IdrlStudyLink[], idrlRecords: IdrlRecord[]) => {
  const idrlStudy = getLinkedIdrlStudy(record, links);
  if (!idrlStudy) return { label: "No IDRL Mapping", tone: "neutral" as const };
  const idrl = idrlRecords.find(item => item.modalityCode === record.modalityCode && item.exam === idrlStudy && record.values[item.metric] !== undefined);
  if (!idrl) return { label: "No IDRL Limit", tone: "neutral" as const };
  const value = Number(record.values[idrl.metric]);
  const limit = Number(idrl.limit);
  if (!Number.isFinite(value) || !Number.isFinite(limit)) return { label: "No Dose", tone: "neutral" as const };
  return value > limit ? { label: "Above IDRL", tone: "danger" as const } : { label: "Within IDRL", tone: "safe" as const };
};

const StatusBadge = ({ status }: { status: ReturnType<typeof getDoseStatus> }) => {
  if (status.tone === "safe") return <Badge className="bg-emerald-600 text-white"><CheckCircle2 className="mr-1 h-3 w-3" />{status.label}</Badge>;
  if (status.tone === "danger") return <Badge className="bg-red-600 text-white"><ShieldAlert className="mr-1 h-3 w-3" />{status.label}</Badge>;
  return <Badge variant="outline">{status.label}</Badge>;
};

const DoseReportPage = () => {
  const { toast } = useToast();
  const [modality, setModality] = useState<DoseModality>("CT");
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [fromDate, setFromDate] = useState("");
  const [toDateValue, setToDateValue] = useState("");
  const [records, setRecords] = useState<DoseRecord[]>([]);
  const [studyLinks, setStudyLinks] = useState<IdrlStudyLink[]>([]);
  const [idrlRecords, setIdrlRecords] = useState<IdrlRecord[]>(defaultIdrlRecords);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const [doseRows, idrlRows, linkRows] = await Promise.all([
        doseService.fetchReports(),
        doseService.fetchIdrlRecords(),
        doseService.fetchIdrlStudyLinks(),
      ]);
      const storedIds = new Set(idrlRows.map(item => item.id));
      setRecords(doseRows as DoseRecord[]);
      setIdrlRecords([...idrlRows, ...defaultIdrlRecords.filter(item => !storedIds.has(item.id))] as IdrlRecord[]);
      setStudyLinks(linkRows as IdrlStudyLink[]);
    } catch (error) {
      if (!options?.silent) toast({ title: "Failed to load dose report", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

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
    if (!autoRefreshEnabled) return;
    const id = window.setInterval(() => {
      load({ silent: true });
    }, 30000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, load]);
  const filteredRecords = useMemo(
    () => records.filter(record => record.modalityCode === modality && isRecordInPreset(record, datePreset, fromDate, toDateValue)),
    [datePreset, fromDate, modality, records, toDateValue]
  );
  const activeModality = modality;
  const activeFields = doseFieldMap[activeModality];
  const aboveCount = filteredRecords.filter(record => getDoseStatus(record, studyLinks, idrlRecords).tone === "danger").length;
  const handleExportExcel = () => {
    const headers = ["No", "Patient Name", "Patient ID", "Accession", "Modality", "Study", "IDRL Study", "Medical Physicist", ...activeFields.map(field => `${field.label}${field.unit ? ` (${field.unit})` : ""}`), "Mode", "IDRL Status"];
    const rows = filteredRecords.map((record, index) => [
      index + 1,
      cleanPatientName(record.patientName, record.patientId) || "-",
      record.patientId || "-",
      record.accessionNumber || "-",
      record.modalityCode || "-",
      record.studyDescription || "-",
      getLinkedIdrlStudy(record, studyLinks) || "-",
      record.medicalPhysicist || "-",
      ...activeFields.map(field => record.values[field.key] || "-"),
      record.captureMode || "-",
      getDoseStatus(record, studyLinks, idrlRecords).label,
    ]);
    const period = getPeriodLabel(datePreset, fromDate, toDateValue);
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["Dose Report"],
      [`Filter: ${modality} | ${period}`],
      [],
      headers,
      ...rows,
    ]);
    worksheet["!cols"] = headers.map(header => ({ wch: Math.max(12, Math.min(34, header.length + 6)) }));
    styleDoseWorksheet(worksheet, headers.length, rows.length);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Dose Report");
    XLSX.writeFile(workbook, `dose-report-${modality}-${fileDate()}.xlsx`);
  };

  return (
    <div className="admin-command-page min-h-full animate-fade-in space-y-5 p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="page-title">Dose Report</h1>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="dashboard-metric rounded-2xl border p-4"><div className="metric-label">Total Saved</div><div className="mt-2 text-3xl font-black">{filteredRecords.length}</div></div>
        <div className="dashboard-metric rounded-2xl border p-4"><div className="metric-label">Above IDRL</div><div className="mt-2 text-3xl font-black text-red-500">{aboveCount}</div></div>
        <div className="dashboard-metric rounded-2xl border p-4"><div className="metric-label">Auto Captured</div><div className="mt-2 text-3xl font-black">{filteredRecords.filter(record => record.captureMode === "auto").length}</div></div>
        <div className="dashboard-metric rounded-2xl border p-4"><div className="metric-label">Manual Input</div><div className="mt-2 text-3xl font-black">{filteredRecords.filter(record => record.captureMode === "manual").length}</div></div>
      </div>

      <section className="overflow-hidden rounded-2xl border bg-card/70">
        <div className="flex flex-col gap-3 border-b px-5 py-4 xl:flex-row xl:items-end xl:justify-between">
          <div />
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end xl:w-auto">
            <Button type="button" variant="outline" size="icon" onClick={handleExportExcel} className="h-10 w-10 rounded-xl" title="Download Excel" aria-label="Download Excel">
              <Download className="h-4 w-4" />
            </Button>
            <div className="w-full space-y-2 sm:w-[180px]">
              <label className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">Modality</label>
              <Select value={modality} onValueChange={value => setModality(value as DoseModality)}>
                <SelectTrigger className="h-10 rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>{modalityOptions.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="w-full space-y-2 sm:w-[180px]">
              <label className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">Period</label>
              <Select value={datePreset} onValueChange={value => setDatePreset(value as DatePreset)}>
                <SelectTrigger className="h-10 rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="7days">7 days ago</SelectItem>
                  <SelectItem value="1month">1 month</SelectItem>
                  <SelectItem value="3months">3 month</SelectItem>
                  <SelectItem value="range">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {datePreset === "range" && (
              <div className="grid w-full gap-2 sm:w-[360px] sm:grid-cols-2">
                <div className="space-y-2"><label className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">From</label><Input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} className="h-10 rounded-xl" /></div>
                <div className="space-y-2"><label className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">To</label><Input type="date" value={toDateValue} onChange={event => setToDateValue(event.target.value)} className="h-10 rounded-xl" /></div>
              </div>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full text-sm">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left">Patient Name</th><th className="px-4 py-3 text-left">Patient ID</th><th className="px-4 py-3 text-left">Accession</th><th className="px-4 py-3 text-left">Modality</th><th className="px-4 py-3 text-left">Study</th><th className="px-4 py-3 text-left">IDRL Study</th><th className="px-4 py-3 text-left">Medical Physicist</th>
                {activeFields.map(field => <th key={field.key} className="px-4 py-3 text-left">{field.label}{field.unit ? ` (${field.unit})` : ""}</th>)}
                <th className="px-4 py-3 text-left">Mode</th><th className="px-4 py-3 text-left">IDRL Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredRecords.length === 0 ? (
                <tr><td colSpan={activeFields.length + 10} className="px-4 py-10 text-center text-muted-foreground"><AlertTriangle className="mx-auto mb-2 h-5 w-5" />No dose data saved yet. Use Dose Monitor and click Get Dose.</td></tr>
              ) : filteredRecords.map(record => (
                <tr key={record.id}>
                  <td className="px-4 py-3 font-semibold">{cleanPatientName(record.patientName, record.patientId) || "-"}</td><td className="px-4 py-3 text-muted-foreground">{record.patientId || "-"}</td>
                  <td className="px-4 py-3">{record.accessionNumber}</td><td className="px-4 py-3"><Badge variant="outline">{record.modalityCode}</Badge></td><td className="px-4 py-3">{record.studyDescription}</td><td className="px-4 py-3 font-semibold">{getLinkedIdrlStudy(record, studyLinks) || "-"}</td><td className="px-4 py-3">{record.medicalPhysicist || "-"}</td>
                  {activeFields.map(field => <td key={field.key} className="px-4 py-3">{record.values[field.key] || "-"}</td>)}
                  <td className="px-4 py-3"><Badge variant="outline">{record.captureMode}</Badge></td><td className="px-4 py-3"><StatusBadge status={getDoseStatus(record, studyLinks, idrlRecords)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default DoseReportPage;
