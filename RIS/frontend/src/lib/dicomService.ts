// DICOMWeb Service
import { resolveBackendUrl, resolveDicomwebBaseUrl } from "@/lib/backendUrl";

export interface WorklistItem {
  PatientID: string;
  PatientName: string;
  OtherPatientIDs?: string;
  AccessionNumber: string;
  InstitutionName?: string;
  ModalityCode: string;
  StudyDescription: string;
  StudyTime: string;
  NumberOfStudyRelatedInstances: number;
  NumberOfStudyRelatedSeries: number;
  ReferringPhysicianName: string;
  StudyDate: string;
  StudyID?: string;
  PatientBirthDate: string;
  PatientSex: string;
  StudyInstanceUID: string;
}

export interface SeriesItem {
  SeriesInstanceUID: string;
  SeriesNumber: string;
  SeriesDescription: string;
  Modality: string;
  BodyPartExamined?: string;
  ProtocolName?: string;
  Laterality?: string;
  NumberOfSeriesRelatedInstances: number;
}

export interface DicomManagerSkippedInstance {
  sopInstanceUid?: string | null;
  reason: string;
  status?: number | null;
}

/** Compact outcome kept on every history row so warnings are visible at a glance. */
export interface DicomManagerOperationOutcome {
  cancelled: boolean;
  sourceStudyRemoved: boolean;
  movedSeriesCount: number | null;
  movedInstanceCount: number | null;
  pendingSeriesCount: number | null;
  skippedInstanceCount: number | null;
  recoveredFiles: number | null;
  unindexedFiles: number | null;
  pacsRefreshStatus: string | null;
  sourceRefreshStatus: string | null;
  reindexStatus: string | null;
}

/** Full detail, only returned by GET /dicom/manager/operations/:id. */
export interface DicomManagerResultDetail {
  cancelled?: boolean;
  sourceStudyRemoved?: boolean;
  movedSeriesCount?: number;
  movedInstanceCount?: number;
  pendingSeriesCount?: number;
  pendingSeriesUids?: string[];
  pendingSeriesTruncated?: boolean;
  skippedInstanceCount?: number;
  skippedInstances?: DicomManagerSkippedInstance[];
  skippedInstancesTruncated?: boolean;
  recoveredFiles?: number;
  unindexedFiles?: number;
  waitForIndex?: { ready: boolean; waitedMs: number } | null;
  sourceRefreshStatus?: string;
  pacsRefreshStatus?: string | null;
  reindex?: { status?: string | null; mode?: string | null; reason?: string | null } | null;
}

export interface DicomManagerReindexResult {
  ok: boolean;
  studyInstanceUid: string;
  /** Set when the server accepted the work in the background (HTTP 202). */
  accepted?: boolean;
  operationId?: string;
  status?: string;
  refresh?: {
    status?: string;
    mode?: string;
    reason?: string;
    indexed?: number;
    unchanged?: number;
    unindexable?: number;
    files?: number;
    recoveredFiles?: number;
  } | null;
}

export interface DicomManagerOperation {
  id: string;
  parentOperationId?: string | null;
  restoredByOperationId?: string | null;
  operationType: "patient_correction" | "study_merge" | "series_move" | "instance_move" | "restore" | string;
  status: "prepared" | "completed" | "cancelled" | "restoring" | "restored" | "restore_failed" | "failed" | string;
  sourceStudyUid?: string | null;
  sourceSeriesUid?: string | null;
  sourceSopUid?: string | null;
  targetStudyUid?: string | null;
  targetSeriesUid?: string | null;
  targetPatientId?: string | null;
  username?: string | null;
  reason?: string | null;
  objectCount: number;
  snapshotAvailable: boolean;
  canRestore: boolean;
  progress?: {
    stage?: string | null;
    done: number;
    total: number;
    updatedAt?: string | null;
  } | null;
  cancelRequested?: boolean;
  outcome?: DicomManagerOperationOutcome;
  errorMessage?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  restoredAt?: string | null;
  restoredBy?: string | null;
  restoreReason?: string | null;
  details?: {
    input?: Record<string, unknown>;
    result?: DicomManagerResultDetail | null;
    entries?: Array<{
      studyInstanceUid?: string;
      seriesInstanceUid?: string;
      sopInstanceUid?: string;
      targetSeriesInstanceUid?: string;
      hasTargetConflictBackup?: boolean;
    }>;
  };
}

export interface DicomManagerRestoreConflict {
  code: string;
  message: string;
  sopInstanceUid?: string;
}

export interface DicomManagerRestorePreflight {
  operation: DicomManagerOperation;
  canRestore: boolean;
  conflicts: DicomManagerRestoreConflict[];
}

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

interface DicomJsonElement {
  Value?: unknown[];
}

type DicomJsonStudy = Record<string, DicomJsonElement>;
type DicomJsonSeries = Record<string, DicomJsonElement>;

const BACKEND_URL = resolveBackendUrl();
const DICOMWEB_BASE_URL = resolveDicomwebBaseUrl();
const PREVIEW_RENDER_VERSION = "dicom-rendered-physical-v7";

export const LETTERHEAD_PRINT_HEIGHT_MM = 32;
export const LETTERHEAD_PAGE_MARGIN_MM = 20;
export const LETTERHEAD_IMAGE_GUIDANCE =
  "A4 portrait full page width 210 mm. Use PNG/JPG around 2400-3000 px wide and 350-600 px high, aspect ratio about 5:1 to 7:1.";

