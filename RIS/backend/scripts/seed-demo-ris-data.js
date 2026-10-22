const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const pool = require('../src/services/db');

const pad = (value) => String(value).padStart(2, '0');
const toDateString = (date) => date.toISOString().slice(0, 10);
const today = new Date();
const todayDate = toDateString(today);

function addDays(days) {
  const value = new Date(today);
  value.setDate(value.getDate() + days);
  return toDateString(value);
}

function makeStudy(index) {
  const n = pad(index);
  const exams = [
    'CT Head Non Contrast',
    'CT Chest Contrast',
    'CT Abdomen Pelvis Contrast',
    'CT Stroke Protocol',
    'CT Pulmonary Angiography',
    'CT Cervical Spine',
    'CT Lumbar Spine',
    'CT Urography',
    'CT Sinus Paranasal',
    'CT Temporal Bone',
    'CT Coronary Calcium Score',
    'CT Angiography Brain',
    'CT Abdomen Non Contrast',
    'CT Thorax HRCT',
    'CT Whole Abdomen Triple Phase',
  ];
  const exam = exams[index - 1];
  return {
    index,
    n,
    patientNo: `DEMO-RM-${n}`,
    patientName: `Demo Dose Patient ${n}`,
    accession: `DEMO-RIS-ACC-${n}`,
    studyUid: `1.2.826.0.1.3680043.10.7777.20260702.${index}`,
    procedureCode: `DEMO-CT-${n}`,
    procedureDesc: exam,
    ctdi: (18 + index * 1.15).toFixed(1),
    dlp: String(420 + index * 34),
    ctdiLimit: String(24 + (index % 4) * 2),
    dlpLimit: String(620 + (index % 5) * 45),
  };
}

function makeAsset(index) {
  const n = pad(index);
  const categories = ['CT', 'MRI', 'XRAY', 'USG', 'CR', 'DR', 'MG', 'FL', 'OTHER'];
  const names = [
    'CT Scanner 128 Slice',
    'MRI 1.5T System',
    'Digital X-Ray Room 1',
    'Ultrasound Premium',
    'Computed Radiography Reader',
    'Digital Radiography Detector',
    'Mammography Unit',
    'Fluoroscopy Suite',
    'Mobile X-Ray',
    'Workstation Radiology',
    'Dose Calibrator',
    'Injector Contrast',
    'PACS Gateway Server',
    'Lead Apron Rack',
    'QA Phantom CT',
  ];
  return {
    id: `DEMO-ASSET-${n}`,
    name: names[index - 1],
    category: categories[(index - 1) % categories.length],
    brand: ['Siemens', 'GE', 'Philips', 'Canon', 'Fujifilm'][index % 5],
    model: `VEXA-${1000 + index}`,
    serial: `SN-DEMO-RIS-${n}`,
    room: `Radiology Room ${((index - 1) % 6) + 1}`,
    purchase: addDays(-900 - index * 17),
    warranty: addDays(index % 5 === 0 ? -45 : 180 + index * 20),
    lastCalibration: addDays(-90 + index),
    nextCalibration: addDays(index % 4 === 0 ? -7 : 20 + index * 3),
    status: index % 6 === 0 ? 'maintenance' : 'active',
    person: ['Budi Santoso', 'Siti Rahma', 'Andi Wijaya', 'Dewi Lestari'][index % 4],
    vendor: ['PT Medika Prima', 'PT Imaging Nusantara', 'PT Radiologi Teknika'][index % 3],
  };
}

