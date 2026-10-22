export type DoseModality = "CT" | "DX" | "CR" | "PX" | "XR" | "MG" | "XA" | "RF" | "NM" | "DENTAL";

export type DoseStudy = {
  id: string;
  patientId: string;
  patientName: string;
  accessionNumber: string;
  modalityCode: DoseModality;
  studyDescription: string;
  studyDate: string;
  studyTime: string;
  sex: "M" | "F";
  birthDate: string;
  cito?: boolean;
  radiologist: string;
  technologist: string;
  medicalPhysicist?: string;
  room: string;
  aeTitle: string;
  studyInstanceUid: string;
};

export type DoseRecord = DoseStudy & {
  savedAt: string;
  captureMode: "auto" | "manual";
  values: Record<string, string>;
};

export type IdrlRecord = {
  id: string;
  modalityCode: DoseModality;
  exam: string;
  metric: string;
  limit: string;
  unit: string;
  bodyRegion: string;
  reference: string;
  effectiveDate: string;
};

export const DOSE_RECORDS_KEY = "nexia:dose-records:v1";
export const IDRL_RECORDS_KEY = "nexia:idrl-records:v1";
export const IDRL_STUDY_LINKS_KEY = "nexia:idrl-study-links:v1";

export type IdrlStudyLink = {
  id: string;
  modalityCode: DoseModality;
  idrlExam: string;
  studyMasterId: number;
  procedureCode: string;
  studyDescription: string;
};

export const doseStudies: DoseStudy[] = [
  {
    id: "dose-001",
    patientId: "SIMRS-MWL-001",
    patientName: "ANDI PRASETYO TEST",
    accessionNumber: "ACC-DOSE-001",
    modalityCode: "CT",
    studyDescription: "CT Thorax Contrast",
    studyDate: "2026-05-20",
    studyTime: "08:12",
    sex: "M",
    birthDate: "1980-01-14",
    cito: true,
    radiologist: "Dr. Radiology One",
    technologist: "Radiographer A, Radiographer B",
    room: "CT Scan 1",
    aeTitle: "CTROOM1",
    studyInstanceUid: "1.2.360.100.1.1",
  },
  {
    id: "dose-002",
    patientId: "SIMRS-MWL-002",
    patientName: "SITI NURHALIZA TEST",
    accessionNumber: "ACC-DOSE-002",
    modalityCode: "DX",
    studyDescription: "Chest PA/AP",
    studyDate: "2026-05-20",
    studyTime: "08:36",
    sex: "F",
    birthDate: "1992-03-21",
    radiologist: "Dr. Radiology Two",
    technologist: "Radiographer C",
    room: "Digital X-Ray 1",
    aeTitle: "DXROOM1",
    studyInstanceUid: "1.2.360.100.1.2",
  },
  {
    id: "dose-003",
    patientId: "SIMRS-MWL-003",
    patientName: "BUDI SANTOSO TEST",
    accessionNumber: "ACC-DOSE-003",
    modalityCode: "MG",
    studyDescription: "Mammography Bilateral MLO CC",
    studyDate: "2026-05-20",
    studyTime: "09:05",
    sex: "F",
    birthDate: "1975-07-09",
    radiologist: "Dr. Radiology One",
    technologist: "Radiographer D",
    room: "Mammo 1",
    aeTitle: "MGROOM1",
    studyInstanceUid: "1.2.360.100.1.3",
  },
  {
    id: "dose-004",
    patientId: "SIMRS-MWL-004",
    patientName: "DEWI LESTARI TEST",
    accessionNumber: "ACC-DOSE-004",
    modalityCode: "CR",
    studyDescription: "Abdomen AP Supine",
    studyDate: "2026-05-19",
    studyTime: "15:42",
    sex: "F",
    birthDate: "1988-11-02",
    radiologist: "Dr. Radiology Three",
    technologist: "Radiographer A",
    room: "CR Room",
    aeTitle: "CRROOM",
    studyInstanceUid: "1.2.360.100.1.4",
  },
  {
    id: "dose-005",
    patientId: "SIMRS-MWL-005",
    patientName: "RIZKY MAULANA TEST",
    accessionNumber: "ACC-DOSE-005",
    modalityCode: "XA",
    studyDescription: "Fluoroscopy Urology",
    studyDate: "2026-05-19",
    studyTime: "16:18",
    sex: "M",
    birthDate: "2001-06-17",
    cito: true,
    radiologist: "Dr. Radiology Two",
    technologist: "Radiographer E",
    room: "Fluoro 1",
    aeTitle: "XAROOM1",
    studyInstanceUid: "1.2.360.100.1.5",
  },
];

