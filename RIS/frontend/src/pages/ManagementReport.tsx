import { useEffect, useState } from "react";
import { CalendarDays, Download, FileBarChart2 } from "lucide-react";
import * as XLSX from "xlsx-js-style";
import { managementReportService, type ManagementReportData } from "@/lib/dicomService";
import LoadingScreen from "@/components/LoadingScreen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";

type DatePreset = "today" | "yesterday" | "7days" | "30days" | "1month" | "2months" | "range";
type ReportType = "modality" | "room" | "exam" | "radiologist" | "technologist";

const datePresetOptions: { value: DatePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7days", label: "Last 7 days" },
  { value: "30days", label: "Last 30 days" },
  { value: "1month", label: "1 Month" },
  { value: "2months", label: "2 Month" },
  { value: "range", label: "Custom range" },
];

const toDateInput = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getPresetRange = (preset: DatePreset) => {
  const end = new Date();
  const start = new Date();
  if (preset === "today") return { startDate: toDateInput(end), endDate: toDateInput(end) };
  if (preset === "yesterday") {
    start.setDate(end.getDate() - 1);
    end.setDate(end.getDate() - 1);
    return { startDate: toDateInput(start), endDate: toDateInput(end) };
  }
  if (preset === "7days") start.setDate(end.getDate() - 6);
  if (preset === "30days") start.setDate(end.getDate() - 29);
  if (preset === "1month") start.setMonth(end.getMonth() - 1);
  if (preset === "2months") start.setMonth(end.getMonth() - 2);
  return { startDate: toDateInput(start), endDate: toDateInput(end) };
};

const formatDate = (value: string) =>
  new Date(`${value}T00:00:00`).toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

const formatDateTime = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatDateOnly = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

const formatMinutes = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const minutes = Number(value);
  if (minutes < 0) return "-";
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours <= 0) return `${remaining} min`;
  return `${hours}h ${remaining}m`;
};

const formatCito = (value?: string | null) =>
  ["1", "Y", "YES", "TRUE", "S", "E", "CITO", "EMERGENCY"].includes(String(value || "").trim().toUpperCase())
    ? "CITO"
    : "Routine";

const getWorkflowStatus = (row: ManagementReportData["rows"][number]) => {
  if (row.distributed_at) return "Distributed";
  if (row.qc_completed_at) return "QC Complete";
  if (row.report_finalized_at) return "Report Final";
  if (row.report_started_at) return "Reporting";
  if (row.study_completed_at) return "Study Complete";
  if (row.technologist_started_at) return "In Examination";
  if (row.mwl_published_at) return "Scheduled";
  return row.order_status || "Pending";
};

const performanceHeaders = [
  "No",
  "Accession",
  "No Register",
  "No RM",
  "Patient Name",
  "Birth Date",
  "Gender",
  "Study",
  "Modality",
  "Modality Room",
  "Priority",
  "Clinical Information",
  "Diagnosis",
  "Origin Room",
  "Payment Type",
  "Insurance",
  "Referring Physician",
  "Technologist",
  "Radiologist",
  "Workflow Status",
  "Order Status",
  "Report Status",
  "Order In",
  "Activated",
  "MWL Published",
  "Technologist Start",
  "Study Complete",
  "Report Start",
  "Report Final",
  "QC Completed",
  "Distributed",
  "Order to MWL",
  "Waiting",
  "Exam",
  "Completed to Report",
  "Read",
  "Final to QC",
  "QC to Distribution",
  "Turnaround",
];

const exportLabels: Record<ReportType, string> = {
  modality: "Modality Summary",
  room: "Room Utilization",
  exam: "Exam Summary",
  radiologist: "Radiologist Summary",
  technologist: "Technologist Summary",
};

const getReportSheetName = (reportType: ReportType) =>
  ({
    modality: "Modality",
    room: "Room Utilization",
    exam: "Exam",
    radiologist: "Radiologist",
    technologist: "Technologist",
  })[reportType];

const getReportHeaders = (reportType: ReportType) => {
  if (reportType === "room") return ["No", "Modality Code", "Room Name", "Study Count"];
  if (reportType === "exam") return ["No", "Exam", "Modality Code", "Study Count"];
  if (reportType === "radiologist") return ["No", "Modality Code", "Exam", "Radiologist", "Study Count"];
  if (reportType === "technologist") return ["No", "Modality Code", "Exam", "Technologist", "Study Count"];
  return ["No", "Modality Code", "Study Count"];
};

