-- MySQL 8 schema for VEXA ECG interpretation workflow.
-- VEXA-ECG-* values are internal application codes, not official AHA/SNOMED/LOINC/DICOM codes.

CREATE TABLE IF NOT EXISTS ecg_interpretation_term (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  terminology_system VARCHAR(64) NOT NULL DEFAULT 'VEXA_ECG_INTERNAL',
  code VARCHAR(64) NOT NULL,
  term_en VARCHAR(255) NOT NULL,
  term_id VARCHAR(255) NOT NULL,
  category VARCHAR(40) NOT NULL,
  statement_type ENUM('primary','secondary','modifier','comparison') NOT NULL,
  default_urgency ENUM('routine','urgent','critical') NOT NULL DEFAULT 'routine',
  algorithm_eligible TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ecg_term_system_code (terminology_system, code),
  KEY idx_ecg_term_category_active (category, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecg_exam (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  exam_number VARCHAR(64) NOT NULL,
  patient_id VARCHAR(128) NOT NULL,
  patient_name VARCHAR(255) NULL,
  study_instance_uid VARCHAR(128) NOT NULL,
  series_instance_uid VARCHAR(128) NULL,
  sop_instance_uid VARCHAR(128) NULL,
  acquisition_datetime DATETIME NULL,
  lead_count SMALLINT UNSIGNED NULL,
  recording_type VARCHAR(64) NOT NULL DEFAULT 'resting_12_lead',
  source_system VARCHAR(64) NOT NULL DEFAULT 'dicom_pacs',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ecg_exam_number (exam_number),
  UNIQUE KEY uq_ecg_exam_sop (sop_instance_uid),
  KEY idx_ecg_exam_patient_date (patient_id, acquisition_datetime),
  KEY idx_ecg_exam_study_uid (study_instance_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecg_algorithm_run (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ecg_exam_id BIGINT UNSIGNED NOT NULL,
  algorithm_name VARCHAR(128) NOT NULL,
  algorithm_version VARCHAR(64) NOT NULL,
  run_status ENUM('queued','running','completed','failed') NOT NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  error_message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ecg_run_exam_created (ecg_exam_id, created_at),
  CONSTRAINT fk_ecg_run_exam FOREIGN KEY (ecg_exam_id) REFERENCES ecg_exam(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecg_measurement_set (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ecg_algorithm_run_id BIGINT UNSIGNED NOT NULL,
  heart_rate_bpm DECIMAL(6,2) NULL,
  rr_ms DECIMAL(8,2) NULL,
  pr_ms DECIMAL(8,2) NULL,
  qrs_ms DECIMAL(8,2) NULL,
  qt_ms DECIMAL(8,2) NULL,
  qtc_bazett_ms DECIMAL(8,2) NULL,
  qtc_fridericia_ms DECIMAL(8,2) NULL,
  p_axis_deg DECIMAL(7,2) NULL,
  qrs_axis_deg DECIMAL(7,2) NULL,
  t_axis_deg DECIMAL(7,2) NULL,
  measurement_payload JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ecg_measurement_run (ecg_algorithm_run_id),
  CONSTRAINT fk_ecg_measurement_run FOREIGN KEY (ecg_algorithm_run_id) REFERENCES ecg_algorithm_run(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecg_finding (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ecg_exam_id BIGINT UNSIGNED NOT NULL,
  ecg_algorithm_run_id BIGINT UNSIGNED NULL,
  interpretation_term_id BIGINT UNSIGNED NOT NULL,
  source ENUM('device','algorithm','clinician') NOT NULL,
  verification_status ENUM('unconfirmed','reviewed','confirmed','amended') NOT NULL DEFAULT 'unconfirmed',
  urgency ENUM('routine','urgent','critical') NOT NULL DEFAULT 'routine',
  confidence DECIMAL(5,4) NULL,
  evidence_payload JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ecg_finding_exam_status (ecg_exam_id, verification_status),
  KEY idx_ecg_finding_run (ecg_algorithm_run_id),
  CONSTRAINT fk_ecg_finding_exam FOREIGN KEY (ecg_exam_id) REFERENCES ecg_exam(id),
  CONSTRAINT fk_ecg_finding_run FOREIGN KEY (ecg_algorithm_run_id) REFERENCES ecg_algorithm_run(id),
  CONSTRAINT fk_ecg_finding_term FOREIGN KEY (interpretation_term_id) REFERENCES ecg_interpretation_term(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecg_review (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ecg_exam_id BIGINT UNSIGNED NOT NULL,
  reviewer_user_id BIGINT UNSIGNED NOT NULL,
  verification_status ENUM('reviewed','confirmed','amended') NOT NULL,
  review_note TEXT NULL,
  reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ecg_review_exam_date (ecg_exam_id, reviewed_at),
  CONSTRAINT fk_ecg_review_exam FOREIGN KEY (ecg_exam_id) REFERENCES ecg_exam(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecg_review_finding (
  ecg_review_id BIGINT UNSIGNED NOT NULL,
  ecg_finding_id BIGINT UNSIGNED NULL,
  interpretation_term_id BIGINT UNSIGNED NOT NULL,
  decision ENUM('accepted','rejected','added','modified') NOT NULL,
  note TEXT NULL,
  PRIMARY KEY (ecg_review_id, interpretation_term_id),
  KEY idx_ecg_review_finding_source (ecg_finding_id),
  CONSTRAINT fk_ecg_review_finding_review FOREIGN KEY (ecg_review_id) REFERENCES ecg_review(id),
  CONSTRAINT fk_ecg_review_finding_finding FOREIGN KEY (ecg_finding_id) REFERENCES ecg_finding(id),
  CONSTRAINT fk_ecg_review_finding_term FOREIGN KEY (interpretation_term_id) REFERENCES ecg_interpretation_term(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecg_final_report (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ecg_exam_id BIGINT UNSIGNED NOT NULL,
  ecg_review_id BIGINT UNSIGNED NOT NULL,
  report_status ENUM('draft','pending_review','finalized') NOT NULL DEFAULT 'draft',
  conclusion TEXT NOT NULL,
  report_note TEXT NULL,
  verified_by_user_id BIGINT UNSIGNED NULL,
  verified_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ecg_final_report_exam (ecg_exam_id),
  CONSTRAINT fk_ecg_report_exam FOREIGN KEY (ecg_exam_id) REFERENCES ecg_exam(id),
  CONSTRAINT fk_ecg_report_review FOREIGN KEY (ecg_review_id) REFERENCES ecg_review(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ecg_interpretation_term
  (code, term_en, term_id, category, statement_type, default_urgency, algorithm_eligible, is_active)
VALUES
  ('VEXA-ECG-NORM-001', 'Normal ECG', 'EKG normal', 'overall', 'primary', 'routine', 0, 1),
  ('VEXA-ECG-RHYTHM-001', 'Sinus rhythm', 'Irama sinus', 'rhythm', 'primary', 'routine', 0, 1),
  ('VEXA-ECG-RHYTHM-002', 'Sinus bradycardia', 'Bradikardia sinus', 'rhythm', 'primary', 'routine', 0, 1),
  ('VEXA-ECG-RHYTHM-003', 'Irregular rhythm', 'Irama tidak teratur', 'rhythm', 'primary', 'urgent', 1, 1),
  ('VEXA-ECG-RHYTHM-004', 'Sinus tachycardia', 'Takikardia sinus', 'rhythm', 'primary', 'urgent', 0, 1),
  ('VEXA-ECG-ARR-001', 'Atrial fibrillation', 'Fibrilasi atrium', 'arrhythmia', 'primary', 'urgent', 0, 1),
  ('VEXA-ECG-ARR-002', 'Atrial flutter', 'Flutter atrium', 'arrhythmia', 'primary', 'urgent', 0, 1),
  ('VEXA-ECG-ARR-003', 'Supraventricular tachycardia', 'Takikardia supraventrikular', 'arrhythmia', 'primary', 'urgent', 0, 1),
  ('VEXA-ECG-ARR-004', 'Premature atrial complexes', 'Kompleks atrium prematur', 'arrhythmia', 'primary', 'routine', 0, 1),
  ('VEXA-ECG-ARR-005', 'Premature ventricular complexes', 'Kompleks ventrikel prematur', 'arrhythmia', 'primary', 'urgent', 0, 1),
  ('VEXA-ECG-RATE-001', 'Bradycardic rate', 'Frekuensi bradikardia', 'rate', 'secondary', 'routine', 1, 1),
  ('VEXA-ECG-RATE-002', 'Tachycardic rate', 'Frekuensi takikardia', 'rate', 'secondary', 'urgent', 1, 1),
  ('VEXA-ECG-COND-001', 'Prolonged QRS duration', 'Durasi QRS memanjang', 'conduction', 'secondary', 'urgent', 1, 1),
  ('VEXA-ECG-COND-002', 'First-degree AV block', 'Blok AV derajat satu', 'conduction', 'primary', 'routine', 0, 1),
  ('VEXA-ECG-COND-003', 'Right bundle branch block', 'Blok cabang berkas kanan', 'conduction', 'primary', 'routine', 0, 1),
  ('VEXA-ECG-COND-004', 'Left bundle branch block', 'Blok cabang berkas kiri', 'conduction', 'primary', 'urgent', 0, 1),
  ('VEXA-ECG-AXIS-002', 'Left axis deviation', 'Deviasi aksis kiri', 'axis', 'primary', 'routine', 1, 1),
  ('VEXA-ECG-AXIS-003', 'Right axis deviation', 'Deviasi aksis kanan', 'axis', 'primary', 'routine', 1, 1),
  ('VEXA-ECG-CHAMBER-001', 'Left ventricular hypertrophy', 'Hipertrofi ventrikel kiri', 'chamber', 'primary', 'routine', 0, 1),
  ('VEXA-ECG-VOLT-001', 'Low QRS voltage', 'Voltase QRS rendah', 'voltage', 'primary', 'routine', 0, 1),
  ('VEXA-ECG-STT-001', 'ST-segment elevation', 'Elevasi segmen ST', 'st_t', 'primary', 'urgent', 1, 1),
  ('VEXA-ECG-STT-002', 'ST-segment depression', 'Depresi segmen ST', 'st_t', 'primary', 'urgent', 1, 1),
  ('VEXA-ECG-STT-003', 'Nonspecific ST-T abnormality', 'Abnormalitas ST-T nonspesifik', 'st_t', 'primary', 'routine', 0, 1),
  ('VEXA-ECG-STT-004', 'T-wave inversion', 'Inversi gelombang T', 'st_t', 'primary', 'urgent', 0, 1),
  ('VEXA-ECG-INT-001', 'Prolonged QTc interval', 'Interval QTc memanjang', 'interval', 'primary', 'urgent', 1, 1),
  ('VEXA-ECG-INF-001', 'Possible anterior infarction pattern', 'Kemungkinan pola infark anterior', 'infarction', 'secondary', 'urgent', 0, 1),
  ('VEXA-ECG-INF-002', 'Possible inferior infarction pattern', 'Kemungkinan pola infark inferior', 'infarction', 'secondary', 'urgent', 0, 1),
  ('VEXA-ECG-OVERALL-001', 'Abnormal ECG', 'EKG abnormal', 'overall', 'secondary', 'routine', 0, 1),
  ('VEXA-ECG-OVERALL-002', 'Borderline ECG', 'EKG borderline', 'overall', 'secondary', 'routine', 0, 1),
  ('VEXA-ECG-TECH-001', 'Limited ECG acquisition', 'Akuisisi EKG terbatas', 'technical', 'modifier', 'routine', 1, 1),
  ('VEXA-ECG-COMP-001', 'No significant change', 'Tidak ada perubahan bermakna', 'comparison', 'comparison', 'routine', 0, 1),
  ('VEXA-ECG-COMP-002', 'Significant change from previous ECG', 'Perubahan bermakna dibanding EKG sebelumnya', 'comparison', 'comparison', 'urgent', 0, 1)
ON DUPLICATE KEY UPDATE
  term_en = VALUES(term_en),
  term_id = VALUES(term_id),
  category = VALUES(category),
  statement_type = VALUES(statement_type),
  default_urgency = VALUES(default_urgency),
  algorithm_eligible = VALUES(algorithm_eligible),
  is_active = VALUES(is_active);

-- Example only: measurements and findings must come from a recorded algorithm run.
-- INSERT INTO ecg_exam (exam_number, patient_id, study_instance_uid, recording_type)
-- VALUES ('ECG-2026-00001', 'PATIENT-ID', '1.2.840.example', 'resting_12_lead');