const projectionDoseFields = [
  { key: "kvp", label: "kVp" },
  { key: "ma", label: "mA" },
  { key: "ua", label: "µA" },
  { key: "seconds", label: "s" },
  { key: "mas", label: "mAs" },
  { key: "uas", label: "µAs" },
  { key: "sid", label: "SID" },
  { key: "dap", label: "DAP" },
  { key: "weight", label: "Weight" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "stationName", label: "StationName" },
];

export const doseFieldMap: Record<DoseModality, { key: string; label: string; unit?: string }[]> = {
  CT: [
    { key: "avgCtdiVol", label: "Avg_CTDIVOL" },
    { key: "totalDlp", label: "Total_DLP" },
    { key: "weight", label: "Weight" },
    { key: "manufacturer", label: "Manufacturer" },
    { key: "stationName", label: "StationName" },
  ],
  DX: projectionDoseFields,
  CR: projectionDoseFields,
  PX: projectionDoseFields,
  XR: projectionDoseFields,
  MG: [
    { key: "agd", label: "Average Glandular Dose", unit: "mGy" },
    { key: "compressedThickness", label: "Compressed Thickness", unit: "mm" },
    { key: "compressionForce", label: "Compression Force", unit: "N" },
    { key: "kv", label: "kV" },
    { key: "mas", label: "mAs" },
    { key: "view", label: "View" },
  ],
  XA: [
    { key: "dap", label: "DAP", unit: "Gy.cm2" },
    { key: "fluoroTime", label: "Fluoro Time", unit: "s" },
    { key: "kv", label: "kV" },
    { key: "ma", label: "mA" },
    { key: "pulseRate", label: "Pulse Rate", unit: "pps" },
  ],
  RF: [
    { key: "totalKerma", label: "Total Kerma", unit: "mGy" },
    { key: "dap", label: "DAP", unit: "Gy.cm2" },
    { key: "weight", label: "Weight" },
    { key: "manufacturer", label: "Manufacturer" },
    { key: "stationName", label: "StationName" },
  ],
  NM: [
    { key: "radiopharmaceutical", label: "Radiofarmaka" },
    { key: "activity", label: "Activity", unit: "MBq" },
    { key: "weight", label: "Weight" },
  ],
  DENTAL: [
    { key: "dap", label: "DAP", unit: "mGy.cm2" },
    { key: "inak", label: "INAK", unit: "mGy" },
    { key: "weight", label: "Weight" },
    { key: "manufacturer", label: "Manufacturer" },
    { key: "stationName", label: "StationName" },
  ],
};