export const buildLetterheadHtml = (imageSrc: string, alt = "Kop Surat") => {
  const safeSrc = String(imageSrc || "").replace(/"/g, "&quot;");
  const safeAlt = String(alt || "Kop Surat").replace(/"/g, "&quot;");
  return `<div class="letterhead-frame" style="width:calc(100% + ${LETTERHEAD_PAGE_MARGIN_MM * 2}mm);height:${LETTERHEAD_PRINT_HEIGHT_MM}mm;margin:0 -${LETTERHEAD_PAGE_MARGIN_MM}mm 12px;overflow:hidden;text-align:center;page-break-inside:avoid;"><img src="${safeSrc}" alt="${safeAlt}" class="header-image" style="display:block;width:100%;height:100%;max-width:100%;max-height:${LETTERHEAD_PRINT_HEIGHT_MM}mm;object-fit:fill;object-position:center center;border:0;" /></div>`;
};

export const DEFAULT_EXPERTISE_TEMPLATE = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Radiology Report</title>
    <style>
      @page { size: A4; margin: 20mm; }
      body { font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
      .letterhead-frame { width: calc(100% + 40mm); height: 32mm; margin: 0 -20mm 12px; overflow: hidden; text-align: center; page-break-inside: avoid; }
      .header-image { display: block; width: 100%; height: 100%; max-width: 100%; max-height: 32mm; object-fit: fill; object-position: center center; border: 0; }
      .header-fallback { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 16px; }
      .title { font-size: 18px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
      .logo { height: 48px; }
      .section { margin-bottom: 14px; }
      .section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 6px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      td { padding: 6px 8px; vertical-align: top; }
      .label { color: #111; font-weight: 600; }
      .value { color: #111; }
      .print-table { width: 100%; border-collapse: collapse; }
      .print-table thead { display: table-header-group; }
      .print-table td { padding: 0; }
      .info-table { width: 100%; border-top: 1px solid #111; border-bottom: 1px solid #111; margin-bottom: 16px; table-layout: fixed; }
      .info-table > tbody > tr > td { width: 50%; }
      .info-block { width: 100%; border-collapse: collapse; table-layout: fixed; }
      .info-block td { padding: 3px 0; line-height: 1.5; }
      .info-label { width: 140px; white-space: nowrap; }
      .info-sep { width: 12px; text-align: center; }
      .info-value { word-break: break-word; }
      .content { font-size: 12px; line-height: 1.6; }
      .footer { margin-top: 28px; }
      .footer-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: end; }
      .footer-qr-only { display: flex; justify-content: flex-end; }
      .footer-slot { border: 1px dashed #bbb; padding: 8px; min-height: 180px; }
      .slot-label { font-size: 10px; color: #666; margin-bottom: 6px; }
      .qr-slot { width: auto; display: flex; flex-direction: column; align-items: flex-start; }
      .qr-block { width: 160px; text-align: center; }
      .qr-image { width: 140px; height: 140px; object-fit: contain; }
      .qr-label { font-size: 10px; margin-top: 6px; }
      .qr-exp { font-size: 10px; margin-top: 4px; }
      .qr-placeholder { font-size: 10px; color: #666; border: 1px dashed #bbb; padding: 6px 8px; margin-top: 6px; }
      .qr-block .qr-image ~ .qr-placeholder { display: none; }
      .signature-block { text-align: center; width: 100%; }
      .signature-placeholder { font-size: 10px; color: #666; border: 1px dashed #bbb; padding: 6px 8px; margin-top: 6px; }
      .signature-block .signature-image ~ .signature-placeholder { display: none; }
      @media print { .footer-slot { border: none; padding: 0; min-height: 0; } .slot-label { display: none; } .qr-placeholder { display: none; } .signature-placeholder { display: none; } .print-border, .print-border td, .print-border th { border: none !important; } }
      .signature-title { font-size: 12px; margin-bottom: 6px; }
      .signature-role { font-size: 12px; margin-bottom: 10px; }
      .signature-image { max-height: 80px; width: 100%; object-fit: contain; margin: 8px 0; }
      .signature-name { font-size: 12px; font-weight: 600; }
    </style>
  </head>
  <body>
    <table class="print-table">
      <thead>
        <tr>
          <td>
            {{header_html}}
            <div class="section">
              <table class="info-table">
                <tr>
                  <td>
                    <table class="info-block">
                      <tr>
                        <td class="info-label label">Patient Name</td>
                        <td class="info-sep">:</td>
                        <td class="info-value value">{{patient_name}}</td>
                      </tr>
                      <tr>
                        <td class="info-label label">Medical Record No</td>
                        <td class="info-sep">:</td>
                        <td class="info-value value">{{patient_id}}</td>
                      </tr>
                      <tr>
                        <td class="info-label label">Sex</td>
                        <td class="info-sep">:</td>
                        <td class="info-value value">{{gender}}</td>
                      </tr>
                      <tr>
                        <td class="info-label label">Birth Date</td>
                        <td class="info-sep">:</td>
                        <td class="info-value value">{{birth_date_age}}</td>
                      </tr>
                    </table>
                  </td>
                  <td>
                    <table class="info-block">
                      <tr>
                        <td class="info-label label">Study</td>
                        <td class="info-sep">:</td>
                        <td class="info-value value">{{study_description}}</td>
                      </tr>
                      <tr>
                        <td class="info-label label">Study Date</td>
                        <td class="info-sep">:</td>
                        <td class="info-value value">{{study_date}}</td>
                      </tr>
                      <tr>
                        <td class="info-label label">Clinician</td>
                        <td class="info-sep">:</td>
                        <td class="info-value value">{{referring_physician}}</td>
                      </tr>
                      <tr>
                        <td class="info-label label">Radiology Doctor</td>
                        <td class="info-sep">:</td>
                        <td class="info-value value">{{radiologist_name}}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </div>
          </td>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <div class="section">
              <div class="content">
                {{report_content}}
              </div>
            </div>
            <div class="footer footer-grid">
              <div class="footer-slot qr-slot">
                <div class="slot-label">QR Area</div>
                <div class="qr-block">
                  {{qr_image_html}}
                  <div class="qr-label">{{qr_label}}</div>
                  <div class="qr-exp">{{qr_expiry}}</div>
                  <div class="qr-placeholder">QR here</div>
                </div>
              </div>
              <div class="footer-slot signature-block">
                <div class="slot-label">Signature Area</div>
                <div class="signature-title">Created By:</div>
                <div class="signature-role">Radiology Specialist</div>
                {{signature_html}}
                <div class="signature-placeholder">Signature here</div>
                <div class="signature-name">{{signature_name}}</div>
              </div>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>
`;

const getStoredUser = (): { username?: string; role?: string } | null => {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem("nexia_auth_user");
    if (!stored) return null;
    return JSON.parse(stored) as { username?: string; role?: string } | null;
  } catch {
    return null;
  }
};

const withRoleHeaders = (headers?: Record<string, string>) => {
  const user = getStoredUser();
  return {
    ...headers,
    ...(user?.role ? { "x-user-role": user.role } : {}),
    ...(user?.username ? { "x-user-username": user.username } : {}),
  };
};

export interface DeleteOptions {
  reason?: string;
}

const deleteRequestInit = (options?: DeleteOptions): RequestInit => ({
  method: "DELETE",
  headers: withRoleHeaders(options?.reason ? { "Content-Type": "application/json" } : undefined),
  ...(options?.reason ? { body: JSON.stringify({ deleteReason: options.reason }) } : {}),
});

export interface User {
  id: number;
  username: string;
  name: string;
  phone_number?: string | null;
  usernamepacs?: string | null;
  has_passwordpacs?: number | boolean;
  role: string;
  theme?: "light" | "dark";
  created_at: string;
  password?: string;
  passwordpacs?: string;
  doctor_id?: number | null;
  doctor_code?: string | null;
  doctor_name?: string | null;
}

export interface RolePermissions {
  role: string;
  permissions: string[];
  doctor_group?: string | null;
  default_landing_page?: string | null;
}

export interface MwlPatient {
  id: number;
  no_rm: string;
  nama_pasien: string;
  tanggal_lahir: string;
  kelamin: "M" | "F" | "O";
  alamat?: string | null;
  kecamatan?: string | null;
  kabupaten?: string | null;
  provinsi?: string | null;
  kode_pos?: string | null;
  no_hp?: string | null;
  waktu_update_pasien?: string | null;
  update_simrs?: "N" | "Y" | string;
}

export interface MwlOrder {
  id: number;
  patient_record_id: number;
  alamat?: string | null;
  kecamatan?: string | null;
  kabupaten?: string | null;
  provinsi?: string | null;
  kode_pos?: string | null;
  study_master_id?: number | null;
  modality_station_id?: number | null;
  tanggal_order?: string | null;
  tanggal_aktivasi?: string | null;
  order_in_tanggal_order?: string | null;
  order_in_tanggal_aktivasi?: string | null;
  accession_number: string;
  no_register?: string | null;
  no_rontgen?: string | null;
  study_instance_uid?: string;
  actual_study_instance_uid?: string | null;
  reconcile_status?: string | null;
  reconcile_method?: string | null;
  reconciled_at?: string | null;
  reconciled_by?: string | null;
  study_date: string;
  study_time?: string | null;
  modality: string;
  cito?: string | null;
  polirawat?: string | null;
  kode_ruangan?: string | null;
  nama_ruangan?: string | null;
  procedure_code?: string | null;
  procedure_desc: string;
  klinis?: string | null;
  diagnosa?: string | null;
  kode_pemeriksaan?: string | null;
  nama_pemeriksaan?: string | null;
  kode_dokter?: string | null;
  nama_dokter?: string | null;
  kode_admin?: string | null;
  nama_admin?: string | null;
  kode_dokter_radiolog?: string | null;
  nama_radiolog?: string | null;
  kode_radiografer?: string | null;
  nama_radiografer?: string | null;
  cara_bayar?: string | null;
  kode_asuransi?: string | null;
  nama_asuransi?: string | null;
  kode_instalasi_radiologi?: string | null;
  nama_instalasi_radiologi?: string | null;
  waktu_update_orderin?: string | null;
  update_ris?: string | null;
  referring_physician?: string | null;
  technologist_id?: number | null;
  technologist_doctor_id?: number | null;
  technologist_username?: string | null;
  technologist_name?: string | null;
  study_master_procedure_code?: string | null;
  study_master_modality_code?: string | null;
  study_master_description?: string | null;
  referring_doctor_id?: number | null;
  radiologist_doctor_id?: number | null;
  referring_doctor_name?: string | null;
  referring_doctor_code?: string | null;
  radiologist_doctor_name?: string | null;
  radiologist_doctor_code?: string | null;
  modality_station_ae?: string | null;
  modality_station_room?: string | null;
  modality_station_aet_master?: string | null;
  has_active_mwl?: number;
  assigned_staff_json?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  deleted_reason?: string | null;
  restored_at?: string | null;
  restored_by?: string | null;
  status: "PENDING" | "SENT_TO_MWL" | "COMPLETED" | "CANCELLED";
  no_rm: string;
  nama_pasien: string;
  tanggal_lahir?: string;
  kelamin?: "M" | "F" | "O";
  created_at: string;
  updated_at: string;
}

export interface MwlReconcileCandidate {
  id: number;
  orderId: number;
  patientId: string;
  patientName: string;
  accessionNumber: string;
  plannedStudyInstanceUid: string;
  actualStudyInstanceUid?: string | null;
  modality: string;
  studyDescription: string;
  studyDate?: string | null;
  status: string;
  reconcileStatus?: string | null;
  matchReason?: string | null;
}

export interface MwlReconcileCandidatesResponse {
  pacsStudy: {
    studyInstanceUid: string;
    accessionNumber: string;
    patientId: string;
    patientName?: string;
    modality?: string;
    studyDescription?: string;
    studyDate?: string;
  };
  exact: MwlReconcileCandidate | null;
  candidates: MwlReconcileCandidate[];
  needsConfirmation: boolean;
}

export interface MwlStudyMaster {
  id: number;
  procedure_code: string;
  modality_code: string;
  study_description: string;
  created_at?: string;
  updated_at?: string;
}

export interface DoseReportRecord {
  id: string;
  patientId: string;
  patientName: string;
  accessionNumber: string;
  modalityCode: string;
  studyDescription: string;
  studyDate: string;
  studyTime: string;
  sex: "M" | "F" | "O" | string;
  birthDate: string;
  cito?: boolean;
  radiologist: string;
  technologist: string;
  medicalPhysicist?: string;
  room: string;
  aeTitle: string;
  studyInstanceUid: string;
  savedAt: string;
  captureMode: "auto" | "manual";
  values: Record<string, string>;
}

export interface DoseExtractionResult {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  modalityCode: string;
  patientId?: string;
  patientName?: string;
  accessionNumber?: string;
  studyDescription?: string;
  studyDate?: string;
  studyTime?: string;
  values: Record<string, string>;
  source?: {
    seriesDescription?: string;
    numericMeasurements?: Array<{ concept: string; path: string; value: number; unit?: string }>;
  };
}

export interface DoseIdrlRecord {
  id: string;
  modalityCode: string;
  exam: string;
  metric: string;
  limit: string;
  unit: string;
  bodyRegion: string;
  reference: string;
  effectiveDate: string;
}

export interface DoseIdrlStudyLink {
  id: string;
  modalityCode: string;
  idrlExam: string;
  studyMasterId: number;
  procedureCode: string;
  studyDescription: string;
}

export interface MwlDoctor {
  id: number;
  kode_dokter: string;
  nama_dokter: string;
  role: "CLINICIAN" | "RADIOLOGIST" | "ADMISSION" | "TECHNOLOGIST" | "FISMED";
  user_id?: number | null;
  linked_username?: string | null;
  linked_user_name?: string | null;
  linked_phone_number?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MwlModalityStation {
  id: number;
  nama_ruangan: string;
  ae_title_station: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MwlStatusLog {
  id: number;
  order_id: number;
  orthanc_file_name?: string | null;
  transport_method?: string | null;
  orthanc_status: string;
  is_active: number;
  message?: string | null;
  sync_date: string;
  accession_number: string;
  order_status: "PENDING" | "SENT_TO_MWL" | "COMPLETED" | "CANCELLED";
  modality: string;
  procedure_desc: string;
  study_instance_uid?: string | null;
  study_date?: string | null;
  study_time?: string | null;
  tanggal_order?: string | null;
  tanggal_aktivasi?: string | null;
  no_register?: string | null;
  no_rontgen?: string | null;
  klinis?: string | null;
  diagnosa?: string | null;
  nama_ruangan?: string | null;
  modality_station_room?: string | null;
  modality_station_aet_master?: string | null;
  technologist_name?: string | null;
  technologist_username?: string | null;
  assigned_staff_json?: string | null;
  kode_admin?: string | null;
  nama_admin?: string | null;
  kode_radiografer?: string | null;
  nama_radiografer?: string | null;
  kode_dokter_radiolog?: string | null;
  nama_radiolog?: string | null;
  referring_doctor_name?: string | null;
  radiologist_doctor_name?: string | null;
  no_rm: string;
  nama_pasien: string;
  status_indicator: "SENT_TO_ORTHANC" | "ACTIVE" | "COMPLETED" | string;
}

export interface MwlPublishedItem {
  id: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  accession_number: string;
  study_instance_uid?: string | null;
  patient_id?: string | null;
  patient_name?: string | null;
  modality?: string | null;
  station_aet?: string | null;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  tags_json?: Record<string, unknown> | null;
  meta_json?: {
    patientId?: string;
    patientName?: string;
    modality?: string;
    procedureCode?: string;
    procedureDescription?: string;
    referringPhysician?: string;
    studyInstanceUid?: string;
    technologist?: {
      id?: number;
      username?: string;
      name?: string;
    } | null;
    stationAet?: string | null;
  } | null;
}

export interface MwlQueryLog {
  id: number;
  created_at: string;
  calling_ae_title?: string | null;
  called_ae_title?: string | null;
  remote_address?: string | null;
  remote_port?: number | null;
  patient_id?: string | null;
  patient_name?: string | null;
  accession_number?: string | null;
  study_instance_uid?: string | null;
  modality?: string | null;
  scheduled_station_ae_title?: string | null;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  match_count?: number | null;
  outcome: "MATCHED" | "NO_MATCH" | "ERROR" | string;
  status_code?: string | null;
  reason_code?: string | null;
  error_message?: string | null;
  recommendation?: string | null;
  matched_worklist_ids?: string[];
  active_worklist_count?: number | null;
  filter_summary_json?: Record<string, unknown> | null;
  query_json?: Record<string, unknown> | null;
}

export interface MwlTechnologist {
  id: number;
  username: string;
  name: string;
  role: string;
}

export interface MwlAssignedStaff {
  id: number;
  kode_dokter: string;
  nama_dokter: string;
  role: "RADIOLOGIST" | "TECHNOLOGIST";
}

export interface DicomNode {
  id: number;
  name: string;
  aet: string;
  host: string;
  port: number;
  description?: string | null;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AuditLogEntry {
  id: number;
  event_type: string;
  outcome: "success" | "failure" | string;
  username?: string | null;
  role?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  study_instance_uid?: string | null;
  series_instance_uid?: string | null;
  sop_instance_uid?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  details_json?: string | Record<string, unknown> | null;
  study_info?: {
    patient_id?: string | null;
    patient_name?: string | null;
    other_patient_ids?: string | null;
    patient_birth_date?: string | null;
    patient_sex?: string | null;
    accession_number?: string | null;
    institution_name?: string | null;
    study_description?: string | null;
    referring_physician?: string | null;
    modality?: string | null;
    study_date?: string | null;
    study_time?: string | null;
    study_id?: string | null;
  } | null;
  created_at: string;
}

export interface AuditLogFilters {
  limit?: number;
  studyInstanceUid?: string;
  eventType?: string;
  username?: string;
}

export interface MwlQueryLogEntry {
  id: number;
  created_at: string;
  calling_ae_title: string | null;
  called_ae_title: string | null;
  remote_address: string | null;
  remote_port: number | null;
  patient_id: string | null;
  patient_name: string | null;
  accession_number: string | null;
  study_instance_uid: string | null;
  modality: string | null;
  scheduled_station_ae_title: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  match_count: number;
  outcome: string;
  status_code: string | null;
  reason_code: string | null;
  error_message: string | null;
  recommendation: string | null;
  matched_worklist_ids: string[];
  active_worklist_count: number | null;
  filter_summary_json: Record<string, unknown> | null;
  query_json: Record<string, unknown> | null;
}

export interface MwlQueryLogFilters {
  limit?: number;
  callingAe?: string;
  calledAe?: string;
  remoteAddress?: string;
  patientId?: string;
  accessionNumber?: string;
  studyInstanceUid?: string;
  modality?: string;
  stationAet?: string;
  outcome?: string;
}

export interface SystemLogEvent {
  id?: number;
  created_at?: string;
  event_type?: string;
  outcome?: string;
  username?: string | null;
  role?: string | null;
  ip_address?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  details_json?: string | Record<string, unknown> | null;
  calling_ae_title?: string | null;
  remote_address?: string | null;
  patient_id?: string | null;
  accession_number?: string | null;
  modality?: string | null;
  match_count?: number;
  status_code?: string | null;
  error_message?: string | null;
}

export interface SystemLogSummary {
  generatedAt: string;
  health: {
    status: "healthy" | "attention" | "warning" | string;
    uptimeSeconds: number;
    dbLatencyMs: number;
    memory: {
      rssMb: number;
      heapUsedMb: number;
      heapTotalMb: number;
    };
    backendPort: number;
    nodeEnv: string;
  };
  troubleshooting: {
    failureEvents24h: number;
    mwlErrors24h: number;
    recentFailures: SystemLogEvent[];
    recentMwlErrors: SystemLogEvent[];
  };
  security: {
    loginEvents24h: number;
    failedLoginEvents24h: number;
    uniqueIpCount24h: number;
    recentEvents: SystemLogEvent[];
  };
  performance: {
    auditEvents24h: number;
    mwlQueries24h: number;
    mwlNoMatchQueries24h: number;
    hourlyAuditEvents: Array<{ bucket: string; count: number }>;
    topEventTypes: Array<{ event_type: string; count: number }>;
  };
  compliance: {
    retentionSource: string;
    latestAuditId?: number | null;
    evidenceFields: string[];
  };
  mwl?: {
    unavailable?: boolean;
    error?: string | null;
  };
}

export interface RadiologyReport {
  id: number;
  study_instance_uid: string;
  patient_id: string | null;
  radiologist_id: number | null;
  radiologist_name?: string | null;
  clinical_info: string | null;
  findings: string | null;
  conclusion: string | null;
  kritis?: "0" | "1";
  status: "draft" | "final";
  created_at: string;
  updated_at: string;
  finalized_at?: string | null;
}

export interface RadiologistTemplate {
  id: number;
  title: string;
  findings: string | null;
  conclusion: string | null;
  modality_code?: string | null;
  procedure_code?: string | null;
  procedure_description?: string | null;
  radiologist_username?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface RadiologyReportRevision {
  id: number;
  report_id: number | null;
  study_instance_uid: string;
  patient_id: string | null;
  radiologist_id: number | null;
  radiologist_name?: string | null;
  clinical_info: string | null;
  findings: string | null;
  conclusion: string | null;
  kritis?: "0" | "1";
  status: "draft" | "final" | string | null;
  created_at: string;
  finalized_at?: string | null;
}

export interface RadiologistAssignment {
  study_instance_uid: string;
  radiologist_id: number | null;
  radiologist_username?: string | null;
  radiologist_name?: string | null;
}

export interface StudyTimeline {
  study_instance_uid: string;
  order: {
    id: number;
    accession_number?: string | null;
    status?: string | null;
  } | null;
  timestamps: {
    order_created_at?: string | null;
    order_activated_at?: string | null;
    mwl_published_at?: string | null;
    technologist_started_at?: string | null;
    study_completed_at?: string | null;
    report_started_at?: string | null;
    report_finalized_at?: string | null;
    qc_completed_at?: string | null;
    distributed_at?: string | null;
  };
  actors?: {
    admin?: string | null;
    technologist?: string | null;
    radiologist?: string | null;
    qc_processed_by?: string | null;
    distributed_by?: string | null;
  };
}

export const usersService = {
  fetchUsers: async (): Promise<User[]> => {
    const response = await fetch(`${BACKEND_URL}/users`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch users");
    return response.json();
  },
  createUser: async (user: {
    username: string;
    name: string;
    password: string;
    phoneNumber?: string | null;
    usernamepacs?: string | null;
    passwordpacs?: string | null;
    role: string;
    doctorId?: number | null;
  }): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/users`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(user),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to create user");
    }
  },
  updateUser: async (id: number, user: {
    username: string;
    name: string;
    phoneNumber?: string | null;
    role: string;
    password?: string;
    usernamepacs?: string | null;
    passwordpacs?: string;
    doctorId?: number | null;
  }): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/users/${id}`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(user),
    });
    if (!response.ok) throw new Error("Failed to update user");
  },
  deleteUser: async (id: number, options?: DeleteOptions): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/users/${id}`, {
      ...deleteRequestInit(options),
    });
    if (!response.ok) throw new Error("Failed to delete user");
  },
  changePassword: async (payload: {
    username: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/users/change-password`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Failed to change password");
    }
  },
  updateUserTheme: async (payload: {
    username: string;
    theme: "light" | "dark";
  }): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/users/theme`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Failed to update theme");
    }
  },
};

export const roleService = {
  fetchRoles: async (): Promise<RolePermissions[]> => {
    const response = await fetch(`${BACKEND_URL}/roles`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch roles");
    return response.json();
  },
  fetchRole: async (role: string): Promise<RolePermissions> => {
    const response = await fetch(`${BACKEND_URL}/roles/${encodeURIComponent(role)}`);
    if (!response.ok) throw new Error("Failed to fetch role permissions");
    return response.json();
  },
  updateRole: async (
    role: string,
    permissions: string[],
    doctorGroup?: string | null,
    defaultLandingPage?: string | null
  ): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/roles/${encodeURIComponent(role)}`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        permissions,
        doctorGroup: doctorGroup ?? null,
        defaultLandingPage: defaultLandingPage ?? null,
      }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update role permissions");
    }
  },
};

export const doseService = {
  fetchReports: async (params?: { modality?: string }): Promise<DoseReportRecord[]> => {
    const url = new URL(`${BACKEND_URL}/dose/reports`);
    if (params?.modality) url.searchParams.set("modality", params.modality);
    const response = await fetch(url.toString(), { headers: withRoleHeaders() });
    if (!response.ok) throw new Error("Failed to fetch dose reports");
    return response.json();
  },

  saveReport: async (record: DoseReportRecord): Promise<DoseReportRecord> => {
    const response = await fetch(`${BACKEND_URL}/dose/reports`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(record),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to save dose report");
    }
    return response.json();
  },

  getDose: async (studyInstanceUid: string): Promise<DoseExtractionResult> => {
    const response = await fetch(`${BACKEND_URL}/dose/getdose`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ studyInstanceUid }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || "Failed to extract dose report");
    }
    return response.json();
  },

  fetchIdrlRecords: async (): Promise<DoseIdrlRecord[]> => {
    const response = await fetch(`${BACKEND_URL}/dose/idrl`, { headers: withRoleHeaders() });
    if (!response.ok) throw new Error("Failed to fetch IDRL records");
    return response.json();
  },

  saveIdrlRecords: async (records: DoseIdrlRecord[]): Promise<DoseIdrlRecord[]> => {
    const response = await fetch(`${BACKEND_URL}/dose/idrl/bulk`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ records }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to save IDRL records");
    }
    return response.json();
  },

  deleteIdrlRecord: async (id: string): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/dose/idrl/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to delete IDRL record");
    }
  },

  fetchIdrlStudyLinks: async (): Promise<DoseIdrlStudyLink[]> => {
    const response = await fetch(`${BACKEND_URL}/dose/idrl-study-links`, { headers: withRoleHeaders() });
    if (!response.ok) throw new Error("Failed to fetch IDRL study links");
    return response.json();
  },

  saveIdrlStudyLinks: async (
    target: { modalityCode: string; idrlExam: string },
    links: DoseIdrlStudyLink[]
  ): Promise<DoseIdrlStudyLink[]> => {
    const response = await fetch(`${BACKEND_URL}/dose/idrl-study-links`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ target, links }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to save IDRL study links");
    }
    return response.json();
  },
};

export const mwlService = {
  fetchModalityStations: async (query?: string): Promise<MwlModalityStation[]> => {
    const url = new URL(`${BACKEND_URL}/mwl/modalities`);
    if (query?.trim()) {
      url.searchParams.set("q", query.trim());
    }
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch modality stations");
    }
    return response.json();
  },

  createModalityStation: async (payload: {
    namaRuangan: string;
    aeTitleStation?: string;
  }): Promise<MwlModalityStation> => {
    const response = await fetch(`${BACKEND_URL}/mwl/modalities`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to create modality station");
    }
    return response.json();
  },

  updateModalityStation: async (
    id: number,
    payload: {
      namaRuangan: string;
      aeTitleStation?: string;
    }
  ): Promise<MwlModalityStation> => {
    const response = await fetch(`${BACKEND_URL}/mwl/modalities/${id}`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update modality station");
    }
    return response.json();
  },

  deleteModalityStation: async (id: number, options?: DeleteOptions): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/mwl/modalities/${id}`, {
      ...deleteRequestInit(options),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to delete modality station");
    }
  },

  fetchDoctors: async (
    params?: { q?: string; role?: "CLINICIAN" | "RADIOLOGIST" | "ADMISSION" | "TECHNOLOGIST" | "FISMED" | "ALL" }
  ): Promise<MwlDoctor[]> => {
    const url = new URL(`${BACKEND_URL}/mwl/doctors`);
    if (params?.q?.trim()) {
      url.searchParams.set("q", params.q.trim());
    }
    if (params?.role && params.role !== "ALL") {
      url.searchParams.set("role", params.role);
    }
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch doctors");
    }
    return response.json();
  },

  createDoctor: async (payload: {
    kodeDokter: string;
    namaDokter: string;
    role: "CLINICIAN" | "RADIOLOGIST" | "ADMISSION" | "TECHNOLOGIST" | "FISMED";
  }): Promise<MwlDoctor> => {
    const response = await fetch(`${BACKEND_URL}/mwl/doctors`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to create doctor");
    }
    return response.json();
  },

  updateDoctor: async (
    id: number,
    payload: {
      kodeDokter: string;
      namaDokter: string;
      role: "CLINICIAN" | "RADIOLOGIST" | "ADMISSION" | "TECHNOLOGIST" | "FISMED";
    }
  ): Promise<MwlDoctor> => {
    const response = await fetch(`${BACKEND_URL}/mwl/doctors/${id}`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update doctor");
    }
    return response.json();
  },

  deleteDoctor: async (id: number, options?: DeleteOptions): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/mwl/doctors/${id}`, {
      ...deleteRequestInit(options),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to delete doctor");
    }
  },

  fetchStudyMasters: async (query?: string): Promise<MwlStudyMaster[]> => {
    const url = new URL(`${BACKEND_URL}/mwl/studies`);
    if (query?.trim()) {
      url.searchParams.set("q", query.trim());
    }
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch MWL study masters");
    }
    return response.json();
  },

  createStudyMaster: async (payload: {
    procedureCode: string;
    modalityCode: string;
    studyDescription: string;
  }): Promise<MwlStudyMaster> => {
    const response = await fetch(`${BACKEND_URL}/mwl/studies`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to create study master");
    }
    return response.json();
  },

  updateStudyMaster: async (
    id: number,
    payload: {
      procedureCode: string;
      modalityCode: string;
      studyDescription: string;
    }
  ): Promise<MwlStudyMaster> => {
    const response = await fetch(`${BACKEND_URL}/mwl/studies/${id}`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update study master");
    }
    return response.json();
  },

  deleteStudyMaster: async (id: number, options?: DeleteOptions): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/mwl/studies/${id}`, {
      ...deleteRequestInit(options),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to delete study master");
    }
  },

  fetchPatients: async (query?: string): Promise<MwlPatient[]> => {
    const url = new URL(`${BACKEND_URL}/mwl/patients`);
    if (query?.trim()) {
      url.searchParams.set("q", query.trim());
    }
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch MWL patients");
    }
    return response.json();
  },

  registerPatient: async (payload: {
    noRm: string;
    namaPasien: string;
    tanggalLahir: string;
    kelamin: "M" | "F" | "O";
    alamat?: string;
    kecamatan?: string;
    kabupaten?: string;
    provinsi?: string;
    kodePos?: string;
    noHp?: string;
    updateSimrs?: "N" | "Y";
  }): Promise<MwlPatient> => {
    const response = await fetch(`${BACKEND_URL}/mwl/patients`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to register patient");
    }
    return response.json();
  },

  updatePatient: async (
    id: number,
    payload: {
      noRm: string;
      namaPasien: string;
      tanggalLahir: string;
      kelamin: "M" | "F" | "O";
      alamat?: string;
      kecamatan?: string;
      kabupaten?: string;
      provinsi?: string;
      kodePos?: string;
      noHp?: string;
      updateSimrs?: "N" | "Y";
    }
  ): Promise<MwlPatient> => {
    const response = await fetch(`${BACKEND_URL}/mwl/patients/${id}`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update patient");
    }
    return response.json();
  },

  deletePatient: async (id: number, options?: DeleteOptions): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/mwl/patients/${id}`, {
      ...deleteRequestInit(options),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to delete patient");
    }
  },

  fetchOrders: async (params?: {
    q?: string;
    status?: "PENDING" | "SENT_TO_MWL" | "COMPLETED" | "CANCELLED" | "ALL";
    limit?: number;
    includeDeleted?: boolean;
    /** Date window applied by the DATABASE, not the browser. */
    dateMode?: "today" | "yesterday" | "7days" | "30days" | "1month" | "2months" | "range" | "all";
    dateFrom?: string;
    dateTo?: string;
    offset?: number;
  }): Promise<MwlOrder[]> => {
    const url = new URL(`${BACKEND_URL}/mwl/orders`);
    if (params?.q?.trim()) {
      url.searchParams.set("q", params.q.trim());
    }
    if (params?.status && params.status !== "ALL") {
      url.searchParams.set("status", params.status);
    }
    if (params?.limit) {
      url.searchParams.set("limit", String(params.limit));
    }
    if (params?.dateMode && params.dateMode !== "all") {
      url.searchParams.set("dateMode", params.dateMode);
      if (params.dateMode === "range") {
        if (params.dateFrom) url.searchParams.set("dateFrom", params.dateFrom);
        if (params.dateTo) url.searchParams.set("dateTo", params.dateTo);
      }
    }
    if (params?.offset) {
      url.searchParams.set("offset", String(params.offset));
    }
    if (params?.includeDeleted) {
      url.searchParams.set("includeDeleted", "true");
    }
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch MWL orders");
    }
    return response.json();
  },

  createOrder: async (payload: {
    patientRecordId: number;
    studyMasterId?: number;
    referringDoctorId?: number;
    radiologistDoctorId?: number;
    technologistDoctorId?: number;
    accessionNumber?: string;
    noRegister?: string;
    noRontgen?: string;
    tanggalOrder?: string;
    tanggalAktivasi?: string;
    studyDate: string;
    studyTime?: string;
    modality: string;
    cito?: string;
    polirawat?: string;
    kodeRuangan?: string;
    namaRuangan?: string;
    klinis: string;
    diagnosa?: string;
    kodePemeriksaan?: string;
    namaPemeriksaan?: string;
    caraBayar?: string;
    kodeAsuransi?: string;
    namaAsuransi?: string;
    kodeInstalasiRadiologi?: string;
    namaInstalasiRadiologi?: string;
    updateRis?: string;
    procedureCode?: string;
    procedureDesc: string;
    referringPhysician?: string;
  }): Promise<MwlOrder> => {
    const response = await fetch(`${BACKEND_URL}/mwl/orders`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to create MWL order");
    }
    return response.json();
  },

  updateOrder: async (
    id: number,
    payload: {
      patientRecordId: number;
      studyMasterId?: number;
      referringDoctorId?: number;
      radiologistDoctorId?: number;
      technologistDoctorId?: number;
      accessionNumber?: string;
      noRegister?: string;
      noRontgen?: string;
      tanggalOrder?: string;
      tanggalAktivasi?: string;
      studyDate: string;
      studyTime?: string;
      modality: string;
      cito?: string;
      polirawat?: string;
      kodeRuangan?: string;
      namaRuangan?: string;
      klinis: string;
      diagnosa?: string;
      kodePemeriksaan?: string;
      namaPemeriksaan?: string;
      caraBayar?: string;
      kodeAsuransi?: string;
      namaAsuransi?: string;
      kodeInstalasiRadiologi?: string;
      namaInstalasiRadiologi?: string;
      updateRis?: string;
      procedureCode?: string;
      procedureDesc: string;
      referringPhysician?: string;
    }
  ): Promise<MwlOrder> => {
    const response = await fetch(`${BACKEND_URL}/mwl/orders/${id}`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update MWL order");
    }
    return response.json();
  },

  deleteOrder: async (id: number, options?: DeleteOptions): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/mwl/orders/${id}`, {
      ...deleteRequestInit(options),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to delete MWL order");
    }
  },

  restoreOrder: async (id: number): Promise<MwlOrder> => {
    const response = await fetch(`${BACKEND_URL}/mwl/orders/${id}/restore`, {
      method: "POST",
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to restore MWL order");
    }
    return response.json();
  },

  fetchTechnologists: async (): Promise<MwlTechnologist[]> => {
    const response = await fetch(`${BACKEND_URL}/mwl/technologists`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch technologists");
    }
    return response.json();
  },

  sendToModality: async (
    orderId: number,
    payload: { staffIds: number[]; modalityStationId?: number; modalityStationAet?: string }
  ): Promise<{
    order: MwlOrder;
    mwlDispatch: {
      orthancFileName?: string | null;
      transportMethod?: string;
      orthancStatus: string;
    };
  }> => {
    const response = await fetch(`${BACKEND_URL}/mwl/orders/${orderId}/send`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to send MWL order");
    }
    return response.json();
  },

  updateOrderStatus: async (
    orderId: number,
    status: "PENDING" | "SENT_TO_MWL" | "COMPLETED" | "CANCELLED"
  ): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/mwl/orders/${orderId}/status`, {
      method: "PATCH",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update MWL order status");
    }
  },

  sendDirectToRadiologist: async (orderId: number): Promise<{ order: MwlOrder; message: string }> => {
    const response = await fetch(`${BACKEND_URL}/mwl/orders/${orderId}/direct-radiologist`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to send order direct to radiologist");
    }
    return response.json();
  },

  fetchStatus: async (): Promise<MwlStatusLog[]> => {
    const response = await fetch(`${BACKEND_URL}/mwl/status`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch MWL status");
    }
    return response.json();
  },

  fetchPublished: async (params?: { active?: boolean | "all" }): Promise<MwlPublishedItem[]> => {
    const url = new URL(`${BACKEND_URL}/mwl/published`);
    if (params?.active === "all") {
      url.searchParams.set("active", "all");
    } else if (typeof params?.active === "boolean") {
      url.searchParams.set("active", params.active ? "true" : "false");
    }
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch published MWL items");
    }
    return response.json();
  },

  fetchQueryLogs: async (params?: {
    limit?: number;
    callingAe?: string;
    calledAe?: string;
    remoteAddress?: string;
    patientId?: string;
    accessionNumber?: string;
    studyInstanceUid?: string;
    modality?: string;
    stationAet?: string;
    outcome?: string;
  }): Promise<MwlQueryLog[]> => {
    const url = new URL(`${BACKEND_URL}/mwl/query-logs`);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      url.searchParams.set(key, String(value));
    });
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch MWL query logs");
    }
    const payload = await response.json();
    return Array.isArray(payload?.logs) ? payload.logs : [];
  },
};

export const mwlReconcileService = {
  fetchCandidates: async (payload: {
    studyInstanceUid: string;
    accessionNumber?: string;
    patientId?: string;
    patientName?: string;
    modality?: string;
    studyDescription?: string;
    studyDate?: string;
  }): Promise<MwlReconcileCandidatesResponse> => {
    const response = await fetch(`${BACKEND_URL}/mwl/reconcile/candidates`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to find MWL reconciliation candidates");
    }
    return response.json();
  },

  confirm: async (payload: {
    orderId: number;
    studyInstanceUid: string;
    method?: string;
    reason?: string;
  }): Promise<{ order: MwlReconcileCandidate }> => {
    const response = await fetch(`${BACKEND_URL}/mwl/reconcile/confirm`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to reconcile MWL order");
    }
    return response.json();
  },
};

export const dicomNodeService = {
  fetchNodes: async (): Promise<DicomNode[]> => {
    const response = await fetch(`${BACKEND_URL}/dicom/nodes`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch DICOM nodes");
    }
    return response.json();
  },
  createNode: async (payload: {
    name: string;
    aet: string;
    host: string;
    port: number;
    description?: string;
    enabled?: boolean;
  }): Promise<DicomNode> => {
    const response = await fetch(`${BACKEND_URL}/dicom/nodes`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error("Failed to create DICOM node");
    }
    return response.json();
  },
  updateNode: async (
    id: number,
    payload: {
      name: string;
      aet: string;
      host: string;
      port: number;
      description?: string;
      enabled?: boolean;
    },
  ): Promise<DicomNode> => {
    const response = await fetch(`${BACKEND_URL}/dicom/nodes/${id}`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error("Failed to update DICOM node");
    }
    return response.json();
  },
  deleteNode: async (id: number, options?: DeleteOptions): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/dicom/nodes/${id}`, {
      ...deleteRequestInit(options),
    });
    if (!response.ok) {
      throw new Error("Failed to delete DICOM node");
    }
  },
  echoNode: async (id: number): Promise<string> => {
    const response = await fetch(`${BACKEND_URL}/dicom/nodes/${id}/echo`, {
      method: "POST",
      headers: withRoleHeaders(),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(text || "Failed to run echo test for DICOM node");
    }
    return text || "Echo test succeeded";
  },
  queryNode: async (id: number): Promise<{ message: string; count: number }> => {
    const response = await fetch(`${BACKEND_URL}/dicom/nodes/${id}/query-test`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ level: "STUDY" }),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error || parsed?.message || text;
      } catch {
        detail = text;
      }
      throw new Error(detail || "Failed to run C-FIND query test for DICOM node");
    }
    try {
      return JSON.parse(text);
    } catch {
      return { message: text || "C-FIND query test succeeded", count: 0 };
    }
  },
  pingNode: async (id: number): Promise<string> => {
    const response = await fetch(`${BACKEND_URL}/dicom/nodes/${id}/ping`, {
      method: "POST",
      headers: withRoleHeaders(),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(text || "Failed to run ping test for DICOM node");
    }
    return text || "Ping test succeeded";
  },
};

