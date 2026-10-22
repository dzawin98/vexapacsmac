import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import {
  DEFAULT_EXPERTISE_TEMPLATE,
  PublicReport,
  PublicShareAssets,
  PublicStudyInfo,
  buildLetterheadHtml,
  dicomWebService,
  publicShareService,
} from "@/lib/dicomService";

type SeriesItem = {
  SeriesInstanceUID: string;
  SeriesNumber: string;
  SeriesDescription: string;
  Modality: string;
  NumberOfSeriesRelatedInstances: number;
};

type PublicInstance = {
  sopInstanceUid: string;
  imageNumber: string;
};

const sanitizeModalityCode = (modality?: string | null) => {
  const parts = String(modality || "")
    .split("\\")
    .map(item => item.trim().toUpperCase())
    .filter(Boolean)
    .filter(item => item !== "SR");
  return Array.from(new Set(parts)).join("\\");
};

const isRenderableSeriesModality = (modality?: string | null) =>
  Boolean(sanitizeModalityCode(modality));

const REPORT_BASE_WIDTH = 900;

const formatDicomDate = (value: string): string => {
  if (!value) return "";
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length >= 8) {
    const year = digits.slice(0, 4);
    const month = digits.slice(4, 6);
    const day = digits.slice(6, 8);
    return `${day}/${month}/${year}`;
  }
  return value;
};

const calculateAgeLabel = (birthDate: string, referenceDate?: string) => {
  const digitsBirth = birthDate.replace(/[^0-9]/g, "");
  if (digitsBirth.length < 8) return "";
  const birthYear = Number(digitsBirth.slice(0, 4));
  const birthMonth = Number(digitsBirth.slice(4, 6));
  const birthDay = Number(digitsBirth.slice(6, 8));
  const reference =
    referenceDate && referenceDate.replace(/[^0-9]/g, "").length >= 8 ? referenceDate : "";
  let refYear: number;
  let refMonth: number;
  let refDay: number;
  if (reference) {
    const digitsRef = reference.replace(/[^0-9]/g, "");
    refYear = Number(digitsRef.slice(0, 4));
    refMonth = Number(digitsRef.slice(4, 6));
    refDay = Number(digitsRef.slice(6, 8));
  } else {
    const now = new Date();
    refYear = now.getFullYear();
    refMonth = now.getMonth() + 1;
    refDay = now.getDate();
  }
  if (!Number.isFinite(birthYear) || !Number.isFinite(refYear)) return "";
  let years = refYear - birthYear;
  let months = refMonth - birthMonth;
  if (refDay < birthDay) {
    months -= 1;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0 || !Number.isFinite(years) || !Number.isFinite(months)) return "";
  return `${years} y ${months} mo`;
};

