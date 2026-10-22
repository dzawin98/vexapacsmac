import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx-js-style";
import { AlertTriangle, CheckCircle2, Download, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { dicomWebService, doseService } from "@/lib/dicomService";
import { defaultIdrlRecords, doseFieldMap, type DoseModality, type DoseRecord, type IdrlRecord, type IdrlStudyLink } from "./doseMock";

const modalityOptions: DoseModality[] = ["CT", "DX", "CR", "PX", "XR", "MG", "XA", "RF", "NM", "DENTAL"];
const textFields = new Set(["manufacturer", "stationName", "view", "radiopharmaceutical"]);
type DatePreset = "today" | "7days" | "1month" | "3months" | "range";
type Status = { label: string; tone: "safe" | "danger" | "neutral" };

const normalizeText = (value?: string | null) => String(value || "").trim().toLowerCase();
const fileDate = () => new Date().toISOString().slice(0, 10);
const parseNumber = (value?: string) => {
  const parsed = Number(String(value || "").trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
const formatNumber = (value?: number) => value === undefined
  ? "-"
  : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
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

const toDate = (value?: string | null) => {
  if (!value) return null;
  const raw = String(value).trim();
  const normalized = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isRecordInPreset = (record: DoseRecord, preset: DatePreset, fromDate: string, toDateValue: string) => {
  const date = toDate(record.studyDate || record.savedAt);
  if (!date) return false;
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const endOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate(), 23, 59, 59, 999);
  const today = new Date();
  const todayStart = startOf(today);
  const dateOnly = startOf(date);
  if (preset === "today") return dateOnly.getTime() === todayStart.getTime();
  if (preset === "7days") {
    const deltaDays = (todayStart.getTime() - dateOnly.getTime()) / 86400000;
    return deltaDays >= 0 && deltaDays <= 7;
  }
  if (preset === "1month" || preset === "3months") {
    const from = new Date(todayStart);
    from.setMonth(from.getMonth() - (preset === "1month" ? 1 : 3));
    return date >= from && date <= endOf(today);
  }
  const from = toDate(fromDate);
  const to = toDate(toDateValue);
  return Boolean(from && to && date >= startOf(from) && date <= endOf(to));
};

const getLinkedIdrlStudy = (record: DoseRecord, links: IdrlStudyLink[]) => {
  const study = normalizeText(record.studyDescription);
  return links.find(link => link.modalityCode === record.modalityCode
    && (normalizeText(link.studyDescription) === study || normalizeText(link.procedureCode) === study))?.idrlExam || "";
};

const StatusBadge = ({ status }: { status: Status }) => {
  if (status.tone === "safe") return <Badge className="bg-emerald-600 text-white"><CheckCircle2 className="mr-1 h-3 w-3" />{status.label}</Badge>;
  if (status.tone === "danger") return <Badge className="bg-red-600 text-white"><ShieldAlert className="mr-1 h-3 w-3" />{status.label}</Badge>;
  return <Badge variant="outline">{status.label}</Badge>;
};

const AverageStudyIdrlPage = () => {
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
        doseService.fetchReports(), doseService.fetchIdrlRecords(), doseService.fetchIdrlStudyLinks(),
      ]);
      const storedIds = new Set(idrlRows.map(item => item.id));
      setRecords(doseRows as DoseRecord[]);
      setIdrlRecords([...idrlRows, ...defaultIdrlRecords.filter(item => !storedIds.has(item.id))] as IdrlRecord[]);
      setStudyLinks(linkRows as IdrlStudyLink[]);
    } catch (error) {
      if (!options?.silent) toast({ title: "Failed to load average study IDRL", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    dicomWebService.fetchUiSettings().then(settings => setAutoRefreshEnabled(typeof settings.autoRefresh === "boolean" ? settings.autoRefresh : true)).catch(() => setAutoRefreshEnabled(true));
  }, []);
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const id = window.setInterval(() => load({ silent: true }), 30000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, load]);

  const filteredRecords = useMemo(
    () => records.filter(record => record.modalityCode === modality && isRecordInPreset(record, datePreset, fromDate, toDateValue)),
    [datePreset, fromDate, modality, records, toDateValue],
  );
  const activeFields = doseFieldMap[modality];

  const rows = useMemo(() => {
    const groups = new Map<string, DoseRecord[]>();
    filteredRecords.forEach(record => {
      const idrlStudy = getLinkedIdrlStudy(record, studyLinks);
      const key = [record.modalityCode, idrlStudy || record.studyDescription, record.values.manufacturer || "", record.values.stationName || ""]
        .map(normalizeText).join("|");
      groups.set(key, [...(groups.get(key) || []), record]);
    });
    return Array.from(groups.entries()).map(([key, group]) => {
      const first = group[0];
      const idrlStudy = getLinkedIdrlStudy(first, studyLinks);
      const averages: Record<string, number> = {};
      const displayValues: Record<string, string> = {};
      activeFields.forEach(field => {
        const values = group.map(record => record.values[field.key]).filter(Boolean);
        if (textFields.has(field.key)) {
          displayValues[field.key] = Array.from(new Set(values)).join(", ") || "-";
          return;
        }
        const numericValues = values.map(parseNumber).filter((value): value is number => value !== null);
        if (numericValues.length) averages[field.key] = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
      });
      const limits = idrlRecords.filter(item => item.modalityCode === first.modalityCode && normalizeText(item.exam) === normalizeText(idrlStudy));
      const comparisons = limits.map(limit => {
        const average = averages[limit.metric];
        const limitValue = parseNumber(limit.limit);
        return average !== undefined && limitValue !== null ? average > limitValue : null;
      }).filter((value): value is boolean => value !== null);
      const status: Status = !idrlStudy
        ? { label: "No IDRL Mapping", tone: "neutral" }
        : comparisons.some(Boolean)
          ? { label: "Above IDRL", tone: "danger" }
          : comparisons.length
            ? { label: "Within IDRL", tone: "safe" }
            : { label: "No IDRL Limit", tone: "neutral" };
      return { key, first, idrlStudy, averages, displayValues, limits, status, studyCount: group.length };
    });
  }, [activeFields, filteredRecords, idrlRecords, studyLinks]);

  const aboveCount = rows.filter(row => row.status.tone === "danger").length;
  const withinCount = rows.filter(row => row.status.tone === "safe").length;
  const handleExportExcel = () => {
    const headers = ["No", "Study Count", "Modality", "Study", "IDRL Study", ...activeFields.map(field => `${textFields.has(field.key) ? field.label : `Average ${field.label}`}${field.unit ? ` (${field.unit})` : ""}`), "IDRL Limit", "Average IDRL Status"];
    const exportRows = rows.map((row, index) => [
      index + 1,
      row.studyCount,
      row.first.modalityCode,
      row.first.studyDescription || "-",
      row.idrlStudy || "-",
      ...activeFields.map(field => textFields.has(field.key) ? row.displayValues[field.key] || "-" : formatNumber(row.averages[field.key])),
      row.limits.length ? row.limits.map(limit => `${limit.metric}: ${limit.limit} ${limit.unit}`).join(" | ") : "-",
      row.status.label,
    ]);
    const period = getPeriodLabel(datePreset, fromDate, toDateValue);
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["Average Study IDRL"],
      [`Filter: ${modality} | ${period}`],
      [],
      headers,
      ...exportRows,
    ]);
    worksheet["!cols"] = headers.map(header => ({ wch: Math.max(12, Math.min(36, header.length + 6)) }));
    styleDoseWorksheet(worksheet, headers.length, exportRows.length);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Average Study IDRL");
    XLSX.writeFile(workbook, `average-study-idrl-${modality}-${fileDate()}.xlsx`);
  };

  return (
    <div className="admin-command-page min-h-full animate-fade-in space-y-5 p-6">
      <h1 className="page-title">Average Study IDRL</h1>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="dashboard-metric rounded-2xl border p-4"><div className="metric-label">Study Groups</div><div className="mt-2 text-3xl font-black">{rows.length}</div></div>
        <div className="dashboard-metric rounded-2xl border p-4"><div className="metric-label">Total Studies</div><div className="mt-2 text-3xl font-black">{filteredRecords.length}</div></div>
        <div className="dashboard-metric rounded-2xl border p-4"><div className="metric-label">Above IDRL</div><div className="mt-2 text-3xl font-black text-red-500">{aboveCount}</div></div>
        <div className="dashboard-metric rounded-2xl border p-4"><div className="metric-label">Within IDRL</div><div className="mt-2 text-3xl font-black text-emerald-600">{withinCount}</div></div>
      </div>

      <section className="overflow-hidden rounded-2xl border bg-card/70">
        <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
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
              <SelectContent><SelectItem value="today">Today</SelectItem><SelectItem value="7days">7 days ago</SelectItem><SelectItem value="1month">1 month</SelectItem><SelectItem value="3months">3 months</SelectItem><SelectItem value="range">Custom</SelectItem></SelectContent>
            </Select>
          </div>
          {datePreset === "range" && <div className="grid w-full gap-2 sm:w-[360px] sm:grid-cols-2">
            <div className="space-y-2"><label className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">From</label><Input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} className="h-10 rounded-xl" /></div>
            <div className="space-y-2"><label className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">To</label><Input type="date" value={toDateValue} onChange={event => setToDateValue(event.target.value)} className="h-10 rounded-xl" /></div>
          </div>}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full whitespace-nowrap text-sm">
            <thead><tr>
              <th className="px-4 py-3 text-left">Study Count</th><th className="px-4 py-3 text-left">Modality</th><th className="px-4 py-3 text-left">Study</th><th className="px-4 py-3 text-left">IDRL Study</th>
              {activeFields.map(field => <th key={field.key} className="px-4 py-3 text-left">{textFields.has(field.key) ? field.label : `Average ${field.label}`}{field.unit ? ` (${field.unit})` : ""}</th>)}
              <th className="px-4 py-3 text-left">IDRL Limit</th><th className="px-4 py-3 text-left">Average IDRL Status</th>
            </tr></thead>
            <tbody>
              {!rows.length ? <tr><td colSpan={activeFields.length + 6} className="px-4 py-10 text-center text-muted-foreground"><AlertTriangle className="mx-auto mb-2 h-5 w-5" />No dose data available for this period.</td></tr> : rows.map(row => <tr key={row.key}>
                <td className="px-4 py-3 font-semibold">{row.studyCount}</td><td className="px-4 py-3"><Badge variant="outline">{row.first.modalityCode}</Badge></td><td className="px-4 py-3">{row.first.studyDescription || "-"}</td><td className="px-4 py-3 font-semibold">{row.idrlStudy || "-"}</td>
                {activeFields.map(field => <td key={field.key} className="px-4 py-3">{textFields.has(field.key) ? row.displayValues[field.key] || "-" : formatNumber(row.averages[field.key])}</td>)}
                <td className="px-4 py-3">{row.limits.length ? row.limits.map(limit => `${limit.metric}: ${limit.limit} ${limit.unit}`).join(" | ") : "-"}</td><td className="px-4 py-3"><StatusBadge status={row.status} /></td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default AverageStudyIdrlPage;