export const dicomForwardService = {
  fetchDestinations: async (): Promise<DicomNode[]> => {
    const response = await fetch(`${BACKEND_URL}/dicom/forward/destinations`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error || parsed?.message || text;
      } catch {
        detail = text;
      }
      throw new Error(detail || "Failed to load DICOM forward destinations");
    }
    return response.json();
  },

  forwardStudies: async (payload: {
    studyInstanceUids: string[];
    nodeId: number;
  }): Promise<{
    node: {
      id: number;
      name: string;
      aet: string;
      host: string;
      port: number;
    };
    results: {
      studyInstanceUid: string;
      status: "ok" | "error";
      message?: string;
      job?: unknown;
    }[];
  }> => {
    const response = await fetch(`${BACKEND_URL}/dicom/forward`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error || parsed?.message || text;
      } catch {
        detail = text;
      }
      throw new Error(detail || "Failed to forward studies");
    }
    return response.json();
  },
};

export type DicomRoutingSchedule = {
  id: number;
  name: string;
  node_id: number;
  node_name: string;
  aet: string;
  enabled: boolean;
  recurrence: "once" | "daily";
  run_time: string;
  source_date_mode: "previous_day" | "specific_date";
  source_date?: string | null;
  modality?: string | null;
  max_retries: number;
  next_run_at: string;
  last_run_at?: string | null;
};