export const defaultIdrlRecords: IdrlRecord[] = [
  { id: "tpdi-gr-abdomen-ap-esak", modalityCode: "DX", exam: "Abdomen AP", metric: "ESAK", limit: "2.0", unit: "mGy", bodyRegion: "Abdomen", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-abdomen-ap-inak", modalityCode: "DX", exam: "Abdomen AP", metric: "INAK", limit: "1.4", unit: "mGy", bodyRegion: "Abdomen", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-ankle-ap-esak", modalityCode: "DX", exam: "Ankle joint AP", metric: "ESAK", limit: "0.2", unit: "mGy", bodyRegion: "Extremity", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-antebrachia-ap-esak", modalityCode: "DX", exam: "Antebrachia AP", metric: "ESAK", limit: "0.1", unit: "mGy", bodyRegion: "Extremity", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-bno-ap-esak", modalityCode: "DX", exam: "BNO AP", metric: "ESAK", limit: "1.7", unit: "mGy", bodyRegion: "Abdomen", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-chest-ap-esak", modalityCode: "DX", exam: "Chest AP", metric: "ESAK", limit: "0.4", unit: "mGy", bodyRegion: "Thorax", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-chest-pa-esak", modalityCode: "DX", exam: "Chest PA", metric: "ESAK", limit: "0.4", unit: "mGy", bodyRegion: "Thorax", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-cervical-lat-esak", modalityCode: "DX", exam: "Cervical LAT", metric: "ESAK", limit: "1.4", unit: "mGy", bodyRegion: "Spine", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-cervical-ap-esak", modalityCode: "DX", exam: "Cervical AP", metric: "ESAK", limit: "0.7", unit: "mGy", bodyRegion: "Spine", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-femur-ap-esak", modalityCode: "DX", exam: "Femur AP", metric: "ESAK", limit: "0.5", unit: "mGy", bodyRegion: "Extremity", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-genu-ap-esak", modalityCode: "DX", exam: "Genu AP", metric: "ESAK", limit: "0.4", unit: "mGy", bodyRegion: "Extremity", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-genu-lat-esak", modalityCode: "DX", exam: "Genu LAT", metric: "ESAK", limit: "0.4", unit: "mGy", bodyRegion: "Extremity", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-lumbar-ap-esak", modalityCode: "DX", exam: "Lumbar Spine AP", metric: "ESAK", limit: "2.0", unit: "mGy", bodyRegion: "Spine", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-lumbar-lat-esak", modalityCode: "DX", exam: "Lumbar Spine LAT", metric: "ESAK", limit: "4.4", unit: "mGy", bodyRegion: "Spine", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-manus-ap-esak", modalityCode: "DX", exam: "Manus AP", metric: "ESAK", limit: "0.2", unit: "mGy", bodyRegion: "Extremity", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-pedis-ap-esak", modalityCode: "DX", exam: "Pedis AP", metric: "ESAK", limit: "0.2", unit: "mGy", bodyRegion: "Extremity", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-pelvis-ap-esak", modalityCode: "DX", exam: "Pelvis AP", metric: "ESAK", limit: "1.8", unit: "mGy", bodyRegion: "Pelvis", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-shoulder-esak", modalityCode: "DX", exam: "Shoulder", metric: "ESAK", limit: "0.4", unit: "mGy", bodyRegion: "Shoulder", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-skull-ap-esak", modalityCode: "DX", exam: "Skull AP", metric: "ESAK", limit: "1.3", unit: "mGy", bodyRegion: "Head", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-skull-lat-esak", modalityCode: "DX", exam: "Skull LAT", metric: "ESAK", limit: "1.2", unit: "mGy", bodyRegion: "Head", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-cruris-esak", modalityCode: "DX", exam: "GR-Cruris/Tibia Fibula", metric: "ESAK", limit: "0.3", unit: "mGy", bodyRegion: "Extremity", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-wrist-ap-esak", modalityCode: "DX", exam: "Wrist joint AP", metric: "ESAK", limit: "0.2", unit: "mGy", bodyRegion: "Extremity", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-gr-waters-esak", modalityCode: "DX", exam: "Waters", metric: "ESAK", limit: "1.7", unit: "mGy", bodyRegion: "Head", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-abdomen-kontras-ctdi", modalityCode: "CT", exam: "CT Abdomen Kontras", metric: "avgCtdiVol", limit: "20", unit: "mGy", bodyRegion: "Abdomen", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-abdomen-kontras-dlp", modalityCode: "CT", exam: "CT Abdomen Kontras", metric: "totalDlp", limit: "1360", unit: "mGy.cm", bodyRegion: "Abdomen", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-abdomen-nonkontras-ctdi", modalityCode: "CT", exam: "CT Abdomen Nonkontras", metric: "avgCtdiVol", limit: "17", unit: "mGy", bodyRegion: "Abdomen", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-abdomen-nonkontras-dlp", modalityCode: "CT", exam: "CT Abdomen Nonkontras", metric: "totalDlp", limit: "885", unit: "mGy.cm", bodyRegion: "Abdomen", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-abdopelvis-kontras-dlp", modalityCode: "CT", exam: "CT Abdo Pelvis Kontras", metric: "totalDlp", limit: "1775", unit: "mGy.cm", bodyRegion: "Abdomen/Pelvis", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-cardiac-ctdi", modalityCode: "CT", exam: "CT Cardiac Studies Kontras", metric: "avgCtdiVol", limit: "47", unit: "mGy", bodyRegion: "Cardiac", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-cardiac-dlp", modalityCode: "CT", exam: "CT Cardiac Studies Kontras", metric: "totalDlp", limit: "1200", unit: "mGy.cm", bodyRegion: "Cardiac", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-chest-kontras-dlp", modalityCode: "CT", exam: "CT Chest Kontras", metric: "totalDlp", limit: "810", unit: "mGy.cm", bodyRegion: "Thorax", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-chest-nonkontras-dlp", modalityCode: "CT", exam: "CT Chest Nonkontras", metric: "totalDlp", limit: "430", unit: "mGy.cm", bodyRegion: "Thorax", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-head-kontras-ctdi", modalityCode: "CT", exam: "CT Head Kontras", metric: "avgCtdiVol", limit: "60", unit: "mGy", bodyRegion: "Head", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-head-kontras-dlp", modalityCode: "CT", exam: "CT Head Kontras", metric: "totalDlp", limit: "2500", unit: "mGy.cm", bodyRegion: "Head", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-head-nonkontras-dlp", modalityCode: "CT", exam: "CT Head Nonkontras", metric: "totalDlp", limit: "1275", unit: "mGy.cm", bodyRegion: "Head", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-neck-kontras-dlp", modalityCode: "CT", exam: "CT Neck Kontras", metric: "totalDlp", limit: "2600", unit: "mGy.cm", bodyRegion: "Neck", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-ct-urologi-dlp", modalityCode: "CT", exam: "CT Urologi Nonkontras", metric: "totalDlp", limit: "830", unit: "mGy.cm", bodyRegion: "Urology", reference: "BAPETEN 1211/K/V/2021", effectiveDate: "2021-05-24" },
  { id: "tpdi-rf-abdominal-angiogram-dap", modalityCode: "XA", exam: "Abdominal Angiogram", metric: "dap", limit: "12", unit: "Gy.cm2", bodyRegion: "Abdomen", reference: "BAPETEN 3426/K/XI/2022", effectiveDate: "2022-11-24" },
  { id: "tpdi-rf-cerebral-angiogram-dap", modalityCode: "XA", exam: "Cerebral Angiogram (1-3 vessels)", metric: "dap", limit: "34", unit: "Gy.cm2", bodyRegion: "Head", reference: "BAPETEN 3426/K/XI/2022", effectiveDate: "2022-11-24" },
  { id: "tpdi-rf-coronary-angiogram-dap", modalityCode: "XA", exam: "Coronary Angiogram (1-3 vessels)", metric: "dap", limit: "20", unit: "Gy.cm2", bodyRegion: "Cardiac", reference: "BAPETEN 3426/K/XI/2022", effectiveDate: "2022-11-24" },
  { id: "tpdi-rf-pci-dap", modalityCode: "XA", exam: "Percutaneous Coronary Intervention (PCI)", metric: "dap", limit: "53", unit: "Gy.cm2", bodyRegion: "Cardiac", reference: "BAPETEN 3426/K/XI/2022", effectiveDate: "2022-11-24" },
  { id: "tpdi-rf-ercp-dap", modalityCode: "XA", exam: "Endoscopic Retrograde Cholangio Pancreatography (ERCP)", metric: "dap", limit: "105", unit: "Gy.cm2", bodyRegion: "Abdomen", reference: "BAPETEN 3426/K/XI/2022", effectiveDate: "2022-11-24" },
  { id: "tpdi-nm-pet-tumor", modalityCode: "NM", exam: "PET Tumor", metric: "activity", limit: "340", unit: "MBq", bodyRegion: "Whole Body", reference: "BAPETEN 3426/K/XI/2022", effectiveDate: "2022-11-24" },
  { id: "tpdi-nm-thyroid-scan", modalityCode: "NM", exam: "Thyroid Scan", metric: "activity", limit: "170", unit: "MBq", bodyRegion: "Thyroid", reference: "BAPETEN 3426/K/XI/2022", effectiveDate: "2022-11-24" },
  { id: "tpdi-nm-bone-scan", modalityCode: "NM", exam: "Bone Scan", metric: "activity", limit: "770", unit: "MBq", bodyRegion: "Bone", reference: "BAPETEN 3426/K/XI/2022", effectiveDate: "2022-11-24" },
  { id: "tpdi-dental-panoramic-standard-adult", modalityCode: "DENTAL", exam: "Panoramic - Standard", metric: "dap", limit: "120", unit: "mGy.cm2", bodyRegion: "Dental", reference: "BAPETEN 1322/2024", effectiveDate: "2024-04-22" },
  { id: "tpdi-dental-cephalometric-lateral", modalityCode: "DENTAL", exam: "Cephalometric - Lateral", metric: "dap", limit: "34.7", unit: "mGy.cm2", bodyRegion: "Dental", reference: "BAPETEN 1322/2024", effectiveDate: "2024-04-22" },
  { id: "tpdi-dental-intraoral-anterior", modalityCode: "DENTAL", exam: "Intraoral - Periapical Anterior", metric: "inak", limit: "2.6", unit: "mGy", bodyRegion: "Dental", reference: "BAPETEN 1322/2024", effectiveDate: "2024-04-22" },
  { id: "tpdi-dental-intraoral-molar", modalityCode: "DENTAL", exam: "Intraoral - Periapical Molar", metric: "inak", limit: "1.8", unit: "mGy", bodyRegion: "Dental", reference: "BAPETEN 1322/2024", effectiveDate: "2024-04-22" },
  { id: "tpdi-mg-cc", modalityCode: "MG", exam: "Cranial - Caudal (CC)", metric: "agd", limit: "1.6", unit: "mGy", bodyRegion: "Breast", reference: "BAPETEN 1322/2024", effectiveDate: "2024-04-22" },
  { id: "tpdi-mg-mlo", modalityCode: "MG", exam: "Mediolateral - Oblique (MLO)", metric: "agd", limit: "1.8", unit: "mGy", bodyRegion: "Breast", reference: "BAPETEN 1322/2024", effectiveDate: "2024-04-22" },
];