const getReportColumnWidths = (reportType: ReportType) => {
  if (reportType === "room") return [{ wch: 8 }, { wch: 18 }, { wch: 32 }, { wch: 16 }];
  if (reportType === "exam") return [{ wch: 8 }, { wch: 34 }, { wch: 18 }, { wch: 16 }];
  if (reportType === "radiologist" || reportType === "technologist") {
    return [{ wch: 8 }, { wch: 18 }, { wch: 34 }, { wch: 28 }, { wch: 16 }];
  }
  return [{ wch: 8 }, { wch: 22 }, { wch: 16 }];
};

const ManagementReport = () => {
  const { toast } = useToast();
  const [data, setData] = useState<ManagementReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportType, setReportType] = useState<ReportType>("modality");
  const [activeTab, setActiveTab] = useState<"report" | "performance">("report");
  const [preset, setPreset] = useState<DatePreset>("30days");
  const defaultRange = getPresetRange("30days");
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const [roomName, setRoomName] = useState("all");

  useEffect(() => {
    if (preset === "range") return;
    const range = getPresetRange(preset);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  }, [preset]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const report = await managementReportService.fetchReport({
          startDate,
          endDate,
          roomName: roomName === "all" ? undefined : roomName,
          limit: 500,
        });
        if (!cancelled) setData(report);
      } catch (error) {
        if (!cancelled) {
          toast({
            title: "Failed to load report",
            description: error instanceof Error ? error.message : "Management report could not be retrieved.",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [endDate, roomName, startDate, toast]);

  if (loading && !data) return <LoadingScreen />;

  const modalityRows = data?.breakdowns.modalities || [];
  const roomRows = data?.breakdowns.rooms || [];
  const examRows = data?.breakdowns.exams || [];
  const radiologistRows = data?.breakdowns.radiologistExams || [];
  const technologistRows = data?.breakdowns.technologistExams || [];
  const activeRows =
    reportType === "room"
      ? roomRows
      : reportType === "exam"
      ? examRows
      : reportType === "radiologist"
        ? radiologistRows
        : reportType === "technologist"
          ? technologistRows
          : modalityRows;
  const totalStudies = activeRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const reportTitle = exportLabels[reportType];
  const activePeriodLabel = datePresetOptions.find(item => item.value === preset)?.label || "Period";
  const performanceRows = data?.rows || [];

  const handleExportExcel = () => {
    const headers = getReportHeaders(reportType);
    const rows = activeRows.map((row, index) => {
      if (reportType === "room") {
        return [index + 1, "modality" in row ? row.modality || "-" : "-", row.name || "-", Number(row.count || 0)];
      }
      if (reportType === "exam") {
        return [index + 1, row.name || "-", "modality" in row ? row.modality || "-" : "-", Number(row.count || 0)];
      }

      if (reportType === "radiologist" || reportType === "technologist") {
        return [
          index + 1,
          "modality" in row ? row.modality || "-" : "-",
          "exam" in row ? row.exam || "-" : "-",
          row.name || "-",
          Number(row.count || 0),
        ];
      }

      return [index + 1, row.name || "-", Number(row.count || 0)];
    });

    const worksheet = XLSX.utils.aoa_to_sheet([
      [reportTitle],
      [`Period: ${formatDate(startDate)} - ${formatDate(endDate)}`],
      [],
      headers,
      ...rows,
      [],
      ["Total Studies", totalStudies],
    ]);

    const lastColumn = headers.length - 1;
    worksheet["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: lastColumn } },
    ];
    worksheet["!cols"] = getReportColumnWidths(reportType);
    worksheet["!autofilter"] = { ref: `A4:${XLSX.utils.encode_col(lastColumn)}${rows.length + 4}` };

    const titleCell = worksheet.A1;
    const periodCell = worksheet.A2;
    if (titleCell) {
      titleCell.s = {
        font: { bold: true, sz: 16, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "1F4E78" } },
        alignment: { horizontal: "left" },
      };
    }
    if (periodCell) {
      periodCell.s = {
        font: { italic: true, color: { rgb: "44546A" } },
        fill: { fgColor: { rgb: "D9EAF7" } },
      };
    }

    headers.forEach((_, columnIndex) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: 3, c: columnIndex })];
      if (!cell) return;
      cell.s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "2F75B5" } },
        alignment: { horizontal: columnIndex === lastColumn ? "right" : "left" },
        border: {
          top: { style: "thin", color: { rgb: "D9E2F3" } },
          bottom: { style: "thin", color: { rgb: "D9E2F3" } },
        },
      };
    });

    rows.forEach((_, rowIndex) => {
      headers.forEach((_, columnIndex) => {
        const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex + 4, c: columnIndex })];
        if (!cell) return;
        cell.s = {
          alignment: { horizontal: columnIndex === lastColumn ? "right" : "left" },
          fill: { fgColor: { rgb: rowIndex % 2 === 0 ? "F7FBFF" : "FFFFFF" } },
          border: { bottom: { style: "thin", color: { rgb: "E7EEF7" } } },
        };
      });
    });

    const totalRow = rows.length + 6;
    ["A", "B"].forEach(column => {
      const cell = worksheet[`${column}${totalRow}`];
      if (!cell) return;
      cell.s = {
        font: { bold: true },
        fill: { fgColor: { rgb: "E2F0D9" } },
      };
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, getReportSheetName(reportType));
    XLSX.writeFile(workbook, `report-${reportType}-${startDate}-to-${endDate}.xlsx`);
  };

  const handleExportPerformanceExcel = () => {
    const rows = performanceRows.map((row, index) => [
      index + 1,
      row.accession_number || row.no_rontgen || "-",
      row.no_register || "-",
      row.no_rm || "-",
      row.nama_pasien || "-",
      formatDateOnly(row.tanggal_lahir),
      row.kelamin || "-",
      row.study_description || "-",
      row.modality || "-",
      row.room_name || "-",
      formatCito(row.cito),
      row.klinis || "-",
      row.diagnosa || "-",
      row.origin_room || "-",
      row.payment_type || "-",
      row.insurance_name || "-",
      row.referring_physician || "-",
      row.radiographer || "-",
      row.radiologist || "-",
      getWorkflowStatus(row),
      row.order_status || "-",
      row.report_status || "-",
      formatDateTime(row.order_created_at),
      formatDateTime(row.order_activated_at),
      formatDateTime(row.mwl_published_at),
      formatDateTime(row.technologist_started_at),
      formatDateTime(row.study_completed_at),
      formatDateTime(row.report_started_at),
      formatDateTime(row.report_finalized_at),
      formatDateTime(row.qc_completed_at),
      formatDateTime(row.distributed_at),
      formatMinutes(row.order_to_mwl_minutes),
      formatMinutes(row.waiting_minutes),
      formatMinutes(row.examination_minutes),
      formatMinutes(row.radiologist_wait_minutes),
      formatMinutes(row.reading_minutes),
      formatMinutes(row.report_to_qc_minutes),
      formatMinutes(row.qc_to_distribution_minutes),
      formatMinutes(row.total_turnaround_minutes),
    ]);

    const worksheet = XLSX.utils.aoa_to_sheet([
      ["Performance Report"],
      [`Period: ${formatDate(startDate)} - ${formatDate(endDate)}`],
      [],
      performanceHeaders,
      ...rows,
    ]);

    worksheet["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: performanceHeaders.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: performanceHeaders.length - 1 } },
    ];
    worksheet["!cols"] = performanceHeaders.map(header => {
      if (["Clinical Information", "Diagnosis"].includes(header)) return { wch: 34 };
      if (["Patient Name", "Referring Physician", "Technologist", "Radiologist"].includes(header)) return { wch: 24 };
      if (["Workflow Status", "Technologist Start", "Study Complete", "Report Start", "Report Final", "QC Completed", "Distributed"].includes(header)) {
        return { wch: 20 };
      }
      return { wch: Math.max(header.length + 2, 14) };
    });
    worksheet["!autofilter"] = { ref: `A4:${XLSX.utils.encode_col(performanceHeaders.length - 1)}${rows.length + 4}` };

    const titleCell = worksheet.A1;
    const periodCell = worksheet.A2;
    if (titleCell) {
      titleCell.s = {
        font: { bold: true, sz: 16, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "1F4E78" } },
      };
    }
    if (periodCell) {
      periodCell.s = {
        font: { italic: true, color: { rgb: "44546A" } },
        fill: { fgColor: { rgb: "D9EAF7" } },
      };
    }

    performanceHeaders.forEach((_, columnIndex) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: 3, c: columnIndex })];
      if (!cell) return;
      cell.s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "2F75B5" } },
        alignment: { horizontal: "left", wrapText: true },
      };
    });

    rows.forEach((_, rowIndex) => {
      performanceHeaders.forEach((_, columnIndex) => {
        const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex + 4, c: columnIndex })];
        if (!cell) return;
        cell.s = {
          alignment: { horizontal: "left", vertical: "top", wrapText: true },
          fill: { fgColor: { rgb: rowIndex % 2 === 0 ? "F7FBFF" : "FFFFFF" } },
          border: { bottom: { style: "thin", color: { rgb: "E7EEF7" } } },
        };
      });
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Performance");
    XLSX.writeFile(workbook, `performance-${startDate}-to-${endDate}.xlsx`);
  };

  return (
    <div className="admin-command-page dashboard-command-surface min-h-full p-6 animate-fade-in">
      <div className="space-y-5">
        <div>
          <h1 className="page-title">Report</h1>
        </div>

        <Tabs value={activeTab} onValueChange={value => setActiveTab(value as "report" | "performance")} className="space-y-5">
          <TabsList className="h-auto rounded-2xl border border-border/70 bg-card/70 p-1">
            <TabsTrigger value="report" className="rounded-xl px-5 py-2.5">
              Report
            </TabsTrigger>
            <TabsTrigger value="performance" className="rounded-xl px-5 py-2.5">
              Performance
            </TabsTrigger>
          </TabsList>

          <div
            className={`grid gap-3 rounded-2xl border border-border/70 bg-card/70 p-4 ${
              activeTab === "report" ? "lg:grid-cols-[240px_240px_minmax(260px,420px)]" : "lg:grid-cols-[240px_minmax(260px,420px)]"
            }`}
          >
            {activeTab === "report" && (
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Report Type</label>
                <Select value={reportType} onValueChange={value => setReportType(value as ReportType)}>
                  <SelectTrigger className="h-11 rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="modality">Modality</SelectItem>
                    <SelectItem value="room">Room Utilization</SelectItem>
                    <SelectItem value="exam">Exam</SelectItem>
                    <SelectItem value="radiologist">Radiologist</SelectItem>
                    <SelectItem value="technologist">Technologist</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Room Name</label>
              <Select value={roomName} onValueChange={setRoomName}>
                <SelectTrigger className="h-11 rounded-xl">
                  <SelectValue placeholder="All rooms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Rooms</SelectItem>
                  {(data?.filters.rooms || []).map(room => (
                    <SelectItem key={room} value={room}>{room}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Period</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className="h-11 w-full justify-between rounded-xl px-3 font-normal">
                    <span>{activePeriodLabel}</span>
                    <CalendarDays className="h-4 w-4 opacity-70" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[440px] max-w-[calc(100vw-2rem)] rounded-2xl p-4">
                  <RadioGroup value={preset} onValueChange={value => setPreset(value as DatePreset)} className="grid gap-3">
                    {datePresetOptions.map(item => (
                      <label key={item.value} className="flex cursor-pointer items-center gap-3 text-sm font-medium text-foreground">
                        <RadioGroupItem value={item.value} id={`report-period-${item.value}`} />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </RadioGroup>
                  {preset === "range" && (
                    <div className="mt-4 space-y-3">
                      <div className="grid grid-cols-[44px_1fr] items-center gap-3">
                        <span className="text-sm text-muted-foreground">From</span>
                        <Input
                          type="date"
                          value={startDate}
                          onChange={event => setStartDate(event.target.value)}
                          className="h-12 rounded-xl"
                        />
                      </div>
                      <div className="grid grid-cols-[44px_1fr] items-center gap-3">
                        <span className="text-sm text-muted-foreground">To</span>
                        <Input
                          type="date"
                          value={endDate}
                          onChange={event => setEndDate(event.target.value)}
                          className="h-12 rounded-xl"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        className="px-0 font-semibold"
                        onClick={() => {
                          const range = getPresetRange("30days");
                          setPreset("30days");
                          setStartDate(range.startDate);
                          setEndDate(range.endDate);
                        }}
                      >
                        Clear
                      </Button>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <TabsContent value="report" className="mt-0">
            <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/70">
              <div className="flex flex-col gap-3 border-b border-border/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FileBarChart2 className="h-4 w-4 text-muted-foreground" />
                    {reportTitle}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatDate(startDate)} - {formatDate(endDate)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="rounded-full bg-muted px-3 py-1 text-sm font-semibold text-muted-foreground">
                    {totalStudies} studies
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleExportExcel}
                    disabled={activeRows.length === 0}
                    title="Export to Excel"
                    aria-label="Export to Excel"
                    className="rounded-full"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto">
              <table key={reportType} className="min-w-max w-full whitespace-nowrap text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr className="border-b border-border/70">
                    <th className="w-20 px-5 py-3 font-semibold text-muted-foreground whitespace-nowrap">No</th>
                    {reportType === "room" ? (
                      <>
                        <th className="w-40 px-5 py-3 font-semibold text-muted-foreground whitespace-nowrap">Modality Code</th>
                        <th className="px-5 py-3 font-semibold text-muted-foreground whitespace-nowrap">Room Name</th>
                      </>
                    ) : reportType === "exam" ? (
                      <>
                        <th className="px-5 py-3 font-semibold text-muted-foreground whitespace-nowrap">Exam</th>
                        <th className="w-40 px-5 py-3 font-semibold text-muted-foreground whitespace-nowrap">Modality Code</th>
                      </>
                    ) : reportType === "radiologist" || reportType === "technologist" ? (
                      <>
                        <th className="w-40 px-5 py-3 font-semibold text-muted-foreground whitespace-nowrap">Modality Code</th>
                        <th className="px-5 py-3 font-semibold text-muted-foreground whitespace-nowrap">Exam</th>
                        <th className="px-5 py-3 font-semibold text-muted-foreground whitespace-nowrap">
                          {reportType === "radiologist" ? "Radiologist" : "Technologist"}
                        </th>
                      </>
                    ) : (
                      <th className="px-5 py-3 font-semibold text-muted-foreground whitespace-nowrap">Modality Code</th>
                    )}
                    <th className="w-40 px-5 py-3 text-right font-semibold text-muted-foreground whitespace-nowrap">Study Count</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRows.length > 0 ? (
                    activeRows.map((row, index) => {
                      const rowKey =
                        reportType === "radiologist" || reportType === "technologist"
                          ? `${reportType}-${row.modality || "-"}-${row.exam || "-"}-${row.name || "-"}-${index}`
                          : reportType === "room"
                            ? `${reportType}-${row.modality || "-"}-${row.name || "-"}-${index}`
                          : reportType === "exam"
                            ? `${reportType}-${row.name || "-"}-${row.modality || "-"}-${index}`
                            : `${reportType}-${row.name || "-"}-${index}`;

                      return (
                        <tr key={rowKey} className="border-b border-border/50 last:border-0">
                          <td className="px-5 py-3 text-muted-foreground">{index + 1}</td>
                          {reportType === "room" ? (
                            <>
                              <td className="px-5 py-3 text-foreground">{row.modality || "-"}</td>
                              <td className="px-5 py-3 font-medium text-foreground">{row.name || "-"}</td>
                            </>
                          ) : reportType === "exam" ? (
                            <>
                              <td className="px-5 py-3 font-medium text-foreground">{row.name || "-"}</td>
                              <td className="px-5 py-3 text-foreground">{row.modality || "-"}</td>
                            </>
                          ) : reportType === "radiologist" || reportType === "technologist" ? (
                            <>
                              <td className="px-5 py-3 text-foreground">{row.modality || "-"}</td>
                              <td className="px-5 py-3 font-medium text-foreground">{row.exam || "-"}</td>
                              <td className="px-5 py-3 text-foreground">{row.name || "-"}</td>
                            </>
                          ) : (
                            <td className="px-5 py-3 font-medium text-foreground">{row.name || "-"}</td>
                          )}
                          <td className="px-5 py-3 text-right font-semibold text-foreground">{row.count}</td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td
                        colSpan={reportType === "room" || reportType === "exam" ? 4 : reportType === "radiologist" || reportType === "technologist" ? 5 : 3}
                        className="px-5 py-10 text-center text-muted-foreground"
                      >
                        No data available for the selected period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="performance" className="mt-0 space-y-5">
            <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/70">
              <div className="flex flex-col gap-2 border-b border-border/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">Performance Timeline</div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatDate(startDate)} - {formatDate(endDate)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="rounded-full bg-muted px-3 py-1 text-sm font-semibold text-muted-foreground">
                    {performanceRows.length} studies
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleExportPerformanceExcel}
                    disabled={performanceRows.length === 0}
                    title="Export to Excel"
                    aria-label="Export performance to Excel"
                    className="rounded-full"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-[3200px] w-full whitespace-nowrap text-sm">
                  <thead className="bg-muted/40 text-left">
                    <tr className="border-b border-border/70">
                      <th className="px-5 py-3 font-semibold text-muted-foreground">No</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Accession</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">No Register</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">No RM</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Patient Name</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Birth Date</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Gender</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Study</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Modality</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Modality Room</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Priority</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Clinical Information</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Diagnosis</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Origin Room</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Payment</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Insurance</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Referring Physician</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Technologist</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Radiologist</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Workflow Status</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Order Status</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Report Status</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Order In</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Activated</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">MWL Published</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Technologist Start</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Study Complete</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Report Start</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Report Final</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">QC</th>
                      <th className="px-5 py-3 font-semibold text-muted-foreground">Distributed</th>
                      <th className="px-5 py-3 text-right font-semibold text-muted-foreground">Order to MWL</th>
                      <th className="px-5 py-3 text-right font-semibold text-muted-foreground">Waiting</th>
                      <th className="px-5 py-3 text-right font-semibold text-muted-foreground">Exam</th>
                      <th className="px-5 py-3 text-right font-semibold text-muted-foreground">Completed to Report</th>
                      <th className="px-5 py-3 text-right font-semibold text-muted-foreground">Read</th>
                      <th className="px-5 py-3 text-right font-semibold text-muted-foreground">Final to QC</th>
                      <th className="px-5 py-3 text-right font-semibold text-muted-foreground">QC to Distribution</th>
                      <th className="px-5 py-3 text-right font-semibold text-muted-foreground">Turnaround</th>
                    </tr>
                  </thead>
                  <tbody>
                    {performanceRows.length > 0 ? (
                      performanceRows.map((row, index) => (
                        <tr key={`${row.id}-${row.study_instance_uid || index}`} className="border-b border-border/50 last:border-0">
                          <td className="px-5 py-3 text-muted-foreground">{index + 1}</td>
                          <td className="px-5 py-3 text-foreground">{row.accession_number || row.no_rontgen || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.no_register || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.no_rm || "-"}</td>
                          <td className="px-5 py-3 font-medium text-foreground">{row.nama_pasien || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateOnly(row.tanggal_lahir)}</td>
                          <td className="px-5 py-3 text-foreground">{row.kelamin || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.study_description || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.modality || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.room_name || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{formatCito(row.cito)}</td>
                          <td className="px-5 py-3 text-foreground">{row.klinis || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.diagnosa || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.origin_room || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.payment_type || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.insurance_name || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.referring_physician || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.radiographer || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.radiologist || "-"}</td>
                          <td className="px-5 py-3 font-medium text-foreground">{getWorkflowStatus(row)}</td>
                          <td className="px-5 py-3 text-foreground">{row.order_status || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{row.report_status || "-"}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateTime(row.order_created_at)}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateTime(row.order_activated_at)}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateTime(row.mwl_published_at)}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateTime(row.technologist_started_at)}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateTime(row.study_completed_at)}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateTime(row.report_started_at)}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateTime(row.report_finalized_at)}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateTime(row.qc_completed_at)}</td>
                          <td className="px-5 py-3 text-foreground">{formatDateTime(row.distributed_at)}</td>
                          <td className="px-5 py-3 text-right text-foreground">{formatMinutes(row.order_to_mwl_minutes)}</td>
                          <td className="px-5 py-3 text-right text-foreground">{formatMinutes(row.waiting_minutes)}</td>
                          <td className="px-5 py-3 text-right text-foreground">{formatMinutes(row.examination_minutes)}</td>
                          <td className="px-5 py-3 text-right text-foreground">{formatMinutes(row.radiologist_wait_minutes)}</td>
                          <td className="px-5 py-3 text-right text-foreground">{formatMinutes(row.reading_minutes)}</td>
                          <td className="px-5 py-3 text-right text-foreground">{formatMinutes(row.report_to_qc_minutes)}</td>
                          <td className="px-5 py-3 text-right text-foreground">{formatMinutes(row.qc_to_distribution_minutes)}</td>
                          <td className="px-5 py-3 text-right font-semibold text-foreground">{formatMinutes(row.total_turnaround_minutes)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={38} className="px-5 py-10 text-center text-muted-foreground">
                          No performance data available for the selected period.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default ManagementReport;