export type DicomRoutingJob = {
  id: number;
  schedule_name: string;
  node_name: string;
  study_instance_uid: string;
  study_date?: string;
  modality?: string;
  status: string;
  attempts: number;
  last_error?: string | null;
  created_at: string;
};

const routingRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${BACKEND_URL}/dicom/routing${path}`, {
    ...init,
    headers: withRoleHeaders({ "Content-Type": "application/json", ...(init?.headers || {}) }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    try { throw new Error(JSON.parse(text)?.error || text || "DICOM routing request failed"); }
    catch (error) { if (error instanceof SyntaxError) throw new Error(text || "DICOM routing request failed"); throw error; }
  }
  return response.json();
};

export const dicomRoutingService = {
  fetchSchedules: () => routingRequest<DicomRoutingSchedule[]>("/schedules"),
  fetchJobs: () => routingRequest<DicomRoutingJob[]>("/jobs"),
  preview: (payload: { sourceDateMode: string; sourceDate?: string; modality?: string }) =>
    routingRequest<{ date: string; count: number; instances: number; studies: unknown[] }>("/preview", { method: "POST", body: JSON.stringify(payload) }),
  create: (payload: Record<string, unknown>) => routingRequest<{ id: number }>("/schedules", { method: "POST", body: JSON.stringify(payload) }),
  setEnabled: (id: number, enabled: boolean) => routingRequest<{ ok: boolean }>(`/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  remove: (id: number) => routingRequest<{ ok: boolean }>(`/schedules/${id}`, { method: "DELETE" }),
  runNow: (id: number) => routingRequest<{ queued: number; date: string }>(`/schedules/${id}/run`, { method: "POST", body: "{}" }),
};