const formatReportDicomDate = (value?: string | null) => {
  if (!value) return "-";
  const raw = String(value).trim();
  if (!raw) return "-";
  if (/^\d{8}$/.test(raw)) {
    const year = raw.slice(0, 4);
    const month = raw.slice(4, 6);
    const day = raw.slice(6, 8);
    return `${day}/${month}/${year}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const day = String(parsed.getDate()).padStart(2, "0");
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const year = parsed.getFullYear();
  return `${day}/${month}/${year}`;
};

const formatStudyDateTime = (dateValue?: string | null, timeValue?: string | null) => {
  const date = formatDicomDate(dateValue ?? "");
  if (!date) return "-";
  if (!timeValue) return date;
  const raw = String(timeValue).trim();
  if (!raw) return date;
  if (/^\d{6}(\.\d+)?$/.test(raw)) {
    const hours = raw.slice(0, 2);
    const minutes = raw.slice(2, 4);
    return `${date} ${hours}:${minutes}`;
  }
  if (/^\d{4}(\.\d+)?$/.test(raw)) {
    const hours = raw.slice(0, 2);
    const minutes = raw.slice(2, 4);
    return `${date} ${hours}:${minutes}`;
  }
  return `${date} ${raw}`;
};

const formatDicomTime = (timeValue?: string | null) => {
  if (!timeValue) return "-";
  const raw = String(timeValue).trim();
  if (!raw) return "-";
  if (/^\d{6}(\.\d+)?$/.test(raw)) {
    const hours = raw.slice(0, 2);
    const minutes = raw.slice(2, 4);
    const seconds = raw.slice(4, 6);
    return seconds ? `${hours}:${minutes}:${seconds}` : `${hours}:${minutes}`;
  }
  if (/^\d{4}(\.\d+)?$/.test(raw)) {
    const hours = raw.slice(0, 2);
    const minutes = raw.slice(2, 4);
    return `${hours}:${minutes}`;
  }
  return raw;
};

const formatReportDate = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
};

const cleanReportPatientName = (patientName?: string | null, patientId?: string | null) => {
  const name = String(patientName || "").trim();
  const id = String(patientId || "").trim();
  if (!name || !id) return name;
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return name.replace(new RegExp(`\\s*[-–—/]?\\s*${escapedId}\\s*$`, "i"), "").trim() || name;
};

const getDicomString = (item: Record<string, { Value?: unknown[] }>, tag: string) => {
  const element = item[tag];
  const value = Array.isArray(element?.Value) ? element.Value[0] : undefined;
  return (value as string | number | undefined)?.toString() ?? "";
};

const getDicomNumber = (item: Record<string, { Value?: unknown[] }>, tag: string) => {
  const element = item[tag];
  const value = Array.isArray(element?.Value) ? element.Value[0] : undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const mapSeries = (item: Record<string, { Value?: unknown[] }>): SeriesItem => ({
  SeriesInstanceUID: getDicomString(item, "0020000E"),
  SeriesNumber: getDicomString(item, "00200011"),
  SeriesDescription: getDicomString(item, "0008103E"),
  Modality: sanitizeModalityCode(getDicomString(item, "00080060")),
  NumberOfSeriesRelatedInstances: getDicomNumber(item, "00201209"),
});

const mapInstances = (items: Record<string, { Value?: unknown[] }>[]): PublicInstance[] =>
  items.map((instance, index) => {
    const sopInstanceUid = getDicomString(instance, "00080018");
    const imageNumber = getDicomString(instance, "00200013") || String(index + 1);
    return { sopInstanceUid, imageNumber };
  });

const formatPortalErrorMessage = (message: string) => {
  const normalized = String(message || "").trim().toLowerCase();
  if (!normalized) {
    return "Sorry, the examination result data cannot be loaded right now.";
  }
  if (normalized.includes("link expired")) {
    return "This examination result link has expired. Please contact the healthcare facility or radiology admin to request a new link.";
  }
  if (normalized.includes("link not found")) {
    return "The examination result link was not found. Please make sure the link is correct or request a new link from the healthcare facility.";
  }
  if (normalized.includes("missing token")) {
    return "The examination result link is not valid. Please check the link again.";
  }
  return "Sorry, the examination result data cannot be loaded right now. Please try again later or contact the radiology admin.";
};

const PublicStudy = () => {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [study, setStudy] = useState<PublicStudyInfo | null>(null);
  const [report, setReport] = useState<PublicReport | null>(null);
  const [assets, setAssets] = useState<PublicShareAssets>({
    headerImage: null,
    signatureImage: null,
    templateHtml: null,
    qrPosition: "right",
  });
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(null);
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [instancesBySeries, setInstancesBySeries] = useState<Record<string, PublicInstance[]>>(
    {}
  );
  const [thumbnailSrcBySeries, setThumbnailSrcBySeries] = useState<Record<string, string>>({});
  const [activeSeriesId, setActiveSeriesId] = useState<string | null>(null);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [showImages, setShowImages] = useState(false);
  const [reportZoom, setReportZoom] = useState(1);
  const [reportFitScale, setReportFitScale] = useState(1);
  const [reportContentHeight, setReportContentHeight] = useState(1200);
  const reportContainerRef = useRef<HTMLDivElement | null>(null);
  const reportFrameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!token) {
      setError("Invalid link.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const payload = await publicShareService.fetchStudy(token);
        if (cancelled) return;
        setStudy(payload.study);
        setReport(payload.report);
        setAssets(
          payload.assets || {
            headerImage: null,
            signatureImage: null,
            templateHtml: null,
            qrPosition: "right",
          }
        );
        setShareExpiresAt(payload.share?.expires_at ?? null);
        setThumbnailSrcBySeries({});
      } catch (err) {
        if (!cancelled) {
          setError(
            formatPortalErrorMessage(err instanceof Error ? err.message : "Failed to load data.")
          );
          setStudy(null);
          setReport(null);
          setShareExpiresAt(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const loadSeries = async () => {
      setSeriesLoading(true);
      try {
        const data = await publicShareService.fetchSeries(token);
        if (cancelled) return;
        setSeries(data.map(mapSeries).filter(item => isRenderableSeriesModality(item.Modality)));
      } catch (err) {
        if (!cancelled) {
          setSeries([]);
        }
      } finally {
        if (!cancelled) setSeriesLoading(false);
      }
    };
    loadSeries();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSelectSeries = useCallback(async (seriesId: string) => {
    if (!token || !study) return;
    setActiveSeriesId(seriesId);
    setActiveImageIndex(0);
    if (!instancesBySeries[seriesId]) {
      try {
        const data = await publicShareService.fetchInstances(token, seriesId);
        const mapped = mapInstances(data);
        setInstancesBySeries(prev => ({ ...prev, [seriesId]: mapped }));
      } catch {
        setInstancesBySeries(prev => ({ ...prev, [seriesId]: [] }));
      }
    }
  }, [token, study, instancesBySeries]);

  useEffect(() => {
    if (!token || !study || series.length === 0) return;
    let cancelled = false;
    const warmSeriesThumbnails = async () => {
      for (const seriesItem of series) {
        if (cancelled) return;
        if (!seriesItem?.SeriesInstanceUID || thumbnailSrcBySeries[seriesItem.SeriesInstanceUID]) {
          continue;
        }
        try {
          const data = await publicShareService.fetchInstances(token, seriesItem.SeriesInstanceUID);
          if (cancelled) return;
          const mapped = mapInstances(data);
          if (!mapped.length || !mapped[0]?.sopInstanceUid) continue;
          setInstancesBySeries(prev => (
            prev[seriesItem.SeriesInstanceUID]
              ? prev
              : {
                  ...prev,
                  [seriesItem.SeriesInstanceUID]: mapped,
                }
          ));
          setThumbnailSrcBySeries(prev => ({
            ...prev,
            [seriesItem.SeriesInstanceUID]: dicomWebService.getInstanceThumbnailUrl(
              study.studyInstanceUid,
              seriesItem.SeriesInstanceUID,
              mapped[0].sopInstanceUid
            ),
          }));
        } catch {
          // Keep default series thumbnail when no instance preview is available.
        }
      }
    };
    warmSeriesThumbnails();
    return () => {
      cancelled = true;
    };
  }, [token, study, series, thumbnailSrcBySeries]);

  useEffect(() => {
    if (!study || !series.length || activeSeriesId) return;
    handleSelectSeries(series[0].SeriesInstanceUID);
  }, [series, study, activeSeriesId, handleSelectSeries]);

  const reportHtml = useMemo(() => {
    if (!study) return "";
    const reportMissing = !report;
    const logoUrl = `${window.location.origin}/logo.png`;
    const gender =
      study.sex === "F" ? "Female" : study.sex === "M" ? "Male" : study.sex || "-";
    const headerHtml = assets.headerImage
      ? buildLetterheadHtml(assets.headerImage)
      : `<div class="header-fallback"><img src="${logoUrl}" class="logo" /><div class="title">Radiology Report</div></div>`;
    const signatureHtml = assets.signatureImage
      ? `<img src="${assets.signatureImage}" class="signature-image" />`
      : "";
    const clinicalInfo = report?.clinical_info ?? "";
    const findings = report?.findings ?? "";
    const conclusion = report?.conclusion ?? "";
    const radiologistName = report?.radiologist_name || "-";
    const reportDateRaw =
      report?.finalized_at || report?.updated_at || report?.created_at || "";
    const reportDate = formatReportDate(reportDateRaw);
    const reportContent = `
      ${clinicalInfo || ""}
      ${clinicalInfo && (findings || conclusion) ? "<br/><br/>" : ""}
      ${findings || ""}
      ${(clinicalInfo || findings) && conclusion ? "<br/><br/>" : ""}
      ${conclusion || ""}
    `;
    const birthDateValue = formatReportDicomDate(study.birthDate);
    const birthAgeText = calculateAgeLabel(study.birthDate, study.studyDate);
    const birthDateAge =
      birthDateValue !== "-"
        ? `${birthDateValue}${birthAgeText ? ` - ${birthAgeText}` : ""}`
        : birthAgeText || "-";
    const shareUrl = token ? `${window.location.origin}/public/study/${token}` : "";
    const expDateText = shareExpiresAt
      ? new Date(shareExpiresAt).toLocaleString("id-ID", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "-";
    const qrAlign =
      assets.qrPosition === "left"
        ? "flex-start"
        : assets.qrPosition === "center"
          ? "center"
          : "flex-end";
    const qrImageTag = shareUrl
      ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(
          shareUrl
        )}" class="qr-image" style="display:block;width:140px;height:140px;object-fit:contain;margin:0 auto;" />`
      : "";
    const qrHtml = shareUrl
      ? `<div class="qr-slot" style="width:100%;display:flex;justify-content:${qrAlign};align-items:flex-end;text-align:center;">${qrImageTag}</div>`
      : "";
    const qrLabel = shareUrl ? "Scan for results" : "";
    const qrExpiry = shareUrl ? `EXP DATE: ${expDateText}` : "";
    const escapeQrText = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const qrBlockHtml = shareUrl
      ? `<div class="qr-slot" style="width:100%;display:flex;justify-content:${qrAlign};align-items:flex-end;text-align:center;"><div class="qr-block" style="width:160px;display:inline-flex;flex-direction:column;align-items:center;text-align:center;line-height:1.2;">${qrImageTag}<div class="qr-label" style="width:100%;margin-top:6px;text-align:center;">${escapeQrText(qrLabel)}</div><div class="qr-exp" style="width:100%;margin-top:4px;text-align:center;white-space:nowrap;">${escapeQrText(qrExpiry)}</div></div></div>`
      : "";
    const patientId = study.patientId || "-";
    const patientName = cleanReportPatientName(study.patientName, patientId) || "-";
    const escapeHtml = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const applyTemplate = (template: string, replacements: Record<string, string>) =>
      template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) =>
        Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : ""
      );
    const ensureQrPlaceholder = (value: string) => {
      if (value.includes("{{qr_html}}") || value.includes("{{qr_image_html}}") || value.includes("{{qr_block_html}}")) return value;
      const footerMatch = value.match(/<div[^>]*class=["']footer["'][^>]*>/i);
      if (footerMatch) {
        return value.replace(footerMatch[0], `${footerMatch[0]}{{qr_image_html}}<div>{{qr_label}}</div><div>{{qr_expiry}}</div>`);
      }
      return value.replace("</body>", `<div class="footer footer-qr-only">{{qr_image_html}}<div>{{qr_label}}</div><div>{{qr_expiry}}</div></div></body>`);
    };
    const rawTemplate =
      assets.templateHtml && assets.templateHtml.trim()
        ? assets.templateHtml
        : DEFAULT_EXPERTISE_TEMPLATE;
    const watermarkHtml = reportMissing
      ? `<div class="report-watermark" aria-hidden="true">No radiologist report yet</div>`
      : "";
    const ensureWatermarkPlaceholder = (value: string) => {
      if (value.includes("{{report_watermark}}")) return value;
      return value.replace("<body>", `<body>{{report_watermark}}`);
    };
    const template = ensureWatermarkPlaceholder(ensureQrPlaceholder(rawTemplate));
    return applyTemplate(template, {
      header_html: headerHtml,
      signature_html: signatureHtml,
      signature_name: escapeHtml(radiologistName),
      patient_name: escapeHtml(patientName),
      patient_id: escapeHtml(patientId),
      gender: escapeHtml(gender),
      birth_date: escapeHtml(birthDateValue || "-"),
      age: escapeHtml(birthAgeText || "-"),
      birth_date_age: escapeHtml(birthDateAge),
      study_description: escapeHtml(study.studyDescription || "-"),
      study_date: escapeHtml(formatDicomDate(study.studyDate || "") || "-"),
      study_time: escapeHtml(formatDicomTime(study.studyTime || "") || "-"),
      study_datetime: escapeHtml(formatDicomDate(study.studyDate || "") || "-"),
      referring_physician: escapeHtml(study.referringPhysician || "-"),
      radiologist_name: escapeHtml(radiologistName),
      clinical_info: clinicalInfo || "",
      findings: findings || "",
      conclusion: conclusion || "",
      report_content: reportContent,
      report_date: escapeHtml(reportDate),
      qr_html: qrHtml,
      qr_image_html: qrHtml,
      qr_label: escapeHtml(qrLabel),
      qr_expiry: escapeHtml(qrExpiry),
      qr_block_html: qrBlockHtml,
      report_watermark: watermarkHtml,
    });
  }, [assets, report, shareExpiresAt, study, token]);

  const reportPreviewHtml = useMemo(() => {
    if (!reportHtml) return "";
    const styleBlock = `
      <style>
        html, body { margin: 0; padding: 0; background: #ffffff; }
        body {
          position: relative;
          width: ${REPORT_BASE_WIDTH}px;
          margin: 0 auto;
          padding: 24px 20px 40px;
          box-sizing: border-box;
        }
        .print-table { width: 100%; }
        .report-watermark {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%) rotate(-24deg);
          font-size: 42px;
          font-weight: 700;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: rgba(148, 163, 184, 0.2);
          white-space: nowrap;
          pointer-events: none;
          user-select: none;
          z-index: 0;
        }
        body > * {
          position: relative;
          z-index: 1;
        }
      </style>
    `;
    return reportHtml
      .replace("</head>", `${styleBlock}</head>`);
  }, [reportHtml]);

  useEffect(() => {
    const container = reportContainerRef.current;
    if (!container) return;

    const updateScale = () => {
      const availableWidth = Math.max(container.clientWidth - 8, 1);
      const nextScale = Math.min(1, availableWidth / REPORT_BASE_WIDTH);
      setReportFitScale(Number(nextScale.toFixed(4)));
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(container);
    window.addEventListener("orientationchange", updateScale);

    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", updateScale);
    };
  }, [reportPreviewHtml]);

  const effectiveReportScale = Math.min(1.6, Math.max(0.25, reportFitScale * reportZoom));

  const handleDownloadPdf = useCallback(() => {
    if (!reportHtml) return;
    const printWindow = window.open("", "_blank", "width=900,height=1200");
    if (!printWindow) return;
    printWindow.document.open();
    printWindow.document.write(reportHtml);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 300);
  }, [reportHtml]);

  return (
    <div className="min-h-screen bg-slate-900 text-foreground overflow-x-hidden">
      <div className="px-4 py-6">
        {loading && (
          <div className="rounded-xl border border-dashed border-white/10 bg-black/30 p-6 text-sm text-slate-300">
            Loading data...
          </div>
        )}
        {error && !loading && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-sm text-destructive">
            {error}
          </div>
        )}
        {!loading && !error && study && (
          <div className="space-y-6">
            <div className="mx-auto max-w-5xl">
              <div
                className={`space-y-3 transition-all duration-300 ease-out ${
                  showImages ? "opacity-0 -translate-y-2 pointer-events-none max-h-0 overflow-hidden" : "opacity-100 translate-y-0 max-h-[2000px]"
                }`}
              >
                {!report && (
                  <div className="rounded-xl border border-dashed border-white/10 bg-black/30 p-4 text-sm text-slate-300">
                    The radiology report is not available yet. The PDF can still be opened, but `finding` and `conclusion` are still empty.
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setReportZoom(value => Math.max(0.8, Number((value - 0.1).toFixed(2))))
                      }
                      className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-slate-200 transition hover:border-emerald-400/50 hover:bg-emerald-400/10"
                    >
                      -
                    </button>
                    <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                      {Math.round(effectiveReportScale * 100)}%
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setReportZoom(value => Math.min(1.8, Number((value + 0.1).toFixed(2))))
                      }
                      className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-slate-200 transition hover:border-emerald-400/50 hover:bg-emerald-400/10"
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleDownloadPdf}
                    className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-widest text-slate-700 transition hover:border-emerald-500/60 hover:text-emerald-600"
                  >
                    Download PDF
                  </button>
                </div>
                <div
                  ref={reportContainerRef}
                  className="rounded-xl bg-white shadow-xl overflow-auto max-h-[calc(100dvh-160px)] p-1 sm:p-2"
                >
                  <div
                    className="mx-auto"
                    style={{
                      width: `${REPORT_BASE_WIDTH * effectiveReportScale}px`,
                      height: `${reportContentHeight * effectiveReportScale}px`,
                    }}
                  >
                    <iframe
                      ref={reportFrameRef}
                      title="Ekspertise"
                      className="bg-white block border-0"
                      style={{
                        width: `${REPORT_BASE_WIDTH}px`,
                        height: `${reportContentHeight}px`,
                        transform: `scale(${effectiveReportScale})`,
                        transformOrigin: "top left",
                      }}
                      srcDoc={reportPreviewHtml}
                      onLoad={() => {
                        const frame = reportFrameRef.current;
                        if (!frame?.contentWindow?.document?.body) return;
                        frame.contentWindow.document.designMode = "off";
                        frame.contentWindow.document.body.contentEditable = "false";
                        const height = frame.contentWindow.document.body.scrollHeight;
                        setReportContentHeight(Math.max(height, 900));
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="mx-auto flex max-w-6xl justify-center">
              <button
                type="button"
                onClick={() => setShowImages(value => !value)}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-6 py-2 text-sm font-semibold uppercase tracking-widest text-slate-200 transition-all duration-300 hover:-translate-y-0.5 hover:border-emerald-400/50 hover:bg-emerald-400/10"
              >
                <span>{showImages ? "Open Expertise" : "Open Image"}</span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform duration-300 ${
                    showImages ? "rotate-180" : ""
                  }`}
                />
              </button>
            </div>

            <div
              className={`mx-auto max-w-6xl space-y-4 transition-all duration-300 ease-out ${
                showImages ? "opacity-100 translate-y-0 max-h-[3000px]" : "opacity-0 -translate-y-2 pointer-events-none max-h-0 overflow-hidden"
              }`}
            >
              <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-300">
                  Series
                </div>
                <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
                  {seriesLoading && (
                    <div className="text-sm text-slate-300">Loading series...</div>
                  )}
                  {!seriesLoading && series.length === 0 && (
                    <div className="text-sm text-slate-300">No series available yet.</div>
                  )}
                  {series.map(s => {
                    const isActive = activeSeriesId === s.SeriesInstanceUID;
                    return (
                      <button
                        key={s.SeriesInstanceUID}
                        type="button"
                        onClick={() => handleSelectSeries(s.SeriesInstanceUID)}
                        className={`flex w-24 shrink-0 flex-col items-center gap-2 rounded-xl border px-2 py-2 text-center transition ${
                          isActive
                            ? "border-emerald-400/60 bg-emerald-400/10"
                            : "border-white/10 hover:border-emerald-400/40"
                        }`}
                      >
                        <div className="h-14 w-14 rounded-lg bg-white/5 flex items-center justify-center overflow-hidden">
                          <img
                            src={
                              thumbnailSrcBySeries[s.SeriesInstanceUID] ||
                              dicomWebService.getSeriesThumbnailUrl(
                                study.studyInstanceUid,
                                s.SeriesInstanceUID
                              )
                            }
                            alt="Series thumbnail"
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="text-[10px] font-semibold text-slate-200 line-clamp-2">
                          {s.SeriesDescription || `Series ${s.SeriesNumber || ""}`}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {s.NumberOfSeriesRelatedInstances || 0} image
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-black/50 p-4">
                {!activeSeriesId && (
                  <div className="text-sm text-slate-300">
                    Select a series to view images.
                  </div>
                )}
                {activeSeriesId && (
                  <div className="space-y-3">
                    {instancesBySeries[activeSeriesId]?.length ? (
                      <>
                        <div
                          className="flex items-center justify-center overflow-hidden"
                          style={{ maxHeight: 'calc(100dvh - 330px)' }}
                          onWheel={event => {
                            if (!activeSeriesId) return;
                            const instances = instancesBySeries[activeSeriesId];
                            if (!instances?.length) return;
                            const direction = event.deltaY > 0 ? 1 : -1;
                            setActiveImageIndex(prev => {
                              const max = instances.length - 1;
                              return Math.min(Math.max(prev + direction, 0), max);
                            });
                          }}
                        >
                          <img
                            src={dicomWebService.getInstanceThumbnailUrl(
                              study.studyInstanceUid,
                              activeSeriesId,
                              instancesBySeries[activeSeriesId][
                                Math.min(
                                  Math.max(activeImageIndex, 0),
                                  instancesBySeries[activeSeriesId].length - 1
                                )
                              ].sopInstanceUid
                            )}
                            alt="Image"
                            className="max-h-full max-w-full w-auto h-auto object-contain"
                          />
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={Math.max(instancesBySeries[activeSeriesId].length - 1, 0)}
                          value={Math.min(
                            Math.max(activeImageIndex, 0),
                            instancesBySeries[activeSeriesId].length - 1
                          )}
                          onChange={event => setActiveImageIndex(Number(event.target.value))}
                          className="w-full accent-emerald-400"
                        />
                      </>
                    ) : (
                      <div className="text-sm text-slate-300">No images available yet.</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PublicStudy;