async function ensureTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      no_rm VARCHAR(255) NOT NULL UNIQUE,
      nama_pasien VARCHAR(255) NOT NULL,
      tanggal_lahir DATE NOT NULL,
      kelamin VARCHAR(1) NOT NULL,
      alamat VARCHAR(150) NULL,
      kecamatan VARCHAR(150) NULL,
      kabupaten VARCHAR(150) NULL,
      provinsi VARCHAR(150) NULL,
      kode_pos VARCHAR(7) NULL,
      no_hp VARCHAR(20) NULL,
      waktu_update_pasien DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_simrs VARCHAR(1) NOT NULL DEFAULT 'N'
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS mwl_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      patient_record_id INT NOT NULL,
      accession_number VARCHAR(64) NOT NULL UNIQUE,
      study_instance_uid VARCHAR(128) NOT NULL UNIQUE,
      study_date DATE NULL,
      study_time TIME NULL,
      modality VARCHAR(16) NOT NULL,
      cito VARCHAR(1) NULL,
      polirawat VARCHAR(15) NULL,
      kode_ruangan VARCHAR(12) NULL,
      nama_ruangan VARCHAR(50) NULL,
      procedure_code VARCHAR(64) NULL,
      procedure_desc VARCHAR(255) NOT NULL,
      kode_pemeriksaan VARCHAR(12) NULL,
      nama_pemeriksaan VARCHAR(50) NULL,
      kode_dokter VARCHAR(12) NULL,
      nama_dokter VARCHAR(255) NULL,
      kode_admin VARCHAR(12) NULL,
      nama_admin VARCHAR(255) NULL,
      kode_dokter_radiolog VARCHAR(12) NULL,
      nama_radiolog VARCHAR(255) NULL,
      kode_radiografer VARCHAR(12) NULL,
      nama_radiografer VARCHAR(100) NULL,
      radiografer_datetime_start DATETIME NULL,
      radiografer_datetime_end DATETIME NULL,
      cara_bayar VARCHAR(10) NULL,
      kode_asuransi VARCHAR(12) NULL,
      nama_asuransi VARCHAR(255) NULL,
      kode_instalasi_radiologi VARCHAR(12) NULL,
      nama_instalasi_radiologi VARCHAR(50) NULL,
      referring_physician VARCHAR(255) NULL,
      assigned_staff_json JSON NULL,
      modality_station_ae VARCHAR(64) NULL,
      modality_station_room VARCHAR(150) NULL,
      status ENUM('PENDING','SENT_TO_MWL','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_mwl_orders_patient FOREIGN KEY (patient_record_id) REFERENCES patients(id) ON DELETE CASCADE
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS mwl_studies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      procedure_code VARCHAR(64) NOT NULL,
      modality_code VARCHAR(16) NOT NULL,
      study_description VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mwl_studies_desc_modality (study_description, modality_code)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS dose_report (
      id VARCHAR(64) PRIMARY KEY,
      mwl_order_id INT NULL,
      patient_id VARCHAR(64) NULL,
      patient_name VARCHAR(255) NULL,
      accession_number VARCHAR(64) NULL,
      modality_code VARCHAR(16) NOT NULL,
      study_description VARCHAR(255) NULL,
      study_date VARCHAR(16) NULL,
      study_time VARCHAR(32) NULL,
      sex VARCHAR(4) NULL,
      birth_date VARCHAR(16) NULL,
      cito TINYINT(1) NOT NULL DEFAULT 0,
      radiologist VARCHAR(255) NULL,
      technologist VARCHAR(255) NULL,
      medical_physicist VARCHAR(255) NULL,
      room VARCHAR(150) NULL,
      ae_title VARCHAR(64) NULL,
      study_instance_uid VARCHAR(128) NULL,
      capture_mode VARCHAR(16) NOT NULL DEFAULT 'manual',
      values_json JSON NULL,
      saved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dose_report_mwl_order (mwl_order_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS dose_idrl (
      id VARCHAR(128) PRIMARY KEY,
      modality_code VARCHAR(16) NOT NULL,
      exam VARCHAR(255) NOT NULL,
      metric VARCHAR(80) NOT NULL,
      dose_limit VARCHAR(80) NOT NULL,
      unit VARCHAR(80) NULL,
      body_region VARCHAR(150) NULL,
      reference_text VARCHAR(255) NULL,
      effective_date VARCHAR(32) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS dose_idrl_study_links (
      id VARCHAR(255) PRIMARY KEY,
      modality_code VARCHAR(16) NOT NULL,
      idrl_exam VARCHAR(255) NOT NULL,
      study_master_id INT NOT NULL,
      procedure_code VARCHAR(64) NULL,
      study_description VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dose_idrl_study_link (modality_code, idrl_exam, study_master_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS assets (
      asset_code VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(32) NOT NULL,
      brand VARCHAR(150) NULL,
      model VARCHAR(150) NULL,
      serial_number VARCHAR(150) NOT NULL,
      room VARCHAR(150) NULL,
      purchase_date DATE NULL,
      warranty_expired_date DATE NULL,
      last_calibration_date DATE NULL,
      next_calibration_date DATE NULL,
      operational_status VARCHAR(32) NOT NULL DEFAULT 'active',
      responsible_person VARCHAR(150) NULL,
      vendor VARCHAR(150) NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_assets_serial_number (serial_number)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS asset_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      asset_code VARCHAR(64) NOT NULL,
      record_date DATE NOT NULL,
      record_type VARCHAR(64) NOT NULL,
      title VARCHAR(255) NOT NULL,
      officer VARCHAR(150) NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (asset_code) REFERENCES assets(asset_code) ON DELETE CASCADE
    )
  `);
}

async function seedStudyAndDose(db, study) {
  await db.query(
    `INSERT INTO patients (no_rm, nama_pasien, tanggal_lahir, kelamin, alamat, no_hp, update_simrs)
     VALUES (?, ?, ?, ?, ?, ?, 'N')
     ON DUPLICATE KEY UPDATE
       nama_pasien = VALUES(nama_pasien),
       tanggal_lahir = VALUES(tanggal_lahir),
       kelamin = VALUES(kelamin),
       alamat = VALUES(alamat),
       no_hp = VALUES(no_hp)`,
    [
      study.patientNo,
      study.patientName,
      `19${70 + (study.index % 24)}-${pad(((study.index - 1) % 12) + 1)}-${pad(((study.index + 8) % 27) + 1)}`,
      study.index % 3 === 0 ? 'F' : 'M',
      `Jl. Demo Dose No. ${study.index}`,
      `0812${String(26070000 + study.index).slice(-8)}`,
    ],
  );
  const [patientRows] = await db.query('SELECT id FROM patients WHERE no_rm = ? LIMIT 1', [study.patientNo]);
  const patientId = patientRows[0]?.id;
  if (!patientId) throw new Error(`Failed to resolve patient ${study.patientNo}`);

  await db.query(
    `INSERT INTO mwl_studies (procedure_code, modality_code, study_description)
     VALUES (?, 'CT', ?)
     ON DUPLICATE KEY UPDATE
       procedure_code = VALUES(procedure_code),
       modality_code = VALUES(modality_code),
       study_description = VALUES(study_description)`,
    [study.procedureCode, study.procedureDesc],
  );
  const [studyRows] = await db.query(
    'SELECT id FROM mwl_studies WHERE modality_code = ? AND study_description = ? LIMIT 1',
    ['CT', study.procedureDesc],
  );
  const studyMasterId = studyRows[0]?.id;
  if (!studyMasterId) throw new Error(`Failed to resolve study master ${study.procedureDesc}`);

  await db.query(
    `INSERT INTO mwl_orders (
      patient_record_id, accession_number, study_instance_uid, study_date, study_time, modality,
      cito, polirawat, kode_ruangan, nama_ruangan, procedure_code, procedure_desc,
      kode_pemeriksaan, nama_pemeriksaan, kode_dokter, nama_dokter, kode_admin, nama_admin,
      kode_dokter_radiolog, nama_radiolog, kode_radiografer, nama_radiografer,
      radiografer_datetime_start, radiografer_datetime_end, cara_bayar, kode_asuransi, nama_asuransi,
      kode_instalasi_radiologi, nama_instalasi_radiologi, referring_physician,
      assigned_staff_json, modality_station_ae, modality_station_room, status
    ) VALUES (?, ?, ?, ?, ?, 'CT', ?, 'RJ', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      patient_record_id = VALUES(patient_record_id),
      study_date = VALUES(study_date),
      study_time = VALUES(study_time),
      modality = VALUES(modality),
      cito = VALUES(cito),
      procedure_code = VALUES(procedure_code),
      procedure_desc = VALUES(procedure_desc),
      nama_dokter = VALUES(nama_dokter),
      nama_radiolog = VALUES(nama_radiolog),
      nama_radiografer = VALUES(nama_radiografer),
      modality_station_ae = VALUES(modality_station_ae),
      modality_station_room = VALUES(modality_station_room),
      status = VALUES(status)`,
    [
      patientId,
      study.accession,
      study.studyUid,
      todayDate,
      `${pad(8 + (study.index % 9))}:${pad((study.index * 4) % 60)}:00`,
      study.index % 5 === 0 ? 'Y' : 'N',
      `RD${pad((study.index % 4) + 1)}`,
      `CT Room ${((study.index - 1) % 4) + 1}`,
      study.procedureCode,
      study.procedureDesc,
      study.procedureCode,
      study.procedureDesc.slice(0, 50),
      'CLN001',
      'dr. Demo Clinician',
      'ADM001',
      'Admin Demo RIS',
      'RAD001',
      'dr. Demo Radiologist',
      'TECH001',
      'Radiografer Demo',
      `${todayDate} ${pad(8 + (study.index % 9))}:${pad((study.index * 4) % 60)}:00`,
      `${todayDate} ${pad(8 + (study.index % 9))}:${pad(((study.index * 4) + 18) % 60)}:00`,
      study.index % 2 === 0 ? 'BPJS' : 'UMUM',
      study.index % 2 === 0 ? 'BPJS' : null,
      study.index % 2 === 0 ? 'BPJS Kesehatan' : 'Umum',
      'RAD',
      'Instalasi Radiologi',
      'dr. Demo Clinician',
      JSON.stringify({ technologist: 'Radiografer Demo', medicalPhysicist: 'Fismed Demo' }),
      `CTDEMO${pad((study.index % 4) + 1)}`,
      `CT Room ${((study.index - 1) % 4) + 1}`,
      study.index % 4 === 0 ? 'SENT_TO_MWL' : study.index % 3 === 0 ? 'PENDING' : 'COMPLETED',
    ],
  );
  const [orderRows] = await db.query('SELECT id FROM mwl_orders WHERE accession_number = ? LIMIT 1', [study.accession]);
  const orderId = orderRows[0]?.id;
  if (!orderId) throw new Error(`Failed to resolve order ${study.accession}`);

  const metric = study.index % 2 === 0 ? 'totalDlp' : 'avgCtdiVol';
  const limit = metric === 'totalDlp' ? study.dlpLimit : study.ctdiLimit;
  const unit = metric === 'totalDlp' ? 'mGy.cm' : 'mGy';
  const idrlExam = `DEMO IDRL ${study.procedureDesc}`;
  await db.query(
    `INSERT INTO dose_idrl (id, modality_code, exam, metric, dose_limit, unit, body_region, reference_text, effective_date)
     VALUES (?, 'CT', ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      exam = VALUES(exam),
      metric = VALUES(metric),
      dose_limit = VALUES(dose_limit),
      unit = VALUES(unit),
      body_region = VALUES(body_region),
      reference_text = VALUES(reference_text),
      effective_date = VALUES(effective_date)`,
    [
      `DEMO-IDRL-${study.n}`,
      idrlExam,
      metric,
      limit,
      unit,
      study.procedureDesc.includes('Head') || study.procedureDesc.includes('Brain') ? 'Head' : 'Body',
      'Demo local IDRL reference',
      todayDate,
    ],
  );
  await db.query(
    `INSERT INTO dose_idrl_study_links (id, modality_code, idrl_exam, study_master_id, procedure_code, study_description)
     VALUES (?, 'CT', ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      idrl_exam = VALUES(idrl_exam),
      study_master_id = VALUES(study_master_id),
      procedure_code = VALUES(procedure_code),
      study_description = VALUES(study_description)`,
    [
      `DEMO-LINK-${study.n}`,
      idrlExam,
      studyMasterId,
      study.procedureCode,
      study.procedureDesc,
    ],
  );

  await db.query(
    `INSERT INTO dose_report (
      id, mwl_order_id, patient_id, patient_name, accession_number, modality_code,
      study_description, study_date, study_time, sex, birth_date, cito, radiologist,
      technologist, medical_physicist, room, ae_title, study_instance_uid, capture_mode, values_json, saved_at
    ) VALUES (?, ?, ?, ?, ?, 'CT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
      mwl_order_id = VALUES(mwl_order_id),
      patient_id = VALUES(patient_id),
      patient_name = VALUES(patient_name),
      accession_number = VALUES(accession_number),
      modality_code = VALUES(modality_code),
      study_description = VALUES(study_description),
      study_date = VALUES(study_date),
      study_time = VALUES(study_time),
      sex = VALUES(sex),
      birth_date = VALUES(birth_date),
      cito = VALUES(cito),
      radiologist = VALUES(radiologist),
      technologist = VALUES(technologist),
      medical_physicist = VALUES(medical_physicist),
      room = VALUES(room),
      ae_title = VALUES(ae_title),
      study_instance_uid = VALUES(study_instance_uid),
      capture_mode = VALUES(capture_mode),
      values_json = VALUES(values_json),
      saved_at = NOW()`,
    [
      `DEMO-DOSE-${study.n}`,
      orderId,
      study.patientNo,
      study.patientName,
      study.accession,
      study.procedureDesc,
      todayDate,
      `${pad(8 + (study.index % 9))}:${pad((study.index * 4) % 60)}`,
      study.index % 3 === 0 ? 'F' : 'M',
      `19${70 + (study.index % 24)}${pad(((study.index - 1) % 12) + 1)}${pad(((study.index + 8) % 27) + 1)}`,
      study.index % 5 === 0 ? 1 : 0,
      'dr. Demo Radiologist',
      'Radiografer Demo',
      'Fismed Demo',
      `CT Room ${((study.index - 1) % 4) + 1}`,
      `CTDEMO${pad((study.index % 4) + 1)}`,
      study.studyUid,
      study.index % 2 === 0 ? 'auto' : 'manual',
      JSON.stringify({
        avgCtdiVol: study.ctdi,
        totalDlp: study.dlp,
        weight: String(55 + study.index),
        manufacturer: ['Siemens', 'GE', 'Philips'][study.index % 3],
        stationName: `CTDEMO${pad((study.index % 4) + 1)}`,
      }),
    ],
  );
}

async function seedAsset(db, asset) {
  await db.query(
    `INSERT INTO assets (
      asset_code, name, category, brand, model, serial_number, room, purchase_date,
      warranty_expired_date, last_calibration_date, next_calibration_date,
      operational_status, responsible_person, vendor, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      category = VALUES(category),
      brand = VALUES(brand),
      model = VALUES(model),
      serial_number = VALUES(serial_number),
      room = VALUES(room),
      purchase_date = VALUES(purchase_date),
      warranty_expired_date = VALUES(warranty_expired_date),
      last_calibration_date = VALUES(last_calibration_date),
      next_calibration_date = VALUES(next_calibration_date),
      operational_status = VALUES(operational_status),
      responsible_person = VALUES(responsible_person),
      vendor = VALUES(vendor),
      notes = VALUES(notes)`,
    [
      asset.id,
      asset.name,
      asset.category,
      asset.brand,
      asset.model,
      asset.serial,
      asset.room,
      asset.purchase,
      asset.warranty,
      asset.lastCalibration,
      asset.nextCalibration,
      asset.status,
      asset.person,
      asset.vendor,
      'Demo asset seeded for RIS asset management testing.',
    ],
  );
  await db.query('DELETE FROM asset_history WHERE asset_code = ? AND title LIKE ?', [asset.id, 'Demo %']);
  await db.query(
    `INSERT INTO asset_history (asset_code, record_date, record_type, title, officer, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      asset.id,
      asset.lastCalibration,
      'Calibration',
      `Demo calibration ${asset.id}`,
      asset.vendor,
      'Calibration certificate and QA check recorded as demo data.',
    ],
  );
}

async function main() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureTables(connection);

    const studies = Array.from({ length: 15 }, (_, index) => makeStudy(index + 1));
    for (const study of studies) {
      await seedStudyAndDose(connection, study);
    }

    const assets = Array.from({ length: 15 }, (_, index) => makeAsset(index + 1));
    for (const asset of assets) {
      await seedAsset(connection, asset);
    }

    await connection.commit();

    const [[doseMonitorCount], [doseReportCount], [idrlCount], [idrlLinkCount], [assetCount]] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM mwl_orders WHERE accession_number LIKE 'DEMO-RIS-ACC-%'").then(([rows]) => rows),
      pool.query("SELECT COUNT(*)::int AS count FROM dose_report WHERE id LIKE 'DEMO-DOSE-%'").then(([rows]) => rows),
      pool.query("SELECT COUNT(*)::int AS count FROM dose_idrl WHERE id LIKE 'DEMO-IDRL-%'").then(([rows]) => rows),
      pool.query("SELECT COUNT(*)::int AS count FROM dose_idrl_study_links WHERE id LIKE 'DEMO-LINK-%'").then(([rows]) => rows),
      pool.query("SELECT COUNT(*)::int AS count FROM assets WHERE asset_code LIKE 'DEMO-ASSET-%'").then(([rows]) => rows),
    ]);

    console.log('Demo RIS data seeded.');
    console.log(`Dose Monitor MWL orders: ${doseMonitorCount.count}`);
    console.log(`Dose Report rows: ${doseReportCount.count}`);
    console.log(`Dose IDRL rows: ${idrlCount.count}`);
    console.log(`Average Study IDRL links: ${idrlLinkCount.count}`);
    console.log(`Asset Management rows: ${assetCount.count}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