export const auditLogService = {
  fetchLogs: async (filters?: AuditLogFilters): Promise<AuditLogEntry[]> => {
    const url = new URL(`${BACKEND_URL}/audit-logs`);
    if (filters?.limit) url.searchParams.set("limit", String(filters.limit));
    if (filters?.studyInstanceUid?.trim()) {
      url.searchParams.set("studyInstanceUid", filters.studyInstanceUid.trim());
    }
    if (filters?.eventType?.trim()) {
      url.searchParams.set("eventType", filters.eventType.trim());
    }
    if (filters?.username?.trim()) {
      url.searchParams.set("username", filters.username.trim());
    }

    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to fetch audit logs");
    }

    const payload = await response.json();
    return Array.isArray(payload?.logs) ? payload.logs : payload;
  },

  fetchSystemLogs: async (): Promise<SystemLogSummary> => {
    const response = await fetch(`${BACKEND_URL}/system-logs`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to fetch system logs");
    }
    return response.json();
  },

  fetchMwlQueryLogs: async (filters?: MwlQueryLogFilters): Promise<MwlQueryLogEntry[]> => {
    const url = new URL(`${BACKEND_URL}/mwl/query-logs`);
    if (filters?.limit) url.searchParams.set("limit", String(filters.limit));
    if (filters?.callingAe?.trim()) url.searchParams.set("callingAe", filters.callingAe.trim());
    if (filters?.calledAe?.trim()) url.searchParams.set("calledAe", filters.calledAe.trim());
    if (filters?.remoteAddress?.trim()) url.searchParams.set("remoteAddress", filters.remoteAddress.trim());
    if (filters?.patientId?.trim()) url.searchParams.set("patientId", filters.patientId.trim());
    if (filters?.accessionNumber?.trim()) url.searchParams.set("accessionNumber", filters.accessionNumber.trim());
    if (filters?.studyInstanceUid?.trim()) url.searchParams.set("studyInstanceUid", filters.studyInstanceUid.trim());
    if (filters?.modality?.trim()) url.searchParams.set("modality", filters.modality.trim());
    if (filters?.stationAet?.trim()) url.searchParams.set("stationAet", filters.stationAet.trim());
    if (filters?.outcome?.trim()) url.searchParams.set("outcome", filters.outcome.trim());

    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to fetch MWL query logs");
    }

    const payload = await response.json();
    return Array.isArray(payload?.logs) ? payload.logs : payload;
  },
};

const parseApiError = async (response: Response, fallback: string) => {
  try {
    const payload = await response.json();
    return payload?.error || payload?.message || fallback;
  } catch {
    const text = await response.text().catch(() => "");
    return text || fallback;
  }
};