export const buildAutoDose = (study: DoseStudy) => {
  if (study.id === "dose-004") return null;
  if (study.modalityCode === "CT") return { avgCtdiVol: "14.8", totalDlp: "482", weight: "", manufacturer: "", stationName: "" };
  if (study.modalityCode === "MG") return { agd: "2.1", compressedThickness: "48", compressionForce: "112", kv: "28", mas: "74", view: "MLO/CC" };
  if (study.modalityCode === "XA") return { dap: "8.4", fluoroTime: "212", kv: "74", ma: "320", pulseRate: "15" };
  return { kvp: "", ma: "", ua: "", seconds: "", mas: "", uas: "", sid: "", dap: "", weight: "", manufacturer: "", stationName: "" };
};

export const readDoseRecords = (): DoseRecord[] => {
  try {
    const raw = window.localStorage.getItem(DOSE_RECORDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

export const writeDoseRecords = (records: DoseRecord[]) => {
  window.localStorage.setItem(DOSE_RECORDS_KEY, JSON.stringify(records));
};

export const readIdrlRecords = (): IdrlRecord[] => {
  try {
    const raw = window.localStorage.getItem(IDRL_RECORDS_KEY);
    if (!raw) return defaultIdrlRecords;
    const stored = JSON.parse(raw) as IdrlRecord[];
    const storedIds = new Set(stored.map(item => item.id));
    return [...stored, ...defaultIdrlRecords.filter(item => !storedIds.has(item.id))];
  } catch {
    return defaultIdrlRecords;
  }
};

export const writeIdrlRecords = (records: IdrlRecord[]) => {
  window.localStorage.setItem(IDRL_RECORDS_KEY, JSON.stringify(records));
};

export const getIdrlStudyGroupKey = (modalityCode: DoseModality, exam: string) => `${modalityCode}::${exam.trim().toLowerCase()}`;

export const readIdrlStudyLinks = (): IdrlStudyLink[] => {
  try {
    const raw = window.localStorage.getItem(IDRL_STUDY_LINKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

export const writeIdrlStudyLinks = (links: IdrlStudyLink[]) => {
  window.localStorage.setItem(IDRL_STUDY_LINKS_KEY, JSON.stringify(links));
};