export const backupService = {
  fetchConfig: async (): Promise<BackupConfig> => {
    const response = await fetch(`${BACKEND_URL}/system/backup/config`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to load backup config"));
    const payload = await response.json();
    return payload.config;
  },

  saveConfig: async (config: Partial<BackupConfig>): Promise<BackupConfig> => {
    const response = await fetch(`${BACKEND_URL}/system/backup/config`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(config),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to save backup config"));
    const payload = await response.json();
    return payload.config;
  },

  listBackups: async (): Promise<BackupManifestSummary[]> => {
    const response = await fetch(`${BACKEND_URL}/system/backup/list`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to list backups"));
    const payload = await response.json();
    return Array.isArray(payload.backups) ? payload.backups : [];
  },

  fetchStatus: async (): Promise<{ job: BackupJobStatus; schedule: BackupScheduleStatus }> => {
    const response = await fetch(`${BACKEND_URL}/system/backup/status`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to load backup status"));
    return response.json();
  },

  listJobs: async (limit = 25): Promise<BackupJobLog[]> => {
    const response = await fetch(`${BACKEND_URL}/system/backup/jobs?limit=${encodeURIComponent(String(limit))}`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to load backup jobs"));
    const payload = await response.json();
    return Array.isArray(payload.jobs) ? payload.jobs : [];
  },

  runBackup: async (options?: { skipDicomData?: boolean; skipProgramData?: boolean; noStopServices?: boolean }) => {
    const response = await fetch(`${BACKEND_URL}/system/backup/run`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(options || {}),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to start backup"));
    return response.json() as Promise<{ job: BackupJobStatus }>;
  },

  runRestore: async (payload: {
    backupPath: string;
    confirmation: string;
    skipDatabase?: boolean;
    skipDicomData?: boolean;
    skipProgramData?: boolean;
    noStopServices?: boolean;
    noStartServices?: boolean;
  }) => {
    const response = await fetch(`${BACKEND_URL}/system/restore/run`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to start restore"));
    return response.json() as Promise<{ job: BackupJobStatus }>;
  },

  saveSchedule: async (schedule: BackupScheduleSettings): Promise<BackupScheduleStatus> => {
    const response = await fetch(`${BACKEND_URL}/system/backup/schedule`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ schedule }),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to save backup schedule"));
    const payload = await response.json();
    return payload.schedule;
  },

  deleteSchedule: async (): Promise<BackupScheduleStatus> => {
    const response = await fetch(`${BACKEND_URL}/system/backup/schedule`, {
      method: "DELETE",
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to delete backup schedule"));
    const payload = await response.json();
    return payload.schedule;
  },
};

export const preferencesService = {
  fetch: async (): Promise<Record<string, unknown>> => {
    const response = await fetch(`${BACKEND_URL}/user/preferences`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to load preferences"));
    const payload = await response.json();
    return payload.preferences || {};
  },

  save: async (preferences: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetch(`${BACKEND_URL}/user/preferences`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ preferences }),
    });
    if (!response.ok) throw new Error(await parseApiError(response, "Failed to save preferences"));
    const payload = await response.json();
    return payload.preferences || {};
  },
};

export const radiologyReportService = {
  fetchReport: async (studyInstanceUid: string): Promise<RadiologyReport | null> => {
    const response = await fetch(`${BACKEND_URL}/reports/${encodeURIComponent(studyInstanceUid)}`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch report");
    }
    const data = await response.json();
    return data?.report ?? null;
  },
  fetchRevisions: async (studyInstanceUid: string): Promise<RadiologyReportRevision[]> => {
    const response = await fetch(
      `${BACKEND_URL}/reports/${encodeURIComponent(studyInstanceUid)}/revisions`,
      {
        headers: withRoleHeaders(),
      }
    );
    if (!response.ok) {
      throw new Error("Failed to fetch report revisions");
    }
    const data = await response.json();
    return Array.isArray(data?.revisions) ? data.revisions : [];
  },
  reviseReport: async (studyInstanceUid: string): Promise<RadiologyReport> => {
    const response = await fetch(
      `${BACKEND_URL}/reports/${encodeURIComponent(studyInstanceUid)}/revise`,
      {
        method: "POST",
        headers: withRoleHeaders(),
      }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to revise report");
    }
    const data = await response.json();
    return data.report;
  },
  fetchStatuses: async (studyInstanceUids: string[]): Promise<
    {
      study_instance_uid: string;
      status: "draft" | "final";
      updated_at: string;
      finalized_at?: string | null;
      radiologist_name?: string | null;
    }[]
  > => {
    const response = await fetch(`${BACKEND_URL}/reports/status`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ studyInstanceUids }),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch report status");
    }
    return response.json();
  },
  saveDraft: async (
    studyInstanceUid: string,
    payload: {
      patientId?: string;
      radiologistUsername: string;
      clinicalInfo?: string;
      findings?: string;
      conclusion?: string;
      kritis?: "0" | "1";
    }
  ): Promise<RadiologyReport> => {
    const response = await fetch(`${BACKEND_URL}/reports/${encodeURIComponent(studyInstanceUid)}/draft`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to save draft");
    }
    const data = await response.json();
    return data.report;
  },
  finalizeReport: async (
    studyInstanceUid: string,
    payload: {
      patientId?: string;
      radiologistUsername: string;
      clinicalInfo?: string;
      findings?: string;
      conclusion?: string;
      kritis?: "0" | "1";
    }
  ): Promise<RadiologyReport> => {
    const response = await fetch(`${BACKEND_URL}/reports/${encodeURIComponent(studyInstanceUid)}/finalize`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to finalize report");
    }
    const data = await response.json();
    return data.report;
  },
};

export const radiologistTemplateService = {
  createTemplate: async (payload: {
    radiologistUsername: string;
    title: string;
    findings?: string;
    conclusion?: string;
    modalityCode?: string | null;
    procedureCode?: string | null;
    procedureDescription?: string | null;
  }): Promise<RadiologistTemplate> => {
    const response = await fetch(`${BACKEND_URL}/reports/templates`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to save template");
    }
    const data = await response.json();
    return data?.template ?? data;
  },
  fetchTemplates: async (
    radiologistUsername: string,
    context?: {
      modalityCode?: string | null;
      procedureCode?: string | null;
      procedureDescription?: string | null;
    }
  ): Promise<RadiologistTemplate[]> => {
    const url = new URL(`${BACKEND_URL}/reports/templates`);
    url.searchParams.set("radiologistUsername", radiologistUsername);
    if (context?.modalityCode?.trim()) url.searchParams.set("modalityCode", context.modalityCode.trim());
    if (context?.procedureCode?.trim()) url.searchParams.set("procedureCode", context.procedureCode.trim());
    if (context?.procedureDescription?.trim()) url.searchParams.set("procedureDescription", context.procedureDescription.trim());
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to fetch templates");
    }
    const data = await response.json();
    return data?.templates ?? data;
  },
};

export const dicomWebService = {
  // ... (previous methods)
  fetchStudies: async (queryParams?: Record<string, string>): Promise<WorklistItem[]> => {
    const url = new URL(`${DICOMWEB_BASE_URL}/studies`);
    if (queryParams) {
      Object.entries(queryParams).forEach(([key, value]) => {
        if (value) url.searchParams.append(key, value);
      });
    }

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/dicom+json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch studies: ${response.statusText}`);
    }

    const data = (await response.json()) as DicomJsonStudy[];

    return data.map<WorklistItem>(item => {
      const patientNameElement = item["00100010"];
      const patientNameValue = Array.isArray(patientNameElement?.Value)
        ? patientNameElement?.Value[0]
        : undefined;
      const patientName =
        typeof patientNameValue === "object" && patientNameValue !== null
          ? (patientNameValue as { Alphabetic?: string }).Alphabetic ?? ""
          : (patientNameValue as string | undefined) ?? "";

      const referringElement = item["00080090"];
      const referringValue = Array.isArray(referringElement?.Value)
        ? referringElement?.Value[0]
        : undefined;
      const referringName =
        typeof referringValue === "object" && referringValue !== null
          ? (referringValue as { Alphabetic?: string }).Alphabetic ?? ""
          : (referringValue as string | undefined) ?? "";

      const getString = (tag: string): string => {
        const element = item[tag];
        const value = Array.isArray(element?.Value) ? element?.Value[0] : undefined;
        return (value as string | number | undefined)?.toString() ?? "";
      };

      const getNumber = (tag: string): number => {
        const element = item[tag];
        const value = Array.isArray(element?.Value) ? element?.Value[0] : undefined;
        const numeric = typeof value === "number" ? value : Number(value);
        return Number.isFinite(numeric) ? numeric : 0;
      };

      return {
        PatientID: getString("00100020"),
        PatientName: patientName,
        OtherPatientIDs: getString("00101000"),
        AccessionNumber: getString("00080050"),
        InstitutionName: getString("00080080"),
        ModalityCode: sanitizeModalityCode(getString("00080060") || getString("00080061")),
        StudyDescription: getString("00081030"),
        StudyTime: getString("00080030"),
        NumberOfStudyRelatedInstances: getNumber("00201208"),
        NumberOfStudyRelatedSeries: getNumber("00201206"),
        ReferringPhysicianName: referringName,
        StudyDate: getString("00080020"),
        StudyID: getString("00200010"),
        PatientBirthDate: getString("00100030"),
        PatientSex: getString("00100040"),
        StudyInstanceUID: getString("0020000D"),
      };
    });
  },

  fetchSeries: async (studyUID: string): Promise<SeriesItem[]> => {
    const response = await fetch(`${DICOMWEB_BASE_URL}/studies/${studyUID}/series`, {
      headers: {
        Accept: "application/dicom+json",
      },
    });
    if (!response.ok) throw new Error("Failed to fetch series");

    const data = (await response.json()) as DicomJsonSeries[];

    return data.map<SeriesItem>(item => {
      const getString = (tag: string): string => {
        const element = item[tag];
        const value = Array.isArray(element?.Value) ? element?.Value[0] : undefined;
        return (value as string | number | undefined)?.toString() ?? "";
      };

      const getNumber = (tag: string): number => {
        const element = item[tag];
        const value = Array.isArray(element?.Value) ? element?.Value[0] : undefined;
        const numeric = typeof value === "number" ? value : Number(value);
        return Number.isFinite(numeric) ? numeric : 0;
      };

      return {
        SeriesInstanceUID: getString("0020000E"),
        SeriesNumber: getString("00200011"),
        SeriesDescription: getString("0008103E"),
        Modality: sanitizeModalityCode(getString("00080060")),
        BodyPartExamined: getString("00180015"),
        ProtocolName: getString("00181030"),
        Laterality: getString("00200060"),
        NumberOfSeriesRelatedInstances: getNumber("00201209"),
      };
    }).filter(series => isRenderableSeriesModality(series.Modality));
  },

  fetchInstances: async (studyUID: string, seriesUID: string) => {
    const response = await fetch(
      `${DICOMWEB_BASE_URL}/studies/${studyUID}/series/${seriesUID}/instances`,
      {
        headers: {
          Accept: "application/dicom+json",
        },
      }
    );
    if (!response.ok) throw new Error("Failed to fetch instances");
    return response.json();
  },

  getSeriesThumbnailUrl: (studyUID: string, seriesUID: string): string =>
    `${BACKEND_URL}/dicom/series/${encodeURIComponent(
      seriesUID
    )}/thumbnail?studyInstanceUID=${encodeURIComponent(studyUID)}&v=${PREVIEW_RENDER_VERSION}`,

  getInstanceThumbnailUrl: (
    studyUID: string,
    seriesUID: string,
    sopInstanceUID: string,
    windowing?: { windowWidth?: number; windowLevel?: number }
  ): string => {
    const baseUrl = `${BACKEND_URL}/dicom/instances/preview?sopInstanceUID=${encodeURIComponent(
      sopInstanceUID
    )}&seriesInstanceUID=${encodeURIComponent(seriesUID)}&studyInstanceUID=${encodeURIComponent(
      studyUID
    )}&v=${PREVIEW_RENDER_VERSION}`;
    const windowWidth = Number(windowing?.windowWidth);
    const windowLevel = Number(windowing?.windowLevel);
    if (!Number.isFinite(windowWidth) || windowWidth <= 1 || !Number.isFinite(windowLevel)) {
      return baseUrl;
    }
    return `${baseUrl}&ww=${encodeURIComponent(windowWidth)}&wl=${encodeURIComponent(windowLevel)}`;
  },

  getInstanceWadoUrl: (
    studyUID: string,
    seriesUID: string,
    sopInstanceUID: string,
    frameNumber = 1
  ): string => {
    return `${BACKEND_URL}/dicom/instances/preview?sopInstanceUID=${encodeURIComponent(
      sopInstanceUID
    )}&seriesInstanceUID=${encodeURIComponent(seriesUID)}&studyInstanceUID=${encodeURIComponent(
      studyUID
    )}&v=${PREVIEW_RENDER_VERSION}`;
  },

  getStudyZipUrl: (studyUID: string): string =>
    `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/archive`,

  downloadStudyZip: async (studyUID: string): Promise<Blob> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/archive`,
      { headers: withRoleHeaders() }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      let detail = message;
      try {
        const parsed = JSON.parse(message);
        detail = parsed?.error || parsed?.message || message;
      } catch {
        detail = message;
      }
      throw new Error(detail || `Failed to download DICOM ZIP (${response.status})`);
    }
    return response.blob();
  },

  updateStudyMetadata: async (
    studyUID: string,
    payload: {
      patientName?: string;
      patientId?: string;
      patientBirthDate?: string;
      patientSex?: string;
      otherPatientIds?: string;
      accessionNumber?: string;
      institutionName?: string;
      studyDescription?: string;
      referringPhysician?: string;
      studyDate?: string;
      studyTime?: string;
      studyId?: string;
      _managerOperation?: {
        type: "patient_correction";
        reason?: string;
        targetPatientId?: string;
      };
    }
  ): Promise<{ managerOperationId?: string | null }> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/metadata`,
      {
        method: "PUT",
        headers: {
          ...withRoleHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      let detail = message;
      try {
        const parsed = JSON.parse(message);
        detail = parsed?.error || parsed?.message || message;
      } catch {
        detail = message;
      }
      throw new Error(detail || `Failed to update study metadata (${response.status})`);
    }
    return response.json();
  },

  updateSeriesMetadata: async (
    studyUID: string,
    seriesUID: string,
    payload: {
      modality?: string;
      seriesDescription?: string;
      seriesNumber?: string;
      bodyPartExamined?: string;
      protocolName?: string;
      laterality?: string;
    }
  ): Promise<void> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/series/${encodeURIComponent(seriesUID)}/metadata`,
      {
        method: "PUT",
        headers: {
          ...withRoleHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      let detail = message;
      try {
        const parsed = JSON.parse(message);
        detail = parsed?.error || parsed?.message || message;
      } catch {
        detail = message;
      }
      throw new Error(detail || `Failed to update series metadata (${response.status})`);
    }
  },

  updateInstanceMetadata: async (
    studyUID: string,
    seriesUID: string,
    sopInstanceUID: string,
    payload: {
      instanceNumber?: string;
      imageComments?: string;
      viewPosition?: string;
    }
  ): Promise<void> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/series/${encodeURIComponent(
        seriesUID
      )}/instances/${encodeURIComponent(sopInstanceUID)}/metadata`,
      {
        method: "PUT",
        headers: {
          ...withRoleHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      let detail = message;
      try {
        const parsed = JSON.parse(message);
        detail = parsed?.error || parsed?.message || message;
      } catch {
        detail = message;
      }
      throw new Error(detail || `Failed to update image metadata (${response.status})`);
    }
  },

  createStudy: async (payload: {
    studyInstanceUid?: string;
    patientId?: string;
    patientName?: string;
    patientBirthDate?: string;
    patientSex?: string;
    accessionNumber?: string;
    studyDate?: string;
    studyTime?: string;
    modality?: string;
    studyDescription?: string;
    studyId?: string;
    referringPhysician?: string;
  }): Promise<{ studyInstanceUid: string }> => {
    const response = await fetch(`${BACKEND_URL}/dicom/studies`, {
      method: "POST",
      headers: { ...withRoleHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error((await response.text().catch(() => "")) || "Failed to create study");
    return response.json();
  },

  createSeries: async (
    studyUID: string,
    payload: {
      modality?: string;
      seriesNumber?: string;
      seriesDescription?: string;
      bodyPartExamined?: string;
      protocolName?: string;
    }
  ): Promise<{ seriesInstanceUid: string }> => {
    const response = await fetch(`${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/series`, {
      method: "POST",
      headers: { ...withRoleHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error((await response.text().catch(() => "")) || "Failed to create series");
    return response.json();
  },

  uploadImageToSeries: async (
    studyUID: string,
    seriesUID: string,
    payload: {
      fileName: string;
      mimeType: string;
      base64: string;
      instanceNumber?: string;
      imageComments?: string;
    }
  ): Promise<{ sopInstanceUid: string }> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/series/${encodeURIComponent(seriesUID)}/instances/upload-image`,
      {
        method: "POST",
        headers: { ...withRoleHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) throw new Error((await response.text().catch(() => "")) || "Failed to upload image");
    return response.json();
  },

  moveStudyToStudy: async (
    studyUID: string,
    payload: { targetStudyInstanceUid: string; reason?: string }
  ): Promise<{
    managerOperationId?: string | null;
    movedInstanceCount?: number;
    movedSeriesCount?: number;
    cancelled?: boolean;
    pendingSeriesUids?: string[];
    skippedInstances?: Array<{ sopInstanceUid: string; reason?: string }>;
    targetRefresh?: { status?: string; mode?: string; recoveredFiles?: string[] } | null;
  }> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/move`,
      {
        method: "POST",
        headers: {
          ...withRoleHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      let detail = message;
      try {
        const parsed = JSON.parse(message);
        detail = parsed?.error || parsed?.message || message;
      } catch {
        detail = message;
      }
      throw new Error(detail || `Failed to bind study (${response.status})`);
    }
    return response.json();
  },

  moveSeriesToStudy: async (
    studyUID: string,
    seriesUID: string,
    payload: { targetStudyInstanceUid: string; reason?: string }
  ): Promise<{
    managerOperationId?: string | null;
    skippedInstances?: Array<{ sopInstanceUid: string; reason?: string }>;
  }> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/series/${encodeURIComponent(seriesUID)}/move`,
      {
        method: "POST",
        headers: {
          ...withRoleHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      let detail = message;
      try {
        const parsed = JSON.parse(message);
        detail = parsed?.error || parsed?.message || message;
      } catch {
        detail = message;
      }
      throw new Error(detail || `Failed to move series (${response.status})`);
    }
    return response.json();
  },

  moveInstanceToSeries: async (
    studyUID: string,
    seriesUID: string,
    sopInstanceUID: string,
    payload: { targetStudyInstanceUid: string; targetSeriesInstanceUid: string; reason?: string }
  ): Promise<{ managerOperationId?: string | null }> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyUID)}/series/${encodeURIComponent(
        seriesUID
      )}/instances/${encodeURIComponent(sopInstanceUID)}/move`,
      {
        method: "POST",
        headers: {
          ...withRoleHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      let detail = message;
      try {
        const parsed = JSON.parse(message);
        detail = parsed?.error || parsed?.message || message;
      } catch {
        detail = message;
      }
      throw new Error(detail || `Failed to move image (${response.status})`);
    }
    return response.json();
  },

  fetchManagerOperations: async (params?: {
    studyInstanceUid?: string;
    status?: string;
    limit?: number;
  }): Promise<DicomManagerOperation[]> => {
    const url = new URL(`${BACKEND_URL}/dicom/manager/operations`);
    if (params?.studyInstanceUid) url.searchParams.set("studyInstanceUid", params.studyInstanceUid);
    if (params?.status) url.searchParams.set("status", params.status);
    if (params?.limit) url.searchParams.set("limit", String(params.limit));
    const response = await fetch(url.toString(), { headers: withRoleHeaders() });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Failed to load manager history (${response.status})`);
    }
    const payload = await response.json();
    return Array.isArray(payload?.operations) ? payload.operations : [];
  },

  cancelManagerOperation: async (operationId: string): Promise<{ ok: boolean; requested: boolean }> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/manager/operations/${encodeURIComponent(operationId)}/cancel`,
      {
        method: "POST",
        headers: { ...withRoleHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Operator requested cancellation from DICOM Manager" }),
      }
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Failed to request cancellation (${response.status})`);
    }
    return response.json();
  },

  reindexStudy: async (
    studyInstanceUid: string,
    options?: { mode?: "index" | "store"; reason?: string; wait?: boolean }
  ): Promise<DicomManagerReindexResult> => {
    const url = new URL(`${BACKEND_URL}/dicom/manager/studies/${encodeURIComponent(studyInstanceUid)}/reindex`);
    // Without wait=1 the server answers 202 immediately and the caller follows the
    // operation, which is what the UI does for large studies.
    if (options?.wait) url.searchParams.set("wait", "1");
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { ...withRoleHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: options?.mode,
        reason: options?.reason || "Operator re-indexed the study from DICOM Manager history",
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Failed to re-index the study (${response.status})`);
    }
    return response.json();
  },

  fetchManagerOperation: async (operationId: string): Promise<DicomManagerOperation> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/manager/operations/${encodeURIComponent(operationId)}`,
      { headers: withRoleHeaders() }
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Failed to load manager operation (${response.status})`);
    }
    const payload = await response.json();
    return payload.operation;
  },

  preflightManagerOperationRestore: async (operationId: string): Promise<DicomManagerRestorePreflight> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/manager/operations/${encodeURIComponent(operationId)}/restore-preflight`,
      { headers: withRoleHeaders() }
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Failed to check restore readiness (${response.status})`);
    }
    return response.json();
  },

  restoreManagerOperation: async (
    operationId: string,
    payload: { reason: string }
  ): Promise<{ restoreOperationId: string; restoredObjectCount: number; status: string }> => {
    const response = await fetch(
      `${BACKEND_URL}/dicom/manager/operations/${encodeURIComponent(operationId)}/restore`,
      {
        method: "POST",
        headers: { ...withRoleHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const conflictDetail = Array.isArray(body?.conflicts) && body.conflicts.length
        ? ` ${body.conflicts[0]?.message || "Restore conflict detected."}`
        : "";
      throw new Error(`${body?.error || `Failed to restore manager operation (${response.status})`}${conflictDetail}`);
    }
    return response.json();
  },

  deleteStudy: async (patientId: string, studyInstanceUid: string, options?: DeleteOptions): Promise<void> => {
    if (!studyInstanceUid) throw new Error("Missing StudyInstanceUID");
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(studyInstanceUid)}`,
      deleteRequestInit(options)
    );
    if (!response.ok) {
      throw new Error(`Failed to delete study (${response.status})`);
    }
  },

  deleteSeries: async (
    patientId: string,
    studyInstanceUid: string,
    seriesInstanceUid: string,
    options?: DeleteOptions
  ): Promise<void> => {
    if (!studyInstanceUid || !seriesInstanceUid) {
      throw new Error("Missing identifiers for series delete");
    }
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(
        studyInstanceUid
      )}/series/${encodeURIComponent(seriesInstanceUid)}`,
      deleteRequestInit(options)
    );
    if (!response.ok) {
      throw new Error(`Failed to delete series (${response.status})`);
    }
  },

  deleteInstance: async (
    patientId: string,
    studyInstanceUid: string,
    seriesInstanceUid: string,
    sopInstanceUid: string,
    options?: DeleteOptions
  ): Promise<void> => {
    if (!studyInstanceUid || !seriesInstanceUid || !sopInstanceUid) {
      throw new Error("Missing identifiers for instance delete");
    }
    const response = await fetch(
      `${BACKEND_URL}/dicom/studies/${encodeURIComponent(
        studyInstanceUid
      )}/series/${encodeURIComponent(
        seriesInstanceUid
      )}/instances/${encodeURIComponent(sopInstanceUid)}`,
      deleteRequestInit(options)
    );
    if (!response.ok) {
      throw new Error(`Failed to delete instance (${response.status})`);
    }
  },

  fetchStatistics: async (params?: { startDate?: string; endDate?: string }): Promise<StatisticsData> => {
    const url = new URL(`${BACKEND_URL}/dicom/stats`);
    if (params?.startDate) url.searchParams.set("start", params.startDate);
    if (params?.endDate) url.searchParams.set("end", params.endDate);
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch statistics from backend`);
    }
    return response.json();
  },

  fetchSettings: async (): Promise<ServerSettings> => {
    const response = await fetch(`${BACKEND_URL}/dicom/settings`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch settings");
    return response.json();
  },

  updateSettings: async (settings: Partial<ServerSettings>): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/dicom/settings`, {
      method: "POST",
      headers: {
        ...withRoleHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });
    if (!response.ok) throw new Error("Failed to update settings");
  },
  fetchUiSettings: async (): Promise<UiSettings> => {
    const response = await fetch(`${BACKEND_URL}/ui/settings`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch UI settings");
    return response.json();
  },
  fetchViewerConfigs: async (): Promise<ViewerConfig[]> => {
    const response = await fetch(`${BACKEND_URL}/ui/viewers`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch viewer settings");
    const payload = await response.json();
    return Array.isArray(payload?.viewers) ? payload.viewers : [];
  },
  updateUiSettings: async (settings: Partial<UiSettings>): Promise<UiSettings> => {
    const response = await fetch(`${BACKEND_URL}/ui/settings`, {
      method: "POST",
      headers: {
        ...withRoleHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });
    if (!response.ok) throw new Error("Failed to save UI settings");
    const payload = await response.json();
    return payload?.settings ?? settings;
  },

  restartServer: async (): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/dicom/restart`, {
      method: "POST",
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to restart DICOM Server via backend");
  },
};

export const expertiseService = {
  fetchSettings: async (): Promise<ExpertiseSettings> => {
    const response = await fetch(`${BACKEND_URL}/expertise/settings`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch expertise settings");
    return response.json();
  },
  updateSettings: async (payload: ExpertiseSettings): Promise<ExpertiseSettings> => {
    const response = await fetch(`${BACKEND_URL}/expertise/settings`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("Failed to save expertise settings");
    const data = await response.json();
    return data?.settings ?? payload;
  },
  fetchSignature: async (userId: number): Promise<{ signatureImage: string | null }> => {
    const response = await fetch(`${BACKEND_URL}/expertise/signature/${userId}`, {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch signature");
    return response.json();
  },
  updateSignature: async (payload: {
    userId: number;
    signatureImage: string | null;
  }): Promise<{ signatureImage: string | null }> => {
    const response = await fetch(`${BACKEND_URL}/expertise/signature`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("Failed to save signature");
    const data = await response.json();
    return data?.signature ?? payload;
  },
  fetchAssets: async (username: string): Promise<ExpertiseAssets> => {
    const url = new URL(`${BACKEND_URL}/expertise/assets`);
    url.searchParams.set("username", username);
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch expertise assets");
    return response.json();
  },
  fetchPrintTemplates: async (options?: { activeOnly?: boolean }): Promise<ExpertisePrintTemplate[]> => {
    const url = new URL(`${BACKEND_URL}/expertise/print-templates`);
    if (options?.activeOnly) url.searchParams.set("active", "1");
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch print templates");
    const data = await response.json();
    return Array.isArray(data?.templates) ? data.templates : [];
  },
  createPrintTemplate: async (payload: ExpertisePrintTemplatePayload): Promise<ExpertisePrintTemplate> => {
    const response = await fetch(`${BACKEND_URL}/expertise/print-templates`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("Failed to create print template");
    const data = await response.json();
    return data.template;
  },
  updatePrintTemplate: async (id: number, payload: ExpertisePrintTemplatePayload): Promise<ExpertisePrintTemplate> => {
    const response = await fetch(`${BACKEND_URL}/expertise/print-templates/${id}`, {
      method: "PUT",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("Failed to update print template");
    const data = await response.json();
    return data.template;
  },
  deletePrintTemplate: async (id: number): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/expertise/print-templates/${id}`, {
      method: "DELETE",
      headers: withRoleHeaders(),
    });
    if (!response.ok) throw new Error("Failed to delete print template");
  },
};

/**
 * PERBAIKAN KHUSUS MODE DEVELOPMENT (tidak ikut ke build produksi / installer).
 *
 * Di development, halaman RIS (mis. :8080) dan API (:3001) berbeda origin, sementara
 * backend membangun URL share dari host request API-nya -> link yang ditampilkan menjadi
 * http://127.0.0.1:3001/public/study/<token>, dan saat dibuka browser menjawab
 * "Cannot GET /public/study/...". Di dev saja URL dialihkan ke origin halaman yang sedang
 * dibuka supaya bisa diuji.
 *
 * Kenapa aman untuk installer: pada build produksi `import.meta.env.DEV` bernilai false,
 * jadi cabang ini dibuang oleh bundler (dead code elimination). Penanda di bawah dipakai
 * untuk membuktikannya: kalau string DEV_ONLY_share_origin_fix ada di bundel produksi,
 * berarti gerbangnya bocor.
 */
const DEV_ONLY_SHARE_ORIGIN_MARKER = "DEV_ONLY_share_origin_fix";
function normalizeDevPublicShareUrl<T extends string | undefined>(url: T): T {
  if (!import.meta.env.DEV) return url;
  void DEV_ONLY_SHARE_ORIGIN_MARKER;
  if (typeof url !== "string" || !url) return url;
  try {
    const parsed = new URL(url);
    const here = window.location;
    const isLocalHost = (host: string) =>
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(host).toLowerCase());
    // Hanya berlaku untuk dev lokal (kedua sisi loopback) dan hanya kalau portnya berbeda.
    if (!isLocalHost(parsed.hostname) || !isLocalHost(here.hostname)) return url;
    if (parsed.port === here.port) return url;
    return `${here.origin}${parsed.pathname}${parsed.search}` as T;
  } catch {
    return url;
  }
}

export const publicShareService = {
  parseError: async (response: Response, fallbackMessage: string): Promise<string> => {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json().catch(() => null);
      if (typeof data?.error === "string" && data.error.trim()) {
        return data.error.trim();
      }
    }
    const message = await response.text().catch(() => "");
    return message || fallbackMessage;
  },
  createShare: async (
    studyInstanceUid: string,
    expiresInDays?: number,
    patientPhone?: string,
    createdBy?: string,
    templateId?: number | null,
    allowIncompleteDistribution?: boolean
  ): Promise<{ token: string; url: string; expires_at?: string | null; patient_phone?: string | null; template_id?: number | null }> => {
    const response = await fetch(`${BACKEND_URL}/public/share`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ studyInstanceUid, expiresInDays, patientPhone, createdBy, templateId, allowIncompleteDistribution }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to create share link");
    }
    const payload = await response.json();
    return { ...payload, url: normalizeDevPublicShareUrl(payload?.url) };
  },
  fetchLatestShare: async (
    studyInstanceUid: string
  ): Promise<{ token: string; url: string; expires_at?: string | null; patient_phone?: string | null; template_id?: number | null } | null> => {
    const url = new URL(`${BACKEND_URL}/public/share/latest`);
    url.searchParams.set("studyInstanceUid", studyInstanceUid);
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to fetch share link");
    }
    const payload = await response.json();
    return payload ? { ...payload, url: normalizeDevPublicShareUrl(payload?.url) } : payload;
  },
  updateSharePhone: async (
    token: string,
    patientPhone?: string
  ): Promise<{ token: string; patient_phone?: string | null }> => {
    const response = await fetch(`${BACKEND_URL}/public/share/${encodeURIComponent(token)}/phone`, {
      method: "PATCH",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ patientPhone }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update phone");
    }
    return response.json();
  },
  fetchStudy: async (token: string): Promise<PublicStudyResponse> => {
    const response = await fetch(`${BACKEND_URL}/public/study/${encodeURIComponent(token)}`);
    if (!response.ok) {
      const message = await publicShareService.parseError(response, "Failed to fetch public study");
      throw new Error(message);
    }
    return response.json();
  },
  fetchSeries: async (token: string): Promise<Record<string, { Value?: unknown[] }>[]> => {
    const response = await fetch(`${BACKEND_URL}/public/study/${encodeURIComponent(token)}/series`);
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to fetch series");
    }
    return response.json();
  },
  fetchInstances: async (
    token: string,
    seriesInstanceUid: string
  ): Promise<Record<string, { Value?: unknown[] }>[]> => {
    const response = await fetch(
      `${BACKEND_URL}/public/study/${encodeURIComponent(
        token
      )}/series/${encodeURIComponent(seriesInstanceUid)}/instances`
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to fetch instances");
    }
    return response.json();
  },
};

export const patientContactService = {
  fetchPhone: async (
    params:
      | string
      | {
          patientId?: string;
          accessionNumber?: string;
          studyInstanceUid?: string;
        }
  ): Promise<{ patient_id?: string | null; patient_phone?: string | null; source?: string | null }> => {
    const lookup = typeof params === "string" ? { patientId: params } : params;
    const url = new URL(`${BACKEND_URL}/patients/phone`);
    if (lookup.patientId?.trim()) {
      url.searchParams.set("patientId", lookup.patientId.trim());
    }
    if (lookup.accessionNumber?.trim()) {
      url.searchParams.set("accessionNumber", lookup.accessionNumber.trim());
    }
    if (lookup.studyInstanceUid?.trim()) {
      url.searchParams.set("studyInstanceUid", lookup.studyInstanceUid.trim());
    }
    const response = await fetch(url.toString(), {
      headers: withRoleHeaders(),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to fetch patient phone");
    }
    return response.json();
  },
  updatePhone: async (
    patientId: string,
    patientPhone?: string
  ): Promise<{ patient_id: string; patient_phone?: string | null }> => {
    const response = await fetch(`${BACKEND_URL}/patients/phone`, {
      method: "PATCH",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ patientId, patientPhone }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update patient phone");
    }
    return response.json();
  },
};

export const studyTimelineService = {
  fetchTimeline: async (studyInstanceUid: string): Promise<StudyTimeline> => {
    const response = await fetch(
      `${BACKEND_URL}/studies/${encodeURIComponent(studyInstanceUid)}/timeline`,
      { headers: withRoleHeaders() }
    );
    if (!response.ok) {
      throw new Error("Failed to fetch study timeline");
    }
    return response.json();
  },
};

export interface ManagementReportRow {
  id: number;
  study_instance_uid: string;
  accession_number: string;
  no_register?: string | null;
  no_rontgen?: string | null;
  no_rm: string;
  nama_pasien: string;
  tanggal_lahir?: string | null;
  kelamin?: string | null;
  alamat_lengkap?: string | null;
  study_description?: string | null;
  modality?: string | null;
  cito?: string | null;
  referring_physician?: string | null;
  radiologist?: string | null;
  radiographer?: string | null;
  origin_room?: string | null;
  room_name?: string | null;
  payment_type?: string | null;
  insurance_name?: string | null;
  klinis?: string | null;
  diagnosa?: string | null;
  order_status?: string | null;
  report_status?: string | null;
  findings?: string | null;
  conclusion?: string | null;
  order_created_at?: string | null;
  order_activated_at?: string | null;
  mwl_published_at?: string | null;
  technologist_started_at?: string | null;
  study_completed_at?: string | null;
  report_started_at?: string | null;
  report_finalized_at?: string | null;
  qc_completed_at?: string | null;
  distributed_at?: string | null;
  waiting_minutes?: number | null;
  order_to_mwl_minutes?: number | null;
  examination_minutes?: number | null;
  radiologist_wait_minutes?: number | null;
  reading_minutes?: number | null;
  report_to_qc_minutes?: number | null;
  qc_to_distribution_minutes?: number | null;
  total_turnaround_minutes?: number | null;
}

export interface ManagementReportData {
  summary: {
    total_orders?: number | null;
    completed_orders?: number | null;
    cito_orders?: number | null;
    finalized_reports?: number | null;
    qc_completed?: number | null;
    avg_waiting_minutes?: number | null;
    avg_examination_minutes?: number | null;
    avg_reading_minutes?: number | null;
    avg_turnaround_minutes?: number | null;
  };
  rows: ManagementReportRow[];
  breakdowns: {
    studies: { name: string; count: number }[];
    exams: { name: string; modality: string; count: number }[];
    modalities: { name: string; count: number }[];
    rooms: { name: string; modality: string; count: number }[];
    radiologists: { name: string; count: number }[];
    radiologistExams: { modality: string; exam: string; name: string; count: number }[];
    technologistExams: { modality: string; exam: string; name: string; count: number }[];
  };
  filters: {
    modalities: string[];
    rooms: string[];
    studies: string[];
    radiologists: string[];
    referringPhysicians: string[];
  };
}

export const managementReportService = {
  fetchReport: async (params?: {
    startDate?: string;
    endDate?: string;
    modality?: string;
    roomName?: string;
    study?: string;
    radiologist?: string;
    referringPhysician?: string;
    status?: string;
    limit?: number;
  }): Promise<ManagementReportData> => {
    const url = new URL(`${BACKEND_URL}/management-reports`);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
    const response = await fetch(url.toString(), { headers: withRoleHeaders() });
    if (!response.ok) {
      throw new Error("Failed to fetch management report");
    }
    return response.json();
  },
};

export type AssetStatus = "active" | "due_soon" | "overdue" | "maintenance";

export interface AssetHistoryRecord {
  id?: number;
  date: string;
  type: string;
  title: string;
  officer: string;
  notes: string;
}

export interface BackupConfig {
  backupRoot: string;
  dataPath: string;
  programDataPath: string;
  includeDicomData: boolean;
  includeProgramData: boolean;
  postgres: {
    host: string;
    port: number;
    user: string;
    password?: string;
    passwordConfigured?: boolean;
    risDb: string;
    pacsDb: string;
    binPath?: string;
  };
  retention: {
    keepLast: number;
  };
  schedule?: BackupScheduleSettings;
  configPath?: string;
  backupScriptPath?: string;
  restoreScriptPath?: string;
}

export interface BackupManifestSummary {
  name: string;
  path: string;
  createdAt?: string | null;
  backupVersion?: string | null;
  includeDicomData?: boolean;
  includeProgramData?: boolean;
  invalid?: boolean;
  databases?: Record<string, string>;
}

export interface BackupJobStatus {
  running: boolean;
  type?: "backup" | "restore" | string;
  startedAt?: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  error?: string | null;
  output?: string;
  progress?: {
    percent: number;
    message: string;
  } | null;
}

export interface BackupJobLog {
  id: number;
  job_type: "backup" | "restore" | string;
  status: string;
  backup_path?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  exit_code?: number | null;
  progress_percent?: number | null;
  progress_message?: string | null;
  requested_by?: string | null;
}

export interface BackupScheduleStatus {
  enabled: boolean;
  taskName: string;
  frequency?: "daily" | "weekly" | "monthly";
  time?: string;
  interval?: number;
  daysOfWeek?: string[];
  dayOfMonth?: number;
  warning?: string;
  runLevel?: string;
  /** Registered to run as SYSTEM, so it fires with nobody logged on. */
  runsWithoutUserLoggedOn?: boolean;
  nextRunTime?: string;
  taskState?: string;
  error?: string;
  raw?: string;
}

export type BackupScheduleSettings = Omit<
  BackupScheduleStatus,
  "taskName" | "raw" | "warning" | "runLevel" | "runsWithoutUserLoggedOn" | "nextRunTime" | "taskState" | "error"
>;

export interface AssetRecord {
  id: string;
  name: string;
  category: string;
  brand: string;
  model: string;
  serialNumber: string;
  room: string;
  purchaseDate?: string | null;
  warrantyExpiredDate?: string | null;
  lastCalibrationDate?: string | null;
  nextCalibrationDate?: string | null;
  status: AssetStatus;
  operationalStatus: "active" | "maintenance";
  responsiblePerson: string;
  vendor: string;
  notes: string;
  history: AssetHistoryRecord[];
}

const assetRequest = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: withRoleHeaders({
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || "Asset request failed");
  }
  return response.json();
};

export const assetService = {
  fetchAssets: (): Promise<AssetRecord[]> => assetRequest("/assets"),
  createAsset: (asset: Omit<AssetRecord, "status" | "history"> & { initialHistory?: AssetHistoryRecord | null }) =>
    assetRequest("/assets", { method: "POST", body: JSON.stringify(asset) }),
  updateAsset: (assetCode: string, asset: Omit<AssetRecord, "status" | "history">) =>
    assetRequest(`/assets/${encodeURIComponent(assetCode)}`, { method: "PUT", body: JSON.stringify(asset) }),
  deleteAsset: (assetCode: string) =>
    assetRequest(`/assets/${encodeURIComponent(assetCode)}`, { method: "DELETE" }),
  addHistory: (assetCode: string, record: AssetHistoryRecord) =>
    assetRequest(`/assets/${encodeURIComponent(assetCode)}/history`, { method: "POST", body: JSON.stringify(record) }),
  updateHistory: (assetCode: string, historyId: number, record: AssetHistoryRecord) =>
    assetRequest(`/assets/${encodeURIComponent(assetCode)}/history/${historyId}`, { method: "PUT", body: JSON.stringify(record) }),
  deleteHistory: (assetCode: string, historyId: number) =>
    assetRequest(`/assets/${encodeURIComponent(assetCode)}/history/${historyId}`, { method: "DELETE" }),
};

export const whatsappService = {
  sendMessage: async (payload: {
    number: string;
    message: string;
    recipientType?: "patient" | "radiologist";
    patientId?: string;
    studyInstanceUid?: string;
    accessionNumber?: string;
  }): Promise<{ sent: boolean; provider?: string; fallbackUrl?: string; reason?: string }> => {
    const response = await fetch(`${BACKEND_URL}/whatsapp/send`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || "Failed to send WhatsApp message");
      (error as Error & { fallbackUrl?: string }).fallbackUrl = data?.fallbackUrl;
      throw error;
    }
    return data;
  },
};

export const qualityControlService = {
  fetchStatuses: async (studyInstanceUids: string[]): Promise<
    { study_instance_uid: string; processed_by?: string | null; processed_at?: string | null }[]
  > => {
    const response = await fetch(`${BACKEND_URL}/qc/status`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ studyInstanceUids }),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch QC status");
    }
    return response.json();
  },
  processStudies: async (payload: {
    studyInstanceUids: string[];
    processedBy?: string;
  }): Promise<{ study_instance_uid: string; processed_by?: string | null; processed_at?: string | null }[]> => {
    const response = await fetch(`${BACKEND_URL}/qc/process`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to update QC status");
    }
    return response.json();
  },
};

export const orderOutViewerLinkService = {
  retry: async (
    accessionNumbers: string[]
  ): Promise<{
    updated: number;
    skipped: number;
    failed: number;
    results: {
      accessionNumber: string;
      status: "updated" | "skipped" | "failed";
      reason?: string;
      url?: string;
      token?: string;
      expiresAt?: string | null;
    }[];
  }> => {
    const response = await fetch(`${BACKEND_URL}/order-out/viewer-link/retry`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ accessionNumbers }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to retry viewer links");
    }
    return response.json();
  },
};

export const radiologistAssignmentService = {
  fetchAssignments: async (studyInstanceUids: string[]): Promise<RadiologistAssignment[]> => {
    const response = await fetch(`${BACKEND_URL}/radiologist-assignments/status`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ studyInstanceUids }),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch assignments");
    }
    return response.json();
  },
  fetchByRadiologist: async (radiologistUsername: string): Promise<{ study_instance_uid: string }[]> => {
    const response = await fetch(`${BACKEND_URL}/radiologist-assignments/by-radiologist`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ radiologistUsername }),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch radiologist assignments");
    }
    return response.json();
  },
  assignRadiologist: async (payload: {
    studyInstanceUid: string;
    radiologistId?: number;
    radiologistUsername?: string;
    assignedBy?: string;
  }): Promise<RadiologistAssignment> => {
    const response = await fetch(`${BACKEND_URL}/radiologist-assignments`, {
      method: "POST",
      headers: withRoleHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Failed to assign radiologist");
    }
    const data = await response.json();
    return data?.assignment ?? data;
  },
};

export interface ServerSettings {
  storagePath: string;
  pacsBaseUrl: string;
  rsRoot: string;
  aeTitle: string;
  dicomHost: string;
  dicomPort: string;
}

export interface ViewerConfig {
  id: string;
  name: string;
  baseUrl: string;
  path: string;
  queryParam: string;
  type?: "url" | "inobitec-rpc" | string;
  rpcUrl?: string;
  command?: "DownloadAndOpenStudy" | "DisplayStudy" | string;
  commandType?: "C-GET" | "C-MOVE" | "WADO-RS" | string;
  pacsAet?: string;
  pacsIp?: string;
  pacsPort?: string;
  wadoServiceRootPath?: string;
  isWadoSecured?: boolean;
  wadoPort?: string;
  wadoAuthLogin?: string;
  wadoAuthPassword?: string;
  displayAfterMs?: number;
  launchEndpoint?: string;
  launchHeaderName?: string;
  modalityFilter?: string[];
}

export interface UiSettings {
  facility?: {
    name?: string;
    address?: string;
  };
  viewerUrl: string;
  viewerPath: string;
  autoRefresh: boolean;
  worklistSeriesPreviewEnabled?: boolean;
  radiologistCompetitionEnabled?: boolean;
  viewerAccessLinkDays?: number;
  patientPortalMaxImagesPerSeries?: number;
  radiologistWhatsappNotification?: {
    mode: "manual" | "auto";
    scope?: "all" | "cito";
    messageTemplate: string;
  };
  viewers?: ViewerConfig[];
}

export interface ExpertiseSettings {
  headerImage: string | null;
  templateHtml: string | null;
  qrPosition: "left" | "center" | "right" | null;
}

export interface ExpertisePrintTemplate {
  id: number;
  name: string;
  headerImage: string | null;
  templateHtml: string | null;
  isActive: boolean;
  isDefault: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ExpertisePrintTemplatePayload {
  name: string;
  headerImage: string | null;
  templateHtml: string | null;
  isActive: boolean;
  isDefault: boolean;
}

export interface ExpertiseAssets {
  headerImage: string | null;
  signatureImage: string | null;
  templateHtml: string | null;
  qrPosition: "left" | "center" | "right" | null;
  templateId?: number | null;
  templateName?: string | null;
}

export interface PublicStudyInfo {
  patientId: string;
  patientName: string;
  otherPatientIds?: string;
  accessionNumber: string;
  institutionName?: string;
  modalityCode: string;
  studyDescription: string;
  imageCount: number;
  seriesCount: number;
  referringPhysician: string;
  studyDate: string;
  studyTime?: string;
  studyId?: string;
  birthDate: string;
  sex: "M" | "F" | "O" | string;
  studyInstanceUid: string;
}

export interface PublicReport {
  radiologist_id?: number | null;
  radiologist_name?: string | null;
  clinical_info?: string | null;
  findings?: string | null;
  conclusion?: string | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  finalized_at?: string | null;
}

export interface PublicShareAssets {
  headerImage: string | null;
  signatureImage: string | null;
  templateHtml: string | null;
  qrPosition: "left" | "center" | "right" | null;
  templateId?: number | null;
  templateName?: string | null;
}

export interface PublicStudyResponse {
  study: PublicStudyInfo | null;
  report: PublicReport | null;
  assets: PublicShareAssets;
  share?: { expires_at?: string | null; template_id?: number | null };
}

export interface StatisticsData {
  storage: {
    total: string;
    used: string;
    free: string;
    path: string;
  };
  totalStudies: number;
  totalPatients: number;
  todayStudies: number;
  risSummary: {
    pendingOrders: number;
    sentToMwl: number;
    completedStudies: number;
    draftReports: number;
    finalReports: number;
    qcCompleted: number;
  };
  dashboardSummary: {
    totalOrder: number;
    technologistProcessed: number;
    radiologist: {
      read: number;
      total: number;
      pending: number;
    };
    qualityControl: {
      done: number;
      total: number;
      pending: number;
    };
  };
  modalities: { name: string; count: number }[];
  monthlyRecap: { month: string, count: number }[];
  studyDescriptions: { name: string; count: number }[];
}
const BACKEND = () => resolveBackendUrl();
